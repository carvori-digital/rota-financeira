import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { FinanceData, Transaction } from "../src/types/index.ts";
import type { RecurringItem } from "../src/features/recurring/types.ts";
import { projection } from "../src/features/planning/calculations.ts";
import { monthlyCommitments } from "../src/features/planning/commitments.ts";
import { experienceReport } from "../src/features/experience/calculations.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";
import { buildFinancialExport } from "../src/features/export/calculations.ts";
const base = { user_id: "u", created_at: "2026-09-01T12:00:00Z" };
function fixture() {
  const data: FinanceData = {
    accounts: [
      {
        ...base,
        id: "cash",
        name: "Banco",
        type: "checking",
        is_active: true,
        currency: "BRL",
        initial_balance_cents: 100000,
      },
    ],
    categories: [],
    transactions: [],
    goals: [],
    goal_contributions: [],
  };
  const plan = structuredClone(emptyPlanning);
  const rule: RecurringItem = {
    ...base,
    id: "rule",
    name: "Conta",
    type: "expense",
    amount_cents: 10000,
    account_id: "cash",
    category_id: "cat",
    frequency: "monthly",
    start_date: "2026-10-13",
    end_date: null,
    active: true,
    is_essential: true,
  };
  plan.recurring_items = [rule];
  const tx: Transaction = {
    ...base,
    id: "tx",
    type: "expense",
    account_id: "cash",
    category_id: "cat",
    destination_account_id: null,
    amount_cents: 4000,
    description: "Conta original",
    transaction_date: "2026-10-13",
    status: "realized",
    is_recurring: true,
    recurrence_frequency: "monthly",
  };
  return { data, plan, rule, tx };
}
test("P1: configuration edits cannot reclassify recorded variable income or reopen its verified payment", () => {
  const { data, plan, rule, tx } = fixture();
  data.transactions = [{ ...tx, type: "income", amount_cents: 5000 }];
  plan.recurring_occurrences = [
    {
      ...base,
      id: "o",
      recurring_item_id: "rule",
      due_date: "2026-10-13",
      status: "recorded",
      transaction_id: "tx",
      amount_cents: 20000,
      terms: {
        name: "Comissão original",
        type: "income",
        account_id: "cash",
        category_id: "income",
        frequency: "monthly",
      },
    },
  ];
  rule.type = "expense";
  rule.amount_cents = 90000;
  rule.name = "Configuração futura";
  const c = projection(data, plan, "2026-10-15")[0].items.find(
    (c) => c.occurrenceId === "o",
  )!;
  assert.equal(c.name, "Comissão original");
  assert.equal(c.direction, "income");
  assert.equal(c.amount, 15000);
  assert.equal(c.impact, 15000);
  assert.equal(monthlyCommitments(data, plan, "2026-10-15").length, 0);
});
test("P1: planned obligation is independent of changed start/frequency and paused configuration", () => {
  const { data, plan, rule } = fixture();
  plan.recurring_occurrences = [
    {
      ...base,
      id: "o",
      recurring_item_id: "rule",
      due_date: "2026-10-13",
      status: "planned",
      transaction_id: null,
      amount_cents: 10000,
      terms: {
        name: "Conta original",
        type: "expense",
        account_id: "cash",
        category_id: "cat",
        frequency: "monthly",
      },
    },
  ];
  Object.assign(rule, {
    start_date: "2026-11-20",
    frequency: "weekly",
    active: false,
    amount_cents: 30000,
  });
  const c = projection(data, plan, "2026-10-15")[0].items[0];
  assert.equal(c.amount, 10000);
  assert.equal(c.name, "Conta original");
  assert.equal(c.canResolve, true);
  plan.recurring_occurrences.push({
    ...plan.recurring_occurrences[0],
    id: "future",
    due_date: "2026-11-13",
  });
  assert.ok(
    projection(data, plan, "2026-10-15")[1].items.some(
      (c) =>
        c.occurrenceId === "future" ||
        (c.entity === rule.id && c.due === "2026-11-13"),
    ),
  );
});
test("P1: pending cash date and obligation competence remain separate", () => {
  const { data, plan, tx } = fixture();
  data.transactions = [
    {
      ...tx,
      status: "pending",
      amount_cents: 10000,
      transaction_date: "2026-11-20",
    },
  ];
  plan.recurring_occurrences = [
    {
      ...base,
      id: "o",
      recurring_item_id: "rule",
      due_date: "2026-10-13",
      status: "recorded",
      transaction_id: "tx",
      amount_cents: 10000,
    },
  ];
  const months = projection(data, plan, "2026-10-15");
  assert.equal(months[0].commitments, 0);
  assert.equal(months[1].commitments, 20000);
  const c = monthlyCommitments(data, plan, "2026-10-15")[0];
  assert.equal(c.due, "2026-10-13");
  assert.equal(c.status, "pending");
});
test("P1: late settlement stays visible in the settlement month and exports do not duplicate competence", () => {
  const { data, plan, rule, tx } = fixture();
  rule.start_date = "2026-09-13";
  data.transactions = [
    { ...tx, amount_cents: 10000, transaction_date: "2026-10-15" },
  ];
  plan.recurring_occurrences = [
    {
      ...base,
      id: "o",
      recurring_item_id: "rule",
      due_date: "2026-09-13",
      status: "recorded",
      transaction_id: "tx",
      amount_cents: 10000,
    },
  ];
  const r = experienceReport(data, plan, "2026-10-15");
  assert.equal(r.completed, 1);
  assert.equal(r.total, 2);
  const exp = buildFinancialExport(
    {
      owner: "u",
      generated_at: "2026-10-15T12:00:00Z",
      finance: data,
      plan,
      confirmations: [],
      counts: {},
    },
    { start: "2026-09-01", end: "2026-10-15", detailed: true },
  );
  assert.equal(exp.scheduled.commitments.length, 2);
  assert.equal(new Set(exp.scheduled.commitments.map((c) => c.id)).size, 2);
  assert.equal(exp.realized.expense_cents, 10000);
});
test("P1: card obligation uses the same verified payment cutoff in cash projection, report and wealth", () => {
  const { data, plan, tx } = fixture();
  plan.recurring_items = [];
  plan.credit_cards = [
    {
      ...base,
      id: "card",
      name: "Cartão",
      active: true,
      limit_cents: null,
      closing_day: 1,
      due_day: 13,
      payment_account_id: "cash",
    },
  ];
  plan.card_invoices = [
    {
      ...base,
      id: "inv",
      card_id: "card",
      due_date: "2026-09-13",
      due_month: "2026-09",
      amount_cents: 10000,
      description: "Fatura",
      covered_at: "2026-09-01T00:00:00Z",
    },
  ];
  plan.card_payments = [
    {
      ...base,
      id: "pay",
      card_id: "card",
      due_month: "2026-09",
      transaction_id: "tx",
      amount_cents: 10000,
      payment_date: "2026-10-15",
    },
  ];
  data.transactions = [
    {
      ...tx,
      type: "card_payment",
      category_id: null,
      payment_reference: "card",
      amount_cents: 10000,
      transaction_date: "2026-10-15",
    },
  ];
  const asOf = "2026-09-15";
  assert.equal(projection(data, plan, asOf)[0].cards, 10000);
  assert.equal(monthlyCommitments(data, plan, asOf)[0].status, "pending");
  assert.equal(wealthSummary(data, plan, asOf).cards, 10000);
});
test("P1: partial invoice funded by reserve has no fabricated effect on operational cash", () => {
  const { data, plan } = fixture();
  plan.recurring_items = [];
  data.accounts.push({
    ...data.accounts[0],
    id: "reserve",
    name: "Reserva",
    type: "savings",
  });
  plan.credit_cards = [
    {
      ...base,
      id: "card",
      name: "Cartão",
      active: true,
      limit_cents: null,
      closing_day: 1,
      due_day: 13,
      payment_account_id: "reserve",
    },
  ];
  plan.card_invoices = [
    {
      ...base,
      id: "inv",
      card_id: "card",
      due_date: "2026-10-13",
      due_month: "2026-10",
      amount_cents: 10000,
      description: "Fatura",
      covered_at: base.created_at,
    },
  ];
  const r = experienceReport(data, plan, "2026-10-15");
  assert.equal(r.current.commitments, 0);
  assert.equal(r.groups.find((g) => g.key === "cards")!.total, 0);
  assert.equal(r.pending[0].amount, 10000);
});
test("P1: future card purchases affect forecasts before they affect current wealth", () => {
  const { data, plan } = fixture();
  plan.recurring_items = [];
  plan.credit_cards = [
    {
      ...base,
      id: "card",
      name: "Cartão",
      active: true,
      limit_cents: null,
      closing_day: 1,
      due_day: 13,
      payment_account_id: "cash",
    },
  ];
  plan.card_purchases = [
    {
      ...base,
      id: "purchase",
      card_id: "card",
      category_id: "cat",
      amount_cents: 10000,
      description: "Compra futura",
      purchase_date: "2026-11-01",
      installments: 1,
      first_due_date: "2026-11-13",
      due_anchor_day: 13,
    },
  ];
  assert.equal(wealthSummary(data, plan, "2026-10-15").cards, 0);
  assert.equal(projection(data, plan, "2026-10-15")[1].cards, 10000);
  assert.equal(wealthSummary(data, plan, "2026-11-01").cards, 10000);
});
test("P1: archived partial debt funded by reserve has the same cash effect across screens", () => {
  const { data, plan, tx } = fixture();
  plan.recurring_items = [];
  data.accounts.push({ ...data.accounts[0], id: "reserve", type: "savings" });
  data.transactions = [{ ...tx, account_id: "reserve", amount_cents: 4000 }];
  plan.debts = [
    {
      ...base,
      id: "debt",
      name: "Dívida",
      original_amount_cents: 10000,
      remaining_amount_cents: 6000,
      installment_amount_cents: 10000,
      next_due_date: "2026-10-13",
      due_anchor_day: 13,
      installment_paid_cents: 4000,
      payment_account_id: "reserve",
      active: false,
    },
  ];
  plan.debt_payments = [
    {
      ...base,
      id: "pay",
      debt_id: "debt",
      transaction_id: "tx",
      amount_cents: 4000,
      payment_date: "2026-10-13",
      scheduled_date: "2026-10-13",
      obligation_amount_cents: 10000,
    },
  ];
  assert.equal(projection(data, plan, "2026-10-15")[0].commitments, 0);
  assert.equal(monthlyCommitments(data, plan, "2026-10-15")[0].impact, 0);
  assert.equal(
    experienceReport(data, plan, "2026-10-15").groups.find(
      (g) => g.key === "debts",
    )!.total,
    0,
  );
});
