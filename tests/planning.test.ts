import { monthReport } from "../src/features/planning/reportCalculations.ts";
import { balanceSummary } from "../src/utils/finance.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { projection, realized } from "../src/features/planning/calculations.ts";
import {
  firstInvoiceDate,
  purchaseInstallments,
  invoices,
} from "../src/features/cards/calculations.ts";
import { debtInstallments } from "../src/features/debts/calculations.ts";
import {
  recurringDates,
  essentialMonthly,
} from "../src/features/recurring/calculations.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { PlanningData } from "../src/features/planning/types.ts";
import type { FinanceData, Transaction } from "../src/types/index.ts";
import type { CardPurchase, CreditCard } from "../src/features/cards/types.ts";
import type { Debt } from "../src/features/debts/types.ts";
import type { RecurringItem } from "../src/features/recurring/types.ts";
const base = { user_id: "u", created_at: "2026-10-01T00:00:00Z" };
const card: CreditCard = {
  ...base,
  id: "card",
  name: "Cartão",
  active: true,
  limit_cents: null,
  closing_day: 20,
  due_day: 28,
  payment_account_id: "cash",
};
const purchase: CardPurchase = {
  ...base,
  id: "purchase",
  card_id: "card",
  category_id: "expense",
  amount_cents: 10001,
  description: "Compra",
  purchase_date: "2026-10-01",
  installments: 3,
  first_due_date: "2026-10-28",
  due_anchor_day: 28,
};
const rule: RecurringItem = {
  ...base,
  id: "rule",
  name: "Aluguel",
  type: "expense",
  amount_cents: 2000,
  account_id: "cash",
  category_id: "expense",
  frequency: "monthly",
  start_date: "2026-10-01",
  end_date: null,
  active: true,
  is_essential: true,
};
const debt: Debt = {
  ...base,
  id: "debt",
  name: "Dívida",
  original_amount_cents: 2500,
  remaining_amount_cents: 2200,
  installment_amount_cents: 1000,
  installment_paid_cents: 300,
  next_due_date: "2026-10-31",
  due_anchor_day: 31,
  payment_account_id: "cash",
  active: true,
};
const data = (): FinanceData => ({
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
    {
      ...base,
      id: "reserve",
      name: "Reserva",
      type: "savings",
      initial_balance_cents: 5000,
      currency: "BRL",
      is_active: true,
    },
  ],
  categories: [],
  transactions: [],
  goals: [],
  goal_contributions: [],
});
const plan = (overrides: Partial<PlanningData> = {}): PlanningData => ({
  ...structuredClone(emptyPlanning),
  ...overrides,
});
const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  ...base,
  id: "tx",
  account_id: "cash",
  destination_account_id: null,
  category_id: "expense",
  type: "expense",
  amount_cents: 300,
  description: "Lançamento",
  transaction_date: "2026-10-01",
  is_recurring: false,
  recurrence_frequency: null,
  ...overrides,
});

test("parcelas preservam centavos, fechamento e dia âncora em fevereiro", () => {
  assert.deepEqual(
    purchaseInstallments(purchase).map((i) => i.amount),
    [3334, 3334, 3333],
  );
  assert.equal(firstInvoiceDate("2026-10-20", 20, 28), "2026-10-28");
  assert.equal(firstInvoiceDate("2026-10-21", 20, 28), "2026-11-28");
  assert.equal(firstInvoiceDate("2026-10-01", 20, 10), "2026-11-10");
  assert.deepEqual(
    purchaseInstallments({
      ...purchase,
      first_due_date: "2027-01-31",
      due_anchor_day: 31,
    }).map((i) => i.date),
    ["2027-01-31", "2027-02-28", "2027-03-31"],
  );
});
test("fatura manual cobre compras anteriores só no mês informado", () => {
  const manual = {
    ...base,
    id: "invoice",
    card_id: "card",
    due_date: "2026-10-28",
    due_month: "2026-10",
    amount_cents: 5000,
    covered_at: "2026-10-02T00:00:00Z",
    description: "",
  };
  const later = {
    ...purchase,
    id: "later",
    installments: 1,
    amount_cents: 1000,
    created_at: "2026-10-03T00:00:00Z",
  };
  const bills = invoices(
    [card],
    [purchase, later],
    [manual],
    [
      {
        ...base,
        id: "payment",
        card_id: "card",
        due_month: "2026-10",
        transaction_id: "tx",
        amount_cents: 500,
        payment_date: "2026-10-01",
      },
    ],
  );
  assert.deepEqual(
    bills.map((i) => i.total),
    [6000, 3334, 3333],
  );
  assert.equal(bills[0].pending, 5500);
});
test("pagamento de cartão reduz saldo e pendência sem repetir consumo", () => {
  const d = data();
  d.transactions = [
    transaction({
      type: "card_payment",
      category_id: null,
      payment_reference: "card",
      amount_cents: 500,
    }),
  ];
  const p = plan({
    credit_cards: [card],
    card_purchases: [{ ...purchase, installments: 1, amount_cents: 1000 }],
    card_payments: [
      {
        ...base,
        id: "payment",
        card_id: "card",
        due_month: "2026-10",
        transaction_id: "tx",
        amount_cents: 500,
        payment_date: "2026-10-01",
      },
    ],
  });
  const m = projection(d, p, "2026-10-01")[0];
  assert.equal(m.opening, 9500);
  assert.equal(m.cards, 500);
  assert.equal(m.closing, 9000);
  assert.equal(
    realized(d.transactions, p.card_purchases, "2026-10", "2026-10-01").expense,
    1000,
  );
});
test("recorrência realizada ou pulada sai da previsão e não duplica transação", () => {
  const d = data();
  d.transactions = [transaction({ id: "done", amount_cents: 2000 })];
  const p = plan({
    recurring_items: [rule],
    recurring_occurrences: [
      {
        ...base,
        id: "done",
        recurring_item_id: "rule",
        due_date: "2026-10-01",
        status: "recorded",
        transaction_id: "done",
      },
      {
        ...base,
        id: "skip",
        recurring_item_id: "rule",
        due_date: "2026-11-01",
        status: "skipped",
        transaction_id: null,
      },
    ],
  });
  const m = projection(d, p, "2026-10-01");
  assert.equal(m[0].opening, 8000);
  assert.equal(m[0].recurring, 0);
  assert.equal(m[1].recurring, 0);
  assert.equal(m[2].recurring, 2000);
});
test("transação futura vinculada à recorrência aparece uma única vez e não muda saldo atual", () => {
  const d = data();
  d.transactions = [
    transaction({ transaction_date: "2026-10-20", amount_cents: 2000 }),
  ];
  const p = plan({
    recurring_items: [{ ...rule, start_date: "2026-10-20" }],
    recurring_occurrences: [
      {
        ...base,
        id: "occ",
        recurring_item_id: "rule",
        due_date: "2026-10-20",
        status: "recorded",
        transaction_id: "tx",
      },
    ],
  });
  const m = projection(d, p, "2026-10-01")[0];
  assert.equal(m.opening, 10000);
  assert.equal(m.items.length, 1);
  assert.equal(m.closing, 8000);
  assert.equal(
    realized(d.transactions, [], "2026-10", "2026-10-01").expense,
    0,
  );
});
test("pagamento parcial e parcela final nunca ultrapassam saldo da dívida", () => {
  const result = debtInstallments(debt, "2027-02-28");
  assert.deepEqual(result, [
    { date: "2026-10-31", amount: 700 },
    { date: "2026-11-30", amount: 1000 },
    { date: "2026-12-31", amount: 500 },
  ]);
  assert.equal(
    result.reduce((s, i) => s + i.amount, 0),
    2200,
  );
  assert.deepEqual(
    debtInstallments({ ...debt, remaining_amount_cents: 0 }, "2027-02-28"),
    [],
  );
});
test("pagamento de dívida aparece realizado e saldo restante é projetado uma vez", () => {
  const d = data();
  d.transactions = [transaction({ payment_reference: "debt" })];
  const m = projection(d, plan({ debts: [debt] }), "2026-10-01");
  assert.equal(m[0].opening, 9700);
  assert.equal(
    m.reduce((s, i) => s + i.debts, 0),
    2200,
  );
  assert.equal(m.at(-1)!.closing, 7500);
  assert.equal(
    realized(d.transactions, [], "2026-10", "2026-10-01").expense,
    300,
  );
});
test("transferências internas não geram consumo; aporte futuro afeta só saldo projetado", () => {
  const d = data();
  d.transactions = [
    transaction({
      type: "transfer",
      category_id: null,
      destination_account_id: "reserve",
      transaction_date: "2026-10-20",
      amount_cents: 1000,
    }),
  ];
  const m = projection(d, plan(), "2026-10-01")[0];
  assert.equal(m.opening, 10000);
  assert.equal(m.transfers, -1000);
  assert.equal(m.closing, 9000);
  assert.equal(
    realized(d.transactions, [], "2026-10", "2026-10-31").expense,
    0,
  );
});
test("vencidos ficam pendentes no mês atual e dívida pausada sai da previsão", () => {
  const p = plan({
    recurring_items: [{ ...rule, start_date: "2026-09-01" }],
    debts: [{ ...debt, active: false }],
    credit_cards: [{ ...card, active: false }],
    card_purchases: [
      { ...purchase, first_due_date: "2026-09-28", installments: 1 },
    ],
  });
  const m = projection(data(), p, "2026-10-01");
  assert.equal(m[0].recurring, 4000);
  assert.equal(m[0].cards, 10001);
  assert.equal(m[0].debts, 0);
  assert.equal(m[0].closing, -4001);
});
test("recorrências respeitam término, semanas, ano bissexto e custo essencial", () => {
  assert.deepEqual(
    recurringDates(
      { ...rule, start_date: "2026-01-31", end_date: "2026-03-31" },
      "2026-04-30",
    ),
    ["2026-01-31", "2026-02-28", "2026-03-31"],
  );
  assert.deepEqual(
    recurringDates(
      { ...rule, start_date: "2024-02-29", frequency: "yearly" },
      "2026-02-28",
    ),
    ["2024-02-29", "2025-02-28", "2026-02-28"],
  );
  assert.equal(
    essentialMonthly(
      [
        { ...rule, amount_cents: 1200, frequency: "yearly" },
        { ...rule, id: "weekly", amount_cents: 1200, frequency: "weekly" },
      ],
      "2026-10-01",
    ),
    5300,
  );
});

test("pendentes vencidos não alteram saldo e confirmação remove projeção uma vez", () => {
  const d = data();
  d.transactions = [
    transaction({
      status: "pending",
      transaction_date: "2026-09-20",
      amount_cents: 1000,
    }),
  ];
  let r = projection(d, plan(), "2026-10-02")[0];
  assert.equal(r.opening, 10000);
  assert.equal(r.commitments, 1000);
  assert.equal(r.closing, 9000);
  d.transactions[0].status = "realized";
  d.transactions[0].transaction_date = "2026-10-02";
  r = projection(d, plan(), "2026-10-02")[0];
  assert.equal(r.opening, 9000);
  assert.equal(r.commitments, 0);
  assert.equal(r.closing, 9000);
});
test("cancelado nunca movimenta saldo nem compromissos; realizado futuro aguarda data", () => {
  const d = data();
  d.transactions = [
    transaction({ status: "cancelled", transaction_date: "2026-09-20" }),
    transaction({
      id: "future",
      status: "realized",
      transaction_date: "2026-11-01",
    }),
  ];
  assert.equal(projection(d, plan(), "2026-10-02")[0].opening, 10000);
  assert.equal(projection(d, plan(), "2026-10-02")[0].commitments, 0);
});
test("ajuste assinado altera disponível sem criar receita ou despesa", () => {
  const d = data();
  d.transactions = [
    transaction({
      type: "adjustment",
      category_id: null,
      amount_cents: 12000,
      adjustment_delta_cents: -12000,
      status: "realized",
      transaction_date: "2026-10-01",
    }),
  ];
  assert.equal(projection(d, plan(), "2026-10-02")[0].opening, -2000);
  assert.deepEqual(realized(d.transactions, [], "2026-10", "2026-10-02"), {
    income: 0,
    expense: 0,
  });
});
test("parcela importada 8/14 termina em 14 e última parcela fecha saldo", () => {
  const d = {
    ...debt,
    installment_paid_cents: 0,
    installment_number: 8,
    total_installments: 14,
    installment_amount_cents: 1000,
    remaining_amount_cents: 6500,
  };
  const schedule = debtInstallments(d, "2028-01-01");
  assert.deepEqual(
    schedule.map((i) => i.number),
    [8, 9, 10, 11, 12, 13, 14],
  );
  assert.equal(schedule.at(-1)!.amount, 500);
  assert.equal(schedule.at(-1)!.date, "2027-04-30");
  assert.equal(
    schedule.reduce((s, i) => s + i.amount, 0),
    6500,
  );
});

test("relatório grupos, encargos e livre com conta negativa sem duplicação", () => {
  const d = data();
  d.accounts[0].initial_balance_cents = -2000;
  d.transactions = [
    transaction({
      id: "fee",
      status: "pending",
      planning_group: "other",
      amount_cents: 100,
      transaction_date: "2026-10-03",
    }),
    transaction({
      id: "salary",
      type: "income",
      status: "pending",
      amount_cents: 5000,
      transaction_date: "2026-10-20",
    }),
  ];
  const r = monthReport(d, plan({ recurring_items: [rule] }), "2026-10-02");
  assert.equal(r.current.opening, -2000);
  assert.equal(r.incoming, 5000);
  assert.equal(r.current.commitments, 2100);
  assert.equal(r.current.closing, 900);
  assert.equal(r.groups.find((g) => g.key === "fixed")!.total, 2000);
  assert.equal(r.groups.find((g) => g.key === "other")!.total, 100);
  assert.equal(
    r.groups.reduce((s, g) => s + g.total, 0),
    r.current.commitments,
  );
});
test("relatório distingue pagamentos de consumo, reservas e metas", () => {
  const d = data();
  d.transactions = [
    transaction({
      type: "card_payment",
      category_id: null,
      payment_reference: "card",
      status: "realized",
      amount_cents: 1000,
      transaction_date: "2026-10-01",
    }),
  ];
  const r = monthReport(d, plan({ card_purchases: [purchase] }), "2026-10-02");
  assert.equal(r.paid, 1000);
  assert.equal(r.actual.expense, purchase.amount_cents);
  assert.equal(r.current.opening, 9000);
  assert.equal(
    balanceSummary(d.accounts, d.transactions, "2026-10-02").total,
    14000,
  );
});
test("ocorrência pendente vinculada substitui previsão e não duplica receita/despesa", () => {
  const d = data();
  d.transactions = [
    transaction({
      status: "pending",
      amount_cents: 2000,
      transaction_date: "2026-10-01",
    }),
  ];
  const p = plan({
    recurring_items: [rule],
    recurring_occurrences: [
      {
        ...base,
        id: "occ",
        recurring_item_id: rule.id,
        due_date: "2026-10-01",
        status: "recorded",
        transaction_id: "tx",
      },
    ],
  });
  const r = monthReport(d, p, "2026-10-02");
  assert.equal(r.current.commitments, 2000);
  assert.equal(r.current.items.length, 1);
  assert.equal(r.groups.find((g) => g.key === "fixed")!.total, 2000);
  assert.equal(r.months[1].recurring, 2000);
});
