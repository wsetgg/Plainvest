// GET /api/analyze?ticker=AAPL
// Quarter-by-quarter analysis from SEC EDGAR (10-Q / 10-K figures + 8-K announcements).
// Env vars: SEC_USER_AGENT, GEMINI_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.

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
      "The daily analysis limit is not configured yet. Please try again later."
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
      "The daily limit service is temporarily unavailable. Please try again later."
    );
  }

  if (!response.ok || data.error) {
    console.error("Daily limit storage request failed.");
    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable. Please try again later."
    );
  }

  return data.result;
}

async function reserveDailyAnalysis(req) {
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
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);
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
  await redisCommand(["EVAL", RELEASE_DAILY_SCRIPT, "1", key]);
}

const UA = () => process.env.SEC_USER_AGENT;
const H = () => ({
  "User-Agent": UA(),
  Accept: "application/json"
});

const DAY = 864e5;
const MON = 30.44 * DAY;

const d = s => new Date(s).getTime();
const near = (a, b, tol) => Math.abs(a - b) <= tol * DAY;

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

// Annual values, or balance-sheet values from 10-K and 10-Q when anyPeriod is true.
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

    const values = [...byEnd.values()].sort(
      (a, b) => b.end.localeCompare(a.end)
    );

    if (
      values.length &&
      (!best.length || values[0].end > best[0].end)
    ) {
      best = values;
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

// Convert year-to-date reporting into individual quarterly figures.
function quarters(facts, concepts) {
  let best = [];

  for (const concept of concepts) {
    const annual = series(facts, [concept]).slice(0, 4);
    if (!annual.length) continue;

    const rows = rowsOf(facts, concept).filter(
      row => row.form === "10-Q" && row.start
    );

    const years = annual.map(value => ({
      start: value.start,
      fy: value
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

      const [q1, q2, q3] = [ytd[3], ytd[6], ytd[9]];

      if (q1) output.push({ end: q1.end, val: q1.val });

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
      series(facts, concepts, true, true).map(row => [
        row.end,
        row.val
      ])
    );

  const liabilitiesAndEquity = makeMap([
    "LiabilitiesAndStockholdersEquity"
  ]);

  const liabilities = makeMap(["Liabilities"]);
  const equity = makeMap(["StockholdersEquity"]);

  const equityIncludingNoncontrolling = makeMap([
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]);

  const ends = [
    ...new Set([
      ...liabilitiesAndEquity.keys(),
      ...liabilities.keys()
    ])
  ].sort().reverse();

  const at = end => {
    let liab = liabilities.get(end);
    let eq =
      equity.get(end) ??
      equityIncludingNoncontrolling.get(end);

    const total = liabilitiesAndEquity.get(end);
    const totalEquity =
      equityIncludingNoncontrolling.get(end) ??
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

  const revenueQuarters = quarters(facts, [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet"
  ]);

  if (revenueQuarters.length < 2) return null;

  const incomeQuarters = quarters(facts, [
    "NetIncomeLoss",
    "ProfitLoss"
  ]);

  const operatingCashQuarters = quarters(facts, [
    "NetCashProvidedByUsedInOperatingActivities"
  ]);

  const capexQuarters = quarters(facts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ]);

  const cashAt = (end, offset = 0) => {
    const operatingCash = qAt(operatingCashQuarters, end, offset);

    return operatingCash == null
      ? null
      : operatingCash - (qAt(capexQuarters, end, offset) ?? 0);
  };

  // Return up to eight quarters for the chart and table.
  // The latest quarter remains rows[0], so the existing analysis uses the latest data.
  const rows = revenueQuarters.slice(0, 8).map(quarter => {
    const income = qAt(incomeQuarters, quarter.end);
    const yearAgo = yAgo(revenueQuarters, quarter.end);

    return {
      end: quarter.end,
      sales: quarter.val,
      salesYoY: yearAgo > 0 ? quarter.val / yearAgo - 1 : null,
      profit: income ?? null,
      margin:
        income != null && quarter.val
          ? income / quarter.val
          : null,
      cash: cashAt(quarter.end)
    };
  });

  const now = rows[0];
  const previous = rows[1];

  const incomeYearAgo = yAgo(incomeQuarters, now.end);
  const revenueYearAgo = yAgo(revenueQuarters, now.end);
  const cashYearAgo = cashAt(now.end, 365);

  const marginYearAgo =
    incomeYearAgo != null && revenueYearAgo
      ? incomeYearAgo / revenueYearAgo
      : null;

  const previousGrowth = previous?.salesYoY;

  const balanceSheet = balance(facts);
  const balanceSheetEnd = balanceSheet.ends[0];
  const balanceNow = balanceSheetEnd
    ? balanceSheet.at(balanceSheetEnd)
    : {};

  const debtRatio = value =>
    value.liab != null && value.eq > 0
      ? value.liab / value.eq
      : null;

  const previousBalanceSheetEnd = balanceSheet.ends.find(end =>
    near(d(end), d(balanceSheetEnd) - 365 * DAY, 12)
  );

  const ratioNow = debtRatio(balanceNow);
  const ratioYearAgo = previousBalanceSheetEnd
    ? debtRatio(balanceSheet.at(previousBalanceSheetEnd))
    : null;

  const signals = [];
  const addSignal = (kind, title, text) =>
    signals.push({ kind, title, text });

  if (now.salesYoY != null && previousGrowth != null) {
    const difference = now.salesYoY - previousGrowth;

    if (difference >= 0.05) {
      addSignal(
        "positive",
        "Sales growth is speeding up",
        `Year-over-year sales growth rose from ${pct(previousGrowth)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    } else if (difference <= -0.05) {
      addSignal(
        "negative",
        "Sales growth is slowing",
        `Year-over-year sales growth dropped from ${pct(previousGrowth)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    }
  }

  if (now.salesYoY != null && now.salesYoY <= -0.05) {
    addSignal(
      "negative",
      "Sales are shrinking",
      `Sales were down about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (now.salesYoY != null && now.salesYoY >= 0.2) {
    addSignal(
      "positive",
      "Fast growth",
      `Sales were up about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (
    incomeYearAgo != null &&
    now.profit != null &&
    incomeYearAgo < 0 &&
    now.profit >= 0
  ) {
    addSignal(
      "positive",
      "Swung to a profit",
      "It lost money in the same quarter a year ago, but made a profit in the latest quarter."
    );
  } else if (
    incomeYearAgo != null &&
    now.profit != null &&
    incomeYearAgo >= 0 &&
    now.profit < 0
  ) {
    addSignal(
      "negative",
      "Swung to a loss",
      "It made a profit in the same quarter a year ago, but lost money in the latest quarter."
    );
  } else if (now.margin != null && marginYearAgo != null) {
    const marginDifference = now.margin - marginYearAgo;

    if (marginDifference >= 0.03) {
      addSignal(
        "positive",
        "Profit margin improved",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, up from ${(marginYearAgo * 100).toFixed(0)}% a year earlier.`
      );
    } else if (marginDifference <= -0.03) {
      addSignal(
        "negative",
        "Profit margin shrank",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, down from ${(marginYearAgo * 100).toFixed(0)}% a year earlier.`
      );
    }
  }

  if (now.cash != null && cashYearAgo != null) {
    if (now.cash > 0 && cashYearAgo <= 0) {
      addSignal(
        "positive",
        "Cash flow turned positive",
        "It used cash in the same quarter a year ago, but brought in cash in the latest quarter."
      );
    } else if (now.cash < 0 && cashYearAgo >= 0) {
      addSignal(
        "negative",
        "Now burning cash",
        "It brought in cash in the same quarter a year ago, but used up cash in the latest quarter."
      );
    }
  }

  if (ratioNow != null && ratioYearAgo != null) {
    if (ratioNow - ratioYearAgo >= 0.5) {
      addSignal(
        "negative",
        "Debt load is rising",
        `It owes about $${ratioNow.toFixed(1)} per $1 of owners' stake, up from $${ratioYearAgo.toFixed(1)} a year earlier.`
      );
    } else if (ratioYearAgo - ratioNow >= 0.5) {
      addSignal(
        "positive",
        "Debt load is falling",
        `It owes about $${ratioNow.toFixed(1)} per $1 of owners' stake, down from $${ratioYearAgo.toFixed(1)} a year earlier.`
      );
    }
  }

  const unavailable = (title, jargon) => ({
    title,
    jargon,
    status: "na",
    text: "The filings don't report this in a standard way, so we can't check it."
  });

  const checks = [];

  if (now.margin == null) {
    checks.push(unavailable("Profit", "Net profit margin"));
  } else {
    checks.push({
      title: "Profit",
      jargon: "Net profit margin",
      status:
        now.margin >= 0.10
          ? "good"
          : now.margin >= 0.03
            ? "warn"
            : "bad",
      text:
        now.margin >= 0
          ? `Of every $100 it sold in the latest quarter, it kept about $${(now.margin * 100).toFixed(0)} as profit after all costs.`
          : `In the latest quarter, it lost about $${(-now.margin * 100).toFixed(0)} for every $100 it sold.`
    });
  }

  if (balanceNow.liab == null || balanceNow.eq == null) {
    checks.push(unavailable("Debt", "Total liabilities to equity"));
  } else if (balanceNow.eq <= 0) {
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
      status:
        ratioNow <= 1
          ? "good"
          : ratioNow <= 2.5
            ? "warn"
            : "bad",
      text: `As of ${balanceSheetEnd}, it owed about $${ratioNow.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.`
    });
  }

  if (now.salesYoY == null) {
    checks.push(unavailable("Growth", "Revenue growth"));
  } else {
    checks.push({
      title: "Growth",
      jargon: "Revenue growth (year over year)",
      status:
        now.salesYoY >= 0.08
          ? "good"
          : now.salesYoY >= 0
            ? "warn"
            : "bad",
      text: `Sales in the latest quarter ${now.salesYoY >= 0 ? "were up" : "were down"} about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    });
  }

  if (now.cash == null) {
    checks.push(unavailable("Cash", "Free cash flow"));
  } else {
    checks.push({
      title: "Cash",
      jargon: "Free cash flow",
      status:
        now.cash > 0 && now.cash / now.sales >= 0.05
          ? "good"
          : now.cash > 0
            ? "warn"
            : "bad",
      text:
        now.cash > 0
          ? `In the latest quarter, after paying for equipment and buildings, it generated ${money(now.cash)} in cash.`
          : `In the latest quarter, after paying for equipment and buildings, it used up ${money(-now.cash)} in cash.`
    });
  }

  const statusFor = title =>
    checks.find(check => check.title === title)?.status;

  const risks = [];

  if (statusFor("Profit") === "bad") {
    risks.push("It isn't earning much or any profit on its sales right now.");
  }

  if (statusFor("Debt") === "bad") {
    risks.push("High debt can become a burden if business slows or interest rates rise.");
  }

  if (statusFor("Growth") === "bad") {
    risks.push("Shrinking sales can be a sign the business is losing customers.");
  }

  if (statusFor("Cash") === "bad") {
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
        ? `The main changes were: ${signals.slice(0, 3).map(signal => `${signal.title.toLowerCase()} — ${signal.text}`).join(" ")}`
        : "There were no major changes in the tracked figures compared with the same period a year earlier."
    );

  return {
    fiscalYearEnd: now.end,
    periodLabel: `Latest quarter ended ${now.end}`,
    balanceSheetDate: balanceSheetEnd ?? null,
    quarters: rows,
    signals,
    checks,
    risks,
    summary
  };
}

// Recent company announcements (8-K filings), translated from SEC item codes.
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

    const accession = String(recent.accessionNumber[i]).replace(/-/g, "");
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

// Optional: have Gemini explain the computed numbers and listed events only.
async function aiWrite(name, out) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const formatMoney = value =>
      value == null ? "n/a" : money(value);

    const quarterData = out.quarters.map(quarter =>
      `Quarter ending ${quarter.end}: sales ${formatMoney(quarter.sales)}, vs year ago ${
        quarter.salesYoY == null
          ? "n/a"
          : (quarter.salesYoY * 100).toFixed(0) + "%"
      }, profit ${formatMoney(quarter.profit)}, cash ${formatMoney(quarter.cash)}`
    ).join("\n");

    const signalData = out.signals
      .map(signal => `${signal.kind}: ${signal.title}. ${signal.text}`)
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
Return valid JSON only, with exactly this shape:
{"summary":"4 to 6 plain-English sentences","risks":["2 or 3 short risks tied to supplied data"],"eventAnalyses":[{"index":0,"whatHappened":"...","whyItMatters":"...","potentialImpact":"...","uncertainty":"..."}]}

SUMMARY RULES:
- Start with the latest quarter's sales and year-over-year change, and profit/loss if available.
- Explain the most important changes in the CHANGES IN THE NUMBERS section, using actual comparisons and figures supplied.
- Explain in simple terms why each change could matter. Mention both positive and negative changes when both exist.
- If the data does not establish a cause, explicitly say it does not tell us why.
- Do not call a company healthy or unhealthy based on one metric alone. Do not give buy/sell advice or price predictions.
- Keep wording natural and understandable to a Grade 9 student. Avoid jargon unless explained.

EVENT ANALYSIS RULES:
- Return exactly one eventAnalyses entry for every supplied announcement, preserving its index.
- whatHappened: explain what the filing says in plain English; do not merely repeat the title.
- whyItMatters: explain why an investor or the company might care, based only on the supplied filing.
- potentialImpact: describe plausible business implications, not a prediction of the stock price.
- uncertainty: state what is not known or what the filing text does not establish. If details are missing, say so clearly.
- Do not invent amounts, causes, consequences, or facts. A filing category/title alone is not enough to claim specifics.
- If filing details are unavailable or insufficient, be transparent rather than guessing.
- Keep each field concise (usually 1–2 sentences) and beginner-friendly.
- If there are no announcements, return an empty eventAnalyses array.

COMPANY: ${name}

QUARTERS (newest first):
${quarterData}

CHANGES IN THE NUMBERS (calculated from SEC filings):
${signalData}

RECENT COMPANY ANNOUNCEMENTS (filing text may be incomplete):
${JSON.stringify(eventInputs)}`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.risks)
    ) {
      return null;
    }

    const analyses = new Map(
      (Array.isArray(parsed.eventAnalyses) ? parsed.eventAnalyses : [])
        .filter(analysis => Number.isInteger(analysis.index))
        .map(analysis => [analysis.index, analysis])
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
      summary: parsed.summary,
      risks: parsed.risks.slice(0, 3).map(String),
      events
    };
  } catch (err) {
    console.error("Gemini aiWrite failed:", err);
    return null;
  }
}

const FOREIGN_MSG =
  "That looks like a stock listed on a non-US exchange (like Toronto, London, or Tokyo). Plainvest only covers US-listed companies for now. If the company also trades in the US, try its US ticker.";

const ETF_MSG =
  "That looks like an ETF or fund. ETFs don't have sales or profits the way companies do, so Plainvest can't analyze them yet.";

// Tickers with an exchange suffix (SHOP.TO, BP.L, 7203.T) or prefix (TSX:SHOP).
const FOREIGN =
  /^[A-Z0-9]{1,6}[.:](TO|V|NE|CN|L|T|HK|AX|NZ|SI|SW|PA|DE|F|MI|MC|AS|ST|OL|HE|CO|SS|SZ|KS|KQ|NS|BO|SA|MX|TW|JK|BK|KL|TA|IR)$|^(TSX|TSXV|TSE|LSE|LON|ASX|HKEX|SGX|FRA|EPA|NSE|BSE|TYO|SHA|SHE|KRX|BME|SWX|AMS)[:.]/;

// Popular ETFs, plus the SEC's list of funds (checked below).
const ETFS = new Set((
  "SPY QQQ VOO VTI IVV DIA IWM VT VEA VWO VXUS BND AGG GLD IAU SLV XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC ARKK ARKG ARKW SCHD SCHB SCHX SCHG " +
  "VUG VTV VIG VYM VGT VHT VNQ IJH IJR IJK MDY EFA IEFA IEMG EEM TLT IEF SHY HYG LQD JNK USO UNG SMH SOXX SOXL TQQQ SQQQ UPRO SPXL SPXS TNA TZA IVW IVE IWF IWD IWB IWV " +
  "QQQM SPLG SPYG SPYV RSP QUAL USMV DGRO DVY SDY JEPI JEPQ BITO IBIT FBTC GBTC ETHE XBI IBB KRE KBE XOP OIH GDX GDXJ ITB XHB VXX UVXY"
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
          ? (data.data || []).map(row => String(row[index]).toUpperCase())
          : []
      );

      fundAt = Date.now();
    }

    return fundSet.has(ticker);
  } catch {
    return false;
  }
}

async function addEventDetails(events) {
  return Promise.all((events || []).map(async event => {
    if (!event.url) {
      return { ...event, details: null };
    }

    try {
      // Fetch the primary filing document directly.
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
        .replace(/&#(\d+);/g, (_, value) => {
          const code = Number(value);
          return code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : " ";
        })
        .replace(/&#x([\da-f]+);/gi, (_, value) => {
          const code = parseInt(value, 16);
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
        "Server setup incomplete: SEC_USER_AGENT is missing."
      );
    }

    const raw = String(req.query?.ticker || "")
      .trim()
      .toUpperCase();

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

    // Reserve one of the visitor's three daily analyses.
    const reservation = await reserveDailyAnalysis(req);

    if (!reservation.allowed) {
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
      ).catch(() => null)
    ]);

    let submissions = null;

    try {
      if (submissionsResponse && submissionsResponse.ok) {
        submissions = await submissionsResponse.json();
      }
    } catch {}

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
        `${company.title} doesn't have enough quarterly reports in a format this version can read (often newly listed or unusual companies).`
      );
    };

    if (factsResponse.status === 404) {
      throw unsupportedCompanyError();
    }

    if (!factsResponse.ok) {
      throw new HttpError(
        502,
        "The SEC didn't respond. Try again shortly."
      );
    }

    const out = analyzeFacts(await factsResponse.json());

    if (!out) {
      throw unsupportedCompanyError();
    }

    out.events = await addEventDetails(
      eventsFrom(submissions, company.cik_str)
    );

    const ai = await aiWrite(company.title, out);

    // Do not let Vercel cache an analysis response and bypass the daily counter.
    res.setHeader("Cache-Control", "no-store");

    // The analysis succeeded, so keep this reservation counted.
    dailyReservationKey = null;

    res.status(200).json({
      ticker,
      name: company.title,
      ...out,
      ...(ai || {})
    });
  } catch (err) {
    // Failed analyses do not consume the daily allowance.
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

    if (err.status === 429) {
      res.setHeader("Cache-Control", "no-store");
    }

    res.status(err.status || 500).json({
      error: err.status
        ? err.message
        : "Something went wrong. Try again."
    });
  }
}

module.exports = handler;
module.exports.analyzeFacts = analyzeFacts;
module.exports.eventsFrom = eventsFrom;
