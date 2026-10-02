import type { FinanceData, Transaction } from "../../types/index.ts";
import type { PlanningData, Commitment, MonthProjection } from "./types.ts";
import {
  balanceSummary,
  isReserveAccount,
  isRealized,
} from "../../utils/finance.ts";
import { addMonths } from "./dates.ts";
import { recurringDates } from "../recurring/calculations.ts";
import { invoices } from "../cards/calculations.ts";
import { debtInstallments } from "../debts/calculations.ts";
export function projection(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
): MonthProjection[] {
  const through = addMonths(`${asOf.slice(0, 7)}-01`, 3, 31);
  const all: Commitment[] = [];
  const cash = (id: string | null) =>
    data.accounts.some((a) => a.id === id && !isReserveAccount(a));
  for (const r of plan.recurring_items)
    for (const due of recurringDates(r, through, plan.recurring_occurrences))
      all.push({
        id: `${r.id}:${due}`,
        source: "recurring",
        canResolve: due <= asOf,
        entity: r.id,
        name: r.name,
        due,
        amount: r.amount_cents,
        impact: cash(r.account_id)
          ? r.amount_cents * (r.type === "income" ? 1 : -1)
          : 0,
        direction: r.type,
      });
  for (const i of invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    plan.card_payments,
  )) {
    if (i.pending === 0 || i.due_date > through) continue;
    const card = plan.credit_cards.find((c) => c.id === i.card_id)!;
    all.push({
      id: `${card.id}:${i.month}`,
      source: "card",
      entity: card.id,
      name: `Fatura · ${card.name}`,
      due: i.due_date,
      amount: i.pending,
      impact: cash(card.payment_account_id) ? -i.pending : 0,
      direction: "expense",
    });
  }
  for (const d of plan.debts)
    for (const i of debtInstallments(d, through))
      all.push({
        id: `${d.id}:${i.date}`,
        source: "debt",
        canResolve: i.date === d.next_due_date,
        entity: d.id,
        name: i.number
          ? `${d.name} · ${i.number}/${d.total_installments}`
          : d.name,
        due: i.date,
        amount: i.amount,
        impact: cash(
          d.payment_account_id ??
            data.accounts.find((a) => a.is_active && !isReserveAccount(a))
              ?.id ??
            null,
        )
          ? -i.amount
          : 0,
        direction: "expense",
      });
  for (const t of data.transactions.filter(
    (t) =>
      t.type !== "adjustment" &&
      t.status !== "cancelled" &&
      (t.status === "pending" || t.transaction_date > asOf),
  )) {
    if (t.transaction_date > through) continue;
    const impact =
      (cash(t.account_id)
        ? t.type === "income"
          ? t.amount_cents
          : -t.amount_cents
        : 0) +
      (t.type === "transfer" && cash(t.destination_account_id)
        ? t.amount_cents
        : 0);
    const occurrence = plan.recurring_occurrences.find(
      (o) => o.transaction_id === t.id,
    );
    all.push({
      id: t.id,
      source: occurrence ? "recurring" : "transaction",
      group: occurrence
        ? "fixed"
        : t.planning_group === "other"
          ? "other"
          : "scheduled",
      entity: t.id,
      name: t.description || "Lançamento previsto",
      due: t.transaction_date,
      amount: t.amount_cents,
      impact,
      direction:
        t.type === "card_payment"
          ? "expense"
          : (t.type as Commitment["direction"]),
    });
  }
  let opening = balanceSummary(
    data.accounts,
    data.transactions,
    asOf,
  ).available;
  return Array.from({ length: 4 }, (_, i) => {
    const month = addMonths(`${asOf.slice(0, 7)}-01`, i).slice(0, 7);
    const items = all
      .filter((c) => (c.due < asOf ? asOf : c.due).slice(0, 7) === month)
      .sort((a, b) => a.due.localeCompare(b.due));
    const sum = (f: (c: Commitment) => boolean) =>
      items.filter(f).reduce((s, c) => s + Math.abs(c.impact), 0);
    const income = sum((c) => c.direction === "income" && c.impact > 0);
    const recurring = sum((c) => c.source === "recurring" && c.impact < 0),
      cards = sum((c) => c.source === "card" && c.impact < 0),
      debts = sum((c) => c.source === "debt" && c.impact < 0);
    const other = sum(
      (c) =>
        c.source === "transaction" && c.direction === "expense" && c.impact < 0,
    );
    const transfers = items
      .filter((c) => c.direction === "transfer")
      .reduce((s, c) => s + c.impact, 0);
    const commitments = sum((c) => c.impact < 0);
    const closing = opening + items.reduce((s, c) => s + c.impact, 0);
    const result = {
      month,
      opening,
      income,
      recurring,
      cards,
      debts,
      other,
      transfers,
      commitments,
      closing,
      items,
    };
    opening = closing;
    return result;
  });
}
export function realized(
  transactions: Transaction[],
  purchases: PlanningData["card_purchases"],
  month: string,
  asOf: string,
) {
  const tx = transactions.filter(
    (t) => isRealized(t, asOf) && t.transaction_date.startsWith(month),
  );
  const income = tx
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount_cents, 0);
  const expense =
    tx
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + t.amount_cents, 0) +
    purchases
      .filter(
        (p) => p.purchase_date <= asOf && p.purchase_date.startsWith(month),
      )
      .reduce((s, p) => s + p.amount_cents, 0);
  return { income, expense };
}
