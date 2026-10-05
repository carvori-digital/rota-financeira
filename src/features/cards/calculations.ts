import type {
  CreditCard,
  CardPurchase,
  CardInvoice,
  CardPayment,
  InvoiceSummary,
  CardAdjustment,
} from "./types.ts";
import { monthDay, addMonths } from "../planning/dates.ts";
export function firstInvoiceDate(date: string, closing: number, due: number) {
  let month = date.slice(0, 7);
  if (date > monthDay(month, closing))
    month = addMonths(`${month}-01`, 1).slice(0, 7);
  if (due <= closing) month = addMonths(`${month}-01`, 1).slice(0, 7);
  return monthDay(month, due);
}
export function purchaseInstallments(p: CardPurchase) {
  return Array.from({ length: p.installments }, (_, i) => ({
    date: addMonths(p.first_due_date, i, p.due_anchor_day),
    amount:
      Math.floor(p.amount_cents / p.installments) +
      (i < p.amount_cents % p.installments ? 1 : 0),
    number: i + 1,
  }));
}
export function invoices(
  cards: CreditCard[],
  purchases: CardPurchase[],
  manual: CardInvoice[],
  payments: CardPayment[],
  adjustments: CardAdjustment[] = [],
): InvoiceSummary[] {
  const result = new Map<string, InvoiceSummary>();
  for (const invoice of manual)
    result.set(`${invoice.card_id}:${invoice.due_month}`, {
      card_id: invoice.card_id,
      month: invoice.due_month,
      due_date: invoice.due_date,
      total: invoice.amount_cents,
      paid: 0,
      pending: 0,
    });
  for (const purchase of purchases)
    if (!purchase.cancelled_at)
      for (const installment of purchaseInstallments(purchase)) {
        const month = installment.date.slice(0, 7),
          key = `${purchase.card_id}:${month}`;
        const baseline = manual.find(
          (m) => m.card_id === purchase.card_id && m.due_month === month,
        );
        if (baseline && purchase.created_at <= baseline.covered_at) continue;
        const item = result.get(key) ?? {
          card_id: purchase.card_id,
          month,
          due_date: installment.date,
          total: 0,
          paid: 0,
          pending: 0,
        };
        item.total += installment.amount;
        result.set(key, item);
      }
  for (const adjustment of adjustments) {
    const key = `${adjustment.card_id}:${adjustment.due_month}`;
    const item = result.get(key) ?? {
      card_id: adjustment.card_id,
      month: adjustment.due_month,
      due_date: adjustment.due_date,
      total: 0,
      paid: 0,
      pending: 0,
    };
    item.total += adjustment.amount_cents;
    result.set(key, item);
  }
  for (const payment of payments) {
    const key = `${payment.card_id}:${payment.due_month}`;
    const item = result.get(key);
    if (item) item.paid += payment.amount_cents;
  }
  return [...result.values()]
    .filter((i) => cards.some((c) => c.id === i.card_id))
    .map((i) => ({ ...i, pending: Math.max(0, i.total - i.paid) }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}
