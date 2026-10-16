
 // GET /api/analyze?ticker=AAPL
// Quarter-by-quarter analysis from SEC EDGAR (10-Q / 10-K figures + 8-K announcements).
// Env vars: SEC_USER_AGENT (required), GEMINI_API_KEY (optional).
process.traceDeprecation = true;

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const UA = () => process.env.SEC_USER_AGENT;
const H = () => ({ "User-Agent": UA(), Accept: "application/json" });
const DAY = 864e5;
const MON = 30.44 * DAY;
const d = s => new Date(s).getTime();
const near = (a, b, tol) => Math.abs(a - b) <= tol * DAY;
const rowsOf = (facts, c) => facts.facts?.["us-gaap"]?.[c]?.units?.USD || [];

let tickerMap = null;
let tickerAt = 0;

async function lookup(t) {
  if (!tickerMap || Date.now() - tickerAt > DAY) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: H()
    });

    if (!r.ok) {
      throw new HttpError(502, "Could not reach the SEC ticker list. Try again shortly.");
    }

    const j = await r.json();
    tickerMap = {};

    for (const e of Object.values(j)) {
      tickerMap[String(e.ticker).toUpperCase()] = e;
    }

    tickerAt = Date.now();
  }

  return tickerMap[t];
}

// Annual (10-K) values, or balance-sheet values from 10-K and 10-Q when anyPeriod is true.
function series(facts, concepts, instant = false, anyPeriod = false) {
  let best = [];

  for (const c of concepts) {
    const rows = rowsOf(facts, c);
    if (!rows.length) continue;

    const byEnd = new Map();

    for (const r of rows) {
      if (
        anyPeriod
          ? !["10-K", "10-Q"].includes(r.form)
          : (r.form !== "10-K" || r.fp !== "FY")
      ) {
        continue;
      }

      if (instant) {
        if (r.start) continue;
      } else {
        if (!r.start) continue;

        const days = (d(r.end) - d(r.start)) / DAY;
        if (days < 340 || days > 390) continue;
      }

      const p = byEnd.get(r.end);
      if (!p || r.filed > p.filed) byEnd.set(r.end, r);
    }

    const s = [...byEnd.values()].sort((a, b) =>
      b.end.localeCompare(a.end)
    );

    if (s.length && (!best.length || s[0].end > best[0].end)) {
      best = s;
    }
  }

  return best;
}

const money = v => {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";

  return a >= 1e9
    ? `${s}$${(a / 1e9).toFixed(1)} billion`
    : a >= 1e6
      ? `${s}$${(a / 1e6).toFixed(0)} million`
      : `${s}$${Math.round(a).toLocaleString("en-US")}`;
};

const pct = x => `${(Math.abs(x) * 100).toFixed(0)}%`;

// Single-quarter values. Filings report year-to-date totals (3, 6, 9 months)
// plus the full year, so Q1 = 3M, Q2 = 6M - 3M,
// Q3 = 9M - 6M, Q4 = full year - 9M. Newest first.
function quarters(facts, concepts) {
  let best = [];

  for (const c of concepts) {
    const ann = series(facts, [c]).slice(0, 4);
    if (!ann.length) continue;

    const rows = rowsOf(facts, c).filter(
      r => r.form === "10-Q" && r.start
    );

    const years = ann.map(a => ({ start: a.start, fy: a }));

    years.unshift({
      start: new Date(d(ann[0].end) + DAY).toISOString().slice(0, 10),
      fy: null
    });

    const out = [];

    for (const y of years) {
      const ytd = {};

      for (const r of rows) {
        if (!near(d(r.start), d(y.start), 10)) continue;

        const m = Math.round((d(r.end) - d(r.start)) / MON);
        if (![3, 6, 9].includes(m)) continue;

        if (!ytd[m] || r.filed > ytd[m].filed) {
          ytd[m] = r;
        }
      }

      const [q1, q2, q3] = [ytd[3], ytd[6], ytd[9]];

      if (q1) out.push({ end: q1.end, val: q1.val });
      if (q1 && q2) out.push({ end: q2.end, val: q2.val - q1.val });
      if (q2 && q3) out.push({ end: q3.end, val: q3.val - q2.val });
      if (q3 && y.fy) out.push({ end: y.fy.end, val: y.fy.val - q3.val });
    }

    out.sort((a, b) => b.end.localeCompare(a.end));

    if (
      out.length &&
      (
        !best.length ||
        out[0].end > best[0].end ||
        (out[0].end === best[0].end && out.length > best.length)
      )
    ) {
      best = out;
    }
  }

  return best.slice(0, 12);
}

const qAt = (list, end, off = 0) =>
  list.find(q => near(d(q.end), d(end) - off * DAY, off ? 12 : 7))?.val;

const yAgo = (list, end) => qAt(list, end, 365);

function balance(facts) {
  const m = cs =>
    new Map(series(facts, cs, true, true).map(r => [r.end, r.val]));

  const lse = m(["LiabilitiesAndStockholdersEquity"]);
  const li = m(["Liabilities"]);
  const ep = m(["StockholdersEquity"]);
  const ea = m([
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]);

  const ends = [...new Set([...lse.keys(), ...li.keys()])].sort().reverse();

  const at = end => {
    let liab = li.get(end);
    let eq = ep.get(end) ?? ea.get(end);

    const L = lse.get(end);
    const E = ea.get(end) ?? ep.get(end);

    if (liab == null && L != null && E != null) {
      liab = L - E;
    }

    if (eq == null && L != null && liab != null) {
      eq = L - liab;
    }

    return { liab, eq };
  };

  return { ends, at };
}

function analyzeFacts(facts) {
  if (!facts.facts?.["us-gaap"]) return null;

  const revQ = quarters(facts, [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet"
  ]);

  if (revQ.length < 2) return null;

  const niQ = quarters(facts, ["NetIncomeLoss", "ProfitLoss"]);

  const ocfQ = quarters(facts, [
    "NetCashProvidedByUsedInOperatingActivities"
  ]);

  const capQ = quarters(facts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ]);

  const cashAt = (end, off = 0) => {
    const o = qAt(ocfQ, end, off);
    return o == null ? null : o - (qAt(capQ, end, off) ?? 0);
  };

  // CHANGED: return up to eight quarters instead of four.
  const rows = revQ.slice(0, 8).map(q => {
    const ni = qAt(niQ, q.end);
    const ago = yAgo(revQ, q.end);

    return {
      end: q.end,
      sales: q.val,
      salesYoY: ago > 0 ? q.val / ago - 1 : null,
      profit: ni ?? null,
      margin: ni != null && q.val ? ni / q.val : null,
      cash: cashAt(q.end)
    };
  });

  const now = rows[0];
  const prev = rows[1];

  const niAgo = yAgo(niQ, now.end);
  const revAgo = yAgo(revQ, now.end);
  const cashAgo = cashAt(now.end, 365);

  const marginAgo = niAgo != null && revAgo ? niAgo / revAgo : null;
  const prevYoY = prev?.salesYoY;

  // Balance sheet: latest quarter, and the same quarter a year earlier.
  const bal = balance(facts);
  const bsEnd = bal.ends[0];
  const b = bsEnd ? bal.at(bsEnd) : {};

  const ratio = x =>
    (x.liab != null && x.eq > 0 ? x.liab / x.eq : null);

  const agoEnd = bal.ends.find(e =>
    near(d(e), d(bsEnd) - 365 * DAY, 12)
  );

  const ratioNow = ratio(b);
  const ratioAgo = agoEnd ? ratio(bal.at(agoEnd)) : null;

  // What changed in the numbers: good and bad shifts versus a year ago.
  const signals = [];
  const sig = (kind, title, text) =>
    signals.push({ kind, title, text });

  if (now.salesYoY != null && prevYoY != null) {
    const diff = now.salesYoY - prevYoY;

    if (diff >= 0.05) {
      sig(
        "positive",
        "Sales growth is speeding up",
        `Year-over-year sales growth rose from ${pct(prevYoY)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    } else if (diff <= -0.05) {
      sig(
        "negative",
        "Sales growth is slowing",
        `Year-over-year sales growth dropped from ${pct(prevYoY)} to ${pct(now.salesYoY)} in the latest quarter.`
      );
    }
  }

  if (now.salesYoY != null && now.salesYoY <= -0.05) {
    sig(
      "negative",
      "Sales are shrinking",
      `Sales were down about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (now.salesYoY != null && now.salesYoY >= 0.2) {
    sig(
      "positive",
      "Fast growth",
      `Sales were up about ${pct(now.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (niAgo != null && now.profit != null && niAgo < 0 && now.profit >= 0) {
    sig(
      "positive",
      "Swung to a profit",
      "It lost money in the same quarter a year ago, but made a profit in the latest quarter."
    );
  } else if (
    niAgo != null &&
    now.profit != null &&
    niAgo >= 0 &&
    now.profit < 0
  ) {
    sig(
      "negative",
      "Swung to a loss",
      "It made a profit in the same quarter a year ago, but lost money in the latest quarter."
    );
  } else if (now.margin != null && marginAgo != null) {
    const dm = now.margin - marginAgo;

    if (dm >= 0.03) {
      sig(
        "positive",
        "Profit margin improved",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, up from ${(marginAgo * 100).toFixed(0)}% a year earlier.`
      );
    } else if (dm <= -0.03) {
      sig(
        "negative",
        "Profit margin shrank",
        `It kept about ${(now.margin * 100).toFixed(0)}% of sales as profit, down from ${(marginAgo * 100).toFixed(0)}% a year earlier.`
      );
    }
  }

  if (now.cash != null && cashAgo != null) {
    if (now.cash > 0 && cashAgo <= 0) {
      sig(
        "positive",
        "Cash flow turned positive",
        "It used cash in the same quarter a year ago, but brought in cash in the latest quarter."
      );
    } else if (now.cash < 0 && cashAgo >= 0) {
      sig(
        "negative",
        "Now burning cash",
        "It brought in cash in the same quarter a year ago, but used up cash in the latest quarter."
      );
    }
  }

  if (ratioNow != null && ratioAgo != null) {
    if (ratioNow - ratioAgo >= 0.5) {
      sig(
        "negative",
        "Debt load is rising",
        `It owes about $${ratioNow.toFixed(1)} per $1 of owners' stake, up from $${ratioAgo.toFixed(1)} a year earlier.`
      );
    } else if (ratioAgo - ratioNow >= 0.5) {
      sig(
        "positive",
        "Debt load is falling",
        `It owes about $${ratioNow.toFixed(1)} per $1 of owners' stake, down from $${ratioAgo.toFixed(1)} a year earlier.`
      );
    }
  }

  // The four checks, based on the latest quarter.
  const na = (title, jargon) => ({
    title,
    jargon,
    status: "na",
    text: "The filings don't report this in a standard way, so we can't check it."
  });

  const checks = [];

  if (now.margin == null) {
    checks.push(na("Profit", "Net profit margin"));
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

  if (b.liab == null || b.eq == null) {
    checks.push(na("Debt", "Total liabilities to equity"));
  } else if (b.eq <= 0) {
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
      status: ratioNow <= 1
        ? "good"
        : ratioNow <= 2.5
          ? "warn"
          : "bad",
      text: `As of ${bsEnd}, it owed about $${ratioNow.toFixed(1)} for every $1 that belongs to its owners. Banks and utilities usually run higher than other industries.`
    });
  }

  if (now.salesYoY == null) {
    checks.push(na("Growth", "Revenue growth"));
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
    checks.push(na("Cash", "Free cash flow"));
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

  const st = t => checks.find(x => x.title === t)?.status;
  const risks = [];

  if (st("Profit") === "bad") {
    risks.push("It isn't earning much or any profit on its sales right now.");
  }

  if (st("Debt") === "bad") {
    risks.push("High debt can become a burden if business slows or interest rates rise.");
  }

  if (st("Growth") === "bad") {
    risks.push("Shrinking sales can be a sign the business is losing customers.");
  }

  if (st("Cash") === "bad") {
    risks.push("It is spending more cash than it brings in, so it may need to borrow or sell new shares.");
  }

  if (!risks.length) {
    risks.push("Even healthy companies can be hurt by competition, new regulation, or an economic downturn.");
  }

  const pos = signals.filter(s => s.kind === "positive").length;
  const neg = signals.filter(s => s.kind === "negative").length;

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
    `. ${pos} positive and ${neg} negative changes stood out in the numbers.`;

  return {
    fiscalYearEnd: now.end,
    periodLabel: `Latest quarter ended ${now.end}`,
    balanceSheetDate: bsEnd ?? null,
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

function eventsFrom(sub, cik) {
  const r = sub?.filings?.recent;
  if (!r?.form) return [];

  const rank = { negative: 0, watch: 1, event: 2 };
  const cutoff = Date.now() - 365 * DAY;
  const out = [];

  for (let i = 0; i < r.form.length; i++) {
    if (!String(r.form[i]).startsWith("8-K") || d(r.filingDate[i]) < cutoff) {
      continue;
    }

    const hit = String(r.items?.[i] || "")
      .split(",")
      .map(s => s.trim())
      .filter(x => ITEMS[x])
      .sort((a, b) => rank[ITEMS[a][0]] - rank[ITEMS[b][0]])[0];

    if (!hit) continue;

    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    const doc = r.primaryDocument?.[i];

    out.push({
      date: r.filingDate[i],
      kind: ITEMS[hit][0],
      title: ITEMS[hit][1],
      url: doc
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${doc}`
        : null
    });
  }

  return out
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.date.localeCompare(a.date))
    .slice(0, 6);
}

async function aiWrite(name, out, businessType = "") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const m = v => (v == null ? "n/a" : money(v));

    const qs = out.quarters.map(q =>
      `Quarter ending ${q.end}: sales ${m(q.sales)}, vs year ago ${
        q.salesYoY == null ? "n/a" : (q.salesYoY * 100).toFixed(0) + "%"
      }, profit ${m(q.profit)}, cash ${m(q.cash)}`
    ).join("\n");

    const sg = out.signals.map(s =>
      `${s.kind}: ${s.title}. ${s.text}`
    ).join("\n") || "none";

    const ev = out.events.map((e, i) =>
      `EVENT ${i + 1}\nDate: ${e.date}\nSEC category: ${e.title}\nFiling text: ${
        e.details || "No readable filing text was retrieved."
      }`
    ).join("\n\n") || "none";

    const prompt = `You are Plainvest, a careful financial research assistant for beginner investors.
Analyze ${name}. Return valid JSON only, with exactly these fields:
{
  "companyDescription": "2-4 sentences explaining what the company does, its products or services, customers, and how it makes money",
  "summary": "3-4 sentences explaining the latest financial results and the most important changes in the supplied data",
  "risks": ["2-3 concise risks grounded in the supplied data or clearly identified business context"],
  "eventExplanations": [
    {"eventNumber": 1, "explanation": "Specific plain-English explanation of this announcement"}
  ]
}

RULES:
- Keep companyDescription separate from financial results and announcements. Do not describe an announcement as the company description.
- For companyDescription, you may use reliable general knowledge about this well-known company, but if you are not sure of a fact, omit it rather than guessing. The supplied industry classification, if present, is only a broad clue.
- For summary, use the supplied financial figures and changes. Do not imply that the numbers caused a stock-price move.
- Explain each announcement separately. For each event, state exactly what happened, who was involved and their role, and the effective date or deal terms when the filing text provides them.
- Explain why the event could matter to the business or investors, but label this as a possible implication, not a confirmed outcome.
- Do not simply repeat the SEC category or title. For example, do not answer only "Executive or director change." Identify the person and what changed when the filing says so.
- If the filing text does not reveal a name, reason, amount, or other detail, explicitly say it was not specified in the available filing text. Never invent missing details.
- Return one eventExplanations entry for every supplied event, using its exact event number. If the filing text is missing or unreadable, say that the available text was insufficient to determine the specific change.
- Do not give buy/sell advice or make a stock-price prediction.
- Use plain English. No Markdown fences or text outside the JSON.

COMPANY INDUSTRY CLASSIFICATION:
${businessType || "Not available"}

QUARTERLY FINANCIAL DATA (newest first):
${qs}

CHANGES IN THE NUMBERS:
${sg}

RECENT SEC FILINGS (each event is numbered):
${ev}`;

    const r = await fetch(
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
            responseMimeType: "application/json",
            temperature: 0.2
          }
        })
      }
    );

    if (!r.ok) {
      const errorText = await r.text();
      console.error("Gemini API error:", r.status, errorText);
      return null;
    }

    const j = await r.json();

    const raw = j.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "").join("");

    if (!raw) {
      console.error("Gemini returned no text:", JSON.stringify(j).slice(0, 1000));
      return null;
    }

    const o = JSON.parse(raw);

    if (typeof o.summary !== "string" || !Array.isArray(o.risks)) {
      return null;
    }

    const explanations = Array.isArray(o.eventExplanations)
      ? o.eventExplanations
      : [];

    const events = out.events.map((e, i) => {
      const found = explanations.find(x => Number(x.eventNumber) === i + 1);

      return {
        ...e,
        explanation: typeof found?.explanation === "string"
          ? found.explanation
          : "The filing was retrieved, but an explanation was not generated."
      };
    });

    return {
      companyDescription: typeof o.companyDescription === "string"
        ? o.companyDescription
        : "",
      summary: o.summary,
      risks: o.risks.slice(0, 3).map(String),
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

const ETFS = new Set((
  "SPY QQQ VOO VTI IVV DIA IWM VT VEA VWO VXUS BND AGG GLD IAU SLV XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC ARKK ARKG ARKW SCHD SCHB SCHX SCHG " +
  "VUG VTV VIG VYM VGT VHT VNQ IJH IJR IJK MDY EFA IEFA IEMG EEM TLT IEF SHY HYG LQD JNK USO UNG SMH SOXX SOXL TQQQ SQQQ UPRO SPXL SPXS TNA TZA IVW IVE IWF IWD IWB IWV " +
  "QQQM SPLG SPYG SPYV RSP QUAL USMV DGRO DVY SDY JEPI JEPQ BITO IBIT FBTC GBTC ETHE XBI IBB KRE KBE XOP OIH GDX GDXJ ITB XHB VXX UVXY"
).split(" "));

let fundSet = null;
let fundAt = 0;

async function isFund(t) {
  if (ETFS.has(t)) return true;

  try {
    if (!fundSet || Date.now() - fundAt > 7 * DAY) {
      const r = await fetch(
        "https://www.sec.gov/files/company_tickers_mf.json",
        { headers: H() }
      );

      if (!r.ok) return false;

      const j = await r.json();
      const i = j.fields?.indexOf("symbol");

      fundSet = new Set(
        i >= 0
          ? (j.data || []).map(row => String(row[i]).toUpperCase())
          : []
      );

      fundAt = Date.now();
    }

    return fundSet.has(t);
  } catch {
    return false;
  }
}

async function addEventDetails(events) {
  return Promise.all(events.map(async e => {
    if (!e.url) return e;

    try {
      // Fetch the primary 8-K document itself.
      const r = await fetch(e.url, {
        headers: {
          "User-Agent": UA(),
          Accept: "text/html, text/plain;q=0.9, */*;q=0.8"
        }
      });

      if (!r.ok) {
        console.error("SEC filing fetch failed:", r.status, e.url);
        return e;
      }

      const html = await r.text();

      const details = html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<ix:header\b[^>]*>[\s\S]*?<\/ix:header>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);

      return { ...e, details };
    } catch (err) {
      console.error("SEC filing detail error:", err.message);
      return e;
    }
  }));
}

async function handler(req, res) {
  try {
    if (!UA()) {
      throw new HttpError(500, "Server setup incomplete: SEC_USER_AGENT is missing.");
    }

    const raw = String(req.query?.ticker || "").trim().toUpperCase();

    if (FOREIGN.test(raw)) {
      throw new HttpError(422, FOREIGN_MSG);
    }

    const t = raw.replace(".", "-");

    if (!/^[A-Z0-9-]{1,8}$/.test(t)) {
      throw new HttpError(400, "Enter a valid ticker, like AAPL.");
    }

    if (ETFS.has(t)) {
      throw new HttpError(422, ETF_MSG);
    }

    const e = await lookup(t);

    if (!e) {
      if (await isFund(t)) {
        throw new HttpError(422, ETF_MSG);
      }

      throw new HttpError(
        404,
        `No US-listed company found for ${t}. Plainvest covers US-listed companies only, so check the ticker. ETFs and non-US stocks aren't supported yet.`
      );
    }

    const cik = String(e.cik_str).padStart(10, "0");

    const [r, sr] = await Promise.all([
      fetch(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
        { headers: H() }
      ),
      fetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers: H() }
      ).catch(() => null)
    ]);

    let sub = null;

    try {
      if (sr && sr.ok) sub = await sr.json();
    } catch {}

    const cant = () => {
      const forms = new Set(sub?.filings?.recent?.form || []);

      if (forms.has("20-F") || forms.has("40-F")) {
        return new HttpError(
          422,
          `${e.title} is a foreign company that files different reports with the SEC (20-F or 40-F), which Plainvest can't read yet. Companies that file standard US reports, like AAPL, work.`
        );
      }

      if (/\b(ETF|FUND|INDEX|ISHARES|SPDR|PROSHARES)\b/i.test(e.title)) {
        return new HttpError(422, ETF_MSG);
      }

      return new HttpError(
        422,
        `${e.title} doesn't have enough quarterly reports in a format this version can read (often newly listed or unusual companies).`
      );
    };

    if (r.status === 404) throw cant();

    if (!r.ok) {
      throw new HttpError(502, "The SEC didn't respond. Try again shortly.");
    }

    const out = analyzeFacts(await r.json());

    if (!out) throw cant();

    out.events = await addEventDetails(eventsFrom(sub, e.cik_str));

    const ai = await aiWrite(e.title, out, sub?.sicDescription || "");

    // CHANGED: reduce the shared cache lifetime to five minutes.
    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=300"
    );

    res.status(200).json({
      ticker: t,
      name: e.title,
      ...out,
      ...(ai || {})
    });
  } catch (err) {
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
