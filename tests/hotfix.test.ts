import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { FinanceData, Transaction } from "../src/types/index.ts";
import { monthlyCommitments } from "../src/features/planning/commitments.ts";
import { projection } from "../src/features/planning/calculations.ts";
import { experienceReport } from "../src/features/experience/calculations.ts";
import { monthReport } from "../src/features/planning/reportCalculations.ts";
import { isLegacyReserveAccount, balance } from "../src/utils/finance.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";
import { buildFinancialExport } from "../src/features/export/calculations.ts";
const base = { user_id: "a", created_at: "2026-10-01T12:00:00Z" };
const transaction = (
  id: string,
  amount: number,
  status: Transaction["status"] = "realized",
): Transaction => ({
  ...base,
  id,
  account_id: "cash",
  destination_account_id: null,
  category_id: "cat",
  type: "expense",
  amount_cents: amount,
  description: "Cemig",
  transaction_date: "2026-10-13",
  status,
  is_recurring: true,
  recurrence_frequency: "monthly",
});
export function hotfixFixture() {
  const data: FinanceData = {
    accounts: [
      {
        ...base,
        id: "cash",
        name: "Banco",
        type: "checking",
        initial_balance_cents: 100000,
        currency: "BRL",
        is_active: true,
      },
    ],
    categories: [],
    transactions: [transaction("october", 36337)],
    goals: [],
    goal_contributions: [],
  };
  const plan = structuredClone(emptyPlanning);
  plan.recurring_items = [
    {
      ...base,
      id: "rule",
      name: "Cemig",
      type: "expense",
      amount_cents: 39678,
      account_id: "cash",
      category_id: "cat",
      frequency: "monthly",
      start_date: "2026-10-13",
      end_date: null,
      active: true,
      is_essential: true,
    },
  ];
  plan.recurring_occurrences = [
    {
      ...base,
      id: "occ",
      recurring_item_id: "rule",
      due_date: "2026-10-13",
      status: "recorded",
      transaction_id: "october",
      amount_cents: 36337,
    },
  ];
  return { data, plan };
}
test("Cemig October paid, November forecast: no fictitious R$33.41 residual in Home, report or projection", () => {
  const { data, plan } = hotfixFixture(),
    before = JSON.stringify({ data, plan });
  const c = monthlyCommitments(data, plan, "2026-10-15");
  assert.equal(c.length, 1);
  assert.equal(c[0].status, "completed");
  assert.equal(c[0].amount, 36337);
  assert.equal(c[0].paid, 36337);
  assert.equal(c[0].impact, 0);
  assert.equal(c[0].canResolve, false);
  const r = experienceReport(data, plan, "2026-10-15");
  assert.equal(r.completed, 1);
  assert.equal(r.total, 1);
  assert.equal(r.pending.length, 0);
  assert.equal(r.current.commitments, 0);
  assert.equal(
    monthReport(data, plan, "2026-10-15").groups.flatMap((g) => g.items).length,
    1,
  );
  const nov = projection(data, plan, "2026-10-15")[1];
  assert.equal(nov.items.length, 1);
  assert.equal(nov.items[0].amount, 39678);
  assert.equal(nov.commitments, 39678);
  assert.equal(JSON.stringify({ data, plan }), before);
});
test("future rule edits cannot reopen snapshot or legacy verified payment; missing references cannot be resolved", () => {
  const { data, plan } = hotfixFixture();
  plan.recurring_items[0].amount_cents = 50000;
  for (const snapshot of [36337, undefined]) {
    plan.recurring_occurrences[0].amount_cents = snapshot;
    const c = monthlyCommitments(data, plan, "2026-10-15")[0];
    assert.equal(c.status, "completed");
    assert.equal(c.amount, 36337);
  }
  data.transactions = [];
  const c = monthlyCommitments(data, plan, "2026-10-15")[0];
  assert.equal(c.status, "pending");
  assert.equal(c.paid, 0);
  assert.equal(c.canResolve, false);
  assert.equal(c.amount, 0);
  plan.recurring_items = [];
  assert.deepEqual(monthlyCommitments(data, plan, "2026-10-15"), []);
});
test("planned amount is per occurrence, survives rule edits, skipped dates do not recur", () => {
  const { data, plan } = hotfixFixture();
  plan.recurring_occurrences.push({
    ...base,
    id: "nov",
    recurring_item_id: "rule",
    due_date: "2026-11-13",
    status: "planned",
    transaction_id: null,
    amount_cents: 39678,
  });
  plan.recurring_items[0].amount_cents = 50000;
  let months = projection(data, plan, "2026-10-15");
  assert.equal(months[1].commitments, 39678);
  assert.equal(months[2].commitments, 50000);
  plan.recurring_occurrences[1].status = "skipped";
  months = projection(data, plan, "2026-10-15");
  assert.equal(months[1].items.length, 0);
  assert.equal(
    balance(data.accounts[0], data.transactions, "2026-10-15"),
    63663,
  );
});
test("real partial remainder, supplementary integral payment and canonical identity appear once", () => {
  const { data, plan } = hotfixFixture();
  plan.recurring_occurrences[0].amount_cents = 39678;
  let c = monthlyCommitments(data, plan, "2026-10-15")[0];
  assert.equal(c.status, "pending");
  assert.equal(c.impact, -3341);
  assert.equal(c.entity, "rule");
  assert.equal(c.transactionId, "october");
  assert.equal(c.canResolve, true);
  assert.equal(projection(data, plan, "2026-10-15")[0].commitments, 3341);
  data.transactions.push(transaction("remaining", 3341));
  plan.recurring_payments = [
    {
      ...base,
      id: "remaining",
      occurrence_id: "occ",
      transaction_id: "remaining",
    },
  ];
  c = monthlyCommitments(data, plan, "2026-10-15")[0];
  assert.equal(c.status, "completed");
  assert.equal(c.paid, 39678);
  assert.equal(c.canResolve, false);
  assert.equal(monthlyCommitments(data, plan, "2026-10-15").length, 1);
  assert.equal(projection(data, plan, "2026-10-15")[0].items.length, 0);
});
test("pending linked transaction keeps rule, occurrence and transaction identities separate", () => {
  const { data, plan } = hotfixFixture();
  data.transactions[0].status = "pending";
  const c = monthlyCommitments(data, plan, "2026-10-15")[0];
  assert.equal(c.entity, "rule");
  assert.equal(c.transactionId, "october");
  assert.equal(c.occurrenceId, "occ");
  assert.equal(c.status, "pending");
  assert.equal(c.paid, 0);
  assert.equal(c.canResolve, true);
  assert.equal(projection(data, plan, "2026-10-15")[0].items.length, 1);
});
test("archived rule retains verified history, creates no new forecasts; cancelled/skipped does not charge", () => {
  const { data, plan } = hotfixFixture();
  plan.recurring_items[0].active = false;
  assert.equal(
    monthlyCommitments(data, plan, "2026-10-15")[0].status,
    "completed",
  );
  assert.equal(
    projection(data, plan, "2026-10-15").flatMap((m) => m.items).length,
    0,
  );
  data.transactions[0].status = "cancelled";
  assert.equal(monthlyCommitments(data, plan, "2026-10-15").length, 0);
  plan.recurring_occurrences[0].status = "skipped";
  plan.recurring_occurrences[0].transaction_id = null;
  assert.equal(monthlyCommitments(data, plan, "2026-10-15").length, 0);
});
test("retired Reserva stays technical; new Turbo and migrated history survive with wealth counted once", () => {
  const { data, plan } = hotfixFixture();
  data.transactions = [];
  data.accounts.push({
    ...base,
    id: "old",
    name: "Reserva excluída",
    type: "investment",
    initial_balance_cents: 48866,
    currency: "BRL",
    is_active: false,
    investment_retired: true,
  });
  data.accounts.push({
    ...base,
    id: "migrated",
    name: "Migrada",
    type: "savings",
    initial_balance_cents: 25000,
    currency: "BRL",
    is_active: false,
    investment_id: "migrated-position",
  });
  plan.investments = [
    {
      ...base,
      id: "turbo",
      name: "Caixinha Turbo",
      institution: "Nubank",
      type: "RDB",
      initial_date: "2026-10-01",
      yield_type: "manual",
      yield_rate: 0,
      is_emergency_reserve: true,
      active: true,
      source_account_id: null,
      updated_at: base.created_at,
    },
    {
      ...base,
      id: "migrated-position",
      name: "Migrada",
      institution: "Banco",
      type: "RDB",
      initial_date: "2026-10-01",
      yield_type: "manual",
      yield_rate: 0,
      is_emergency_reserve: false,
      active: true,
      source_account_id: "migrated",
      updated_at: base.created_at,
    },
  ];
  plan.investment_movements = plan.investments.map((i, n) => ({
    ...base,
    id: "movement" + n,
    investment_id: i.id,
    type: "adjustment",
    amount_cents: n ? 25000 : 59069,
    date: "2026-10-01",
    description: "Posição sintética",
    sync_value_cents: n ? 25000 : 59069,
    transaction_id: null,
    source_transaction_id: null,
    source_account_id: null,
  }));
  const before = JSON.stringify({ data, plan });
  assert.equal(data.accounts.filter(isLegacyReserveAccount).length, 0);
  const r = wealthSummary(data, plan, "2026-10-15");
  assert.equal(r.invested, 84069);
  assert.equal(r.gross, 184069);
  assert.equal(r.reserve, 59069);
  assert.equal(
    balance(data.accounts[1], data.transactions, "2026-10-15"),
    48866,
  );
  const exp = buildFinancialExport(
    {
      owner: "a",
      generated_at: "2026-10-15T12:00:00Z",
      finance: data,
      plan,
      confirmations: [],
      counts: {},
    },
    { start: "2026-10-01", end: "2026-10-15", detailed: true },
  );
  assert.equal(exp.accounts.length, 1);
  assert.equal(exp.accounts[0].id, "cash");
  assert.equal(JSON.stringify({ data, plan }), before);
});
