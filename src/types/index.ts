export type Kind = "income" | "expense" | "transfer" | "card_payment";
export interface Base {
  id: string;
  user_id: string;
  created_at: string;
}
export interface Account extends Base {
  name: string;
  type: string;
  initial_balance_cents: number;
  currency: string;
  is_active: boolean;
}
export interface Category extends Base {
  name: string;
  type: "income" | "expense";
}
export interface Transaction extends Base {
  payment_reference?: 'card' | 'debt' | null;
  account_id: string;
  destination_account_id: string | null;
  category_id: string | null;
  type: Kind;
  amount_cents: number;
  description: string;
  transaction_date: string;
  is_recurring: boolean;
  recurrence_frequency: string | null;
}
export interface Goal extends Base {
  essential_monthly_cents?: number | null;
  reserve_months?: number | null;
  is_emergency_reserve?: boolean;
  name: string;
  target_amount_cents: number;
  initial_amount_cents: number;
  target_date: string | null;
  is_active: boolean;
}
export interface Contribution extends Base {
  goal_id: string;
  amount_cents: number;
  contribution_date: string;
  description: string;
}
export interface FinanceData {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  goals: Goal[];
  goal_contributions: Contribution[];
}
export type Table = keyof FinanceData;
