import { test } from "node:test";
import assert from "node:assert/strict";
import { monthlyCommitments } from "../src/features/planning/commitments.ts";
import { experienceReport } from "../src/features/experience/calculations.ts";
import { monthReport } from "../src/features/planning/reportCalculations.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { FinanceData, Transaction } from "../src/types/index.ts";
const base = { user_id: "fixture", created_at: "2026-10-01T00:00:00Z" };
const tx = (
  id: string,
  type: Transaction["type"],
  status: Transaction["status"] = "realized",
): Transaction => ({
  ...base,
  id,
  type,
  status,
  account_id: "cash",
  destination_account_id: null,
  category_id: null,
  amount_cents: 1000,
  description: id,
  transaction_date: "2026-10-02",
  is_recurring: false,
  recurrence_frequency: null,
});
function fixture() {
  const data: FinanceData = {
    accounts: [
      {
        ...base,
        id: "cash",
        name: "Cash",
        type: "checking",
        initial_balance_cents: 100000,
        currency: "BRL",
        is_active: true,
      },
    ],
    categories: [],
    transactions: [],
    goals: [],
    goal_contributions: [],
  };
  return { data, plan: structuredClone(emptyPlanning) };
}
test("variable, income, transfers and investment adjustments do not count", () => {
  const { data, plan } = fixture();
  data.transactions = [
    tx("snack", "expense"),
    tx("income", "income"),
    tx("transfer", "transfer"),
    tx("investment", "adjustment"),
  ];
  assert.deepEqual(monthlyCommitments(data, plan, "2026-10-10"), []);
});
test("scheduled pending and completed share Home/Planning model; no mutations", () => {
  const { data, plan } = fixture();
  data.transactions = [
    tx("pending", "expense", "pending"),
    { ...tx("paid", "expense"), financial_commitment: true },
    { ...tx("cancel", "expense", "cancelled"), financial_commitment: true },
  ];
  const before = JSON.stringify({ data, plan });
  const a = experienceReport(data, plan, "2026-10-10"),
    b = monthReport(data, plan, "2026-10-10");
  assert.equal(a.completed, 1);
  assert.equal(a.total, 2);
  assert.equal(b.groups.flatMap((g) => g.items).length, a.total);
  assert.equal(JSON.stringify({ data, plan }), before);
});
test("recurrence appears once and only verified integral payment completes", () => {
  const { data, plan } = fixture();
  plan.recurring_items = [
    {
      ...base,
      id: "rule",
      name: "Rent",
      type: "expense",
      amount_cents: 1000,
      account_id: "cash",
      category_id: "cat",
      frequency: "monthly",
      start_date: "2026-10-02",
      end_date: null,
      active: true,
      is_essential: true,
    },
  ];
  data.transactions = [tx("rent", "expense")];
  plan.recurring_occurrences = [
    {
      ...base,
      id: "occ",
      recurring_item_id: "rule",
      due_date: "2026-10-02",
      status: "recorded",
      transaction_id: "rent",
    },
  ];
  let r = monthlyCommitments(data, plan, "2026-10-10");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "completed");
  data.transactions[0].amount_cents = 500;
  r = monthlyCommitments(data, plan, "2026-10-10");
  assert.equal(r[0].status, "pending");
  assert.equal(r[0].impact, -500);
});
test("debt historical payments require captured obligation; partial payments stay pending", () => {
  const { data, plan } = fixture();
  plan.debts = [
    {
      ...base,
      id: "debt",
      name: "Debt",
      original_amount_cents: 2000,
      remaining_amount_cents: 500,
      installment_amount_cents: 1000,
      next_due_date: "2026-10-02",
      due_anchor_day: 2,
      installment_paid_cents: 500,
      payment_account_id: "cash",
      active: true,
    },
  ];
  data.transactions = [tx("part", "expense")];
  data.transactions[0].amount_cents = 500;
  plan.debt_payments = [
    {
      ...base,
      id: "p",
      debt_id: "debt",
      transaction_id: "part",
      amount_cents: 500,
      payment_date: "2026-10-02",
      scheduled_date: "2026-10-02",
      obligation_amount_cents: 1000,
    },
  ];
  let r = monthlyCommitments(data, plan, "2026-10-10");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "pending");
  plan.debts[0].remaining_amount_cents = 0;
  plan.debts[0].next_due_date = null;
  plan.debt_payments[0].obligation_amount_cents = undefined;
  assert.equal(monthlyCommitments(data, plan, "2026-10-10").length, 0);
});
