import type { PlanningData } from '../planning/types';
import type { Money } from '../planning/ui';
import type { RecurringItem } from './types';
import { recurringDates } from './calculations';
import { addMonths } from '../planning/dates';
import { displayDate,today } from '../../utils/finance';
export function RecurringPanel({plan,money,onEdit,onResolve,onToggle}:{plan:PlanningData;money:Money;onEdit:(r?:RecurringItem)=>void;onResolve:(r:RecurringItem,date:string,skip:boolean)=>void;onToggle:(r:RecurringItem)=>void}) {
 const now=today();
 return <><div className="section-heading"><h2>Recorrentes</h2><button onClick={()=>onEdit()}>Adicionar recorrente</button></div>{!plan.recurring_items.length&&<div className="empty"><p>Adicione uma receita ou conta recorrente para prever os próximos meses.</p><button className="primary" onClick={()=>onEdit()}>Adicionar receita ou conta recorrente</button></div>}{plan.recurring_items.map(r=><article className="panel" key={r.id}><div className="section-heading"><h3>{r.name}</h3><strong>{money(r.amount_cents)}</strong></div><p>{r.type==='income'?'Receita':'Despesa'} · {({weekly:'Semanal',monthly:'Mensal',yearly:'Anual'})[r.frequency]}{r.is_essential?' · Essencial':''}{!r.active?' · Pausada':''}</p><div className="actions"><button onClick={()=>onEdit(r)}>Editar regra</button><button onClick={()=>onToggle(r)}>{r.active?'Pausar':'Reativar'}</button></div>{recurringDates(r,addMonths(now,1),plan.recurring_occurrences).slice(0,6).map(date=><div className="account-line" key={date}><small>{displayDate(date)} · {date<=now?'PENDENTE':'PREVISTO'}</small><div className="actions"><button disabled={date>now} onClick={()=>onResolve(r,date,false)}>Realizar</button><button onClick={()=>onResolve(r,date,true)}>Pular</button></div></div>)}</article>)}</>;
}
