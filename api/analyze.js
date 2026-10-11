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

// Latest value per fiscal year from 10-K filings. Picks the concept with the most recent data.
function series(facts, concepts, instant = false) {
  const g = facts.facts?.["us-gaap"] || {};
  let best = [];
  for (const c of concepts) {
    const rows = g[c]?.units?.USD;
    if (!rows) continue;
    const byEnd = new Map();
    for (const r of rows) {
      if (r.form !== "10-K" || r.fp !== "FY") continue;
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

function analyzeFacts(facts) {
  if (!facts.facts?.["us-gaap"]) return null;
  const rev = series(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]);
  if (!rev.length) return null;
  const end = rev[0].end;
  const ni = at(series(facts, ["NetIncomeLoss", "ProfitLoss"]), end);
  const liab = at(series(facts, ["Liabilities"], true), end);
  const eq = at(series(facts, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], true), end);
  const ocf = at(series(facts, ["NetCashProvidedByUsedInOperatingActivities"]), end);
  const capex = at(series(facts, ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]), end);
  const na = (title, jargon) => ({ title, jargon, status: "na", text: "The filings don't report this in a standard way, so we can't check it." });
  const checks = [];

  // 1. Profit
  if (ni == null) checks.push(na("Profit", "Net profit margin"));
  else {
    const m = ni / rev[0].val, per = Math.abs(m * 100).toFixed(0);
    checks.push({ title: "Profit", jargon: "Net profit margin", status: m >= 0.10 ? "good" : m >= 0.03 ? "warn" : "bad",
      text: m >= 0 ? `Of every $100 it sold, it kept about $${per} as profit after all costs.` : `It lost about $${per} for every $100 it sold.` });
  }
  // 2. Debt
  if (liab == null || eq == null) checks.push(na("Debt", "Total liabilities to equity"));
  else if (eq <= 0) checks.push({ title: "Debt", jargon: "Total liabilities to equity", status: "bad", text: "It owes more than it owns, so shareholders' stake is zero or negative." });
  else {
    const x = liab / eq;
    checks.push({ title: "Debt", jargon: "Total liabilities to equity", status: x <= 1 ? "good" : x <= 2.5 ? "warn" : "bad",
      text: `It owes about $${x.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.` });
  }
  // 3. Growth
  if (rev.length < 2) checks.push(na("Growth", "Revenue growth"));
  else {
    const g = rev[0].val / rev[1].val - 1;
    checks.push({ title: "Growth", jargon: "Revenue growth", status: g >= 0.08 ? "good" : g >= 0 ? "warn" : "bad",
      text: `Sales ${g >= 0 ? "grew" : "fell"} about ${Math.abs(g * 100).toFixed(0)}% over the last year, to ${money(rev[0].val)}.` });
  }
  // 4. Cash
  if (ocf == null) checks.push(na("Cash", "Free cash flow"));
  else {
    const f = ocf - (capex || 0), fm = f / rev[0].val;
    checks.push({ title: "Cash", jargon: "Free cash flow", status: f > 0 && fm >= 0.05 ? "good" : f > 0 ? "warn" : "bad",
      text: f > 0 ? `After paying for equipment and buildings, it generated ${money(f)} in cash.` : `After paying for equipment and buildings, it used up ${money(-f)} in cash.` });
  }

  const n = s => checks.filter(c => c.status === s).length;
  const risks = [];
  const st = t => checks.find(c => c.title === t)?.status;
  if (st("Profit") === "bad") risks.push("It isn't earning much or any profit on its sales yet.");
  if (st("Debt") === "bad") risks.push("High debt can become a burden if business slows or interest rates rise.");
  if (st("Growth") === "bad") risks.push("Shrinking sales can be a sign the business is losing customers.");
  if (st("Cash") === "bad") risks.push("It is spending more cash than it brings in, so it may need to borrow or sell new shares.");
  if (!risks.length) risks.push("Even healthy companies can be hurt by competition, new regulation, or an economic downturn.");
  return { fiscalYearEnd: end, revenue: rev[0].val, checks, risks,
    summary: `For the year ending ${end}, it reported ${money(rev[0].val)} in sales. ${n("good")} of 4 checks look good and ${n("bad")} raise concerns.` };
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
