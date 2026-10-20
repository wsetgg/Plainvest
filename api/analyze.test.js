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

test("reported combined long-term debt takes precedence over component sum", () => {
  const facts = makeFacts({
    Assets: [factRow("2026-03-31", 1000)],
    Liabilities: [factRow("2026-03-31", 500)],
    StockholdersEquity: [factRow("2026-03-31", 500)],
    LongTermDebtCurrent: [factRow("2026-03-31", 50)],
    LongTermDebtNoncurrent: [factRow("2026-03-31", 250)],
    LongTermDebt: [factRow("2026-03-31", 280)]
  });

  const sheet = balanceSheetObject(facts);
  assert.equal(sheet.funding.find(item => item.label === "Reported debt").value, 280);
});
