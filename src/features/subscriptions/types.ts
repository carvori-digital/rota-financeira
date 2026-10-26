import type { Base } from "../../types/index.ts";
export interface CardSubscription extends Omit<Base, "updated_at"> {
  start_date: string;
  billing_day: number;
  frequency: "monthly";
}
export interface SubscriptionVersion extends Omit<Base, "updated_at"> {
  subscription_id: string;
  revision: number;
  effective_month: string;
  name: string;
  card_id: string;
  category_id: string;
  amount_cents: number;
  closing_day: number;
  due_day: number;
  status: "active" | "paused" | "cancelled";
  end_date: string | null;
}
export interface SubscriptionCharge {
  subscription_id: string;
  charge_month: string;
  charge_date: string;
  due_date: string;
  card_id: string;
  category_id: string;
  name: string;
  amount_cents: number;
  status: "planned" | "confirmed" | "skipped";
  purchase_id: string | null;
  covered_invoice_id: string | null;
}
export interface SubscriptionOccurrence extends Base, SubscriptionCharge {}
