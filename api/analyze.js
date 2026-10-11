// GET /api/analyze?ticker=AAPL
// Pulls annual (10-K) figures from SEC EDGAR and turns them into four beginner-friendly checks.
// Env vars: SEC_USER_AGENT (required, e.g. "Plainvest you@example.com"), ANTHROPIC_API_KEY (optional).

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const UA = () => process.env.SEC_USER_AGENT;
const H = () => ({ "User-Agent": UA(), Accept: "application/json" });
const DAY = 864e5;

let tickerMap = null, tickerAt = 0;
async function lookup(t) {
  if (!tickerMap || Date.now() - tickerAt > DAY) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: H() });
    if (!r.ok) throw new HttpError(502, "Could not reach the SEC ticker list. Try again shortly.");
    const j = await r.json();
    tickerMap = {};
    for (const e of Object.values(j)) tickerMap[String(e.ticker).toUpperCase()] = e;
    tickerAt = Date.now();
  }
  return tickerMap[t];
}

// Annual (10-K) values, or balance-sheet values from 10-K and 10-Q when anyPeriod is true.
function series(facts, concepts, instant = false, anyPeriod = false) {
  const g = facts.facts?.["us-gaap"] || {};
  let best = [];
  for (const c of concepts) {
    const rows = g[c]?.units?.USD;
    if (!rows) continue;
    const byEnd = new Map();
    for (const r of rows) {
      if (anyPeriod ? !["10-K", "10-Q"].includes(r.form) : (r.form !== "10-K" || r.fp !== "FY")) continue;
      if (instant) { if (r.start) continue; }
      else {
        if (!r.start) continue;
        const d = (new Date(r.end) - new Date(r.start)) / DAY;
        if (d < 340 || d > 390) continue;
      }
      const p = byEnd.get(r.end);
      if (!p || r.filed > p.filed) byEnd.set(r.end, r);
    }
    const s = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
    if (s.length && (!best.length || s[0].end > best[0].end)) best = s;
  }
  return best;
}
const at = (s, end) => s.find(r => r.end === end)?.val;
const money = v => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)} billion` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(0)} million` : `${s}$${Math.round(a).toLocaleString("en-US")}`;
};
const d = s => new Date(s).getTime();
const near = (a, b, tol) => Math.abs(a - b) <= tol * DAY;
const rowsOf = (facts, c) => facts.facts?.["us-gaap"]?.[c]?.units?.USD || [];

// Trailing 12 months = last full year + this year's quarters so far - the same quarters last year.
// If no newer quarterly data exists, falls back to the last full year.
function flow(facts, concepts) {
  let best = null;
  for (const c of concepts) {
    const ann = series(facts, [c]);
    if (!ann.length) continue;
    const fy = ann[0];
    const cur = rowsOf(facts, c)
      .filter(r => r.form === "10-Q" && r.start && near(d(r.start), d(fy.end) + DAY, 10) && d(r.end) > d(fy.end) + 30 * DAY)
      .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
    let cand = { ttm: fy.val, end: fy.end, fyEnd: fy.end, annual: fy.val, ann, ytd: null, prior: null, months: 12 };
    if (cur) {
      const prior = rowsOf(facts, c)
        .filter(r => r.form === "10-Q" && r.start && near(d(r.start), d(cur.start) - 365 * DAY, 12) && near(d(r.end), d(cur.end) - 365 * DAY, 12))
        .sort((a, b) => b.filed.localeCompare(a.filed))[0];
      if (prior) cand = { ttm: fy.val + cur.val - prior.val, end: cur.end, fyEnd: fy.end, annual: fy.val, ann,
        ytd: cur.val, prior: prior.val, months: Math.round((d(cur.end) - d(cur.start)) / (30.44 * DAY)) };
    }
    if (!best || cand.end > best.end) best = cand;
  }
  return best;
}
// Pair two figures that cover the same period (trailing 12 months, else the same full year).
function align(a, b) {
  if (!a || !b) return null;
  if (a.end === b.end) return { x: a.ttm, y: b.ttm };
  if (a.fyEnd === b.fyEnd) return { x: a.annual, y: b.annual };
  return null;
}

function analyzeFacts(facts) {
  if (!facts.facts?.["us-gaap"]) return null;
  const rev = flow(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]);
  if (!rev) return null;
  const ni = flow(facts, ["NetIncomeLoss", "ProfitLoss"]);
  const ocf = flow(facts, ["NetCashProvidedByUsedInOperatingActivities"]);
  const capex = flow(facts, ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]);

  // Balance sheet: the most recent quarter or year-end available.
  const bs = cs => series(facts, cs, true, true);
  const lseS = bs(["LiabilitiesAndStockholdersEquity"]), liabS = bs(["Liabilities"]);
  const bsEnd = lseS[0]?.end ?? liabS[0]?.end;
  const lse = at(lseS, bsEnd), eqParent = at(bs(["StockholdersEquity"]), bsEnd);
  const eqAll = at(bs(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]), bsEnd);
  let eq = eqParent ?? eqAll;
  let liab = at(liabS, bsEnd);
  // Many big companies (e.g. Amazon) don't report a total liabilities line, so work it out.
  if (liab == null && lse != null && (eqAll ?? eqParent) != null) liab = lse - (eqAll ?? eqParent);
  if (eq == null && lse != null && liab != null) eq = lse - liab;

  const na = (title, jargon) => ({ title, jargon, status: "na", text: "The filings don't report this in a standard way, so we can't check it." });
  const checks = [];

  // 1. Profit
  const p = align(ni, rev);
  if (!p || !p.y) checks.push(na("Profit", "Net profit margin"));
  else {
    const m = p.x / p.y, per = Math.abs(m * 100).toFixed(0);
    checks.push({ title: "Profit", jargon: "Net profit margin", status: m >= 0.10 ? "good" : m >= 0.03 ? "warn" : "bad",
      text: m >= 0 ? `Of every $100 it sold over the latest 12 months, it kept about $${per} as profit after all costs.` : `Over the latest 12 months, it lost about $${per} for every $100 it sold.` });
  }
  // 2. Debt
  if (liab == null || eq == null) checks.push(na("Debt", "Total liabilities to equity"));
  else if (eq <= 0) checks.push({ title: "Debt", jargon: "Total liabilities to equity", status: "bad", text: "It owes more than it owns, so shareholders' stake is zero or negative." });
  else {
    const x = liab / eq;
    checks.push({ title: "Debt", jargon: "Total liabilities to equity", status: x <= 1 ? "good" : x <= 2.5 ? "warn" : "bad",
      text: `As of ${bsEnd}, it owed about $${x.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.` });
  }
  // 3. Growth: this year's quarters so far vs the same quarters last year, else last full year vs the year before.
  let g = null, gText = "";
  if (rev.ytd != null && rev.prior > 0) {
    g = rev.ytd / rev.prior - 1;
    gText = `in the latest ${rev.months} months compared with the same months a year earlier`;
  } else if (rev.ann.length >= 2 && rev.ann[1].val > 0) {
    g = rev.ann[0].val / rev.ann[1].val - 1;
    gText = "over the last full year";
  }
  if (g == null) checks.push(na("Growth", "Revenue growth"));
  else checks.push({ title: "Growth", jargon: "Revenue growth", status: g >= 0.08 ? "good" : g >= 0 ? "warn" : "bad",
    text: `Sales ${g >= 0 ? "grew" : "fell"} about ${Math.abs(g * 100).toFixed(0)}% ${gText}.` });
  // 4. Cash
  const none = ocf ? { ttm: 0, annual: 0, end: ocf.end, fyEnd: ocf.fyEnd } : null;
  const c = align(ocf, capex || none);
  if (!c) checks.push(na("Cash", "Free cash flow"));
  else {
    const f = c.x - c.y, fm = rev.ttm ? f / rev.ttm : 0;
    checks.push({ title: "Cash", jargon: "Free cash flow", status: f > 0 && fm >= 0.05 ? "good" : f > 0 ? "warn" : "bad",
      text: f > 0 ? `Over the latest 12 months, after paying for equipment and buildings, it generated ${money(f)} in cash.` : `Over the latest 12 months, after paying for equipment and buildings, it used up ${money(-f)} in cash.` });
  }

  const n = s => checks.filter(x => x.status === s).length;
  const risks = [];
  const st = t => checks.find(x => x.title === t)?.status;
  if (st("Profit") === "bad") risks.push("It isn't earning much or any profit on its sales yet.");
  if (st("Debt") === "bad") risks.push("High debt can become a burden if business slows or interest rates rise.");
  if (st("Growth") === "bad") risks.push("Shrinking sales can be a sign the business is losing customers.");
  if (st("Cash") === "bad") risks.push("It is spending more cash than it brings in, so it may need to borrow or sell new shares.");
  if (!risks.length) risks.push("Even healthy companies can be hurt by competition, new regulation, or an economic downturn.");
  const isTtm = rev.end !== rev.fyEnd;
  return { fiscalYearEnd: rev.end, periodLabel: isTtm ? `12 months ending ${rev.end}` : `Year ending ${rev.end}`, balanceSheetDate: bsEnd,
    revenue: rev.ttm, checks, risks,
    summary: `In the ${isTtm ? "12 months" : "year"} ending ${rev.end}, it reported ${money(rev.ttm)} in sales. ${n("good")} of 4 checks look good and ${n("bad")} raise concerns.` };
}

// Optional: have Claude write the summary and risks from the computed numbers only.
async function aiWrite(name, out) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const figs = out.checks.map(c => `${c.title} (${c.jargon}): ${c.status}. ${c.text}`).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 500, messages: [{ role: "user", content:
        `You explain public companies to beginners. Using ONLY the figures below for ${name}, reply with JSON only: {"summary":"two plain-English sentences","risks":["2 or 3 short risks tied to the figures"]}. No investment advice, no buy or sell language, no outside facts.\n\n${figs}` }] })
    });
    const j = await r.json();
    const o = JSON.parse(j.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim());
    return typeof o.summary === "string" && Array.isArray(o.risks) ? { summary: o.summary, risks: o.risks.slice(0, 3).map(String) } : null;
  } catch { return null; }
}

async function handler(req, res) {
  try {
    if (!UA()) throw new HttpError(500, "Server setup incomplete: SEC_USER_AGENT is missing.");
    const t = String(req.query?.ticker || "").trim().toUpperCase().replace(".", "-");
    if (!/^[A-Z0-9-]{1,8}$/.test(t)) throw new HttpError(400, "Enter a valid ticker, like AAPL.");
    const e = await lookup(t);
    if (!e) throw new HttpError(404, `No US-listed company found for ${t}.`);
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(e.cik_str).padStart(10, "0")}.json`, { headers: H() });
    if (r.status === 404) throw new HttpError(422, `${e.title} doesn't have standard US annual filings to analyze.`);
    if (!r.ok) throw new HttpError(502, "The SEC didn't respond. Try again shortly.");
    const out = analyzeFacts(await r.json());
    if (!out) throw new HttpError(422, `${e.title} reports in a format this version can't analyze yet (often foreign companies).`);
    const ai = await aiWrite(e.title, out);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ ticker: t, name: e.title, ...out, ...(ai || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong. Try again." });
  }
}

module.exports = handler;
module.exports.analyzeFacts = analyzeFacts;
