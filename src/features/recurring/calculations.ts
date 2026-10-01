import type { RecurringItem, RecurringOccurrence } from './types.ts';
import { addMonths,addDays } from '../planning/dates.ts';
export function recurringDates(rule: RecurringItem, through: string, completed: RecurringOccurrence[]=[]) {
 const resolved=new Set(completed.filter(o=>o.recurring_item_id===rule.id).map(o=>o.due_date)); const dates:string[]=[];
 if(!rule.active) return dates;
 for(let i=0; ;i++) {
  const date=rule.frequency==='weekly'?addDays(rule.start_date,i*7):addMonths(rule.start_date,i*(rule.frequency==='yearly'?12:1));
  if(date>through || (rule.end_date && date>rule.end_date)) break;
  if(!resolved.has(date)) dates.push(date);
 }
 return dates;
}
export function essentialMonthly(rules: RecurringItem[], asOf: string) {
 return Math.round(rules.filter(r=>r.active && r.is_essential && r.type==='expense' && (!r.end_date || r.end_date>=asOf)).reduce((sum,r)=>sum+r.amount_cents*(r.frequency==='weekly'?52/12:r.frequency==='yearly'?1/12:1),0));
}
