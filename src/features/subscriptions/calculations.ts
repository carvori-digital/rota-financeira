import type { PlanningData } from "../planning/types.ts";
import type { CardPayment } from "../cards/types.ts";
import type { SubscriptionCharge } from "./types.ts";
import { firstInvoiceDate, invoices } from "../cards/calculations.ts";
import { addMonths, monthDay } from "../planning/dates.ts";

export function subscriptionVersion(
  plan: PlanningData,
  id: string,
  month?: string,
) {
  return (plan.card_subscription_versions ?? [])
    .filter(
      (v) =>
        v.subscription_id === id &&
        (!month || v.effective_month.slice(0, 7) <= month.slice(0, 7)),
    )
    .sort(
      (a, b) =>
        b.effective_month.localeCompare(a.effective_month) ||
        b.revision - a.revision,
    )[0];
}
export function subscriptionCharge(
  plan: PlanningData,
  id: string,
  month: string,
): SubscriptionCharge | null {
  const s = plan.card_subscriptions?.find((s) => s.id === id);
  if (!s) return null;
  const o = plan.card_subscription_occurrences?.find(
    (o) =>
      o.subscription_id === id &&
      o.charge_month.slice(0, 7) === month.slice(0, 7),
  );
  if (o && o.status !== "planned") return o;
  const v = subscriptionVersion(plan, id, month);
  const date = monthDay(month.slice(0, 7), s.billing_day);
  if (
    !v ||
    v.status !== "active" ||
    date < s.start_date ||
    (v.end_date && date > v.end_date)
  )
    return null;
  return {
    subscription_id: id,
    charge_month: `${month.slice(0, 7)}-01`,
    charge_date: date,
    due_date: firstInvoiceDate(date, v.closing_day, v.due_day),
    card_id: v.card_id,
    category_id: v.category_id,
    name: v.name,
    amount_cents: o?.amount_cents ?? v.amount_cents,
    status: "planned",
    purchase_id: null,
    covered_invoice_id: null,
  };
}
// Calendar-month iteration preserves the original billing day in short months.
export function subscriptionCharges(
  plan: PlanningData,
  through: string,
): SubscriptionCharge[] {
  const result: SubscriptionCharge[] = [];
  for (const s of plan.card_subscriptions ?? []) {
    for (
      let month = s.start_date.slice(0, 7);
      month <= through.slice(0, 7);
      month = addMonths(`${month}-01`, 1).slice(0, 7)
    ) {
      const c = subscriptionCharge(plan, s.id, month);
      if (c && c.charge_date <= through) result.push(c);
    }
  }
  return result;
}
export function planningInvoices(
  plan: PlanningData,
  payments: CardPayment[] = plan.card_payments,
  asOf: string,
  through = addMonths(`${asOf.slice(0, 7)}-01`, 3, 31),
  forecasts = true,
) {
  const covered = (plan.card_subscription_occurrences ?? [])
    .filter(
      (o) =>
        o.covered_invoice_id &&
        plan.card_invoices.some((b) => b.id === o.covered_invoice_id),
    )
    .map((o) => o.purchase_id!);
  return invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    payments,
    plan.card_adjustments,
    {
      covered,
      forecasts: forecasts
        ? subscriptionCharges(plan, through).filter(
            (c) => c.status === "planned",
          )
        : [],
    },
  );
}
