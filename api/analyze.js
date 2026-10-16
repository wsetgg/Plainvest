
/*
 * Plainvest API
 * GET /api/analyze?ticker=AAPL
 *
 * Required Vercel environment variables:
 * SEC_USER_AGENT
 * UPSTASH_REDIS_REST_URL
 * UPSTASH_REDIS_REST_TOKEN
 *
 * Optional:
 * GEMINI_API_KEY
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UA = () => process.env.SEC_USER_AGENT;
const H = () => ({
  "User-Agent": UA(),
  Accept: "application/json"
});
const DAY = 86400000;
const DAILY_LIMIT = 3;

const d = value => new Date(value).getTime();
const near = (a, b, tolerance) =>
  Math.abs(a - b) <= tolerance * DAY;

const rowsOf = (facts, concept) =>
  facts.facts?.["us-gaap"]?.[concept]?.units?.USD || [];

/* ---------------- DAILY LIMIT ---------------- */

const RESERVE_SCRIPT = `
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

const RELEASE_SCRIPT = `
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

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      cache: "no-store"
    });
  } catch {
    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable. Please try again."
    );
  }

  if (!response.ok) {
    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable. Please try again."
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new HttpError(
      503,
      "The daily limit service is temporarily unavailable. Please try again."
    );
  }

  return data.result;
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );

  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

async function reserveDailyAnalysis(req) {
  const forwarded = String(
    req.headers?.["x-forwarded-for"] || ""
  ).split(",")[0].trim();

  const ip = String(
    req.headers?.["x-real-ip"] || forwarded || "unknown"
  );

  const crypto = await import("node:crypto");
  const ipHash = crypto
    .createHash("sha256")
    .update(ip)
    .digest("hex");

  const utcDay = new Date().toISOString().slice(0, 10);
  const key = `plainvest:daily:${utcDay}:${ipHash}`;
  const ttl = secondsUntilUtcMidnight();

  const result = await redisCommand([
    "EVAL",
    RESERVE_SCRIPT,
    "1",
    key,
    String(DAILY_LIMIT),
    String(ttl)
  ]);

  if (!Array.isArray(result) || Number(result[0]) !== 1) {
    throw new HttpError(
      429,
      "You've reached today's limit of 3 company analyses. Your limit resets at midnight UTC."
    );
  }

  return key;
}

async function releaseDailyAnalysis(key) {
  if (!key) return;

  try {
    await redisCommand([
      "EVAL",
      RELEASE_SCRIPT,
      "1",
      key
    ]);
  } catch (error) {
    console.error("Could not release daily analysis reservation:", error);
  }
}

/* ---------------- SEC COMPANY LOOKUP ---------------- */

let tickerMap = null;
let tickerAt = 0;

async function lookup(ticker) {
  if (!tickerMap || Date.now() - tickerAt > DAY) {
    const response = await fetch(
      "https://www.sec.gov/files/company_tickers.json",
      { headers: H(), cache: "no-store" }
    );

    if (!response.ok) {
      throw new HttpError(
        502,
        "Could not reach the SEC ticker list. Try again shortly."
      );
    }

    const data = await response.json();
    const nextMap = {};

    for (const entry of Object.values(data)) {
      nextMap[String(entry.ticker).toUpperCase()] = entry;
    }

    tickerMap = nextMap;
    tickerAt = Date.now();
  }

  return tickerMap[ticker];
}

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
      ) continue;

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

    const values = [...byEnd.values()]
      .sort((a, b) => b.end.localeCompare(a.end));

    if (
      values.length &&
      (!best.length || values[0].end > best[0].end)
    ) {
      best = values;
    }
  }

  return best;
}

function quarters(facts, concepts) {
  let best = [];

  for (const concept of concepts) {
    const annual = series(facts, [concept]).slice(0, 5);
    if (!annual.length) continue;

    const rows = rowsOf(facts, concept)
      .filter(row => row.form === "10-Q" && row.start);

    const years = annual.map(row => ({
      start: row.start,
      fiscalYear: row
    }));

    years.unshift({
      start: new Date(d(annual[0].end) + DAY)
        .toISOString()
        .slice(0, 10),
      fiscalYear: null
    });

    const output = [];

    for (const year of years) {
      const ytd = {};

      for (const row of rows) {
        if (!near(d(row.start), d(year.start), 10)) continue;

        const months = Math.round(
          (d(row.end) - d(row.start)) / (30.44 * DAY)
        );

        if (![3, 6, 9].includes(months)) continue;

        if (!ytd[months] || row.filed > ytd[months].filed) {
          ytd[months] = row;
        }
      }

      const q1 = ytd[3];
      const q2 = ytd[6];
      const q3 = ytd[9];

      if (q1) output.push({ end: q1.end, value: q1.val });
      if (q1 && q2) {
        output.push({ end: q2.end, value: q2.val - q1.val });
      }
      if (q2 && q3) {
        output.push({ end: q3.end, value: q3.val - q2.val });
      }
      if (q3 && year.fiscalYear) {
        output.push({
          end: year.fiscalYear.end,
          value: year.fiscalYear.val - q3.val
        });
      }
    }

    output.sort((a, b) => b.end.localeCompare(a.end));

    if (
      output.length &&
      (
        !best.length ||
        output[0].end > best[0].end ||
        (output[0].end === best[0].end &&
          output.length > best.length)
      )
    ) {
      best = output;
    }
  }

  return best.slice(0, 12);
}

function quarterValue(list, end, offset = 0) {
  return list.find(row =>
    near(
      d(row.end),
      d(end) - offset * DAY,
      offset ? 12 : 7
    )
  )?.value;
}

const yearAgo = (list, end) => quarterValue(list, end, 365);

function balance(facts) {
  const makeMap = concepts =>
    new Map(
      series(facts, concepts, true, true)
        .map(row => [row.end, row.val])
    );

  const liabilitiesAndEquity = makeMap([
    "LiabilitiesAndStockholdersEquity"
  ]);
  const liabilities = makeMap(["Liabilities"]);
  const equity = makeMap(["StockholdersEquity"]);
  const equityIncludingMinority = makeMap([
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]);

  const ends = [...new Set([
    ...liabilitiesAndEquity.keys(),
    ...liabilities.keys(),
    ...equity.keys(),
    ...equityIncludingMinority.keys()
  ])].sort().reverse();

  function at(end) {
    let totalLiabilities = liabilities.get(end);
    let totalEquity =
      equityIncludingMinority.get(end) ?? equity.get(end);

    const total = liabilitiesAndEquity.get(end);

    if (totalLiabilities == null && total != null && totalEquity != null) {
      totalLiabilities = total - totalEquity;
    }

    if (totalEquity == null && total != null && totalLiabilities != null) {
      totalEquity = total - totalLiabilities;
    }

    return { liabilities: totalLiabilities, equity: totalEquity };
  }

  return { ends, at };
}

const money = value => {
  if (value == null) return "n/a";

  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)} billion`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)} million`;

  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
};

const pct = value => `${(Math.abs(value) * 100).toFixed(0)}%`;

function analyzeFacts(facts) {
  if (!facts.facts?.["us-gaap"]) return null;

  const revenue = quarters(facts, [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet"
  ]);

  if (revenue.length < 2) return null;

  const netIncome = quarters(facts, ["NetIncomeLoss", "ProfitLoss"]);
  const operatingCash = quarters(facts, [
    "NetCashProvidedByUsedInOperatingActivities"
  ]);
  const capex = quarters(facts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ]);

  const cashAt = (end, offset = 0) => {
    const operating = quarterValue(operatingCash, end, offset);
    return operating == null
      ? null
      : operating - (quarterValue(capex, end, offset) ?? 0);
  };

  const quarterlyRows = revenue.slice(0, 4).map(row => {
    const profit = quarterValue(netIncome, row.end);
    const priorRevenue = yearAgo(revenue, row.end);

    return {
      end: row.end,
      sales: row.value,
      salesYoY: priorRevenue > 0
        ? row.value / priorRevenue - 1
        : null,
      profit: profit ?? null,
      margin: profit != null && row.value
        ? profit / row.value
        : null,
      cash: cashAt(row.end)
    };
  });

  const current = quarterlyRows[0];
  const previous = quarterlyRows[1];
  const priorProfit = yearAgo(netIncome, current.end);
  const priorRevenue = yearAgo(revenue, current.end);
  const priorCash = cashAt(current.end, 365);
  const priorMargin = priorProfit != null && priorRevenue
    ? priorProfit / priorRevenue
    : null;

  const sheet = balance(facts);
  const balanceDate = sheet.ends[0];
  const currentBalance = balanceDate ? sheet.at(balanceDate) : {};
  const priorBalanceDate = sheet.ends.find(end =>
    near(d(end), d(balanceDate) - 365 * DAY, 12)
  );
  const previousBalance = priorBalanceDate
    ? sheet.at(priorBalanceDate)
    : {};

  const debtRatio = value =>
    value.liabilities != null && value.equity > 0
      ? value.liabilities / value.equity
      : null;

  const currentDebtRatio = debtRatio(currentBalance);
  const previousDebtRatio = debtRatio(previousBalance);

  const signals = [];
  const signal = (kind, title, text) =>
    signals.push({ kind, title, text });

  if (current.salesYoY != null && previous.salesYoY != null) {
    const difference = current.salesYoY - previous.salesYoY;

    if (difference >= 0.05) {
      signal(
        "positive",
        "Sales growth is speeding up",
        `Year-over-year sales growth rose from ${pct(previous.salesYoY)} to ${pct(current.salesYoY)} in the latest quarter.`
      );
    } else if (difference <= -0.05) {
      signal(
        "negative",
        "Sales growth is slowing",
        `Year-over-year sales growth dropped from ${pct(previous.salesYoY)} to ${pct(current.salesYoY)} in the latest quarter.`
      );
    }
  }

  if (current.salesYoY != null && current.salesYoY <= -0.05) {
    signal(
      "negative",
      "Sales are shrinking",
      `Sales were down about ${pct(current.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (current.salesYoY != null && current.salesYoY >= 0.2) {
    signal(
      "positive",
      "Fast growth",
      `Sales were up about ${pct(current.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (priorProfit != null && current.profit != null) {
    if (priorProfit < 0 && current.profit >= 0) {
      signal(
        "positive",
        "Swung to a profit",
        "It lost money in the same quarter a year ago, but made a profit in the latest quarter."
      );
    } else if (priorProfit >= 0 && current.profit < 0) {
      signal(
        "negative",
        "Swung to a loss",
        "It made a profit in the same quarter a year ago, but lost money in the latest quarter."
      );
    } else if (current.margin != null && priorMargin != null) {
      const difference = current.margin - priorMargin;

      if (difference >= 0.03) {
        signal(
          "positive",
          "Profit margin improved",
          `It kept about ${(current.margin * 100).toFixed(0)}% of sales as profit, up from ${(priorMargin * 100).toFixed(0)}% a year earlier.`
        );
      } else if (difference <= -0.03) {
        signal(
          "negative",
          "Profit margin shrank",
          `It kept about ${(current.margin * 100).toFixed(0)}% of sales as profit, down from ${(priorMargin * 100).toFixed(0)}% a year earlier.`
        );
      }
    }
  }

  if (current.cash != null && priorCash != null) {
    if (current.cash > 0 && priorCash <= 0) {
      signal(
        "positive",
        "Cash flow turned positive",
        "It used cash in the same quarter a year ago, but brought in cash in the latest quarter."
      );
    } else if (current.cash < 0 && priorCash >= 0) {
      signal(
        "negative",
        "Now burning cash",
        "It brought in cash in the same quarter a year ago, but used up cash in the latest quarter."
      );
    }
  }

  if (currentDebtRatio != null && previousDebtRatio != null) {
    if (currentDebtRatio - previousDebtRatio >= 0.5) {
      signal(
        "negative",
        "Debt load is rising",
        `It owes about $${currentDebtRatio.toFixed(1)} per $1 of owners' stake, up from $${previousDebtRatio.toFixed(1)} a year earlier.`
      );
    } else if (previousDebtRatio - currentDebtRatio >= 0.5) {
      signal(
        "positive",
        "Debt load is falling",
        `It owes about $${currentDebtRatio.toFixed(1)} per $1 of owners' stake, down from $${previousDebtRatio.toFixed(1)} a year earlier.`
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

  if (current.margin == null) {
    checks.push(unavailable("Profit", "Net profit margin"));
  } else {
    checks.push({
      title: "Profit",
      jargon: "Net profit margin",
      status: current.margin >= 0.1
        ? "good"
        : current.margin >= 0.03 ? "warn" : "bad",
      text: current.margin >= 0
        ? `Of every $100 it sold in the latest quarter, it kept about $${(current.margin * 100).toFixed(0)} as profit after all costs.`
        : `In the latest quarter, it lost about $${(-current.margin * 100).toFixed(0)} for every $100 it sold.`
    });
  }

  const liabilities = currentBalance.liabilities;
  const equity = currentBalance.equity;

  if (liabilities == null || equity == null) {
    checks.push(unavailable("Debt", "Total liabilities to equity"));
  } else if (equity <= 0) {
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
      status: currentDebtRatio <= 1
        ? "good"
        : currentDebtRatio <= 2.5 ? "warn" : "bad",
      text: `As of ${balanceDate}, it owed about $${currentDebtRatio.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.`
    });
  }

  if (current.salesYoY == null) {
    checks.push(unavailable("Growth", "Revenue growth"));
  } else {
    checks.push({
      title: "Growth",
      jargon: "Revenue growth (year over year)",
      status: current.salesYoY >= 0.08
        ? "good"
        : current.salesYoY >= 0 ? "warn" : "bad",
      text: `Sales in the latest quarter ${current.salesYoY >= 0 ? "were up" : "were down"} about ${pct(current.salesYoY)} from the same quarter a year earlier.`
    });
  }

  if (current.cash == null) {
    checks.push(unavailable("Cash", "Free cash flow"));
  } else {
    checks.push({
      title: "Cash",
      jargon: "Free cash flow",
      status: current.cash > 0 && current.cash / current.sales >= 0.05
        ? "good"
        : current.cash > 0 ? "warn" : "bad",
      text: current.cash > 0
        ? `In the latest quarter, after paying for equipment and buildings, it generated ${money(current.cash)} in cash.`
        : `In the latest quarter, after paying for equipment and buildings, it used up ${money(-current.cash)} in cash.`
    });
  }

  const status = title => checks.find(item => item.title === title)?.status;
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
    `In the quarter ending ${current.end}, it reported ${money(current.sales)} in sales` +
    (current.salesYoY != null
      ? `, ${current.salesYoY >= 0 ? "up" : "down"} ${pct(current.salesYoY)} from a year earlier`
      : "") +
    (current.profit != null
      ? `, and ${current.profit >= 0 ? `a profit of ${money(current.profit)}` : `a loss of ${money(-current.profit)}`}`
      : "") +
    ". " +
    (
      signals.length
        ? `The main changes were: ${signals.slice(0, 3).map(item => `${item.title.toLowerCase()} — ${item.text}`).join(" ")}`
        : "There were no major changes in the tracked figures compared with the same period a year earlier."
    );

  return {
    fiscalYearEnd: current.end,
    periodLabel: `Latest quarter ended ${current.end}`,
    balanceSheetDate: balanceDate ?? null,
    quarters: quarterlyRows,
    signals,
    checks,
    risks,
    summary
  };
}

/* ---------------- ANNOUNCEMENTS ---------------- */

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
  "2.02": ["event", "Quarterly or annual financial results announced"],
  "5.01": ["event", "Change in company control"],
  "5.02": ["event", "Executive or director change"],
  "5.03": ["event", "Change to company governing documents"],
  "5.07": ["event", "Shareholders voted on company matters"],
  "7.01": ["event", "Company made a public disclosure"],
  "8.01": ["event", "Other important company update"]
};

function filingUrl(cik, accession, document) {
  if (!accession || !document) return null;

  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, "")}/${document}`;
}

function eventsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return [];

  const rank = { negative: 0, watch: 1, event: 2 };
  const cutoff = Date.now() - 90 * DAY;
  const output = [];

  for (let i = 0; i < recent.form.length; i++) {
    if (
      !String(recent.form[i]).startsWith("8-K") ||
      d(recent.filingDate[i]) < cutoff
    ) continue;

    const item = String(recent.items?.[i] || "")
      .split(",")
      .map(value => value.trim())
      .filter(value => ITEMS[value])
      .sort((a, b) => rank[ITEMS[a][0]] - rank[ITEMS[b][0]])[0];

    if (!item) continue;

    output.push({
      date: recent.filingDate[i],
      kind: ITEMS[item][0],
      title: ITEMS[item][1],
      url: filingUrl(cik, recent.accessionNumber[i], recent.primaryDocument?.[i])
    });
  }

  return output
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.date.localeCompare(a.date))
    .slice(0, 6);
}

function earningsReportsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return [];

  const reports = [];

  for (let i = 0; i < recent.form.length; i++) {
    const form = String(recent.form[i] || "");
    if (form !== "10-Q" && form !== "10-K") continue;

    const periodEnd = recent.reportDate?.[i];
    const filedDate = recent.filingDate?.[i];
    if (!periodEnd || !filedDate) continue;

    reports.push({
      form,
      type: form === "10-K" ? "Annual report" : "Quarterly report",
      periodEnd,
      filedDate,
      url: filingUrl(cik, recent.accessionNumber?.[i], recent.primaryDocument?.[i])
    });
  }

  return reports
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.filedDate.localeCompare(a.filedDate))
    .slice(0, 12);
}

function cleanFilingText(source, maxLength = 18000) {
  return String(source || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, value) => {
      const code = Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([\da-f]+);/gi, (_, value) => {
      const code = parseInt(value, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function companySourceFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return "";

  const indices = recent.form
    .map((form, i) => ({ form, i, filed: recent.filingDate?.[i] || "" }))
    .filter(item => item.form === "10-K" || item.form === "10-Q")
    .sort((a, b) =>
      (b.form === "10-K" ? 1 : 0) - (a.form === "10-K" ? 1 : 0) ||
      b.filed.localeCompare(a.filed)
    );

  for (const item of indices.slice(0, 3)) {
    const url = filingUrl(
      cik,
      recent.accessionNumber?.[item.i],
      recent.primaryDocument?.[item.i]
    );

    if (!url) continue;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": UA(),
          Accept: "text/html, text/plain, application/xhtml+xml"
        },
        cache: "no-store"
      });

      if (!response.ok) continue;

      const text = cleanFilingText(await response.text(), 500000);
      if (text.length <= 300) continue;

      const headings = [...text.matchAll(/\bitem\s+1\.?\s+business\b/gi)];

      if (headings.length) {
        const start = headings[headings.length - 1].index;
        const rest = text.slice(start);
        const end = /\bitem\s+(?:1a\.?\s+risk\s+factors|2\.?\s+properties)\b/i.exec(rest.slice(20));
        return (end ? rest.slice(0, end.index + 20) : rest).slice(0, 18000);
      }

      return text.slice(0, 18000);
    } catch (error) {
      console.error("SEC company description source error:", error.message);
    }
  }

  return "";
}

async function addEventDetails(events) {
  return Promise.all((events || []).map(async event => {
    if (!event.url) return { ...event, details: null };

    try {
      const response = await fetch(event.url, {
        headers: {
          "User-Agent": UA(),
          Accept: "text/html, text/plain, application/xhtml+xml"
        },
        cache: "no-store"
      });

      if (!response.ok) return { ...event, details: null };

      const details = cleanFilingText(await response.text(), 8000);
      return { ...event, details: details || null };
    } catch (error) {
      console.error("SEC filing detail error:", error.message);
      return { ...event, details: null };
    }
  }));
}

/* ---------------- GEMINI EXPLANATIONS ---------------- */

async function aiWrite(name, output, companySource = "", sicDescription = "") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const formatMoney = value => value == null ? "n/a" : money(value);

    const quarterText = output.quarters.map(row =>
      `Quarter ending ${row.end}: sales ${formatMoney(row.sales)}, year-over-year change ${
        row.salesYoY == null ? "n/a" : `${(row.salesYoY * 100).toFixed(0)}%`
      }, profit ${formatMoney(row.profit)}, cash ${formatMoney(row.cash)}`
    ).join("\n");

    const signalText = output.signals
      .map(item => `${item.kind}: ${item.title}. ${item.text}`)
      .join("\n") || "None";

    const eventInputs = (output.events || []).map((event, index) => ({
      index,
      date: event.date || "Unknown date",
      title: event.title || "Untitled filing",
      category: event.kind || "event",
      filingDetails: event.details || null
    }));

    const prompt = `You are Plainvest, a careful financial explainer for beginners.
Use ONLY the company data supplied below. Do not use outside knowledge or guess why something happened.
Return valid JSON only, with exactly this shape:
{"companyDescription":"2 to 4 plain-English sentences","summary":"4 to 6 plain-English sentences","risks":["2 or 3 short risks tied to supplied data"],"eventAnalyses":[{"index":0,"whatHappened":"...","whyItMatters":"...","potentialImpact":"...","uncertainty":"..."}]}

COMPANY DESCRIPTION RULES:
- Explain what the company sells or provides, who may buy/use it, and how it makes money, but only where the SEC source text supports those facts.
- Prefer the SEC business-description text below. The SIC description is a broad industry label, not proof of exact products or customers.
- If the source does not provide enough information, say it is not clear from the supplied SEC text.
- Keep it specific, natural, and understandable to a Grade 9 student.

SUMMARY RULES:
- Start with the latest quarter's sales and year-over-year change, and profit/loss if available.
- Explain important changes in the numbers using actual comparisons and figures supplied.
- Explain why each change could matter. Mention both positive and negative changes when both exist.
- If the data does not establish a cause, explicitly say it does not tell us why.
- Do not give buy/sell advice or price predictions.
- Keep wording natural and beginner-friendly.

EVENT ANALYSIS RULES:
- Return exactly one eventAnalyses entry for every supplied announcement, preserving its index.
- Explain what the filing says; do not merely repeat its title.
- Explain why an investor or company might care, based only on the supplied filing.
- Describe plausible business implications, not a stock-price prediction.
- Do not invent amounts, causes, consequences, or facts.
- If filing details are missing or insufficient, say so clearly.
- Keep each field concise and beginner-friendly.
- If there are no announcements, return an empty eventAnalyses array.

COMPANY: ${name}
SEC INDUSTRY LABEL (may be broad): ${sicDescription || "Not available"}
SEC BUSINESS-DESCRIPTION SOURCE:
${companySource || "Not available"}

QUARTERS (newest first):
${quarterText}

CHANGES IN THE NUMBERS:
${signalText}

RECENT COMPANY ANNOUNCEMENTS:
${JSON.stringify(eventInputs)}`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 6000
      }
    });

    let response;

    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key
          },
          body,
          cache: "no-store"
        }
      );

      if (response.ok) break;

      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);

      if (
        attempt === 0 &&
        [429, 500, 502, 503, 504].includes(response.status)
      ) {
        await new Promise(resolve => setTimeout(resolve, 700));
        continue;
      }

      return null;
    }

    if (!response?.ok) return null;

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!raw) return null;

    const cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    const parsed = JSON.parse(cleaned);

    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.risks)) {
      return null;
    }

    const analyses = new Map(
      (Array.isArray(parsed.eventAnalyses) ? parsed.eventAnalyses : [])
        .filter(item => Number.isInteger(item.index))
        .map(item => [item.index, item])
    );

    const events = (output.events || []).map((event, index) => {
      const analysis = analyses.get(index);

      return {
        ...event,
        explanation: analysis ? {
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
        } : null
      };
    });

    return {
      ...(typeof parsed.companyDescription === "string" &&
      parsed.companyDescription.trim()
        ? { companyDescription: parsed.companyDescription.trim() }
        : {}),
      summary: parsed.summary,
      risks: parsed.risks.slice(0, 3).map(String),
      events
    };
  } catch (error) {
    console.error("Gemini aiWrite failed:", error);
    return null;
  }
}

/* ---------------- ETF AND FOREIGN TICKER CHECKS ---------------- */

const FOREIGN_MSG =
  "That looks like a stock listed on a non-US exchange (like Toronto, London, or Tokyo). Plainvest only covers US-listed companies for now. If the company also trades in the US, try its US ticker.";

const ETF_MSG =
  "That looks like an ETF or fund. ETFs don't have sales or profits the way companies do, so Plainvest can't analyze them yet.";

const FOREIGN =
  /^[A-Z0-9]{1,6}[.:](TO|V|NE|CN|L|T|HK|AX|NZ|SI|SW|PA|DE|F|MI|MC|AS|ST|OL|HE|CO|SS|SZ|KS|KQ|NS|BO|SA|MX|TW|JK|BK|KL|TA|IR)$|^(TSX|TSXV|TSE|LSE|LON|ASX|HKEX|SGX|FRA|EPA|NSE|BSE|TYO|SHA|SHE|KRX|BME|SWX|AMS)[:.]/;

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
        { headers: H(), cache: "no-store" }
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

/* ---------------- API HANDLER ---------------- */

export default async function handler(req, res) {
  // Prevent browsers and Vercel from caching results or limit responses.
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Vary", "x-forwarded-for, x-real-ip");

  let reservationKey = null;

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

    const raw = String(req.query?.ticker || "").trim().toUpperCase();

    if (FOREIGN.test(raw)) {
      throw new HttpError(422, FOREIGN_MSG);
    }

    const ticker = raw.replace(".", "-");

    if (!/^[A-Z0-9-]{1,8}$/.test(ticker)) {
      throw new HttpError(400, "Enter a valid ticker, like AAPL.");
    }

    if (ETFS.has(ticker)) {
      throw new HttpError(422, ETF_MSG);
    }

    // Reserve a slot before doing the costly analysis.
    // Failed requests release this reservation in the catch block.
    reservationKey = await reserveDailyAnalysis(req);

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

    const cik = String(company.cik_str).padStart(10, "0");

    const [factsResponse, submissionsResponse] = await Promise.all([
      fetch(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
        { headers: H(), cache: "no-store" }
      ),
      fetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers: H(), cache: "no-store" }
      ).catch(() => null)
    ]);

    let submissions = null;

    try {
      if (submissionsResponse?.ok) {
        submissions = await submissionsResponse.json();
      }
    } catch {}

    const unsupportedCompany = () => {
      const forms = new Set(submissions?.filings?.recent?.form || []);

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

    if (factsResponse.status === 404) throw unsupportedCompany();

    if (!factsResponse.ok) {
      throw new HttpError(502, "The SEC didn't respond. Try again shortly.");
    }

    const output = analyzeFacts(await factsResponse.json());

    if (!output) throw unsupportedCompany();

    output.events = await addEventDetails(
      eventsFrom(submissions, company.cik_str)
    );

    output.earningsReports = earningsReportsFrom(
      submissions,
      company.cik_str
    );

    output.quarters = output.quarters.map(quarter => {
      const report = output.earningsReports.find(item =>
        near(d(item.periodEnd), d(quarter.end), 7)
      );

      return {
        ...quarter,
        periodLabel: `Quarter ended ${quarter.end}`,
        reportedDate: report?.filedDate || null,
        filingForm: report?.form || null,
        filingUrl: report?.url || null
      };
    });

    const companySource = await companySourceFrom(
      submissions,
      company.cik_str
    );

    const ai = await aiWrite(
      company.title,
      output,
      companySource,
      submissions?.sicDescription || ""
    );

    // Only a successful analysis consumes a daily slot.
    // Leave the Redis reservation in place until its UTC expiry.
    res.status(200).json({
      ticker,
      name: company.title,
      ...output,
      ...(ai || {})
    });

    reservationKey = null;
  } catch (error) {
    if (reservationKey) {
      await releaseDailyAnalysis(reservationKey);
      reservationKey = null;
    }

    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }

    console.error("Plainvest analysis failed:", error);
    res.status(500).json({
      error: "Something went wrong. Try again."
    });
  }
}

export { analyzeFacts, eventsFrom, earningsReportsFrom };
