// GET /api/analyze?ticker=AAPL
// Plainvest: SEC financial analysis and optional Gemini explanations.
// Environment variables:
// SEC_USER_AGENT (required)
// GEMINI_API_KEY (optional)
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (optional; enables daily limit)

"use strict";

const { createHash } = require("node:crypto");

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const DAILY_ANALYSIS_LIMIT = 3;

const RESERVE_DAILY_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current >= tonumber(ARGV[1]) then
  return {0, current, redis.call("TTL", KEYS[1])}
end
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return {1, count, redis.call("TTL", KEYS[1])}
`;

const RELEASE_DAILY_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current <= 1 then
  redis.call("DEL", KEYS[1])
  return 0
end
return redis.call("DECR", KEYS[1])
`;

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new HttpError(
      503,
      "The daily analysis limit is not configured. Please try again later."
    );
  }

  let response;
  let data;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
    });

    data = await response.json();
  } catch (err) {
    console.error("Daily limit storage error:", err.message);

    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable."
    );
  }

  if (!response.ok || data.error) {
    console.error("Daily limit storage request failed:", data.error || response.status);

    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable."
    );
  }

  return data.result;
}

async function reserveDailyAnalysis(req) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Redis isn't configured, don't prevent the analysis from running.
  // The daily limit is enforced whenever both Redis variables are present.
  if (!url || !token) {
    console.warn(
      "Plainvest daily analysis limit is disabled because Upstash is not configured."
    );

    return { allowed: true, key: null };
  }

  const forwarded = req.headers?.["x-forwarded-for"];

  const ip = String(
    req.headers?.["x-real-ip"] ||
    (Array.isArray(forwarded) ? forwarded[0] : forwarded || "")
  ).split(",")[0].trim();

  if (!ip) {
    throw new HttpError(
      503,
      "We couldn't identify this visitor. Please try again later."
    );
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  const ipHash = createHash("sha256")
    .update(ip)
    .digest("hex")
    .slice(0, 32);

  const key = `plainvest:daily:${day}:${ipHash}`;

  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );

  const ttl = Math.max(
    1,
    Math.ceil((nextMidnight - now.getTime()) / 1000)
  );

  const result = await redisCommand([
    "EVAL",
    RESERVE_DAILY_SCRIPT,
    "1",
    key,
    String(DAILY_ANALYSIS_LIMIT),
    String(ttl)
  ]);

  return {
    allowed: Number(result[0]) === 1,
    key
  };
}

async function releaseDailyAnalysis(key) {
  if (!key) return;

  await redisCommand([
    "EVAL",
    RELEASE_DAILY_SCRIPT,
    "1",
    key
  ]);
}

const UA = () => process.env.SEC_USER_AGENT;

const H = () => ({
  "User-Agent": UA(),
  Accept: "application/json"
});

const DAY = 864e5;
const MON = 30.44 * DAY;

const d = s => new Date(s).getTime();

const near = (a, b, tol) =>
  Math.abs(a - b) <= tol * DAY;

const rowsOf = (facts, concept) =>
  facts.facts?.["us-gaap"]?.[concept]?.units?.USD || [];

let tickerMap = null;
let tickerAt = 0;

async function lookup(ticker) {
  if (!tickerMap || Date.now() - tickerAt > DAY) {
    const response = await fetch(
      "https://www.sec.gov/files/company_tickers.json",
      { headers: H() }
    );

    if (!response.ok) {
      throw new HttpError(
        502,
        "Could not reach the SEC ticker list. Try again shortly."
      );
    }

    const data = await response.json();

    tickerMap = {};

    for (const company of Object.values(data)) {
      tickerMap[String(company.ticker).toUpperCase()] = company;
    }

    tickerAt = Date.now();
  }

  return tickerMap[ticker];
}

// Annual values, or balance-sheet values from 10-K and 10-Q.
function series(facts, concepts, instant = false, anyPeriod = false) {
  let best = [];

  for (const concept of concepts) {
    const rows = rowsOf(facts, concept);

    if (!rows.length) continue;

    const byEnd = new Map();

    for (const row of rows) {
      if (
        anyPeriod
          ? !["10-K", "10-Q"].includes(row.form)
          : row.form !== "10-K" || row.fp !== "FY"
      ) {
        continue;
      }

      if (instant) {
        if (row.start) continue;
      } else {
        if (!row.start) continue;

        const days = (d(row.end) - d(row.start)) / DAY;

        if (days < 340 || days > 390) continue;
      }

      const previous = byEnd.get(row.end);

      if (!previous || row.filed > previous.filed) {
        byEnd.set(row.end, row);
      }
    }

    const result = [...byEnd.values()].sort(
      (a, b) => b.end.localeCompare(a.end)
    );

    if (
      result.length &&
      (!best.length || result[0].end > best[0].end)
    ) {
      best = result;
    }
  }

  return best;
}

const money = value => {
  const amount = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (amount >= 1e9) {
    return `${sign}$${(amount / 1e9).toFixed(1)} billion`;
  }

  if (amount >= 1e6) {
    return `${sign}$${(amount / 1e6).toFixed(0)} million`;
  }

  return `${sign}$${Math.round(amount).toLocaleString("en-US")}`;
};

const pct = value => `${(Math.abs(value) * 100).toFixed(0)}%`;

// Convert year-to-date filing totals into individual quarters.
function quarters(facts, concepts) {
  let best = [];

  for (const concept of concepts) {
    const annual = series(facts, [concept]).slice(0, 4);

    if (!annual.length) continue;

    const rows = rowsOf(facts, concept).filter(
      row => row.form === "10-Q" && row.start
    );

    const years = annual.map(item => ({
      start: item.start,
      fy: item
    }));

    years.unshift({
      start: new Date(d(annual[0].end) + DAY)
        .toISOString()
        .slice(0, 10),
      fy: null
    });

    const output = [];

    for (const year of years) {
      const ytd = {};

      for (const row of rows) {
        if (!near(d(row.start), d(year.start), 10)) continue;

        const months = Math.round(
          (d(row.end) - d(row.start)) / MON
        );

        if (![3, 6, 9].includes(months)) continue;

        if (!ytd[months] || row.filed > ytd[months].filed) {
          ytd[months] = row;
        }
      }

      const q1 = ytd[3];
      const q2 = ytd[6];
      const q3 = ytd[9];

      if (q1) {
        output.push({ end: q1.end, val: q1.val });
      }

      if (q1 && q2) {
        output.push({
          end: q2.end,
          val: q2.val - q1.val
        });
      }

      if (q2 && q3) {
        output.push({
          end: q3.end,
          val: q3.val - q2.val
        });
      }

      if (q3 && year.fy) {
        output.push({
          end: year.fy.end,
          val: year.fy.val - q3.val
        });
      }
    }

    output.sort((a, b) => b.end.localeCompare(a.end));

    if (
      output.length &&
      (
        !best.length ||
        output[0].end > best[0].end ||
        (
          output[0].end === best[0].end &&
          output.length > best.length
        )
      )
    ) {
      best = output;
    }
  }

  return best.slice(0, 12);
}

const qAt = (list, end, offset = 0) =>
  list.find(q =>
    near(
      d(q.end),
      d(end) - offset * DAY,
      offset ? 12 : 7
    )
  )?.val;

const yAgo = (list, end) => qAt(list, end, 365);

function balance(facts) {
  const makeMap = concepts =>
    new Map(
      series(facts, concepts, true, true)
        .map(row => [row.end, row.val])
    );

  const liabilitiesEquity = makeMap([
    "LiabilitiesAndStockholdersEquity"
  ]);

  const liabilities = makeMap(["Liabilities"]);

  const equity = makeMap(["StockholdersEquity"]);

  const equityIncludingMinority = makeMap([
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]);

  const ends = [
    ...new Set([
      ...liabilitiesEquity.keys(),
      ...liabilities.keys()
    ])
  ].sort().reverse();

  const at = end => {
    let liab = liabilities.get(end);

    let eq =
      equity.get(end) ??
      equityIncludingMinority.get(end);

    const total = liabilitiesEquity.get(end);

    const totalEquity =
      equityIncludingMinority.get(end) ??
      equity.get(end);

    if (liab == null && total != null && totalEquity != null) {
      liab = total - totalEquity;
    }

    if (eq == null && total != null && liab != null) {
      eq = total - liab;
    }

    return { liab, eq };
  };

  return { ends, at };
}

function analyzeFacts(facts) {
  if (!facts.facts?.["us-gaap"]) return null;

  const revenue = quarters(facts, [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet"
  ]);

  if (revenue.length < 2) return null;

  const income = quarters(facts, [
    "NetIncomeLoss",
    "ProfitLoss"
  ]);

  const operatingCash = quarters(facts, [
    "NetCashProvidedByUsedInOperatingActivities"
  ]);

  const capex = quarters(facts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ]);

  const cashAt = (end, offset = 0) => {
    const operating = qAt(operatingCash, end, offset);

    if (operating == null) return null;

    return operating - (qAt(capex, end, offset) ?? 0);
  };

  const rows = revenue.slice(0, 4).map(q => {
    const profit = qAt(income, q.end);
    const previousYear = yAgo(revenue, q.end);

    return {
      end: q.end,
      sales: q.val,
      salesYoY: previousYear > 0
        ? q.val / previousYear - 1
        : null,
      profit: profit ?? null,
      margin: profit != null && q.val
        ? profit / q.val
        : null,
      cash: cashAt(q.end)
    };
  });

  const now = rows[0];
  const previous = rows[1];

  const profitPreviousYear = yAgo(income, now.end);
  const revenuePreviousYear = yAgo(revenue, now.end);
  const cashPreviousYear = cashAt(now.end, 365);

  const marginPreviousYear =
    profitPreviousYear != null && revenuePreviousYear
      ? profitPreviousYear / revenuePreviousYear
      : null;

  const previousGrowth = previous?.salesYoY;

  const bal = balance(facts);
  const balanceDate = bal.ends[0];
  const currentBalance = balanceDate
    ? bal.at(balanceDate)
    : {};

  const ratio = value =>
    value.liab != null && value.eq > 0
      ? value.liab / value.eq
      : null;

  const previousBalanceDate = bal.ends.find(end =>
    near(d(end), d(balanceDate) - 365 * DAY, 12)
  );

  const currentRatio = ratio(currentBalance);

  const previousRatio = previousBalanceDate
    ? ratio(bal.at(previousBalanceDate))
    : null;

  const signals = [];

  const signal = (kind, title, text) =>
    signals.push({ kind, title, text });

  if (now.salesYoY != null && previousGrowth != null) {
    const difference = now.salesYoY - previousGrowth;

    if (difference >= 0.05) {
      signal(
        "positive",
        "Sales growth is speeding up",
        `Year-over-year sales growth rose from ${pct(previousGrowth)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    } else if (difference <= -0.05) {
      signal(
        "negative",
        "Sales growth is slowing",
        `Year-over-year sales growth dropped from ${pct(previousGrowth)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    }
  }

  if (now.salesYoY != null && now.salesYoY <= -0.05) {
    signal(
      "negative",
      "Sales are shrinking",
      `Sales were down about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (now.salesYoY != null && now.salesYoY >= 0.2) {
    signal(
      "positive",
      "Fast growth",
      `Sales were up about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (
    profitPreviousYear != null &&
    now.profit != null &&
    profitPreviousYear < 0 &&
    now.profit >= 0
  ) {
    signal(
      "positive",
      "Swung to a profit",
      "It lost money in the same quarter a year ago, but made a profit in the latest quarter."
    );
  } else if (
    profitPreviousYear != null &&
    now.profit != null &&
    profitPreviousYear >= 0 &&
    now.profit < 0
  ) {
    signal(
      "negative",
      "Swung to a loss",
      "It made a profit in the same quarter a year ago, but lost money in the latest quarter."
    );
  } else if (
    now.margin != null &&
    marginPreviousYear != null
  ) {
    const difference = now.margin - marginPreviousYear;

    if (difference >= 0.03) {
      signal(
        "positive",
        "Profit margin improved",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, up from ${(marginPreviousYear * 100).toFixed(0)}% a year earlier.`
      );
    } else if (difference <= -0.03) {
      signal(
        "negative",
        "Profit margin shrank",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, down from ${(marginPreviousYear * 100).toFixed(0)}% a year earlier.`
      );
    }
  }

  if (now.cash != null && cashPreviousYear != null) {
    if (now.cash > 0 && cashPreviousYear <= 0) {
      signal(
        "positive",
        "Cash flow turned positive",
        "It used cash in the same quarter a year ago, but brought in cash in the latest quarter."
      );
    } else if (now.cash < 0 && cashPreviousYear >= 0) {
      signal(
        "negative",
        "Now burning cash",
        "It brought in cash in the same quarter a year ago, but used up cash in the latest quarter."
      );
    }
  }

  if (currentRatio != null && previousRatio != null) {
    if (currentRatio - previousRatio >= 0.5) {
      signal(
        "negative",
        "Debt load is rising",
        `It owes about $${currentRatio.toFixed(1)} per $1 of owners' stake, up from $${previousRatio.toFixed(1)} a year earlier.`
      );
    } else if (previousRatio - currentRatio >= 0.5) {
      signal(
        "positive",
        "Debt load is falling",
        `It owes about $${currentRatio.toFixed(1)} per $1 of owners' stake, down from $${previousRatio.toFixed(1)} a year earlier.`
      );
    }
  }

  const notAvailable = (title, jargon) => ({
    title,
    jargon,
    status: "na",
    text: "The filings don't report this in a standard way, so we can't check it."
  });

  const checks = [];

  if (now.margin == null) {
    checks.push(notAvailable("Profit", "Net profit margin"));
  } else {
    checks.push({
      title: "Profit",
      jargon: "Net profit margin",
      status: now.margin >= 0.10
        ? "good"
        : now.margin >= 0.03
          ? "warn"
          : "bad",
      text: now.margin >= 0
        ? `Of every $100 it sold in the latest quarter, it kept about $${(now.margin * 100).toFixed(0)} as profit after all costs.`
        : `In the latest quarter, it lost about $${(-now.margin * 100).toFixed(0)} for every $100 it sold.`
    });
  }

  if (currentBalance.liab == null || currentBalance.eq == null) {
    checks.push(notAvailable("Debt", "Total liabilities to equity"));
  } else if (currentBalance.eq <= 0) {
    checks.push({
      title: "Debt",
      jargon: "Total liabilities to equity",
      status: "bad",
      text: "It owes more than it owns, so shareholders' stake is zero or negative."
    });
  } else {
    checks.push({
      title: "Debt",
      jargon: "Total liabilities to equity",
      status: currentRatio <= 1
        ? "good"
        : currentRatio <= 2.5
          ? "warn"
          : "bad",
      text: `As of ${balanceDate}, it owed about $${currentRatio.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.`
    });
  }

  if (now.salesYoY == null) {
    checks.push(notAvailable("Growth", "Revenue growth"));
  } else {
    checks.push({
      title: "Growth",
      jargon: "Revenue growth (year over year)",
      status: now.salesYoY >= 0.08
        ? "good"
        : now.salesYoY >= 0
          ? "warn"
          : "bad",
      text: `Sales in the latest quarter ${now.salesYoY >= 0 ? "were up" : "were down"} about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    });
  }

  if (now.cash == null) {
    checks.push(notAvailable("Cash", "Free cash flow"));
  } else {
    checks.push({
      title: "Cash",
      jargon: "Free cash flow",
      status: now.cash > 0 && now.cash / now.sales >= 0.05
        ? "good"
        : now.cash > 0
          ? "warn"
          : "bad",
      text: now.cash > 0
        ? `In the latest quarter, after paying for equipment and buildings, it generated ${money(now.cash)} in cash.`
        : `In the latest quarter, after paying for equipment and buildings, it used up ${money(-now.cash)} in cash.`
    });
  }

  const status = title =>
    checks.find(check => check.title === title)?.status;

  const risks = [];

  if (status("Profit") === "bad") {
    risks.push("It isn't earning much or any profit on its sales right now.");
  }

  if (status("Debt") === "bad") {
    risks.push("High debt can become a burden if business slows or interest rates rise.");
  }

  if (status("Growth") === "bad") {
    risks.push("Shrinking sales can be a sign the business is losing customers.");
  }

  if (status("Cash") === "bad") {
    risks.push("It is spending more cash than it brings in, so it may need to borrow or sell new shares.");
  }

  if (!risks.length) {
    risks.push("Even healthy companies can be hurt by competition, new regulation, or an economic downturn.");
  }

  const summary =
    `In the quarter ending ${now.end}, it reported ${money(now.sales)} in sales` +
    (
      now.salesYoY != null
        ? `, ${now.salesYoY >= 0 ? "up" : "down"} ${pct(now.salesYoY)} from a year earlier`
        : ""
    ) +
    (
      now.profit != null
        ? `, and ${now.profit >= 0 ? `a profit of ${money(now.profit)}` : `a loss of ${money(-now.profit)}`}`
        : ""
    ) +
    ". " +
    (
      signals.length
        ? `The main changes were: ${signals.slice(0, 3).map(s => `${s.title.toLowerCase()} — ${s.text}`).join(" ")}`
        : "There were no major changes in the tracked figures compared with the same period a year earlier."
    );

  return {
    fiscalYearEnd: now.end,
    periodLabel: `Latest quarter ended ${now.end}`,
    balanceSheetDate: balanceDate ?? null,
    quarters: rows,
    signals,
    checks,
    risks,
    summary
  };
}

// Recent company announcements from SEC 8-K filings.
const ITEMS = {
  "1.02": ["negative", "A major agreement ended"],
  "1.03": ["negative", "Bankruptcy filing"],
  "1.05": ["negative", "Cybersecurity incident reported"],
  "2.04": ["negative", "Debt payments sped up"],
  "2.06": ["negative", "Large asset write-down"],
  "3.01": ["negative", "Stock exchange delisting notice"],
  "4.02": ["negative", "Past financial statements may need correcting"],
  "2.05": ["watch", "Restructuring or layoffs announced"],
  "3.02": ["watch", "New shares sold, which can dilute owners"],
  "4.01": ["watch", "Change of auditor"],
  "2.03": ["watch", "New debt or financial obligation taken on"],
  "1.01": ["event", "New major agreement signed"],
  "2.01": ["event", "Company bought or sold a business"],
  "5.01": ["event", "Change in company control"],
  "5.02": ["event", "Executive or director change"]
};

function eventsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;

  if (!recent?.form) return [];

  const rank = { negative: 0, watch: 1, event: 2 };
  const cutoff = Date.now() - 365 * DAY;
  const output = [];

  for (let i = 0; i < recent.form.length; i++) {
    if (
      !String(recent.form[i]).startsWith("8-K") ||
      d(recent.filingDate[i]) < cutoff
    ) {
      continue;
    }

    const hit = String(recent.items?.[i] || "")
      .split(",")
      .map(value => value.trim())
      .filter(value => ITEMS[value])
      .sort((a, b) => rank[ITEMS[a][0]] - rank[ITEMS[b][0]])[0];

    if (!hit) continue;

    const accession = String(recent.accessionNumber[i])
      .replace(/-/g, "");

    const document = recent.primaryDocument?.[i];

    output.push({
      date: recent.filingDate[i],
      kind: ITEMS[hit][0],
      title: ITEMS[hit][1],
      url: document
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${document}`
        : null
    });
  }

  return output
    .sort((a, b) =>
      rank[a.kind] - rank[b.kind] ||
      b.date.localeCompare(a.date)
    )
    .slice(0, 6);
}

// Optional Gemini explanations based on the SEC data supplied to the model.
async function aiWrite(name, out) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    console.warn("GEMINI_API_KEY is not configured; using SEC-based explanations.");
    return null;
  }

  try {
    const formatMoney = value =>
      value == null ? "n/a" : money(value);

    const quarterText = out.quarters.map(q =>
      `Quarter ending ${q.end}: sales ${formatMoney(q.sales)}, ` +
      `year-over-year change ${
        q.salesYoY == null
          ? "n/a"
          : (q.salesYoY * 100).toFixed(0) + "%"
      }, profit ${formatMoney(q.profit)}, cash ${formatMoney(q.cash)}`
    ).join("\n");

    const signalText = out.signals
      .map(s => `${s.kind}: ${s.title}. ${s.text}`)
      .join("\n") || "none";

    const eventInputs = (out.events || []).map((event, index) => ({
      index,
      date: event.date || "Unknown date",
      title: event.title || "Untitled filing",
      category: event.kind || "event",
      filingDetails: event.details || null
    }));

    const prompt = `You are Plainvest, a careful financial explainer for beginners.

Use ONLY the company data supplied below. Do not use outside knowledge or guess why something happened.

Return valid JSON only with this shape:
{
  "summary": "4 to 6 plain-English sentences",
  "risks": ["2 or 3 short risks tied to supplied data"],
  "eventAnalyses": [
    {
      "index": 0,
      "whatHappened": "...",
      "whyItMatters": "...",
      "potentialImpact": "...",
      "uncertainty": "..."
    }
  ]
}

SUMMARY RULES:
- Start with the latest quarter's sales and year-over-year change, and profit/loss if available.
- Explain the most important changes in the numbers, using actual comparisons and figures supplied.
- Explain why each change could matter.
- Mention both positive and negative changes when both exist.
- If the data does not establish a cause, explicitly say it does not tell us why.
- Do not give buy/sell advice or price predictions.
- Keep wording natural and understandable to a Grade 9 student.
- Avoid jargon unless explained.

EVENT ANALYSIS RULES:
- Return one eventAnalyses entry for every supplied announcement, preserving its index.
- Explain what the filing says in plain English.
- Explain why an investor or the company might care, using only supplied details.
- Describe plausible business implications, not a prediction of stock price.
- State what is unknown or uncertain.
- Do not invent amounts, causes, consequences, or facts.
- If filing details are missing, say so.
- Keep each field concise and beginner-friendly.
- If there are no announcements, return an empty eventAnalyses array.

COMPANY: ${name}

QUARTERS (newest first):
${quarterText}

CHANGES IN THE NUMBERS:
${signalText}

RECENT COMPANY ANNOUNCEMENTS:
${JSON.stringify(eventInputs)}`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt }] }
          ],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        "Gemini API error:",
        response.status,
        errorText
      );

      // Gemini is optional: preserve the SEC-based analysis if it fails.
      return null;
    }

    const data = await response.json();

    const raw = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!raw) {
      console.error(
        "Gemini returned no text.",
        JSON.stringify(data).slice(0, 1000)
      );

      return null;
    }

    const result = JSON.parse(raw);

    if (
      typeof result.summary !== "string" ||
      !Array.isArray(result.risks)
    ) {
      console.error("Gemini returned an unexpected response format.");
      return null;
    }

    const analyses = new Map(
      (Array.isArray(result.eventAnalyses) ? result.eventAnalyses : [])
        .filter(item => Number.isInteger(item.index))
        .map(item => [item.index, item])
    );

    const events = (out.events || []).map((event, index) => {
      const analysis = analyses.get(index);

      return {
        ...event,
        explanation: analysis
          ? {
              whatHappened: String(
                analysis.whatHappened ||
                "The filing text does not provide enough information to explain this announcement."
              ),
              whyItMatters: String(
                analysis.whyItMatters ||
                "Its importance cannot be determined from the available filing details."
              ),
              potentialImpact: String(
                analysis.potentialImpact ||
                "The business impact is unclear from the available information."
              ),
              uncertainty: String(
                analysis.uncertainty ||
                "The available information does not establish the full implications."
              )
            }
          : null
      };
    });

    return {
      summary: result.summary,
      risks: result.risks.slice(0, 3).map(String),
      events
    };
  } catch (err) {
    console.error("Gemini aiWrite failed:", err.message || err);
    return null;
  }
}

const FOREIGN_MSG =
  "That looks like a stock listed on a non-US exchange (like Toronto, London, or Tokyo). Plainvest only covers US-listed companies for now. If the company also trades in the US, try its US ticker.";

const ETF_MSG =
  "That looks like an ETF or fund. ETFs don't have sales or profits the way companies do, so Plainvest can't analyze them yet.";

const FOREIGN =
  /^[A-Z0-9]{1,6}[.:](TO|V|NE|CN|L|T|HK|AX|NZ|SI|SW|PA|DE|F|MI|MC|AS|ST|OL|HE|CO|SS|SZ|KS|KQ|NS|BO|SA|MX|TW|JK|BK|KL|TA|IR)$|^(TSX|TSXV|TSE|LSE|LON|ASX|HKEX|SGX|FRA|EPA|NSE|BSE|TYO|SHA|SHE|KRX|BME|SWX|AMS)[:.]/;

const ETFS = new Set((
  "SPY QQQ VOO VTI IVV DIA IWM VT VEA VWO VXUS BND AGG GLD IAU SLV " +
  "XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC ARKK ARKG ARKW " +
  "SCHD SCHB SCHX SCHG VUG VTV VIG VYM VGT VHT VNQ IJH IJR IJK " +
  "MDY EFA IEFA IEMG EEM TLT IEF SHY HYG LQD JNK USO UNG SMH SOXX " +
  "SOXL TQQQ SQQQ UPRO SPXL SPXS TNA TZA IVW IVE IWF IWD IWB IWV " +
  "QQQM SPLG SPYG SPYV RSP QUAL USMV DGRO DVY SDY JEPI JEPQ BITO " +
  "IBIT FBTC GBTC ETHE XBI IBB KRE KBE XOP OIH GDX GDXJ ITB XHB " +
  "VXX UVXY"
).split(" "));

let fundSet = null;
let fundAt = 0;

async function isFund(ticker) {
  if (ETFS.has(ticker)) return true;

  try {
    if (!fundSet || Date.now() - fundAt > 7 * DAY) {
      const response = await fetch(
        "https://www.sec.gov/files/company_tickers_mf.json",
        { headers: H() }
      );

      if (!response.ok) return false;

      const data = await response.json();
      const index = data.fields?.indexOf("symbol");

      fundSet = new Set(
        index >= 0
          ? (data.data || []).map(row =>
              String(row[index]).toUpperCase()
            )
          : []
      );

      fundAt = Date.now();
    }

    return fundSet.has(ticker);
  } catch (err) {
    console.error("SEC fund lookup failed:", err.message);
    return false;
  }
}

async function addEventDetails(events) {
  return Promise.all((events || []).map(async event => {
    if (!event.url) {
      return { ...event, details: null };
    }

    try {
      const response = await fetch(event.url, {
        headers: {
          "User-Agent": UA(),
          Accept: "text/html, text/plain, application/xhtml+xml"
        }
      });

      if (!response.ok) {
        return { ...event, details: null };
      }

      const source = await response.text();

      const details = source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#(\d+);/g, (_, number) => {
          const code = Number(number);

          return code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : " ";
        })
        .replace(/&#x([\da-f]+);/gi, (_, number) => {
          const code = parseInt(number, 16);

          return code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : " ";
        })
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);

      return {
        ...event,
        details: details || null
      };
    } catch (err) {
      console.error("SEC filing detail error:", err.message);

      return { ...event, details: null };
    }
  }));
}

// IMPORTANT: Use CommonJS consistently throughout this file.
async function handler(req, res) {
  let dailyReservationKey = null;

  try {
    if (req.method && req.method !== "GET") {
      res.setHeader("Allow", "GET");

      throw new HttpError(
        405,
        "Method not allowed. Use GET /api/analyze?ticker=AAPL."
      );
    }

    if (!UA()) {
      throw new HttpError(
        500,
        "Server setup incomplete: SEC_USER_AGENT is missing. Add it in Vercel environment variables."
      );
    }

    const raw = String(req.query?.ticker || "")
      .trim()
      .toUpperCase();

    if (!raw) {
      throw new HttpError(
        400,
        "Enter a valid ticker, like AAPL."
      );
    }

    if (FOREIGN.test(raw)) {
      throw new HttpError(422, FOREIGN_MSG);
    }

    const ticker = raw.replace(".", "-");

    if (!/^[A-Z0-9-]{1,8}$/.test(ticker)) {
      throw new HttpError(
        400,
        "Enter a valid ticker, like AAPL."
      );
    }

    if (ETFS.has(ticker)) {
      throw new HttpError(422, ETF_MSG);
    }

    // Look up the ticker first.
    const company = await lookup(ticker);

    if (!company) {
      if (await isFund(ticker)) {
        throw new HttpError(422, ETF_MSG);
      }

      throw new HttpError(
        404,
        `No US-listed company found for ${ticker}. Plainvest covers US-listed companies only, so check the ticker. ETFs and non-US stocks aren't supported yet.`
      );
    }

    // Enforce the daily limit when Upstash is configured.
    const reservation = await reserveDailyAnalysis(req);

    if (!reservation.allowed) {
      res.setHeader("Cache-Control", "no-store");

      throw new HttpError(
        429,
        "You've reached today's limit of 3 company analyses. Your limit resets at midnight UTC."
      );
    }

    dailyReservationKey = reservation.key;

    const cik = String(company.cik_str).padStart(10, "0");

    const [factsResponse, submissionsResponse] = await Promise.all([
      fetch(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
        { headers: H() }
      ),
      fetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers: H() }
      ).catch(err => {
        console.error("SEC submissions request failed:", err.message);
        return null;
      })
    ]);

    let submissions = null;

    try {
      if (submissionsResponse?.ok) {
        submissions = await submissionsResponse.json();
      }
    } catch (err) {
      console.error("Could not read SEC submissions:", err.message);
    }

    const unsupportedCompanyError = () => {
      const forms = new Set(
        submissions?.filings?.recent?.form || []
      );

      if (forms.has("20-F") || forms.has("40-F")) {
        return new HttpError(
          422,
          `${company.title} is a foreign company that files different reports with the SEC (20-F or 40-F), which Plainvest can't read yet. Companies that file standard US reports, like AAPL, work.`
        );
      }

      if (/\b(ETF|FUND|INDEX|ISHARES|SPDR|PROSHARES)\b/i.test(company.title)) {
        return new HttpError(422, ETF_MSG);
      }

      return new HttpError(
        422,
        `${company.title} doesn't have enough quarterly reports in a format this version can read. This can happen with newly listed or unusual companies.`
      );
    };

    if (factsResponse.status === 404) {
      throw unsupportedCompanyError();
    }

    if (!factsResponse.ok) {
      console.error(
        "SEC company facts request failed:",
        factsResponse.status
      );

      throw new HttpError(
        502,
        "The SEC didn't respond successfully. Try again shortly."
      );
    }

    let facts;

    try {
      facts = await factsResponse.json();
    } catch {
      throw new HttpError(
        502,
        "The SEC returned invalid financial data. Please try again shortly."
      );
    }

    const output = analyzeFacts(facts);

    if (!output) {
      throw unsupportedCompanyError();
    }

    // Filing-detail failures do not stop the core financial analysis.
    output.events = await addEventDetails(
      eventsFrom(submissions, company.cik_str)
    );

    // Gemini is optional. If it fails, return the computed SEC analysis.
    const ai = await aiWrite(company.title, output);

    res.setHeader("Cache-Control", "no-store");

    // The request succeeded, so keep the daily reservation if enabled.
    dailyReservationKey = null;

    return res.status(200).json({
      ticker,
      name: company.title,
      ...output,
      ...(ai || {})
    });

  } catch (err) {
    if (dailyReservationKey) {
      try {
        await releaseDailyAnalysis(dailyReservationKey);
      } catch (releaseError) {
        console.error(
          "Could not release failed analysis reservation:",
          releaseError.message
        );
      }
    }

    const status =
      Number.isInteger(err.status) ? err.status : 500;

    const message =
      status === 500
        ? "Something went wrong while analyzing this company. Check the Vercel function logs for details."
        : err.message;

    console.error("Plainvest API error:", status, err.stack || err.message);

    res.setHeader("Cache-Control", "no-store");

    return res.status(status).json({
      error: message
    });
  }
}

module.exports = handler;
module.exports.analyzeFacts = analyzeFacts;
module.exports.eventsFrom = eventsFrom;
