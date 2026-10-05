import type { Base } from "../../types/index.ts";
export interface Investment extends Base {
  name: string;
  institution: string;
  type: string;
  initial_date: string;
  yield_type: "manual" | "fixed_annual" | "fixed_monthly";
  yield_rate: number;
  is_emergency_reserve: boolean;
  active: boolean;
  source_account_id: string | null;
  updated_at: string;
}
export interface InvestmentMovement extends Base {
  investment_id: string;
  type: "contribution" | "withdrawal" | "adjustment";
  amount_cents: number;
  date: string;
  description: string;
  transaction_id: string | null;
  source_transaction_id: string | null;
  source_account_id: string | null;
}
export interface ClassificationReview extends Base {
  source_table: "accounts" | "card_purchases" | "debts" | "transactions";
  source_id: string;
  reason: string;
  confidence: "LOW" | "MEDIUM";
  status: "pending" | "kept";
  resolution: string | null;
}
