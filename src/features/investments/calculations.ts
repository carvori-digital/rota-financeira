import type { Investment, InvestmentMovement } from "./types.ts";
import type { FinanceData } from "../../types/index.ts";
import type { PlanningData } from "../planning/types.ts";
import { balanceSummary } from "../../utils/finance.ts";
import { invoices } from "../cards/calculations.ts";
export function investmentValue(
  investment: Investment,
  movements: InvestmentMovement[],
  asOf: string,
) {
  const rows = movements.filter(
    (m) => m.investment_id === investment.id && m.date <= asOf,
  );
  let principal = 0,
    value = 0,
    contributed = 0,
    withdrawn = 0,
    adjustments = 0;
  for (const m of rows) {
    const signed = m.type === "withdrawal" ? -m.amount_cents : m.amount_cents;
    const days =
      (Date.parse(asOf + "T00:00:00Z") - Date.parse(m.date + "T00:00:00Z")) /
      86400000;
    const factor =
      investment.yield_type === "manual"
        ? 1
        : Math.pow(
            1 + Number(investment.yield_rate) / 100,
            days / (investment.yield_type === "fixed_annual" ? 365 : 30),
          );
    principal += signed;
    value += signed * factor;
    if (m.type === "contribution") contributed += m.amount_cents;
    else if (m.type === "withdrawal") withdrawn += m.amount_cents;
    else adjustments += m.amount_cents;
  }
  const current = Math.round(value),
    estimatedYield = current - principal;
  return {
    current,
    principal,
    contributed,
    withdrawn,
    adjustments,
    estimatedYield,
    profitability: principal > 0 ? (estimatedYield / principal) * 100 : null,
    lastUpdate:
      rows
        .map((m) => m.date)
        .sort()
        .at(-1) ?? investment.initial_date,
  };
}
export function wealthSummary(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  const cash = balanceSummary(data.accounts, data.transactions, asOf);
  const positions = (plan.investments ?? []).map((i) => ({
    ...investmentValue(i, plan.investment_movements ?? [], asOf),
    investment: i,
  }));
  const invested = positions.reduce((s, p) => s + p.current, 0) + cash.reserve;
  const reserve = positions
    .filter((p) => p.investment.is_emergency_reserve)
    .reduce((s, p) => s + p.current, 0);
  const debts = plan.debts.reduce((s, d) => s + d.remaining_amount_cents, 0);
  const cards = invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    plan.card_payments,
    plan.card_adjustments,
  ).reduce((s, i) => s + i.pending, 0);
  const gross = cash.total + positions.reduce((s, p) => s + p.current, 0);
  return {
    available: cash.available,
    invested,
    reserve,
    gross,
    net: gross - debts - cards,
    debts,
    cards,
    positions,
  };
}
