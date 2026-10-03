import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinanceData, Transaction } from "../src/types/index.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { PlanningData } from "../src/features/planning/types.ts";
import { monthReport } from "../src/features/planning/reportCalculations.ts";
import {
  experienceReport,
  periodReport,
  monthlyEvolution,
} from "../src/features/experience/calculations.ts";
const base = { user_id: "local", created_at: "2026-10-01T00:00:00Z" };
const tx = (
  id: string,
  type: Transaction["type"],
  amount: number,
  status: Transaction["status"] = "realized",
  date = "2026-10-01",
): Transaction => ({
  ...base,
  id,
  account_id: "cash",
  destination_account_id: null,
  category_id: null,
  type,
  amount_cents: amount,
  description: id,
  transaction_date: date,
  is_recurring: false,
  recurrence_frequency: null,
  status,
});
function fixture(): FinanceData {
  return {
    accounts: [
      {
        ...base,
        id: "cash",
        name: "Conta",
        type: "checking",
        initial_balance_cents: 10000,
        currency: "BRL",
        is_active: true,
      },
    ],
    categories: [],
    transactions: [
      tx("income", "income", 50000),
      tx("expense", "expense", 10000),
      tx("pending", "expense", 5000, "pending"),
      tx("future", "expense", 3000, "realized", "2026-11-01"),
    ],
    goals: [],
    goal_contributions: [],
  };
}
test("Home, planejamento e relatórios compartilham o fechamento e não alteram registros", () => {
  const data = fixture(),
    before = JSON.stringify(data),
    plan = structuredClone(emptyPlanning);
  const r = experienceReport(data, plan, "2026-10-02");
  assert.equal(
    r.current.closing,
    monthReport(data, plan, "2026-10-02").current.closing,
  );
  assert.equal(r.completed, 1);
  assert.equal(r.total, 2);
  assert.equal(r.percent, 50);
  assert.equal(JSON.stringify(data), before);
  data.transactions[2].status = "realized";
  assert.equal(experienceReport(data, plan, "2026-10-02").percent, 100);
});
test("categorias incluem consumo sem categoria e cartão uma vez, excluindo pagamento de fatura", () => {
  const data = fixture(),
    plan = structuredClone(emptyPlanning);
  data.transactions.push(tx("bill", "card_payment", 6000));
  plan.card_purchases.push({
    ...base,
    id: "purchase",
    card_id: "card",
    category_id: "uncategorized",
    amount_cents: 6000,
    description: "Compra",
    purchase_date: "2026-10-01",
    installments: 2,
    first_due_date: "2026-10-28",
    due_anchor_day: 28,
  });
  const r = periodReport(data, plan, "2026-10", "2026-10-02");
  assert.equal(r.expense, 16000);
  assert.equal(
    r.categories.reduce((s, c) => s + c.value, 0),
    r.expense,
  );
  assert.equal(r.saved, 68);
});
test("evolução não inventa meses e taxa fica indefinida sem renda", () => {
  const data = fixture();
  assert.equal(
    monthlyEvolution(data, emptyPlanning, "2026-10", "2026-10-02").length,
    1,
  );
  assert.equal(
    periodReport(data, emptyPlanning, "2026-09", "2026-10-02").saved,
    null,
  );
  data.transactions.push(tx("old", "expense", 20000, "realized", "2026-09-12"));
  assert.equal(
    monthlyEvolution(data, emptyPlanning, "2026-10", "2026-10-02").length,
    2,
  );
});
test("proteção usa saldo das contas selecionadas e atualiza após novos registros", () => {
  const data = fixture(),
    plan = structuredClone(emptyPlanning);
  data.accounts.push({
    ...data.accounts[0],
    id: "reserve",
    type: "savings",
    initial_balance_cents: 24000,
  });
  data.goals.push({
    ...base,
    id: "goal",
    name: "Reserva",
    is_emergency_reserve: true,
    target_amount_cents: 60000,
    initial_amount_cents: 0,
    target_date: null,
    is_active: true,
    essential_monthly_cents: 10000,
    reserve_months: 6,
  });
  plan.reserve_account_links.push({
    ...base,
    id: "link",
    goal_id: "goal",
    account_id: "reserve",
  });
  assert.equal(experienceReport(data, plan, "2026-10-02").protectedMonths, 2.4);
  data.transactions.push({
    ...tx("new", "income", 1000),
    account_id: "reserve",
  });
  assert.equal(experienceReport(data, plan, "2026-10-02").protectedMonths, 2.5);
});

test("progresso agrupa fatura paga e não conclui pagamentos parciais ou transferências internas", () => {
  const data = fixture(),
    plan: PlanningData = structuredClone(emptyPlanning);
  data.transactions = [tx("bill", "card_payment", 5000)];
  plan.credit_cards.push({
    ...base,
    id: "card",
    name: "Cartão",
    limit_cents: null,
    closing_day: 20,
    due_day: 28,
    payment_account_id: "cash",
    active: true,
  });
  plan.card_invoices.push({
    ...base,
    id: "invoice",
    card_id: "card",
    amount_cents: 10000,
    due_date: "2026-10-28",
    due_month: "2026-10",
    description: "Fatura",
    covered_at: base.created_at,
  });
  plan.card_payments.push({
    ...base,
    id: "p1",
    card_id: "card",
    transaction_id: "bill",
    amount_cents: 5000,
    payment_date: "2026-10-01",
    due_month: "2026-10",
  });
  const partial = experienceReport(data, plan, "2026-10-02");
  assert.equal(partial.completed, 0);
  assert.equal(partial.total, 1);
  data.accounts[0].type = "investment";
  const protectedBill = experienceReport(data, plan, "2026-10-02");
  assert.equal(protectedBill.current.cards, 0);
  assert.equal(protectedBill.cardsPending, 5000);
  data.accounts[0].type = "checking";
  data.transactions.push(tx("bill2", "card_payment", 5000));
  plan.card_payments.push({
    ...plan.card_payments[0],
    id: "p2",
    transaction_id: "bill2",
  });
  assert.equal(experienceReport(data, plan, "2026-10-02").completed, 1);
  data.accounts.push({ ...data.accounts[0], id: "cash2" });
  data.transactions.push({
    ...tx("internal", "transfer", 1000, "pending"),
    destination_account_id: "cash2",
  });
  assert.equal(experienceReport(data, plan, "2026-10-02").total, 1);
});
