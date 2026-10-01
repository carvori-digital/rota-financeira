import { useEffect,useRef,useState } from 'react';
import type { ReactNode,FormEvent } from 'react';
import { inputMoney,parseMoney } from '../../utils/finance';
export type Money = (cents:number)=>ReactNode;
export function Field({label,children}:{label:string;children:ReactNode}) { return <label className="field"><span>{label}</span>{children}</label>; }
export function Amount({label='Valor (R$)',name='amount',value,hidden,optional=false}:{label?:string;name?:string;value?:number|null;hidden:boolean;optional?:boolean}) { return <Field label={label}><input name={name} type={hidden?'password':'text'} inputMode="decimal" required={!optional} defaultValue={value==null?'':inputMoney(value)} placeholder="0,00" autoComplete="off" /></Field>; }
export function cents(form:FormData,name='amount',optional=false) { const raw=String(form.get(name)??'').trim();if(!raw&&optional)return null;return parseMoney(raw); }
export function text(form:FormData,name:string) { return String(form.get(name)??'').trim(); }
export function Modal({title,children,onClose,onSubmit}:{title:string;children:ReactNode;onClose:()=>void;onSubmit:(form:FormData)=>Promise<void>}) {
 const ref=useRef<HTMLDialogElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [busy,setBusy]=useState(false),[closing,setClosing]=useState(false),[error,setError]=useState('');
 useEffect(()=>{ref.current?.showModal();return()=>{if(timer.current)clearTimeout(timer.current);};},[]);
 function close(action=onClose) {if(closing)return;if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){action();return;}setClosing(true);timer.current=setTimeout(action,140);}
 async function submit(e:FormEvent<HTMLFormElement>) {e.preventDefault();if(busy||closing)return;setBusy(true);setError('');try {await onSubmit(new FormData(e.currentTarget));close();}catch(err){setError((err as {message?:string}).message??'Não foi possível salvar. Tente novamente.');setBusy(false);}}
 return <dialog ref={ref} className={closing?'closing':''} aria-label={title} onCancel={e=>{e.preventDefault();if(!busy)close();}}><form onSubmit={submit}><div className="section-heading"><h2>{title}</h2><button type="button" disabled={busy||closing} aria-label="Fechar" onClick={()=>close()}>×</button></div><fieldset disabled={busy||closing}>{children}{error&&<p role="alert">{error}</p>}<button type="submit" className="primary">{busy?'Salvando…':'Salvar'}</button></fieldset></form></dialog>;
}
export function QuickActions({onSelect,onClose}:{onSelect:(kind:string)=>void;onClose:()=>void}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} aria-label="Nova movimentação" onCancel={e=>{e.preventDefault();onClose();}}><div className="section-heading"><h2>O que deseja registrar?</h2><button aria-label="Fechar" onClick={onClose}>×</button></div><div className="quick-actions">{[['income','Receita'],['expense','Despesa'],['transfer','Transferência'],['purchase','Compra no cartão'],['debtPayment','Pagamento de dívida'],['contribution','Aporte/transferência']].map(([kind,label])=><button key={kind} onClick={()=>onSelect(kind)}>{label}<span aria-hidden="true">→</span></button>)}</div></dialog>;
}
