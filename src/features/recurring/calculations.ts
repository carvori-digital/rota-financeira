import { isRealized } from "../../utils/finance.ts";
import type { RecurringPayment } from "./types.ts";
import type { Transaction } from "../../types/index.ts";
import type { RecurringItem, RecurringOccurrence } from "./types.ts";
import { addMonths, addDays } from "../planning/dates.ts";
export function recurringDates(
  rule: RecurringItem,
  through: string,
  completed: RecurringOccurrence[] = [],
) {
  const resolved = new Set(
    completed
      .filter((o) => o.recurring_item_id === rule.id && o.status !== "planned")
      .map((o) => o.due_date),
  );
  const dates: string[] = [];
  if (rule.active)
    for (let i = 0; ; i++) {
      const date =
        rule.frequency === "weekly"
          ? addDays(rule.start_date, i * 7)
          : addMonths(
              rule.start_date,
              i * (rule.frequency === "yearly" ? 12 : 1),
            );
      if (date > through || (rule.end_date && date > rule.end_date)) break;
      if (!resolved.has(date)) dates.push(date);
    }
  return [
    ...new Set([
      ...dates,
      ...completed
        .filter(
          (o) =>
            o.recurring_item_id === rule.id &&
            o.status === "planned" &&
            o.due_date <= through,
        )
        .map((o) => o.due_date),
    ]),
  ].sort();
}
export function essentialMonthly(rules: RecurringItem[], asOf: string) {
  return Math.round(
    rules
      .filter(
        (r) =>
          r.active &&
          r.is_essential &&
          r.type === "expense" &&
          (!r.end_date || r.end_date >= asOf),
      )
      .reduce(
        (sum, r) =>
          sum +
          r.amount_cents *
            (r.frequency === "weekly"
              ? 52 / 12
              : r.frequency === "yearly"
                ? 1 / 12
                : 1),
        0,
      ),
  );
}

// Legacy recorded occurrences use only their linked transaction as evidence.
// The current rule is never evidence of what was owed in a previous month.
export function occurrenceAmount(
  rule: RecurringItem,
  due: string,
  occurrences: RecurringOccurrence[],
  transactions: Transaction[] = [],
) {
  const occurrence = occurrences.find(
    (o) => o.recurring_item_id === rule.id && o.due_date === due,
  );
  if (occurrence?.amount_cents != null) return occurrence.amount_cents;
  if (occurrence?.status === "recorded")
    return (
      transactions.find((t) => t.id === occurrence.transaction_id)
        ?.amount_cents ?? 0
    );
  return rule.amount_cents;
}

export function occurrencePayments(
  occurrence: RecurringOccurrence,
  type: RecurringItem["type"],
  transactions: Transaction[],
  payments: RecurringPayment[],
  asOf: string,
) {
  const ids = new Set([
    occurrence.transaction_id,
    ...payments
      .filter((p) => p.occurrence_id === occurrence.id)
      .map((p) => p.transaction_id),
  ]);
  return transactions.filter(
    (t) => ids.has(t.id) && t.type === type && isRealized(t, asOf),
  );
}

export function occurrenceDefinition(
  rule: RecurringItem,
  due: string,
  occurrences: RecurringOccurrence[],
  transactions: Transaction[] = [],
): RecurringItem {
  const o = occurrences.find(
    (o) => o.recurring_item_id === rule.id && o.due_date === due,
  );
  if (o?.terms)
    return {
      ...rule,
      ...o.terms,
      name: o.terms.name || "Ocorrência recorrente",
      frequency: o.terms.frequency ?? rule.frequency,
    };
  const t =
    o?.status === "recorded"
      ? transactions.find((t) => t.id === o.transaction_id)
      : undefined;
  return t && (t.type === "income" || t.type === "expense")
    ? {
        ...rule,
        name: t.description || "Ocorrência recorrente",
        type: t.type,
        account_id: t.account_id,
        category_id: t.category_id ?? rule.category_id,
      }
    : rule;
}
