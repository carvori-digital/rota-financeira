import { test } from "node:test";
import assert from "node:assert/strict";
import { cdiPosition, parseSgs12 } from "../src/features/investments/cdi.ts";
import type {
  InvestmentMovement,
  InvestmentRate,
} from "../src/features/investments/types.ts";
const base = {
  user_id: "fixture",
  created_at: "2026-10-01T00:00:00Z",
  investment_id: "i",
};
const m = (
  id: string,
  date: string,
  amount: number,
  type: InvestmentMovement["type"] = "contribution",
): InvestmentMovement => ({
  ...base,
  id,
  date,
  amount_cents: amount,
  type,
  description: "fixture",
  transaction_id: null,
  source_transaction_id: null,
  source_account_id: null,
});
const h = parseSgs12(
  [
    { data: "01/10/2026", valor: "0.05" },
    { data: "02/10/2026", valor: "0.05" },
    { data: "05/10/2026", valor: "0.05" },
  ],
  "2026-10-01",
  "2026-10-06",
  "2026-10-06T00:00:00Z",
);
test("SGS unit is daily, 115 percent compounds each observation; weekends have no factor", () => {
  const r = cdiPosition(
    [m("a", "2026-10-01", 100000)],
    "2026-10-06",
    115,
    [],
    h,
  );
  assert.equal(r.current, Math.round(100000 * Math.pow(1.000575, 3)));
  assert.equal(r.contributed, 100000);
  assert.equal(r.complete, true);
});
test("each deposit, withdrawal and dated rate change follows chronology", () => {
  const rates: InvestmentRate[] = [
    { ...base, id: "rate", effective_date: "2026-10-05", percent: 100 },
  ];
  const r = cdiPosition(
    [
      m("a", "2026-10-01", 100000),
      m("b", "2026-10-02", 10000),
      m("w", "2026-10-05", 5000, "withdrawal"),
    ],
    "2026-10-06",
    115,
    rates,
    h,
  );
  assert.equal(
    r.current,
    Math.round(((100000 * 1.000575 + 10000) * 1.000575 - 5000) * 1.0005),
  );
  assert.equal(r.withdrawn, 5000);
  assert.equal(
    cdiPosition([m("a", "2026-10-01", 100000)], "2026-10-02", 115, rates, h)
      .current,
    100058,
  );
});
test("missing coverage never generates invented yield; synchronization is absolute, not new capital", () => {
  const rows = [
    m("a", "2026-10-01", 100000),
    {
      ...m("sync", "2026-10-05", 2000, "adjustment"),
      sync_value_cents: 102000,
    },
  ];
  let r = cdiPosition(rows, "2026-10-06", 115, []);
  assert.equal(r.complete, false);
  assert.equal(r.current, 102000);
  assert.equal(r.estimatedYield, null);
  r = cdiPosition(rows, "2026-10-06", 115, [], h);
  assert.equal(r.current, 102059);
  assert.equal(r.contributed, 100000);
  assert.equal(r.adjustments, 2000);
});
test("SGS malformed dates, duplicates and annual-rate confusion are rejected", () => {
  for (const values of [
    [{ data: "31/02/2026", valor: "0.05" }],
    [{ data: "01/10/2026", valor: "15" }],
    [{ data: "01/10/2026", valor: "NaN" }],
    [],
    [
      { data: "01/10/2026", valor: "0.05" },
      { data: "01/10/2026", valor: "0.05" },
    ],
  ])
    assert.throws(() => parseSgs12(values, "2026-10-01", "2026-10-06", "now"));
});

test("same-day reconstruction and synchronization use immutable ledger order", () => {
  const rows = [
    { ...m("zzz", "2026-10-05", 100000), ledger_order: 1 },
    {
      ...m("aaa", "2026-10-05", 2000, "adjustment"),
      sync_value_cents: 102000,
      ledger_order: 2,
    },
    { ...m("bbb", "2026-10-05", 10000), ledger_order: 3 },
  ];
  assert.equal(
    cdiPosition(rows, "2026-10-06", 115, [], h).current,
    Math.round(112000 * 1.000575),
  );
});
