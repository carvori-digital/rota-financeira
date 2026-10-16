import type { Base } from "../../types/index.ts";
import type {
  InvestmentRate,
  Investment,
  InvestmentMovement,
  ClassificationReview,
} from "../investments/types.ts";
import type { CardAdjustment } from "../cards/types.ts";
import type { RecurringItem, RecurringOccurrence } from "../recurring/types.ts";
import type {
  CreditCard,
  CardPurchase,
  CardInvoice,
  CardPayment,
} from "../cards/types.ts";
import type { Debt, DebtPayment } from "../debts/types.ts";
export interface ReserveLink extends Base {
  goal_id: string;
  account_id: string;
}
export interface PlanningData {
  card_subscriptions?: import("../subscriptions/types.ts").CardSubscription[];
  card_subscription_versions?: import("../subscriptions/types.ts").SubscriptionVersion[];
  card_subscription_occurrences?: import("../subscriptions/types.ts").SubscriptionOccurrence[];
  investment_reconstructions?: import("../investments/types.ts").InvestmentReconstruction[];
  investment_rates?: InvestmentRate[];
  cdi_history?: import("../investments/cdi.ts").CdiHistory | null;
  investments?: Investment[];
  investment_movements?: InvestmentMovement[];
  classification_reviews?: ClassificationReview[];
  card_adjustments?: CardAdjustment[];
  debt_payment_allocations?: import("../debts/types.ts").DebtPaymentAllocation[];
  recurring_payments?: import("../recurring/types.ts").RecurringPayment[];
  recurring_items: RecurringItem[];
  recurring_occurrences: RecurringOccurrence[];
  credit_cards: CreditCard[];
  card_purchases: CardPurchase[];
  card_invoices: CardInvoice[];
  card_payments: CardPayment[];
  debts: Debt[];
  debt_payments: DebtPayment[];
  reserve_account_links: ReserveLink[];
}
export const emptyPlanning: PlanningData = {
  card_subscriptions: [],
  card_subscription_versions: [],
  card_subscription_occurrences: [],
  investment_reconstructions: [],
  investment_rates: [],
  investments: [],
  investment_movements: [],
  classification_reviews: [],
  card_adjustments: [],
  recurring_payments: [],
  debt_payment_allocations: [],
  recurring_items: [],
  recurring_occurrences: [],
  credit_cards: [],
  card_purchases: [],
  card_invoices: [],
  card_payments: [],
  debts: [],
  debt_payments: [],
  reserve_account_links: [],
};
export interface Commitment {
  transactionId?: string;
  occurrenceId?: string;
  reserveAccount?: boolean;
  canResolve?: boolean;
  group?: "fixed" | "scheduled" | "cards" | "debts" | "other";
  id: string;
  source: "recurring" | "card" | "debt" | "transaction";
  entity: string;
  name: string;
  due: string;
  cashDate?: string;
  amount: number;
  impact: number;
  direction: "income" | "expense" | "transfer";
}
export interface MonthProjection {
  month: string;
  opening: number;
  income: number;
  recurring: number;
  cards: number;
  debts: number;
  other: number;
  transfers: number;
  commitments: number;
  closing: number;
  items: Commitment[];
}
