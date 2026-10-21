"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeFacts, balanceSheetObject } = require("./analyze.js");

function factRow(end, val, form = "10-Q", start = null) {
  return {
    end,
    val,
    form,
    fp: "Q1",
    filed: end,
    ...(start ? { start } : {})
  };
}

function durationFact(end, start, val) {
  return factRow(end, val, "10-Q", start);
}

function makeFacts(concepts) {
  const usGaap = {};
  for (const [name, rows] of Object.entries(concepts)) {
    usGaap[name] = { units: { USD: rows } };
  }
  return { facts: { "us-gaap": usGaap } };
}

test("free cash flow remains unavailable when capex is missing", () => {
  const facts = makeFacts({
    Revenues: [
      durationFact("2026-03-31", "2026-01-01", 120),
      durationFact("2025-12-31", "2025-10-01", 100)
    ],
    NetCashProvidedByUsedInOperatingActivities: [
      durationFact("2026-03-31", "2026-01-01", 30),
      durationFact("2025-12-31", "2025-10-01", 20)
    ]
  });

  const result = analyzeFacts(facts);
  assert.ok(result, "valid revenue quarters should produce an analysis");
  assert.equal(result.quarters[0].cash, null);
  assert.equal(result.checks.find(check => check.title === "Cash").status, "na");
});

test("reported debt combines current and non-current components instead of picking one", () => {
  const facts = makeFacts({
    Assets: [factRow("2026-03-31", 1000)],
    Liabilities: [factRow("2026-03-31", 500)],
    StockholdersEquity: [factRow("2026-03-31", 500)],
    LongTermDebtCurrent: [factRow("2026-03-31", 50)],
    LongTermDebtNoncurrent: [factRow("2026-03-31", 250)]
  });

  const sheet = balanceSheetObject(facts);
  assert.equal(sheet.funding.find(item => item.label === "Reported debt").value, 300);
});

test("current debt is added to LongTermDebt when non-current tag is absent", () => {
  const facts = makeFacts({
    Assets: [factRow("2026-03-31", 1000)],
    Liabilities: [factRow("2026-03-31", 500)],
    StockholdersEquity: [factRow("2026-03-31", 500)],
    LongTermDebtCurrent: [factRow("2026-03-31", 50)],
    LongTermDebt: [factRow("2026-03-31", 250)]
  });

  const sheet = balanceSheetObject(facts);
  assert.equal(sheet.funding.find(item => item.label === "Reported debt").value, 300);
});


test("international IFRS facts reported in USD can produce quarterly analysis", () => {
  const foreignQuarter = (end, start, value) => ({
    ...durationFact(end, start, value),
    form: "6-K"
  });
  const ifrs = {
    Revenue: [
      foreignQuarter("2026-06-30", "2026-04-01", 140),
      foreignQuarter("2026-03-31", "2026-01-01", 120)
    ],
    ProfitLoss: [
      foreignQuarter("2026-06-30", "2026-04-01", 14),
      foreignQuarter("2026-03-31", "2026-01-01", 10)
    ],
    CashFlowsFromUsedInOperatingActivities: [
      foreignQuarter("2026-06-30", "2026-04-01", 25),
      foreignQuarter("2026-03-31", "2026-01-01", 20)
    ],
    PurchaseOfPropertyPlantAndEquipment: [
      foreignQuarter("2026-06-30", "2026-04-01", -5),
      foreignQuarter("2026-03-31", "2026-01-01", -4)
    ]
  };
  const facts = {
    facts: {
      "ifrs-full": Object.fromEntries(
        Object.entries(ifrs).map(([name, rows]) => [
          name,
          { units: { USD: rows } }
        ])
      )
    }
  };

  const result = analyzeFacts(facts);
  assert.ok(result, "IFRS financial facts should be recognized");
  assert.equal(result.quarters[0].sales, 140);
  assert.equal(result.quarters[0].profit, 14);
  assert.equal(result.quarters[0].cash, 20);
});

test("Form 6-K announcements are retained even without 8-K item codes", () => {
  const events = require("./analyze.js").eventsFrom({
    filings: {
      recent: {
        form: ["6-K"],
        filingDate: ["2026-10-01"],
        items: [""],
        accessionNumber: ["0000000000-26-000001"],
        primaryDocument: ["update.htm"]
      }
    }
  }, 1234567);

  assert.equal(events.length, 1);
  assert.equal(events[0].form, "6-K");
  assert.equal(events[0].title, "International company update");
  assert.match(events[0].url, /sec\.gov\/Archives\/edgar\/data\/1234567/);
});


test("ticker index preserves duplicate symbols instead of overwriting an issuer", () => {
  const { buildTickerIndex } = require("./analyze.js");
  const index = buildTickerIndex({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1001, "Example Defense Corp", "ABC", "NYSE"],
      [2002, "Example Canadian Holdings", "ABC", "TSX"]
    ]
  });

  const matches = index.get("ABC");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].title, "Example Defense Corp");
  assert.equal(matches[1].title, "Example Canadian Holdings");
  assert.equal(matches[0].exchange, "NYSE");
  assert.equal(matches[1].exchange, "TSX");
});

test("ticker index ignores malformed rows and normalizes symbols", () => {
  const { buildTickerIndex } = require("./analyze.js");
  const index = buildTickerIndex({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1001, "Example Corp", "abc", "NYSE"],
      [null, "Missing CIK", "XYZ", "NASDAQ"],
      [1002, "", "DEF", "NYSE"]
    ]
  });

  assert.equal(index.get("ABC")[0].title, "Example Corp");
  assert.equal(index.has("XYZ"), false);
  assert.equal(index.has("DEF"), false);
});

test("exact company-name queries resolve to SEC-listed international issuers", () => {
  const { buildTickerIndex } = require("./analyze.js");
  const index = buildTickerIndex({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1234, "Enbridge Inc.", "ENB", "NYSE"],
      [2345, "Example Defense Corp", "ABC", "NYSE"]
    ]
  });

  const byName = [...index.values()].flat().filter(company =>
    company.title.toUpperCase() === "ENBRIDGE INC."
  );
  assert.equal(byName.length, 1);
  assert.equal(byName[0].ticker, "ENB");
  assert.equal(byName[0].cik_str, 1234);
});
