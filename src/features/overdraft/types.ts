import type { Base } from "../../types/index.ts";
export interface OverdraftVersion extends Base {
  account_id: string;
  revision: number;
  tracking_start: string;
  effective_date: string;
  limit_cents: number;
  active: boolean;
  statement_model: "negative_balance" | "needs_reconciliation";
  monthly_interest_rate: number | null;
  contract_notes: string;
  change_reason: string;
}
export interface BankReconciliation extends Base {
  account_id: string;
  statement_date: string;
  statement_balance_cents: number;
  calculated_balance_cents: number;
  difference_cents: number;
  evidence: string;
  ledger_snapshot: { initial_balance_cents: number; transactions: unknown[] };
}
