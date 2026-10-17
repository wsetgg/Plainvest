import { createHash } from 'node:crypto';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DAY = 86400000;
const LIMIT = 10;
const ua = () => process.env.SEC_USER_AGENT;

const secHeaders = (accept = 'application/json') => ({
  'User-Agent': ua(),
  Accept: accept
});

const ms = value => new Date(value).getTime();

const near = (a, b, days = 7) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= days * DAY;

const usdRows = (facts, tag) =>
  facts.facts?.['us-gaap']?.[tag]?.units?.USD || [];

const money = value => {
  if (value == null || !Number.isFinite(Number(value))) {
    return 'not reported';
  }

  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-$' : '$';

  if (abs >= 1e9) {
    return `${sign}${(abs / 1e9).toFixed(1)} billion`;
  }

  if (abs >= 1e6) {
    return `${sign}${(abs / 1e6).toFixed(1)} million`;
  }

  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
};

const pct = value =>
  value == null || !Number.isFinite(Number(value))
    ? 'not available'
    : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

/* ---------------- DAILY LIMIT ---------------- */

const RESERVE_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then
  return {0, n, redis.call('TTL', KEYS[1])}
end
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return {1, c, redis.call('TTL', KEYS[1])}
`;

const RELEASE_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n <= 1 then
  return redis.call('DEL', KEYS[1])
end
return redis.call('DECR', KEYS[1])
`;

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new HttpError(
      503,
      'The daily analysis limit is not configured. Please try again later.'
    );
  }

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new HttpError(
      503,
      'The daily limit service is temporarily unavailable. Please try again.'
    );
  }

  if (!response.ok) {
    throw new HttpError(
      503,
      'The daily limit service is temporarily unavailable. Please try again.'
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new HttpError(
      503,
      'The daily limit service is temporarily unavailable. Please try again.'
    );
  }

  return data.result;
}

function secondsToUtcMidnight() {
  const now = new Date();

  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );

  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

async function reserve(req) {
  const ip = String(
    req.headers?.['x-real-ip'] ||
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    'unknown'
  );

  const hash = createHash('sha256').update(ip).digest('hex');
  const date = new Date().toISOString().slice(0, 10);
  const key = `plainvest:daily:${date}:${hash}`;

  const result = await redis([
    'EVAL',
    RESERVE_LUA,
    '1',
    key,
    String(LIMIT),
    String(secondsToUtcMidnight())
  ]);

  if (!Array.isArray(result) || Number(result[0]) !== 1) {
    throw new HttpError(
      429,
      "You've reached today's limit of 3 company analyses. Your limit resets at midnight UTC."
    );
  }

  return key;
}

async function release(key) {
  if (!key) return;

  try {
    await redis(['EVAL', RELEASE_LUA, '1', key]);
  } catch (error) {
    console.error('Daily reservation release failed:', error?.message);
  }
}

/* ---------------- TICKER LOOKUP ---------------- */

let tickerMap = null;
let tickerAt = 0;

async function lookup(ticker) {
  if (!tickerMap || Date.now() - tickerAt > DAY) {
    let response;

    try {
      response = await fetch(
        'https://www.sec.gov/files/company_tickers.json',
        {
          headers: secHeaders(),
          cache: 'no-store',
          signal: AbortSignal.timeout(12000)
        }
      );
    } catch {
      throw new HttpError(
        502,
        'Could not reach the SEC ticker list. Try again shortly.'
      );
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        'Could not reach the SEC ticker list. Try again shortly.'
      );
    }

    const data = await response.json();
    const next = {};

    for (const entry of Object.values(data)) {
      next[String(entry.ticker).toUpperCase()] = entry;
    }

    tickerMap = next;
    tickerAt = Date.now();
  }

  return tickerMap[ticker];
}

const ETF_NAMES = new Set((
  'SPY QQQ VOO VTI IVV DIA IWM VT VEA VWO VXUS BND AGG GLD IAU SLV ' +
  'XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC ARKK ARKG ARKW ' +
  'SCHD SCHB SCHX SCHG VUG VTV VIG VYM VGT VHT VNQ IJH IJR MDY ' +
  'EFA IEFA IEMG EEM TLT IEF SHY HYG LQD JNK USO UNG SMH SOXX SOXL ' +
  'TQQQ SQQQ UPRO SPXL SPXS TNA TZA IVW IVE IWF IWD IWB IWV QQQM ' +
  'SPLG SPYG SPYV RSP QUAL USMV DGRO DVY SDY JEPI JEPQ BITO IBIT ' +
  'FBTC GBTC ETHE XBI IBB KRE KBE XOP OIH GDX GDXJ ITB XHB VXX UVXY'
).split(/\s+/));

const FOREIGN_RE =
  /^[A-Z0-9]{1,6}[.:](?:TO|V|NE|CN|L|T|HK|AX|NZ|SI|SW|PA|DE|F|MI|MC|AS|ST|OL|HE|CO|SS|SZ|KS|KQ|NS|BO|SA|MX|TW|JK|BK|KL|TA|IR)$/i;

const ETF_MSG =
  "That looks like an ETF or fund. ETFs don't have sales or profits the way companies do, so Plainvest can't analyze them yet.";

const FOREIGN_MSG =
  'That looks like a stock listed on a non-US exchange. Plainvest currently supports US-listed companies only. If the company also trades in the US, try its US ticker.';

let fundSet = null;
let fundAt = 0;

async function isFund(ticker) {
  if (ETF_NAMES.has(ticker)) return true;

  try {
    if (!fundSet || Date.now() - fundAt > 7 * DAY) {
      const response = await fetch(
        'https://www.sec.gov/files/company_tickers_mf.json',
        {
          headers: secHeaders(),
          cache: 'no-store',
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!response.ok) return false;

      const data = await response.json();
      const index = data.fields?.indexOf('symbol');

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
  } catch {
    return false;
  }
}

/* ---------------- QUARTERLY FINANCIAL DATA ---------------- */

function latestByEnd(rows, instant = false) {
  const selected = new Map();

  for (const row of rows) {
    if (!['10-Q', '10-K'].includes(row.form)) continue;

    if (instant ? row.start : !row.start) continue;

    const previous = selected.get(row.end);

    if (!previous || String(row.filed) > String(previous.filed)) {
      selected.set(row.end, row);
    }
  }

  return [...selected.values()].sort((a, b) =>
    a.end.localeCompare(b.end)
  );
}

function durationDays(row) {
  return (ms(row.end) - ms(row.start)) / DAY;
}

function quarterSeries(facts, concepts) {
  for (const concept of concepts) {
    const rows = latestByEnd(usdRows(facts, concept));

    if (!rows.length) continue;

    const direct = rows.filter(row => {
      const days = durationDays(row);
      return days >= 70 && days <= 110;
    });

    const ytd = rows.filter(row => {
      const days = durationDays(row);
      return days >= 120 && days <= 310;
    });

    const annual = rows.filter(row => {
      const days = durationDays(row);
      return row.form === '10-K' && days >= 340 && days <= 390;
    });

    const output = new Map();

    for (const row of direct) {
      output.set(row.end, {
        end: row.end,
        value: row.val
      });
    }

    // Derive standalone quarters from year-to-date totals.
    for (const row of ytd) {
      const days = durationDays(row);

      const previous = ytd
        .filter(other =>
          other.start === row.start &&
          ms(other.end) < ms(row.end) &&
          durationDays(other) >= 120 &&
          durationDays(other) <= days - 60
        )
        .sort((a, b) => ms(b.end) - ms(a.end))[0];

      if (previous) {
        const quarterDays = days - durationDays(previous);

        if (
          quarterDays >= 60 &&
          quarterDays <= 110 &&
          !output.has(row.end)
        ) {
          output.set(row.end, {
            end: row.end,
            value: row.val - previous.val
          });
        }
      }
    }

    // Derive Q4 from the annual total minus the first nine months.
    for (const row of annual) {
      if (output.has(row.end)) continue;

      const nineMonth = ytd
        .filter(other =>
          other.start === row.start &&
          ms(other.end) < ms(row.end) &&
          durationDays(other) >= 240 &&
          durationDays(other) <= 310
        )
        .sort((a, b) => ms(b.end) - ms(a.end))[0];

      if (nineMonth) {
        output.set(row.end, {
          end: row.end,
          value: row.val - nineMonth.val
        });
      } else {
        const previousQuarters = [...output.values()]
          .filter(item =>
            item.end > row.start &&
            item.end < row.end
          )
          .sort((a, b) => a.end.localeCompare(b.end));

        if (previousQuarters.length >= 3) {
          output.set(row.end, {
            end: row.end,
            value: row.val - previousQuarters
              .slice(-3)
              .reduce((sum, item) => sum + item.value, 0)
          });
        }
      }
    }

    const result = [...output.values()]
      .filter(row => Number.isFinite(row.value))
      .sort((a, b) => b.end.localeCompare(a.end));

    if (result.length) return result;
  }

  return [];
}

function findQuarterValue(series, end) {
  return series.find(item =>
    near(ms(item.end), ms(end), 7)
  )?.value ?? null;
}

function yearAgoValue(series, end) {
  const target = ms(end) - 365 * DAY;

  return series.find(item =>
    near(ms(item.end), target, 18)
  )?.value ?? null;
}

/* ---------------- BALANCE SHEET ---------------- */

function instantSeries(facts, concepts) {
  for (const concept of concepts) {
    const rows = latestByEnd(usdRows(facts, concept), true);

    if (rows.length) {
      return rows
        .map(row => ({
          end: row.end,
          value: row.val,
          filed: row.filed
        }))
        .sort((a, b) => b.end.localeCompare(a.end));
    }
  }

  return [];
}

function latestInstant(facts, concepts, date) {
  const rows = instantSeries(facts, concepts);
  const row = date
    ? rows.find(item => item.end === date)
    : rows[0];

  return row?.value ?? null;
}

function latestInstantBefore(facts, concepts, targetDate) {
  for (const concept of concepts) {
    const rows = latestByEnd(usdRows(facts, concept), true)
      .filter(row => ms(row.end) <= ms(targetDate))
      .sort((a, b) => b.end.localeCompare(a.end));

    if (rows.length) return rows[0].val;
  }

  return null;
}

function balanceSheet(facts) {
  const concepts = [
    'Assets',
    'Liabilities',
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'LiabilitiesAndStockholdersEquity'
  ];

  const dates = concepts.flatMap(concept =>
    instantSeries(facts, [concept]).map(row => row.end)
  ).sort((a, b) => b.localeCompare(a));

  const date = dates[0] || null;
  const at = tags => latestInstant(facts, tags, date);

  const totalAssets = at(['Assets']);
  let totalLiabilities = at(['Liabilities']);
  let equity = at([
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'
  ]);

  const combined = at(['LiabilitiesAndStockholdersEquity']);

  if (totalLiabilities == null && combined != null && equity != null) {
    totalLiabilities = combined - equity;
  }

  if (equity == null && combined != null && totalLiabilities != null) {
    equity = combined - totalLiabilities;
  }

  const assetDefinitions = [
    ['Cash and cash equivalents', ['CashAndCashEquivalentsAtCarryingValue']],
    ['Short-term investments', ['ShortTermInvestments']],
    ['Accounts receivable', ['AccountsReceivableNetCurrent', 'AccountsReceivableNet']],
    ['Inventory', ['InventoryNet']],
    ['Other current assets', ['OtherAssetsCurrent']],
    ['Property and equipment', ['PropertyPlantAndEquipmentNet']],
    ['Goodwill', ['Goodwill']],
    ['Intangible assets', ['FiniteLivedIntangibleAssetsNet', 'IntangibleAssetsNetExcludingGoodwill']],
    ['Other non-current assets', ['OtherAssetsNoncurrent', 'OtherAssets']]
  ];

  const fundingDefinitions = [
    ['Accounts payable', ['AccountsPayableCurrent']],
    ['Current debt', ['ShortTermBorrowings', 'ShortTermDebtCurrent', 'LongTermDebtCurrent']],
    ['Other current liabilities', ['OtherLiabilitiesCurrent']],
    ['Long-term debt', ['LongTermDebtNoncurrent', 'LongTermDebt']],
    ['Other non-current liabilities', ['OtherLiabilitiesNoncurrent']],
    ['Shareholders’ equity', ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']]
  ];

  const makeItems = definitions => definitions.map(([label, tags]) => ({
    label,
    value: at(tags)
  }));

  return {
    date,
    totalAssets,
    totalLiabilities,
    equity,
    cashAndEquivalents: at(['CashAndCashEquivalentsAtCarryingValue']),
    assets: makeItems(assetDefinitions),
    funding: makeItems(fundingDefinitions)
  };
}

/* ---------------- FINANCIAL ANALYSIS ---------------- */

function analyzeFacts(facts) {
  if (!facts.facts?.['us-gaap']) return null;

  const revenue = quarterSeries(facts, [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet'
  ]);

  if (revenue.length < 2) return null;

  const profitSeries = quarterSeries(facts, [
    'NetIncomeLoss',
    'ProfitLoss'
  ]);

  const operatingCashSeries = quarterSeries(facts, [
    'NetCashProvidedByUsedInOperatingActivities'
  ]);

  const capexSeries = quarterSeries(facts, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets'
  ]);

  const cashAt = end => {
    const operating = findQuarterValue(operatingCashSeries, end);
    const capex = findQuarterValue(capexSeries, end);

    if (operating == null || capex == null) return null;

    return operating - Math.abs(capex);
  };

  const quarters = revenue.slice(0, 8).map(row => {
    const profit = findQuarterValue(profitSeries, row.end);
    const priorRevenue = yearAgoValue(revenue, row.end);

    return {
      end: row.end,
      sales: row.value,
      salesYoY: priorRevenue != null && priorRevenue > 0
        ? row.value / priorRevenue - 1
        : null,
      profit,
      margin: profit != null && row.value !== 0
        ? profit / row.value
        : null,
      cash: cashAt(row.end)
    };
  });

  const current = quarters[0];
  const previous = quarters[1];
  const priorProfit = yearAgoValue(profitSeries, current.end);
  const priorRevenue = yearAgoValue(revenue, current.end);

  const priorCashEnd = revenue.find(row =>
    near(ms(row.end), ms(current.end) - 365 * DAY, 18)
  )?.end;

  const priorCash = priorCashEnd ? cashAt(priorCashEnd) : null;

  const priorMargin = priorProfit != null && priorRevenue
    ? priorProfit / priorRevenue
    : null;

  const balance = balanceSheet(facts);

  const debtRatio =
    balance.totalLiabilities != null &&
    balance.equity != null &&
    balance.equity > 0
      ? balance.totalLiabilities / balance.equity
      : null;

  const signals = [];

  const addSignal = (kind, title, text) => {
    signals.push({ kind, title, text });
  };

  if (current.salesYoY != null && previous?.salesYoY != null) {
    const difference = current.salesYoY - previous.salesYoY;

    if (difference >= 0.05) {
      addSignal(
        'positive',
        'Sales growth is speeding up',
        `Year-over-year sales growth rose from ${pct(previous.salesYoY)} to ${pct(current.salesYoY)}.`
      );
    } else if (difference <= -0.05) {
      addSignal(
        'negative',
        'Sales growth is slowing',
        `Year-over-year sales growth fell from ${pct(previous.salesYoY)} to ${pct(current.salesYoY)}.`
      );
    }
  }

  if (current.salesYoY != null && current.salesYoY <= -0.05) {
    addSignal(
      'negative',
      'Sales are shrinking',
      `Sales were down ${pct(current.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (current.salesYoY != null && current.salesYoY >= 0.2) {
    addSignal(
      'positive',
      'Fast sales growth',
      `Sales were up ${pct(current.salesYoY)} from the same quarter a year earlier.`
    );
  }

  if (priorProfit != null && current.profit != null) {
    if (priorProfit < 0 && current.profit >= 0) {
      addSignal(
        'positive',
        'Swung to a profit',
        'The company lost money in the comparable quarter last year but made a profit now.'
      );
    } else if (priorProfit >= 0 && current.profit < 0) {
      addSignal(
        'negative',
        'Swung to a loss',
        'The company made a profit in the comparable quarter last year but reported a loss now.'
      );
    } else if (current.margin != null && priorMargin != null) {
      const difference = current.margin - priorMargin;

      if (difference >= 0.03) {
        addSignal(
          'positive',
          'Profit margin improved',
          `It kept ${(current.margin * 100).toFixed(1)}% of sales as profit, compared with ${(priorMargin * 100).toFixed(1)}% a year earlier.`
        );
      } else if (difference <= -0.03) {
        addSignal(
          'negative',
          'Profit margin declined',
          `It kept ${(current.margin * 100).toFixed(1)}% of sales as profit, compared with ${(priorMargin * 100).toFixed(1)}% a year earlier.`
        );
      }
    }
  }

  if (current.cash != null && priorCash != null) {
    if (current.cash > 0 && priorCash <= 0) {
      addSignal(
        'positive',
        'Free cash flow turned positive',
        'Free cash flow was negative in the comparable quarter last year but is positive now.'
      );
    } else if (current.cash < 0 && priorCash >= 0) {
      addSignal(
        'negative',
        'Free cash flow turned negative',
        'Free cash flow was positive in the comparable quarter last year but is negative now.'
      );
    } else if (Math.abs(priorCash) > 0) {
      const change = (current.cash - priorCash) / Math.abs(priorCash);

      if (change >= 0.25) {
        addSignal(
          'positive',
          'Free cash flow improved',
          `Free cash flow changed from ${money(priorCash)} to ${money(current.cash)} year over year.`
        );
      } else if (change <= -0.25) {
        addSignal(
          'negative',
          'Free cash flow weakened',
          `Free cash flow changed from ${money(priorCash)} to ${money(current.cash)} year over year.`
        );
      }
    }
  }

  if (debtRatio != null && balance.date) {
    const olderDate = new Date(
      ms(balance.date) - 365 * DAY
    ).toISOString().slice(0, 10);

    const olderLiabilities = latestInstantBefore(
      facts,
      ['Liabilities'],
      olderDate
    );

    const olderEquity = latestInstantBefore(
      facts,
      ['StockholdersEquity'],
      olderDate
    );

    if (olderLiabilities != null && olderEquity > 0) {
      const oldRatio = olderLiabilities / olderEquity;

      if (debtRatio - oldRatio >= 0.5) {
        addSignal(
          'negative',
          'Debt load is rising',
          `The company owes about $${debtRatio.toFixed(1)} per $1 of shareholders’ equity, compared with $${oldRatio.toFixed(1)} a year earlier.`
        );
      } else if (oldRatio - debtRatio >= 0.5) {
        addSignal(
          'positive',
          'Debt load is falling',
          `The company owes about $${debtRatio.toFixed(1)} per $1 of shareholders’ equity, compared with $${oldRatio.toFixed(1)} a year earlier.`
        );
      }
    }
  }

  const unavailable = (title, jargon) => ({
    title,
    jargon,
    status: 'na',
    text: 'The available SEC filings do not provide enough consistent data to assess this.'
  });

  const checks = [];

  if (current.margin == null) {
    checks.push(unavailable('Profit', 'Net profit margin'));
  } else {
    checks.push({
      title: 'Profit',
      jargon: 'Net profit margin',
      status: current.margin >= 0.1
        ? 'good'
        : current.margin >= 0.03 ? 'warn' : 'bad',
      text: current.margin >= 0
        ? `Of every $100 it sold in the latest quarter, it kept about $${(current.margin * 100).toFixed(0)} as profit after all costs.`
        : `It lost about $${(-current.margin * 100).toFixed(0)} for every $100 it sold.`
    });
  }

  if (balance.totalLiabilities == null || balance.equity == null) {
    checks.push(unavailable('Debt', 'Total liabilities to equity'));
  } else if (balance.equity <= 0) {
    checks.push({
      title: 'Debt',
      jargon: 'Total liabilities to equity',
      status: 'bad',
      text: 'Shareholders’ equity is zero or negative, which can indicate financial pressure and needs closer investigation.'
    });
  } else {
    checks.push({
      title: 'Debt',
      jargon: 'Total liabilities to equity',
      status: debtRatio <= 1 ? 'good' : debtRatio <= 2.5 ? 'warn' : 'bad',
      text: `As of ${balance.date || 'the latest reporting date'}, it owed about $${debtRatio.toFixed(1)} for every $1 of shareholders’ equity. Normal levels differ by industry.`
    });
  }

  if (current.salesYoY == null) {
    checks.push(unavailable('Growth', 'Revenue growth'));
  } else {
    checks.push({
      title: 'Growth',
      jargon: 'Revenue growth (year over year)',
      status: current.salesYoY >= 0.08
        ? 'good'
        : current.salesYoY >= 0 ? 'warn' : 'bad',
      text: `Sales were ${current.salesYoY >= 0 ? 'up' : 'down'} ${pct(current.salesYoY)} from the same quarter a year earlier.`
    });
  }

  if (current.cash == null) {
    checks.push(unavailable('Cash', 'Free cash flow'));
  } else {
    checks.push({
      title: 'Cash',
      jargon: 'Free cash flow',
      status: current.cash > 0 && current.cash / current.sales >= 0.05
        ? 'good'
        : current.cash > 0 ? 'warn' : 'bad',
      text: current.cash > 0
        ? `After capital spending, it generated ${money(current.cash)} in free cash flow in the latest quarter.`
        : `After capital spending, it used up ${money(-current.cash)} in free cash flow in the latest quarter.`
    });
  }

  const status = title => checks.find(item => item.title === title)?.status;
  const risks = [];

  if (status('Profit') === 'bad') {
    risks.push('Low or negative profit can leave less room to handle unexpected costs.');
  }

  if (status('Debt') === 'bad') {
    risks.push('High debt or negative equity can increase financial pressure if business slows.');
  }

  if (status('Growth') === 'bad') {
    risks.push('Shrinking sales may indicate weaker demand, although the figures alone do not explain why.');
  }

  if (status('Cash') === 'bad') {
    risks.push('Negative free cash flow means the company used more cash after capital spending than it generated from operations.');
  }

  if (!risks.length) {
    risks.push('Competition, regulation, economic conditions, and execution problems can affect a company even when its latest financial figures look positive.');
  }

  const summary =
    `In the quarter ending ${current.end}, the company reported ${money(current.sales)} in sales` +
    (current.salesYoY != null
      ? `, ${current.salesYoY >= 0 ? 'up' : 'down'} ${pct(current.salesYoY)} year over year`
      : '') +
    (current.profit != null
      ? `, and ${current.profit >= 0 ? `a profit of ${money(current.profit)}` : `a loss of ${money(-current.profit)}`}`
      : '') +
    '. ' +
    (signals.length
      ? `Notable changes include: ${signals.slice(0, 3).map(item => `${item.title.toLowerCase()}: ${item.text}`).join(' ')}`
      : 'There were no major changes in the tracked figures, or there is not enough comparable data to identify one.');

  return {
    periodLabel: `Latest quarter ended ${current.end}`,
    balanceSheetDate: balance.date,
    balanceSheet: balance,
    quarters,
    signals,
    checks,
    risks,
    summary
  };
}

/* ---------------- SEC FILINGS AND ANNOUNCEMENTS ---------------- */

const ITEMS = {
  '1.01': ['event', 'New major agreement signed'],
  '1.02': ['negative', 'A major agreement ended'],
  '1.03': ['negative', 'Bankruptcy filing'],
  '1.05': ['negative', 'Cybersecurity incident reported'],
  '2.01': ['event', 'Company bought or sold a business'],
  '2.02': ['event', 'Quarterly or annual results announced'],
  '2.03': ['watch', 'New debt or financial obligation'],
  '2.04': ['negative', 'Debt payments accelerated'],
  '2.05': ['watch', 'Restructuring or layoffs announced'],
  '2.06': ['negative', 'Large asset write-down'],
  '3.01': ['negative', 'Stock exchange delisting notice'],
  '3.02': ['watch', 'New shares sold, which can dilute owners'],
  '4.01': ['watch', 'Change of auditor'],
  '4.02': ['negative', 'Past financial statements may need correcting'],
  '5.01': ['event', 'Change in company control'],
  '5.02': ['event', 'Executive or director change'],
  '5.03': ['event', 'Change to company governing documents'],
  '5.07': ['event', 'Shareholders voted on company matters'],
  '7.01': ['event', 'Company made a public disclosure'],
  '8.01': ['event', 'Other important company update']
};

function filingUrl(cik, accession, document) {
  if (!accession || !document) return null;

  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, '')}/${document}`;
}

function eventsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return [];

  const rank = { negative: 0, watch: 1, event: 2 };
  const cutoff = Date.now() - 90 * DAY;
  const events = [];

  for (let i = 0; i < recent.form.length; i++) {
    if (
      !String(recent.form[i]).startsWith('8-K') ||
      ms(recent.filingDate[i]) < cutoff
    ) continue;

    const codes = String(recent.items?.[i] || '')
      .split(',')
      .map(item => item.trim())
      .filter(item => ITEMS[item]);

    if (!codes.length) continue;

    codes.sort((a, b) =>
      rank[ITEMS[a][0]] - rank[ITEMS[b][0]]
    );

    const selected = codes[0];

    events.push({
      date: recent.filingDate[i],
      kind: ITEMS[selected][0],
      title: ITEMS[selected][1],
      url: filingUrl(
        cik,
        recent.accessionNumber?.[i],
        recent.primaryDocument?.[i]
      ),
      details: null,
      explanation: null
    });
  }

  return events
    .sort((a, b) =>
      rank[a.kind] - rank[b.kind] ||
      b.date.localeCompare(a.date)
    )
    .slice(0, 6);
}

function earningsReportsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return [];

  const reports = [];

  for (let i = 0; i < recent.form.length; i++) {
    const form = String(recent.form[i] || '');
    if (form !== '10-Q' && form !== '10-K') continue;

    const periodEnd = recent.reportDate?.[i];
    const filedDate = recent.filingDate?.[i];

    if (!periodEnd || !filedDate) continue;

    reports.push({
      form,
      type: form === '10-K' ? 'Annual report' : 'Quarterly report',
      periodEnd,
      filedDate,
      url: filingUrl(
        cik,
        recent.accessionNumber?.[i],
        recent.primaryDocument?.[i]
      )
    });
  }

  return reports
    .sort((a, b) =>
      b.periodEnd.localeCompare(a.periodEnd) ||
      b.filedDate.localeCompare(a.filedDate)
    )
    .slice(0, 12);
}

function cleanText(source, maxLength = 12000) {
  return String(source || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, value) => {
      const code = Number(value);
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : ' ';
    })
    .replace(/&#x([\da-f]+);/gi, (_, value) => {
      const code = parseInt(value, 16);
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : ' ';
    })
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function addEventDetails(events) {
  return Promise.all(events.map(async event => {
    if (!event.url) return event;

    try {
      const response = await fetch(event.url, {
        headers: secHeaders('text/html, text/plain, application/xhtml+xml'),
        cache: 'no-store',
        signal: AbortSignal.timeout(7000)
      });

      if (!response.ok) return event;

      const details = cleanText(await response.text(), 7000);

      return { ...event, details: details || null };
    } catch (error) {
      console.error('SEC filing detail error:', error?.message);
      return event;
    }
  }));
}

async function companySourceFrom(submissions, cik) {
  const recent = submissions?.filings?.recent;
  if (!recent?.form) return '';

  const filings = recent.form
    .map((form, index) => ({
      form,
      index,
      filed: recent.filingDate?.[index] || ''
    }))
    .filter(item => item.form === '10-K' || item.form === '10-Q')
    .sort((a, b) => b.filed.localeCompare(a.filed));

  for (const filing of filings.slice(0, 3)) {
    const url = filingUrl(
      cik,
      recent.accessionNumber?.[filing.index],
      recent.primaryDocument?.[filing.index]
    );

    if (!url) continue;

    try {
      const response = await fetch(url, {
        headers: secHeaders('text/html, text/plain, application/xhtml+xml'),
        cache: 'no-store',
        signal: AbortSignal.timeout(7000)
      });

      if (!response.ok) continue;

      const text = cleanText(await response.text(), 400000);
      const match = /\bitem\s+1\.?\s+business\b/i.exec(text);

      if (match) {
        const rest = text.slice(match.index);
        const end = /\bitem\s+(?:1a\.?\s+risk\s+factors|2\.?\s+properties)\b/i.exec(rest.slice(30));

        return (end ? rest.slice(0, end.index + 30) : rest).slice(0, 16000);
      }

      return text.slice(0, 16000);
    } catch (error) {
      console.error('Company source error:', error?.message);
    }
  }

  return '';
}

/* ---------------- GEMINI EXPLANATIONS ---------------- */

async function aiWrite(name, output, companySource, sicDescription, events) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const prompt = `You are Plainvest, a careful financial explainer for beginners.
Use only the information supplied below. Do not invent company facts, causes, numbers, or consequences.
Return valid JSON only with this shape:
{
  "companyDescription": "2 to 4 plain-English sentences",
  "summary": "4 to 6 plain-English sentences",
  "risks": ["2 or 3 short risks"],
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
Explain what the company sells, who uses it, and how it makes money only where supported by the SEC text.
Explain important changes in the numbers and mention both positive and negative changes where relevant.
If the supplied data does not explain why something changed, say so.
Explain each announcement using its filing details, not its category alone.
Do not provide investment advice or stock-price predictions.
Write naturally for a Grade 9 student.

COMPANY: ${name}
SEC INDUSTRY LABEL: ${sicDescription || 'Not available'}
SEC BUSINESS DESCRIPTION: ${companySource || 'Not available'}
QUARTERS, NEWEST FIRST: ${JSON.stringify(output.quarters)}
CHANGES IN THE NUMBERS: ${JSON.stringify(output.signals)}
ANNOUNCEMENTS: ${JSON.stringify(events.map((event, index) => ({
  index,
  date: event.date,
  title: event.title,
  category: event.kind,
  filingDetails: event.details
})))}
BASELINE SUMMARY: ${output.summary}`;

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 6000
          }
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(25000)
      }
    );

    if (!response.ok) {
      console.error(
        'Gemini API error:',
        response.status,
        (await response.text()).slice(0, 1000)
      );
      return null;
    }

    const data = await response.json();

    const raw = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('');

    if (!raw) return null;

    const parsed = JSON.parse(
      raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    );

    if (
      typeof parsed.summary !== 'string' ||
      !Array.isArray(parsed.risks)
    ) return null;

    const analyses = new Map(
      (Array.isArray(parsed.eventAnalyses) ? parsed.eventAnalyses : [])
        .filter(item => Number.isInteger(item.index))
        .map(item => [item.index, item])
    );

    const explainedEvents = events.map((event, index) => {
      const analysis = analyses.get(index);

      return {
        ...event,
        explanation: analysis ? {
          whatHappened: String(
            analysis.whatHappened ||
            'The available filing text does not explain this announcement in enough detail.'
          ),
          whyItMatters: String(
            analysis.whyItMatters ||
            'Its importance cannot be determined from the available filing details.'
          ),
          potentialImpact: String(
            analysis.potentialImpact ||
            'The business impact is unclear from the available information.'
          ),
          uncertainty: String(
            analysis.uncertainty ||
            'The available information does not establish the full implications.'
          )
        } : null
      };
    });

    return {
      companyDescription:
        typeof parsed.companyDescription === 'string'
          ? parsed.companyDescription.trim()
          : '',
      summary: parsed.summary,
      risks: parsed.risks.slice(0, 3).map(String),
      events: explainedEvents
    };
  } catch (error) {
    console.error('Gemini explanation failed:', error?.message);
    return null;
  }
}

/* ---------------- API HANDLER ---------------- */

export default async function handler(req, res) {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'x-forwarded-for, x-real-ip');

  let reservationKey = null;

  try {
    if (req.method && req.method !== 'GET') {
      res.setHeader('Allow', 'GET');

      throw new HttpError(
        405,
        'Method not allowed. Use GET /api/analyze?ticker=AAPL.'
      );
    }

    if (!ua()) {
      throw new HttpError(
        500,
        'Server setup incomplete: SEC_USER_AGENT is missing.'
      );
    }

    const raw = String(
      req.query?.ticker ||
      new URL(req.url, 'https://plainvest.invalid').searchParams.get('ticker') ||
      ''
    ).trim().toUpperCase();

    if (FOREIGN_RE.test(raw)) {
      throw new HttpError(422, FOREIGN_MSG);
    }

    const ticker = raw.replace(/\./g, '-');

    if (!/^[A-Z0-9-]{1,8}$/.test(ticker)) {
      throw new HttpError(400, 'Enter a valid ticker, like AAPL.');
    }

    if (ETF_NAMES.has(ticker)) {
      throw new HttpError(422, ETF_MSG);
    }

    // Validate the ticker before reserving a daily analysis.
    const company = await lookup(ticker);

    if (!company) {
      if (await isFund(ticker)) {
        throw new HttpError(422, ETF_MSG);
      }

      throw new HttpError(
        404,
        `No US-listed company found for ${ticker}. Plainvest covers US-listed companies only. Check the ticker.`
      );
    }

    reservationKey = await reserve(req);

    const cik = String(company.cik_str).padStart(10, '0');

    const [factsResponse, submissionsResponse] = await Promise.all([
      fetch(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
        {
          headers: secHeaders(),
          cache: 'no-store',
          signal: AbortSignal.timeout(20000)
        }
      ),
      fetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        {
          headers: secHeaders(),
          cache: 'no-store',
          signal: AbortSignal.timeout(15000)
        }
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

      if (forms.has('20-F') || forms.has('40-F')) {
        return new HttpError(
          422,
          `${company.title} files foreign-company reports that this version of Plainvest cannot yet read.`
        );
      }

      if (/\b(ETF|FUND|INDEX|ISHARES|SPDR|PROSHARES)\b/i.test(company.title)) {
        return new HttpError(422, ETF_MSG);
      }

      return new HttpError(
        422,
        `${company.title} does not have enough quarterly financial data in a format this version can read.`
      );
    };

    if (factsResponse.status === 404) {
      throw unsupportedCompany();
    }

    if (!factsResponse.ok) {
      throw new HttpError(
        502,
        'The SEC did not respond successfully. Try again shortly.'
      );
    }

    const facts = await factsResponse.json();
    const output = analyzeFacts(facts);

    if (!output) {
      throw unsupportedCompany();
    }

    output.events = await addEventDetails(
      eventsFrom(submissions, company.cik_str)
    );

    output.earningsReports = earningsReportsFrom(
      submissions,
      company.cik_str
    );

    output.quarters = output.quarters.map(quarter => {
      const report = output.earningsReports.find(item =>
        near(ms(item.periodEnd), ms(quarter.end), 7)
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
      submissions?.sicDescription || '',
      output.events
    );

    res.status(200).json({
      ticker,
      name: company.title,
      ...output,
      ...(ai || {})
    });

    // Keep the reservation after a successful response until UTC midnight.
    reservationKey = null;
  } catch (error) {
    if (reservationKey) {
      await release(reservationKey);
      reservationKey = null;
    }

    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }

    console.error('Plainvest analysis failed:', error);

    res.status(500).json({
      error: 'Something went wrong while analyzing this company. Please try again.'
    });
  }
}

export {
  analyzeFacts,
  balanceSheet,
  eventsFrom,
  earningsReportsFrom,
  quarterSeries
};
