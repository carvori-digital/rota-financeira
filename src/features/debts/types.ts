import type { Base } from '../../types/index.ts';
export interface Debt extends Base { name: string; original_amount_cents: number; remaining_amount_cents: number; installment_amount_cents: number|null; next_due_date: string|null; due_anchor_day: number|null; installment_paid_cents: number; payment_account_id: string|null; active: boolean; }
export interface DebtPayment extends Base { debt_id: string; transaction_id: string; amount_cents: number; payment_date: string; scheduled_date: string|null; }
