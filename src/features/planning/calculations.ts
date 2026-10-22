import type { FinanceData, Transaction } from "../../types/index.ts";
import type { PlanningData, Commitment, MonthProjection } from "./types.ts";
import {
  balanceSummary,
  isReserveAccount,
  isOperationalAccount,
  isRealized,
} from "../../utils/finance.ts";
import { addMonths } from "./dates.ts";
import {
  recurringDates,
  occurrenceAmount,
  occurrenceDefinition,
  occurrencePayments,
} from "../recurring/calculations.ts";
import { verifiedCardPayments } from "../cards/verifiedPayments.ts";
import { planningInvoices } from "../subscriptions/calculations.ts";
import { debtInstallments } from "../debts/calculations.ts";
export function projection(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
): MonthProjection[] {
  const through = addMonths(`${asOf.slice(0, 7)}-01`, 3, 31);
  const all: Commitment[] = [];
  const cash = (id: string | null) =>
    data.accounts.some((a) => a.id === id && isOperationalAccount(a));
  for (const rule of plan.recurring_items)
    for (const due of recurringDates(
      rule,
      through,
      plan.recurring_occurrences,
    )) {
      const r = occurrenceDefinition(
        rule,
        due,
        plan.recurring_occurrences,
        data.transactions,
      );
      all.push({
        id: `${r.id}:${due}`,
        source: "recurring",
        canResolve: true,
        entity: r.id,
        name: r.name,
        due,
        amount: occurrenceAmount(
          r,
          due,
          plan.recurring_occurrences,
          data.transactions,
        ),
        reserveAccount: data.accounts.some(
          (a) => a.id === r.account_id && isReserveAccount(a),
        ),
        impact: cash(r.account_id)
          ? occurrenceAmount(
              r,
              due,
              plan.recurring_occurrences,
              data.transactions,
            ) * (r.type === "income" ? 1 : -1)
          : 0,
        direction: r.type,
      });
    }
  for (const o of plan.recurring_occurrences.filter(
    (o) => o.status === "recorded",
  )) {
    const rule = plan.recurring_items.find((r) => r.id === o.recurring_item_id);
    const r =
      rule &&
      occurrenceDefinition(
        rule,
        o.due_date,
        plan.recurring_occurrences,
        data.transactions,
      );
    const linked = data.transactions.find((t) => t.id === o.transaction_id);
    if (
      !r ||
      !linked ||
      linked.status === "pending" ||
      linked.status === "cancelled" ||
      !isRealized(linked, asOf)
    )
      continue;
    const paid = occurrencePayments(
      o,
      r.type,
      data.transactions,
      plan.recurring_payments ?? [],
      asOf,
    ).reduce((s, t) => s + t.amount_cents, 0);
    const remaining =
      occurrenceAmount(
        r,
        o.due_date,
        plan.recurring_occurrences,
        data.transactions,
      ) - paid;
    if (remaining <= 0) continue;
    all.push({
      id: `${r.id}:${o.due_date}`,
      source: "recurring",
      entity: r.id,
      occurrenceId: o.id,
      name: r.name,
      due: o.due_date,
      amount: remaining,
      impact: cash(r.account_id)
        ? remaining * (r.type === "income" ? 1 : -1)
        : 0,
      direction: r.type,
      canResolve: true,
    });
  }
  for (const i of planningInvoices(
    plan,
    verifiedCardPayments(data.transactions, plan.card_payments, asOf),
    asOf,
  )) {
    if (i.pending === 0 || i.due_date > through) continue;
    const card = plan.credit_cards.find((c) => c.id === i.card_id)!;
    all.push({
      id: `${card.id}:${i.month}`,
      source: "card",
      entity: card.id,
      name: `Fatura · ${card.name}`,
      canResolve: (i.payable ?? i.pending) > 0,
      due: i.due_date,
      amount: i.pending,
      impact:
        card.payment_account_id === null || cash(card.payment_account_id)
          ? -i.pending
          : 0,
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
            data.accounts.find((a) => a.is_active && isOperationalAccount(a))
              ?.id ??
            null,
        )
          ? -i.amount
          : 0,
        direction: "expense",
      });
  // A recorded partial obligation survives pausing its source configuration.
  const allocated = plan.debt_payment_allocations ?? [];
  const evidence = [
    ...allocated.flatMap((a) => {
      const p = plan.debt_payments.find((p) => p.id === a.payment_id);
      return p &&
        data.transactions.some(
          (t) =>
            t.id === p.transaction_id &&
            t.amount_cents === p.amount_cents &&
            isRealized(t, asOf),
        )
        ? [{ ...a, transaction_id: p.transaction_id }]
        : [];
    }),
    ...plan.debt_payments.filter(
      (p) =>
        !allocated.some((a) => a.payment_id === p.id) &&
        p.scheduled_date &&
        p.obligation_amount_cents &&
        data.transactions.some(
          (t) =>
            t.id === p.transaction_id &&
            t.amount_cents === p.amount_cents &&
            isRealized(t, asOf),
        ),
    ),
  ];
  const known = new Map<
    string,
    { debt: string; due: string; amount: number; paid: number }
  >();
  for (const p of evidence) {
    if (!p.scheduled_date || !p.obligation_amount_cents) continue;
    const key = `${p.debt_id}:${p.scheduled_date}`,
      old = known.get(key);
    known.set(key, {
      debt: p.debt_id,
      due: p.scheduled_date,
      amount: Math.max(old?.amount ?? 0, p.obligation_amount_cents),
      paid: (old?.paid ?? 0) + p.amount_cents,
    });
  }
  for (const p of known.values()) {
    const d = plan.debts.find((d) => d.id === p.debt);
    if (
      !d ||
      p.paid >= p.amount ||
      all.some(
        (c) => c.source === "debt" && c.entity === p.debt && c.due === p.due,
      )
    )
      continue;
    const amount = p.amount - p.paid;
    all.push({
      id: `${d.id}:${p.due}`,
      source: "debt",
      entity: d.id,
      name: d.name,
      due: p.due,
      amount,
      impact:
        d.payment_account_id === null || cash(d.payment_account_id)
          ? -amount
          : 0,
      direction: "expense",
      canResolve: d.next_due_date === p.due,
    });
  }
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
      entity: occurrence?.recurring_item_id ?? t.id,
      transactionId: t.id,
      occurrenceId: occurrence?.id,
      canResolve: true,
      reserveAccount: data.accounts.some(
        (a) => a.id === t.account_id && isReserveAccount(a),
      ),
      name: t.description || "Lançamento previsto",
      due: occurrence?.due_date ?? t.commitment_due_date ?? t.transaction_date,
      cashDate: t.transaction_date,
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
      .filter(
        (c) =>
          ((c.cashDate ?? c.due) < asOf ? asOf : (c.cashDate ?? c.due)).slice(
            0,
            7,
          ) === month,
      )
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
  adjustments: PlanningData["card_adjustments"] = [],
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
        (p) =>
          !p.cancelled_at &&
          p.purchase_date <= asOf &&
          p.purchase_date.startsWith(month),
      )
      .reduce((s, p) => s + p.amount_cents, 0) +
    adjustments
      .filter((a) => a.due_date <= asOf && a.due_date.startsWith(month))
      .reduce((s, a) => s + a.amount_cents, 0);
  return { income, expense };
}
