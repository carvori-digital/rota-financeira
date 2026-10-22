import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account, FinanceData, Transaction } from "../src/types/index.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { PlanningData } from "../src/features/planning/types.ts";
import { balance } from "../src/utils/finance.ts";
import {
  overdraftPosition,
  bankingSummary,
  overdraftHistory,
  overdraftCharges,
  accountRecovery,
} from "../src/features/overdraft/calculations.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";
import { projection, realized } from "../src/features/planning/calculations.ts";
const asOf = "2026-10-22";
const a = {
  id: "itau",
  user_id: "u",
  created_at: "",
  name: "Itaú sintético",
  type: "checking",
  initial_balance_cents: 0,
  currency: "BRL",
  is_active: true,
} satisfies Account;
const data = (
  transactions: Transaction[] = [],
  accounts: Account[] = [a],
): FinanceData => ({
  accounts,
  transactions,
  categories: [],
  goals: [],
  goal_contributions: [],
});
const tx = (
  type: Transaction["type"],
  amount_cents: number,
  date = "2026-10-20",
  extra: Partial<Transaction> = {},
): Transaction => ({
  id: crypto.randomUUID(),
  user_id: "u",
  created_at: "",
  account_id: a.id,
  destination_account_id: null,
  category_id: null,
  type,
  amount_cents,
  description: "Sintético",
  transaction_date: date,
  is_recurring: false,
  recurrence_frequency: null,
  ...extra,
});
const v = {
  id: "v1",
  user_id: "u",
  created_at: "",
  account_id: a.id,
  revision: 1,
  tracking_start: "2026-10-15",
  effective_date: "2026-10-15",
  limit_cents: 100000,
  active: true,
  statement_model: "negative_balance" as const,
  monthly_interest_rate: null,
  contract_notes: "",
  change_reason: "Contrato sintético",
};
const plan: PlanningData = {
  ...emptyPlanning,
  account_overdraft_versions: [v],
};
test("positive, zero, partial, full and exceeded positions do not add credit to money", () => {
  for (const [b, used, remaining, state] of [
    [80000, 0, 100000, "Sem uso"],
    [0, 0, 100000, "Sem uso"],
    [-30000, 30000, 70000, "Em uso"],
    [-100000, 100000, 0, "Em uso"],
    [-110000, 110000, 0, "Acima do limite"],
  ] as const) {
    const account = { ...a, initial_balance_cents: b };
    const d = data([], [account]);
    const p = overdraftPosition(account, d, plan, asOf);
    assert.equal(p.used, used);
    assert.equal(p.remaining, remaining);
    assert.equal(p.state, state);
    assert.equal(bankingSummary(d, plan, asOf).net, b);
  }
});
test("Pix crosses zero; debit purchases and receipts reduce then eliminate the negative position", () => {
  const account = { ...a, initial_balance_cents: 10000 };
  let rows = [
    tx("transfer", 20000, undefined, { destination_account_id: "nubank" }),
    tx("expense", 20000),
  ];
  assert.equal(balance(account, rows, asOf), -30000);
  for (const [receipt, expected] of [
    [20000, -10000],
    [30000, 0],
    [50000, 20000],
  ]) {
    const d = data([...rows, tx("income", receipt)], [account]);
    const p = overdraftPosition(account, d, plan, asOf);
    assert.equal(p.bankBalance, expected);
    assert.equal(p.used, Math.max(0, -expected));
  }
  rows = [];
  assert.equal(balance(account, rows, asOf), 10000);
});
test("Nubank positive and Itaú negative consolidate algebraically; transfers preserve net wealth", () => {
  const nubank = { ...a, id: "nubank", initial_balance_cents: 80000 },
    itau = { ...a, initial_balance_cents: -30000 };
  const d = data([], [itau, nubank]);
  assert.deepEqual(bankingSummary(d, plan, asOf), {
    positive: 80000,
    negative: -30000,
    net: 50000,
    additionalCredit: 70000,
    unreconciled: 0,
  });
  const after = data(
    [
      tx("transfer", 20000, undefined, {
        account_id: "nubank",
        destination_account_id: a.id,
      }),
    ],
    [itau, nubank],
  );
  assert.equal(bankingSummary(after, plan, asOf).net, 50000);
  assert.equal(wealthSummary(d, plan, asOf).net, 50000);
  assert.equal(wealthSummary(after, plan, asOf).net, 50000);
  assert.equal(wealthSummary(d, plan, asOf).gross, 80000);
});
test("limit changes and deactivation preserve prior daily usage and negative debt", () => {
  const d = data([tx("expense", 30000)]);
  const p = {
    ...plan,
    account_overdraft_versions: [
      v,
      {
        ...v,
        id: "v2",
        revision: 2,
        effective_date: "2026-10-21",
        limit_cents: 20000,
      },
      { ...v, id: "v3", revision: 3, effective_date: asOf, active: false },
    ],
  };
  assert.equal(overdraftPosition(a, d, p, "2026-10-20").remaining, 70000);
  assert.equal(
    overdraftPosition(a, d, p, "2026-10-21").state,
    "Acima do limite",
  );
  assert.equal(overdraftPosition(a, d, p, asOf).used, 30000);
  assert.equal(overdraftPosition(a, d, p, asOf).remaining, 0);
  assert.equal(
    overdraftPosition({ ...a, is_active: false }, d, plan, asOf).remaining,
    0,
  );
});
test("retroactive entries before activation rebuild history without assuming a historical limit", () => {
  const d = data([
    tx("income", 20000, "2026-10-21"),
    tx("expense", 30000, "2026-10-10"),
  ]);
  const h = overdraftHistory(a, d, plan, asOf);
  assert.equal(h[0].date, "2026-10-10");
  assert.equal(h[0].bankBalance, -30000);
  assert.equal(h[0].terms, undefined);
  assert.equal(h.find((r) => r.date === "2026-10-21")?.used, 10000);
});
test("interest and IOF are real expenses once; forecasts and cancelled charges are excluded", () => {
  const rows = [
    tx("expense", 30000),
    tx("expense", 1000, undefined, { financial_charge: "overdraft_interest" }),
    tx("expense", 100, undefined, { financial_charge: "overdraft_iof" }),
    tx("expense", 900, undefined, {
      financial_charge: "overdraft_iof",
      status: "pending",
    }),
    tx("expense", 900, undefined, {
      financial_charge: "overdraft_interest",
      status: "cancelled",
    }),
  ];
  const d = data(rows);
  const c = overdraftCharges(a, d, asOf);
  assert.equal(c.interest, 1000);
  assert.equal(c.iof, 100);
  assert.equal(overdraftPosition(a, d, plan, asOf).used, 31100);
  assert.equal(realized(rows, [], "2026-10", asOf).expense, 31100);
});
test("assigned future salary offsets the deficit without becoming received; no income from unused credit", () => {
  const d = data([
    tx("expense", 30000),
    tx("income", 150000, "2026-10-30", { status: "pending" }),
  ]);
  const r = accountRecovery(a, d, plan, asOf);
  assert.equal(r.recoveryDate, "2026-10-30");
  assert.equal(r.projected, 120000);
  assert.equal(projection(d, plan, asOf)[0].closing, 120000);
  assert.equal(balance(a, d.transactions, asOf), -30000);
  assert.equal(
    accountRecovery(a, data([tx("expense", 30000)]), plan, asOf).recoveryDate,
    null,
  );
});
test("unknown statement model withholds utilization and available credit", () => {
  const p = {
    ...plan,
    account_overdraft_versions: [
      { ...v, statement_model: "needs_reconciliation" as const },
    ],
  };
  const d = data([tx("expense", 30000)]);
  assert.equal(overdraftPosition(a, d, p, asOf).used, null);
  assert.equal(bankingSummary(d, p, asOf).additionalCredit, 0);
  assert.equal(bankingSummary(d, p, asOf).negative, -30000);
});
test("reserve and technical investment accounts are excluded from banking with no double count", () => {
  const accounts = [
    { ...a, initial_balance_cents: -30000 },
    { ...a, id: "reserve", type: "savings", initial_balance_cents: 50000 },
    {
      ...a,
      id: "technical",
      initial_balance_cents: 90000,
      investment_retired: true,
    },
  ];
  const d = data([], accounts);
  const w = wealthSummary(d, plan, asOf);
  assert.equal(w.bank.net, -30000);
  assert.equal(w.invested, 50000);
  assert.equal(w.gross, 50000);
  assert.equal(w.net, 20000);
});
test("per-account projections respect transfers and do not allocate unassigned card payments", () => {
  const d = data(
    [
      tx("expense", 30000),
      tx("transfer", 50000, "2026-10-30", {
        status: "pending",
        account_id: "nubank",
        destination_account_id: a.id,
      }),
    ],
    [a, { ...a, id: "nubank", initial_balance_cents: 80000 }],
  );
  assert.equal(accountRecovery(a, d, plan, asOf).projected, 20000);
  assert.equal(projection(d, plan, asOf)[0].closing, 50000);
});

test("zero contracted limit cannot produce an invented utilization percentage", () => {
  const p = overdraftPosition(
    a,
    data([tx("expense", 100)]),
    { ...plan, account_overdraft_versions: [{ ...v, limit_cents: 0 }] },
    asOf,
  );
  assert.equal(p.state, "Acima do limite");
  assert.equal(p.remaining, 0);
  assert.equal(p.percent, null);
});
