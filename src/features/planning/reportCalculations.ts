import type { FinanceData } from "../../types/index.ts";
import type { PlanningData, Commitment } from "./types.ts";
import { isRealized, isReserveAccount } from "../../utils/finance.ts";
import { projection, realized } from "./calculations.ts";
export const commitmentGroups = {
  fixed: "Fixas",
  scheduled: "Programadas",
  cards: "Cartões",
  debts: "Parcelas / Dívidas",
  other: "Outros",
};
export function commitmentGroup(c: Commitment): keyof typeof commitmentGroups {
  return (
    c.group ??
    (
      {
        recurring: "fixed",
        card: "cards",
        debt: "debts",
        transaction: "scheduled",
      } as const
    )[c.source]
  );
}
export function monthReport(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  const months = projection(data, plan, asOf),
    current = months[0];
  const cash = (id: string) =>
    data.accounts.some((a) => a.id === id && !isReserveAccount(a));
  const paidItems = data.transactions.filter(
    (t) =>
      isRealized(t, asOf) &&
      t.transaction_date.startsWith(current.month) &&
      cash(t.account_id) &&
      (t.type === "expense" ||
        t.type === "card_payment" ||
        (t.type === "transfer" && !cash(t.destination_account_id ?? ""))),
  );
  const paid = paidItems.reduce((s, t) => s + t.amount_cents, 0);
  const incoming = current.items.reduce((s, c) => s + Math.max(0, c.impact), 0);
  const groups = Object.entries(commitmentGroups).map(([key, label]) => {
    const items = current.items.filter(
      (c) => commitmentGroup(c) === key && c.direction !== "income",
    );
    return {
      key,
      label,
      items,
      total: items.reduce((s, c) => s + Math.max(0, -c.impact), 0),
    };
  });
  return {
    months,
    current,
    groups,
    paid,
    paidItems,
    incoming,
    totalCommitted: paid + current.commitments,
    actual: realized(
      data.transactions,
      plan.card_purchases,
      current.month,
      asOf,
      plan.card_adjustments,
    ),
  };
}
