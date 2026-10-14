import type { Base } from "../../types/index.ts";
export interface Investment extends Base {
  name: string;
  institution: string;
  type: string;
  initial_date: string;
  yield_type: "manual" | "fixed_annual" | "fixed_monthly" | "percent_cdi";
  yield_rate: number;
  is_emergency_reserve: boolean;
  active: boolean;
  source_account_id: string | null;
  replaced_by_id?: string | null;
  updated_at: string;
}
export interface InvestmentMovement extends Base {
  ledger_order?: number;
  accounting_kind?: "real_cash" | "historical_position" | "valuation";
  sync_value_cents?: number | null;
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

export interface InvestmentRate extends Base {
  investment_id: string;
  effective_date: string;
  percent: number;
}

export interface InvestmentReconstruction extends Base {
  old_investment_id: string;
  new_investment_id: string;
  recorded_value_cents: number;
  historical_net_cents: number;
  real_value_cents: number;
  difference_cents: number;
  reconciliation_note: string;
}
