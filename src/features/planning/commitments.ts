import type { FinanceData } from "../../types/index.ts";
import type { PlanningData, Commitment } from "./types.ts";
import {
  occurrenceAmount,
  occurrenceDefinition,
  occurrencePayments,
} from "../recurring/calculations.ts";
import { projection } from "./calculations.ts";
import {
  isRealized,
  isReserveAccount,
  isOperationalAccount,
} from "../../utils/finance.ts";
import { planningInvoices } from "../subscriptions/calculations.ts";

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
    if (
      belongs(c.due, !completed) ||
      (completed &&
        c.due < `${month}-01` &&
        references.some((id) =>
          data.transactions.some(
            (t) =>
              t.id === id &&
              isRealized(t, asOf) &&
              t.transaction_date.startsWith(month),
          ),
        ))
    )
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
        data.transactions.find((t) => t.id === c.entity)?.type ===
          "card_payment"
      )
        continue;
      if (
        c.source === "transaction" &&
        plan.debt_payments.some((p) => p.transaction_id === c.entity)
      )
        continue;
      const o = plan.recurring_occurrences.find(
        (o) => o.transaction_id === c.transactionId,
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
    const rule = plan.recurring_items.find((r) => r.id === o.recurring_item_id);
    const r =
      rule &&
      occurrenceDefinition(
        rule,
        o.due_date,
        plan.recurring_occurrences,
        data.transactions,
      );
    if (
      !r ||
      r.type !== "expense" ||
      o.status === "skipped" ||
      o.status === "planned" ||
      data.transactions.find((t) => t.id === o.transaction_id)?.status ===
        "cancelled"
    )
      continue;
    const paymentTransactions = occurrencePayments(
      o,
      r.type,
      data.transactions,
      plan.recurring_payments ?? [],
      asOf,
    );
    const paid = paymentTransactions.reduce((s, t) => s + t.amount_cents, 0);
    const expected = occurrenceAmount(
      r,
      o.due_date,
      plan.recurring_occurrences,
      data.transactions,
    );
    const account = data.accounts.find((a) => a.id === r.account_id);
    const linked = data.transactions.find((t) => t.id === o.transaction_id);
    put(
      {
        id: `recurring:${r.id}:${o.due_date}`,
        source: "recurring",
        entity: r.id,
        transactionId: o.transaction_id ?? undefined,
        occurrenceId: o.id,
        name: r.name,
        due: o.due_date,
        amount: expected,
        impact:
          account && isOperationalAccount(account)
            ? Math.min(0, paid - expected)
            : 0,
        reserveAccount: !!account && isReserveAccount(account),
        direction: "expense",
        group: "fixed",
        canResolve:
          !!linked &&
          (linked.status === "pending" || (paid > 0 && paid < expected)),
      },
      paid,
      [o.id, ...paymentTransactions.map((t) => t.id)],
      expected > 0 && paid >= expected,
    );
  }
  for (const t of data.transactions) {
    if (
      t.type !== "expense" ||
      !t.financial_commitment ||
      !isRealized(t, asOf) ||
      t.payment_reference ||
      plan.recurring_occurrences.some((o) => o.transaction_id === t.id) ||
      (plan.recurring_payments ?? []).some((p) => p.transaction_id === t.id)
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
  for (const i of planningInvoices(plan, payments, asOf)) {
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
        impact:
          card.payment_account_id === null ||
          data.accounts.some(
            (a) => a.id === card.payment_account_id && isOperationalAccount(a),
          )
            ? -i.pending
            : 0,
        direction: "expense",
        group: "cards",
        canResolve: (i.payable ?? i.pending) > 0,
      },
      i.paid,
      payments
        .filter((p) => p.card_id === i.card_id && p.due_month === i.month)
        .map((p) => p.id),
      i.pending === 0,
    );
  }
  const allocations = plan.debt_payment_allocations ?? [];
  const debtEvidence = [
    ...allocations.flatMap((a) => {
      const p = plan.debt_payments.find((p) => p.id === a.payment_id);
      return p && tx(p.transaction_id)?.amount_cents === p.amount_cents
        ? [
            {
              ...p,
              ...a,
              transaction_id: p.transaction_id,
              payment_date: p.payment_date,
            },
          ]
        : [];
    }),
    ...plan.debt_payments.filter(
      (p) =>
        !allocations.some((a) => a.payment_id === p.id) &&
        tx(p.transaction_id)?.amount_cents === p.amount_cents,
    ),
  ];
  for (const m of projection(data, plan, asOf))
    for (const c of m.items.filter((c) => c.source === "debt")) {
      const paid = debtEvidence
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
  const groups = new Map<string, typeof debtEvidence>();
  for (const p of debtEvidence)
    if (p.scheduled_date && !!tx(p.transaction_id) && p.payment_date <= asOf) {
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
        impact:
          d.payment_account_id === null ||
          data.accounts.some(
            (a) => a.id === d.payment_account_id && isOperationalAccount(a),
          )
            ? Math.min(0, paid - expected)
            : 0,
        direction: "expense",
        group: "debts",
        canResolve: d.next_due_date === ps[0].scheduled_date,
      },
      paid,
      [...new Set(ps.map((p) => p.transaction_id))],
      paid >= expected,
    );
  }
  return [...result.values()].sort(
    (a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id),
  );
}
