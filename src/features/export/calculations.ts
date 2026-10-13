import type { ExportSnapshot } from "./snapshot.ts";
import { monthlyCommitments } from "../planning/commitments.ts";
import { periodReport, experienceReport } from "../experience/calculations.ts";
import { essentialMonthly } from "../recurring/calculations.ts";
import { addMonths } from "../planning/dates.ts";
import { isRealized, balance } from "../../utils/finance.ts";
import { commitmentGroup } from "../planning/reportCalculations.ts";
export interface ExportOptions {
  start: string;
  end: string;
  detailed: boolean;
}
const safeDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// Explicit allowlists: tokens/auth/session/provider metadata never enter files.
function pick(row: object, keys: string[]) {
  return Object.fromEntries(
    keys
      .filter((k) => k in row)
      .map((k) => [k, (row as Record<string, unknown>)[k]]),
  );
}
const base = ["id", "created_at"];
export function buildFinancialExport(s: ExportSnapshot, o: ExportOptions) {
  const asOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(s.generated_at));
  if (
    !safeDate(o.start) ||
    !safeDate(o.end) ||
    o.start > o.end ||
    o.end > asOf ||
    Number(o.end.slice(0, 4)) - Number(o.start.slice(0, 4)) > 50
  )
    throw new Error("Selecione um período válido até hoje (máximo 50 anos)");
  const inPeriod = (date: string) => date >= o.start && date <= o.end;
  const tx = s.finance.transactions.filter((t) => inPeriod(t.transaction_date));
  const purchases = s.plan.card_purchases.filter((p) =>
    inPeriod(p.purchase_date),
  );
  const adjustments = (s.plan.card_adjustments ?? []).filter((a) =>
    inPeriod(a.due_date),
  );
  const f = { ...s.finance, transactions: tx };
  const p = {
    ...s.plan,
    card_purchases: purchases,
    card_adjustments: adjustments,
  };
  const months: string[] = [];
  for (
    let date = o.start.slice(0, 7) + "-01";
    date.slice(0, 7) <= o.end.slice(0, 7);
    date = addMonths(date, 1)
  )
    months.push(date.slice(0, 7));
  const monthly = months.map((month) => {
    const r = periodReport(f, p, month, asOf),
      confirmation = s.confirmations.find((c) => c.month.startsWith(month));
    return {
      month,
      ...r,
      complete: confirmation?.complete === true && month < asOf.slice(0, 7),
      confirmed_at: confirmation?.confirmed_at ?? null,
    };
  });
  const fullMonths = monthly.filter(
    (m) =>
      m.complete &&
      o.start <= m.month + "-01" &&
      o.end >= addMonths(m.month + "-01", 0, 31),
  );
  const income = monthly.reduce((n, m) => n + m.income, 0),
    expense = monthly.reduce((n, m) => n + m.expense, 0);
  const obligations = months
    .flatMap((month) => monthlyCommitments(s.finance, s.plan, asOf, month))
    .filter((c) => inPeriod(c.due));
  const r = experienceReport(s.finance, s.plan, asOf);
  const scheduledIds = new Set(
      obligations
        .filter((c) => c.source === "transaction")
        .map((c) => c.entity),
    ),
    recurringIds = new Set(
      s.plan.recurring_occurrences.map((o) => o.transaction_id),
    );
  const realizedExpenses = tx.filter(
    (t) => t.type === "expense" && isRealized(t, asOf),
  );
  const isDebt = (id: string) =>
    s.plan.debt_payments.some((d) => d.transaction_id === id);
  const fixed = realizedExpenses
    .filter((t) => recurringIds.has(t.id))
    .reduce((n, t) => n + t.amount_cents, 0);
  const scheduled = realizedExpenses
    .filter(
      (t) => !recurringIds.has(t.id) && scheduledIds.has(t.id) && !isDebt(t.id),
    )
    .reduce((n, t) => n + t.amount_cents, 0);
  const debtExpense = realizedExpenses
    .filter((t) => isDebt(t.id))
    .reduce((n, t) => n + t.amount_cents, 0);
  const variable = expense - fixed - scheduled - debtExpense;
  const warnings = [
    ...monthly
      .filter((m) => !m.complete)
      .map(
        (m) =>
          `${m.month}: dados não confirmados como completos; não usar como mês integral.`,
      ),
    "Patrimônio, contas, dívidas e reserva representam a posição atual na geração; não são uma reconstrução do saldo no fim do período.",
    "Projetado e estimado não são rendas realizadas. Compras no cartão contam na compra; pagamento da fatura não é novo consumo.",
    "IR/IOF e saldo líquido de investimentos indisponíveis sem lotes fiscais; saldo efetivo do banco prevalece.",
    "Parcelas históricas sem evidência do valor integral e programadas antigas sem marcador não são inferidas.",
  ];
  for (const position of r.wealth.positions)
    if (position.limitation)
      warnings.push(`${position.investment.name}: ${position.limitation}`);
  const detail = o.detailed
    ? {
        transactions: tx.map((t) =>
          pick(t, [
            ...base,
            "transaction_date",
            "description",
            "type",
            "category_id",
            "account_id",
            "destination_account_id",
            "amount_cents",
            "adjustment_delta_cents",
            "status",
            "planning_group",
            "financial_commitment",
            "commitment_due_date",
            "payment_reference",
          ]),
        ),
        card_purchases: purchases.map((t) =>
          pick(t, [
            ...base,
            "card_id",
            "category_id",
            "amount_cents",
            "description",
            "purchase_date",
            "installments",
            "first_due_date",
            "due_anchor_day",
            "cancelled_at",
          ]),
        ),
        card_adjustments: adjustments.map((t) =>
          pick(t, [
            ...base,
            "card_id",
            "purchase_id",
            "due_month",
            "due_date",
            "amount_cents",
            "description",
          ]),
        ),
        card_payments: s.plan.card_payments
          .filter((t) => inPeriod(t.payment_date))
          .map((t) =>
            pick(t, [
              ...base,
              "card_id",
              "due_month",
              "transaction_id",
              "amount_cents",
              "payment_date",
            ]),
          ),
        debt_payments: s.plan.debt_payments
          .filter((t) => inPeriod(t.payment_date))
          .map((t) =>
            pick(t, [
              ...base,
              "debt_id",
              "transaction_id",
              "amount_cents",
              "payment_date",
              "scheduled_date",
              "obligation_amount_cents",
            ]),
          ),
        recurring_occurrences: s.plan.recurring_occurrences
          .filter((t) => inPeriod(t.due_date))
          .map((t) =>
            pick(t, [
              ...base,
              "recurring_item_id",
              "due_date",
              "status",
              "transaction_id",
            ]),
          ),
        investment_movements: (s.plan.investment_movements ?? [])
          .filter((t) => inPeriod(t.date))
          .map((t) =>
            pick(t, [
              ...base,
              "investment_id",
              "ledger_order",
              "type",
              "amount_cents",
              "date",
              "description",
              "transaction_id",
              "source_transaction_id",
              "source_account_id",
              "accounting_kind",
              "sync_value_cents",
            ]),
          ),
        goal_contributions: s.finance.goal_contributions
          .filter((t) => inPeriod(t.contribution_date))
          .map((t) =>
            pick(t, [
              ...base,
              "goal_id",
              "amount_cents",
              "contribution_date",
              "description",
            ]),
          ),
        reconciliation_context: {
          transactions: s.finance.transactions.map((t) =>
            pick(t, [
              ...base,
              "transaction_date",
              "description",
              "type",
              "category_id",
              "account_id",
              "destination_account_id",
              "amount_cents",
              "adjustment_delta_cents",
              "status",
              "payment_reference",
              "financial_commitment",
              "commitment_due_date",
            ]),
          ),
          card_purchases: s.plan.card_purchases.map((t) =>
            pick(t, [
              ...base,
              "card_id",
              "category_id",
              "amount_cents",
              "description",
              "purchase_date",
              "installments",
              "first_due_date",
              "due_anchor_day",
              "cancelled_at",
            ]),
          ),
          card_adjustments: (s.plan.card_adjustments ?? []).map((t) =>
            pick(t, [
              ...base,
              "card_id",
              "purchase_id",
              "due_date",
              "due_month",
              "amount_cents",
            ]),
          ),
          card_payments: s.plan.card_payments.map((t) =>
            pick(t, [
              ...base,
              "card_id",
              "transaction_id",
              "amount_cents",
              "payment_date",
              "due_month",
            ]),
          ),
          debt_payments: s.plan.debt_payments.map((t) =>
            pick(t, [
              ...base,
              "debt_id",
              "transaction_id",
              "amount_cents",
              "payment_date",
              "scheduled_date",
              "obligation_amount_cents",
            ]),
          ),
          investment_movements: (s.plan.investment_movements ?? []).map((t) =>
            pick(t, [
              ...base,
              "investment_id",
              "ledger_order",
              "type",
              "amount_cents",
              "date",
              "sync_value_cents",
              "accounting_kind",
              "source_account_id",
              "source_transaction_id",
              "transaction_id",
            ]),
          ),
          investment_rates: (s.plan.investment_rates ?? []).map((t) =>
            pick(t, [...base, "investment_id", "effective_date", "percent"]),
          ),
          cdi_history: s.plan.cdi_history ?? null,
        },
      }
    : undefined;
  return {
    schema_version: "rota-financial-export/1.0",
    generated_at: s.generated_at,
    currency: "BRL",
    money_unit: "integer_cents",
    period: { start: o.start, end: o.end },
    mode: o.detailed ? "detailed" : "summary",
    source: { consistent_snapshot: true, counts: s.counts },
    privacy:
      "Arquivo contém dados financeiros privados. Compartilhe somente com quem autorizar.",
    realized: {
      income_cents: income,
      expense_cents: expense,
      result_cents: income - expense,
      fixed_expenses_cents: fixed,
      scheduled_expenses_cents: scheduled,
      variable_expenses_cents: variable,
      debt_payments_expense_cents: debtExpense,
      months: monthly,
    },
    scheduled: {
      commitments: obligations,
      remaining_cents: obligations.reduce(
        (n, c) => n + Math.max(0, c.amount - c.paid),
        0,
      ),
    },
    projected: { as_of: asOf, months: r.months },
    estimated: {
      as_of: asOf,
      wealth: {
        available_cents: r.wealth.available,
        invested_cents: r.wealth.invested,
        gross_cents: r.wealth.gross,
        net_cents: r.wealth.net,
        debts_cents: r.wealth.debts,
        cards_cents: r.wealth.cards,
      },
      reserve_cents: r.reserve,
      positions: r.wealth.positions.map((v) => ({
        investment_id: v.investment.id,
        current_cents: v.current,
        contributed_cents: v.contributed,
        withdrawn_cents: v.withdrawn,
        valuation_adjustments_cents: v.adjustments,
        estimated_yield_cents: v.estimatedYield,
        complete: v.complete,
        limitation: v.limitation,
      })),
    },
    indicators: {
      fixed_monthly_cents: essentialMonthly(
        s.plan.recurring_items.map((r) => ({ ...r, is_essential: true })),
        asOf,
      ),
      scheduled_commitments_cents: obligations
        .filter((c) => commitmentGroup(c) === "scheduled")
        .reduce((n, c) => n + c.amount, 0),
      variable_expenses_cents: variable,
      installment_obligations_cents: obligations
        .filter((c) => c.source === "debt" || c.source === "card")
        .reduce((n, c) => n + Math.max(0, c.amount - c.paid), 0),
      complete_months: fullMonths.map((m) => m.month),
      average_expenses_complete_months_cents: fullMonths.length
        ? Math.round(
            fullMonths.reduce((n, m) => n + m.expense, 0) / fullMonths.length,
          )
        : null,
      reserve_cents: r.reserve,
      protection_months: r.protectedMonths,
      observed_savings_cents: fullMonths.length
        ? Math.round(
            fullMonths.reduce((n, m) => n + m.result, 0) / fullMonths.length,
          )
        : null,
      observed_savings_rate: income > 0 ? (income - expense) / income : null,
    },
    accounts: s.finance.accounts.map((a) => ({
      ...pick(a, [
        ...base,
        "name",
        "type",
        "currency",
        "initial_balance_cents",
        "is_active",
        "investment_id",
      ]),
      current_balance_cents: balance(a, s.finance.transactions, asOf),
    })),
    categories: s.finance.categories.map((c) =>
      pick(c, ["id", "name", "type"]),
    ),
    cards: s.plan.credit_cards.map((c) =>
      pick(c, [
        ...base,
        "name",
        "holder_name",
        "limit_cents",
        "closing_day",
        "due_day",
        "payment_account_id",
        "active",
      ]),
    ),
    invoices: s.plan.card_invoices.map((i) =>
      pick(i, [
        ...base,
        "card_id",
        "amount_cents",
        "due_date",
        "due_month",
        "covered_at",
      ]),
    ),
    debts: s.plan.debts.map((d) =>
      pick(d, [
        ...base,
        "name",
        "original_amount_cents",
        "remaining_amount_cents",
        "installment_amount_cents",
        "installment_paid_cents",
        "installment_number",
        "total_installments",
        "next_due_date",
        "due_anchor_day",
        "payment_account_id",
        "active",
      ]),
    ),
    recurrences: s.plan.recurring_items.map((r) =>
      pick(r, [
        ...base,
        "name",
        "type",
        "amount_cents",
        "account_id",
        "category_id",
        "frequency",
        "start_date",
        "end_date",
        "active",
        "is_essential",
      ]),
    ),
    goals: s.finance.goals.map((g) =>
      pick(g, [
        ...base,
        "name",
        "target_amount_cents",
        "initial_amount_cents",
        "target_date",
        "is_emergency_reserve",
        "reserve_months",
        "essential_monthly_cents",
        "is_active",
      ]),
    ),
    investments: (s.plan.investments ?? [])
      .filter((i) => !i.replaced_by_id)
      .map((i) =>
        pick(i, [
          ...base,
          "name",
          "institution",
          "type",
          "initial_date",
          "yield_type",
          "yield_rate",
          "is_emergency_reserve",
          "active",
          "source_account_id",
        ]),
      ),
    reconstructions: (s.plan.investment_reconstructions ?? []).map((i) =>
      pick(i, [
        ...base,
        "old_investment_id",
        "new_investment_id",
        "recorded_value_cents",
        "historical_net_cents",
        "real_value_cents",
        "difference_cents",
        "reconciliation_note",
      ]),
    ),
    details: detail,
    warnings,
  };
}
export type FinancialExport = ReturnType<typeof buildFinancialExport>;
