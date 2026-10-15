import type { Base } from "../../types/index.ts";
export interface RecurringItem extends Base {
  name: string;
  type: "income" | "expense";
  amount_cents: number;
  account_id: string;
  category_id: string;
  frequency: "weekly" | "monthly" | "yearly";
  start_date: string;
  end_date: string | null;
  active: boolean;
  is_essential: boolean;
}
export interface RecurringOccurrence extends Base {
  recurring_item_id: string;
  due_date: string;
  status: "planned" | "recorded" | "skipped";
  amount_cents?: number | null;
  terms?: Pick<
    RecurringItem,
    "name" | "type" | "account_id" | "category_id"
  > & { frequency: RecurringItem["frequency"] | null };
  transaction_id: string | null;
}

export interface RecurringPayment extends Base {
  occurrence_id: string;
  transaction_id: string;
}
