import type { FinanceData } from "../../types/index.ts";
import type { PlanningData } from "../planning/types.ts";
import { monthReport } from "../planning/reportCalculations.ts";
import { realized } from "../planning/calculations.ts";
import { balance, isReserveAccount, isRealized } from "../../utils/finance.ts";
import { essentialMonthly } from "../recurring/calculations.ts";
import { invoices } from "../cards/calculations.ts";
import { wealthSummary } from "../investments/calculations.ts";

// Presentation models only: money and projections keep their existing source.
export function experienceReport(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  const report = monthReport(data, plan, asOf);
  const pending = report.current.items.filter((c) => c.impact < 0);
  const bills = invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    plan.card_payments.filter((p) => p.payment_date <= asOf),
    plan.card_adjustments,
  );
  const completedKeys = new Set<string>();
  for (const transaction of report.paidItems) {
    const cardPayment = plan.card_payments.find(
      (p) => p.transaction_id === transaction.id,
    );
    const debtPayment = plan.debt_payments.find(
      (p) => p.transaction_id === transaction.id,
    );
    if (cardPayment) {
      const bill = bills.find(
        (i) =>
          i.card_id === cardPayment.card_id &&
          i.month === cardPayment.due_month,
      );
      if (bill && bill.pending === 0)
        completedKeys.add(`card:${bill.card_id}:${bill.month}`);
    } else if (debtPayment) {
      const debt = plan.debts.find((d) => d.id === debtPayment.debt_id);
      if (
        debt &&
        (debt.remaining_amount_cents === 0 ||
          (debtPayment.scheduled_date &&
            debt.next_due_date &&
            debt.next_due_date > debtPayment.scheduled_date))
      ) {
        completedKeys.add(
          `debt:${debt.id}:${debtPayment.scheduled_date ?? "balance"}`,
        );
      }
    } else {
      completedKeys.add(`transaction:${transaction.id}`);
    }
  }
  const completed = completedKeys.size;
  const reserveGoal = data.goals.find((g) => g.is_emergency_reserve);
  const cost =
    reserveGoal?.essential_monthly_cents ??
    essentialMonthly(plan.recurring_items, asOf);
  const targetMonths = reserveGoal?.reserve_months ?? 6;
  const selected = reserveGoal
    ? plan.reserve_account_links
        .filter((l) => l.goal_id === reserveGoal.id)
        .map((l) => l.account_id)
    : data.accounts.filter((a) => a.type === "savings").map((a) => a.id);
  const wealth = wealthSummary(data, plan, asOf);
  const reserve =
    wealth.reserve +
    data.accounts
      .filter(
        (a) =>
          !a.investment_id && isReserveAccount(a) && selected.includes(a.id),
      )
      .reduce((s, a) => s + balance(a, data.transactions, asOf), 0);
  const total = completed + pending.length;
  return {
    ...report,
    wealth,
    cardsPending: report.current.items
      .filter((c) => c.source === "card")
      .reduce((s, c) => s + c.amount, 0),
    pending,
    completed,
    total,
    percent: total ? (completed / total) * 100 : 0,
    reserve,
    reserveGoal,
    selected,
    cost,
    targetMonths,
    protectedMonths: cost > 0 ? Math.max(0, reserve) / cost : null,
  };
}

export function periodReport(
  data: FinanceData,
  plan: PlanningData,
  period: string,
  asOf: string,
) {
  const actual = realized(
    data.transactions,
    plan.card_purchases,
    period,
    asOf,
    plan.card_adjustments,
  );
  const result = actual.income - actual.expense;
  const categories = new Map<string, number>();
  const add = (id: string | null, amount: number) => {
    const name =
      data.categories.find((c) => c.id === id)?.name ?? "Sem categoria";
    categories.set(name, (categories.get(name) ?? 0) + amount);
  };
  data.transactions
    .filter(
      (t) =>
        t.type === "expense" &&
        isRealized(t, asOf) &&
        t.transaction_date.startsWith(period),
    )
    .forEach((t) => add(t.category_id, t.amount_cents));
  plan.card_purchases
    .filter(
      (p) =>
        !p.cancelled_at &&
        p.purchase_date <= asOf &&
        p.purchase_date.startsWith(period),
    )
    .forEach((p) => add(p.category_id, p.amount_cents));
  (plan.card_adjustments ?? [])
    .filter((a) => a.due_date <= asOf && a.due_date.startsWith(period))
    .forEach((a) =>
      add(
        plan.card_purchases.find((p) => p.id === a.purchase_id)?.category_id ??
          null,
        a.amount_cents,
      ),
    );
  return {
    ...actual,
    result,
    saved: actual.income > 0 ? (result / actual.income) * 100 : null,
    categories: [...categories]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
  };
}

// Available periods are choices, not an assertion that their data is complete.
export function reportMonths(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  const dates = [
    asOf,
    ...data.transactions.map((t) => t.transaction_date),
    ...plan.card_purchases.map((p) => p.purchase_date),
    ...(plan.card_adjustments ?? []).map((a) => a.due_date),
  ];
  return [
    ...new Set(
      dates.filter((date) => date <= asOf).map((date) => date.slice(0, 7)),
    ),
  ]
    .sort()
    .reverse();
}
export function selectedMonthReports(
  data: FinanceData,
  plan: PlanningData,
  months: string[],
  asOf: string,
) {
  const available = new Set(reportMonths(data, plan, asOf));
  return [...new Set(months)]
    .filter((month) => available.has(month))
    .sort()
    .map((period) => ({ period, ...periodReport(data, plan, period, asOf) }));
}
