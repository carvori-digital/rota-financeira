import type { Base } from "../../types/index.ts";
export interface CreditCard extends Base {
  name: string;
  limit_cents: number | null;
  closing_day: number;
  due_day: number;
  payment_account_id: string | null;
  holder_name?: string | null;
  active: boolean;
}
export interface CardPurchase extends Base {
  cancelled_at?: string | null;
  card_id: string;
  category_id: string;
  amount_cents: number;
  description: string;
  purchase_date: string;
  installments: number;
  first_due_date: string;
  due_anchor_day: number;
}
export interface CardInvoice extends Base {
  card_id: string;
  amount_cents: number;
  due_date: string;
  due_month: string;
  description: string;
  covered_at: string;
}
export interface CardPayment extends Base {
  card_id: string;
  due_month: string;
  transaction_id: string;
  amount_cents: number;
  payment_date: string;
}
export interface InvoiceSummary {
  card_id: string;
  month: string;
  due_date: string;
  total: number;
  paid: number;
  pending: number;
}
export interface CardAdjustment extends Base {
  card_id: string;
  purchase_id: string;
  due_month: string;
  due_date: string;
  amount_cents: number;
  description: string;
}
