import type { Debt } from './types.ts';
import { addMonths } from '../planning/dates.ts';
export function debtInstallments(debt: Debt, through: string) {
 const result:{date:string;amount:number}[]=[];
 if(!debt.active || !debt.next_due_date || !debt.installment_amount_cents) return result;
 let remaining=debt.remaining_amount_cents;
 for(let i=0;remaining>0;i++) {
  const date=addMonths(debt.next_due_date,i,debt.due_anchor_day??Number(debt.next_due_date.slice(8,10)));
  if(date>through) break;
  const amount=Math.min(remaining,debt.installment_amount_cents-(i===0?debt.installment_paid_cents:0));
  if(amount<=0) throw new Error('Parcela da dívida inconsistente');
  result.push({date,amount});remaining-=amount;
 }
 return result;
}
export function debtProgress(debt: Debt) { const paid=debt.original_amount_cents-debt.remaining_amount_cents;return {paid,percent:paid*100/debt.original_amount_cents}; }
