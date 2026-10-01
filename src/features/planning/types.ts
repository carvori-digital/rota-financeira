import type { Base } from '../../types/index.ts';
import type { RecurringItem, RecurringOccurrence } from '../recurring/types.ts';
import type { CreditCard, CardPurchase, CardInvoice, CardPayment } from '../cards/types.ts';
import type { Debt, DebtPayment } from '../debts/types.ts';
export interface ReserveLink extends Base { goal_id: string; account_id: string; }
export interface PlanningData { recurring_items: RecurringItem[]; recurring_occurrences: RecurringOccurrence[]; credit_cards: CreditCard[]; card_purchases: CardPurchase[]; card_invoices: CardInvoice[]; card_payments: CardPayment[]; debts: Debt[]; debt_payments: DebtPayment[]; reserve_account_links: ReserveLink[]; }
export const emptyPlanning: PlanningData = { recurring_items: [], recurring_occurrences: [], credit_cards: [], card_purchases: [], card_invoices: [], card_payments: [], debts: [], debt_payments: [], reserve_account_links: [] };
export interface Commitment { id: string; source: 'recurring'|'card'|'debt'|'transaction'; entity: string; name: string; due: string; amount: number; impact: number; direction: 'income'|'expense'|'transfer'; }
export interface MonthProjection { month: string; opening: number; income: number; recurring: number; cards: number; debts: number; other: number; transfers: number; commitments: number; closing: number; items: Commitment[]; }
