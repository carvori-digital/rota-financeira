import type { FinanceData } from "../../types/index.ts";
import type { PlanningData, Commitment } from "./types.ts";
import { projection } from "./calculations.ts";
import { isRealized } from "../../utils/finance.ts";
import { invoices } from "../cards/calculations.ts";

export interface MonthlyCommitment extends Commitment {
  status: "pending" | "completed";
  paid: number;
  references: string[];
}
// Obligations and cash-flow projections are separate models. A transaction's
// default planning_group is not evidence that it was scheduled historically.
export function monthlyCommitments(
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
  month = asOf.slice(0, 7),
): MonthlyCommitment[] {
  const result = new Map<string, MonthlyCommitment>();
  const tx = (id: string | null) =>
    data.transactions.find((t) => t.id === id && isRealized(t, asOf));
  const belongs = (due: string, pending: boolean) =>
    due.startsWith(month) ||
    (pending && month === asOf.slice(0, 7) && due < `${month}-01`);
  const put = (
    c: Commitment,
    paid = 0,
    references: string[] = [],
    completed = false,
  ) => {
    if (belongs(c.due, !completed))
      result.set(c.id, {
        ...c,
        status: completed ? "completed" : "pending",
        canResolve: !completed && c.canResolve,
        paid,
        references,
      });
  };
  for (const m of projection(data, plan, asOf))
    for (const c of m.items) {
      if (
        c.direction !== "expense" ||
        c.source === "card" ||
        c.source === "debt"
      )
        continue;
      if (
        c.source === "transaction" &&
        plan.debt_payments.some((p) => p.transaction_id === c.entity)
      )
        continue;
      const o = plan.recurring_occurrences.find(
        (o) => o.transaction_id === c.entity,
      );
      put({
        ...c,
        id: o
          ? `recurring:${o.recurring_item_id}:${o.due_date}`
          : `${c.source}:${c.id}`,
        due: o?.due_date ?? c.due,
      });
    }
  for (const o of plan.recurring_occurrences) {
    const r = plan.recurring_items.find((r) => r.id === o.recurring_item_id);
    if (!r || r.type !== "expense" || o.status === "skipped") continue;
    const t = tx(o.transaction_id);
    const paid = t?.type === "expense" ? t.amount_cents : 0;
    put(
      {
        id: `recurring:${r.id}:${o.due_date}`,
        source: "recurring",
        entity: o.transaction_id ?? r.id,
        name: r.name,
        due: o.due_date,
        amount: r.amount_cents,
        impact: -Math.max(0, r.amount_cents - paid),
        direction: "expense",
        group: "fixed",
        canResolve: !!o.transaction_id,
      },
      paid,
      o.transaction_id ? [o.id, o.transaction_id] : [o.id],
      paid >= r.amount_cents,
    );
  }
  for (const t of data.transactions) {
    if (
      t.type !== "expense" ||
      !t.financial_commitment ||
      !isRealized(t, asOf) ||
      t.payment_reference ||
      plan.recurring_occurrences.some((o) => o.transaction_id === t.id)
    )
      continue;
    put(
      {
        id: `transaction:${t.id}`,
        source: "transaction",
        entity: t.id,
        name: t.description,
        due: t.commitment_due_date ?? t.transaction_date,
        amount: t.amount_cents,
        impact: 0,
        direction: "expense",
        group: t.planning_group === "other" ? "other" : "scheduled",
      },
      t.amount_cents,
      [t.id],
      true,
    );
  }
  const payments = plan.card_payments.filter((p) => {
    const t = tx(p.transaction_id);
    return (
      t?.type === "card_payment" &&
      t.amount_cents === p.amount_cents &&
      p.payment_date <= asOf
    );
  });
  for (const i of invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    payments,
    plan.card_adjustments,
  )) {
    if (i.total <= 0) continue;
    const card = plan.credit_cards.find((c) => c.id === i.card_id)!;
    put(
      {
        id: `card:${i.card_id}:${i.month}`,
        source: "card",
        entity: card.id,
        name: `Fatura · ${card.name}`,
        due: i.due_date,
        amount: i.total,
        impact: -i.pending,
        direction: "expense",
        group: "cards",
      },
      i.paid,
      payments
        .filter((p) => p.card_id === i.card_id && p.due_month === i.month)
        .map((p) => p.id),
      i.pending === 0,
    );
  }
  for (const m of projection(data, plan, asOf))
    for (const c of m.items.filter((c) => c.source === "debt")) {
      const paid = plan.debt_payments
        .filter(
          (p) =>
            p.debt_id === c.entity &&
            p.scheduled_date === c.due &&
            tx(p.transaction_id),
        )
        .reduce((s, p) => s + p.amount_cents, 0);
      put({ ...c, id: `debt:${c.id}`, amount: c.amount + paid }, paid);
    }
  // Only payments with a captured obligation amount can establish historical
  // completion. No association is inferred from descriptions or current balance.
  const groups = new Map<string, typeof plan.debt_payments>();
  for (const p of plan.debt_payments)
    if (
      p.scheduled_date &&
      tx(p.transaction_id)?.amount_cents === p.amount_cents &&
      p.payment_date <= asOf
    ) {
      const key = `debt:${p.debt_id}:${p.scheduled_date}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
  for (const [id, ps] of groups) {
    const d = plan.debts.find((d) => d.id === ps[0].debt_id);
    const amounts = ps
      .map((p) => p.obligation_amount_cents)
      .filter((v): v is number => v != null);
    if (!d || !amounts.length) continue;
    const expected = Math.max(...amounts),
      paid = ps.reduce((s, p) => s + p.amount_cents, 0);
    put(
      {
        id,
        source: "debt",
        entity: d.id,
        name: d.name,
        due: ps[0].scheduled_date!,
        amount: expected,
        impact: -Math.max(0, expected - paid),
        direction: "expense",
        group: "debts",
        canResolve: d.next_due_date === ps[0].scheduled_date,
      },
      paid,
      ps.map((p) => p.id),
      paid >= expected,
    );
  }
  return [...result.values()].sort(
    (a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id),
  );
}
