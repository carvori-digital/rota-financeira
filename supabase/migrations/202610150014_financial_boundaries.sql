begin;
-- Freeze provenance independently of mutable rules. Recorded legacy provenance
-- comes from the linked bank transaction; planned provenance is current config.
alter table public.recurring_occurrences add column terms jsonb;
-- This metadata backfill must preserve original timestamps as well as money.
-- ALTER TABLE holds its lock until COMMIT; no concurrent writer bypasses this.
alter table public.recurring_occurrences disable trigger protect_row;
update public.recurring_occurrences o set terms=jsonb_build_object(
 'name',t.description,'type',t.type,'account_id',t.account_id,'category_id',t.category_id,'frequency',t.recurrence_frequency)
from public.transactions t where t.id=o.transaction_id and t.user_id=o.user_id;
update public.recurring_occurrences o set terms=jsonb_build_object(
 'name',r.name,'type',r.type,'account_id',r.account_id,'category_id',r.category_id,'frequency',r.frequency)
from public.recurring_items r where r.id=o.recurring_item_id and r.user_id=o.user_id and o.terms is null;
alter table public.recurring_occurrences enable trigger protect_row;
alter table public.recurring_occurrences alter column terms set not null;
alter table public.recurring_occurrences add column obligation_account_id uuid generated always as ((terms->>'account_id')::uuid) stored;
alter table public.recurring_occurrences add column obligation_category_id uuid generated always as ((terms->>'category_id')::uuid) stored;
alter table public.recurring_occurrences add column obligation_type text generated always as (terms->>'type') stored;
alter table public.recurring_occurrences add constraint occurrence_account_owner foreign key(obligation_account_id,user_id) references public.accounts(id,user_id) on delete restrict;
alter table public.recurring_occurrences add constraint occurrence_category_owner foreign key(obligation_category_id,user_id,obligation_type) references public.categories(id,user_id,type) on delete restrict;
create function public.capture_recurring_terms() returns trigger language plpgsql set search_path='' as $$
declare r public.recurring_items; t public.transactions;
begin
 if tg_op='UPDATE' and new.terms is distinct from old.terms then raise exception 'Origem da obrigação é imutável';end if;
 if new.terms is null then
  if new.transaction_id is not null then
   select * into t from public.transactions where id=new.transaction_id and user_id=new.user_id;
   if found then new.terms=jsonb_build_object('name',t.description,'type',t.type,'account_id',t.account_id,'category_id',t.category_id,'frequency',t.recurrence_frequency);end if;
  end if;
  if new.terms is null then
   select * into r from public.recurring_items where id=new.recurring_item_id and user_id=new.user_id;
   new.terms=jsonb_build_object('name',r.name,'type',r.type,'account_id',r.account_id,'category_id',r.category_id,'frequency',r.frequency);
  end if;
 end if;
 return new;
end $$;
create trigger capture_recurring_terms before insert or update on public.recurring_occurrences for each row execute function public.capture_recurring_terms();
create or replace function public.preserve_due_recurring_amounts() returns trigger language plpgsql security definer set search_path='' as $$
declare due date; n integer=0;
begin
 if not old.active then return new;end if;
 if (new.frequency,new.start_date) is distinct from (old.frequency,old.start_date) and new.start_date<public.financial_date() and exists(select 1 from public.recurring_occurrences where recurring_item_id=old.id and user_id=old.user_id) then raise exception 'Mudança de calendário exige primeira ocorrência atual ou futura';end if;
 if (new.name,new.type,new.amount_cents,new.account_id,new.category_id,new.frequency,new.start_date,new.end_date,new.active)
  is not distinct from (old.name,old.type,old.amount_cents,old.account_id,old.category_id,old.frequency,old.start_date,old.end_date,old.active) then return new;end if;
 loop
  due=case old.frequency when 'weekly' then old.start_date+n*7
   else public.month_day((old.start_date+n*(case old.frequency when 'yearly' then 12 else 1 end)*interval '1 month')::date,extract(day from old.start_date)::integer) end;
  exit when due>public.financial_date() or (old.end_date is not null and due>old.end_date);
  insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,amount_cents,terms)
   values(old.user_id,old.id,due,'planned',old.amount_cents,jsonb_build_object('name',old.name,'type',old.type,'account_id',old.account_id,'category_id',old.category_id,'frequency',old.frequency))
   on conflict(recurring_item_id,user_id,due_date) do nothing;
  n=n+1;
 end loop;
 return new;
end $$;
drop trigger preserve_due_recurring_amounts on public.recurring_items;
create trigger preserve_due_recurring_amounts before update on public.recurring_items for each row execute function public.preserve_due_recurring_amounts();

-- Immutable request results survive subsequent edits and zero-value operations.
create table public.financial_requests (
 id uuid primary key,user_id uuid not null,operation text not null,payload jsonb not null,result uuid not null,created_at timestamptz not null default now()
);
alter table public.financial_requests enable row level security;
create policy own_select on public.financial_requests for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.financial_requests from public,anon,authenticated;grant select on public.financial_requests to authenticated;
create index on public.financial_requests(user_id);
create function public.financial_request_result(p_id uuid,p_operation text,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.financial_requests;u uuid=auth.uid();
begin
 if u is null or p_id is null then raise exception 'Autenticação e identificador necessários';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,14));
 select * into r from public.financial_requests where id=p_id;
 if found then
  if r.user_id<>u or r.operation<>p_operation or r.payload is distinct from p_payload then raise exception 'Requisição já utilizada com outros parâmetros';end if;
  return r.result;
 end if;
 return null;
end $$;
revoke all on function public.financial_request_result(uuid,text,jsonb) from public,anon,authenticated;

-- New requests use the occurrence provenance, never the rule's current fields.
create or replace function public.record_recurring_payment(p_id uuid,p_rule uuid,p_due date,p_amount bigint default null,p_date date default null) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; o public.recurring_occurrences; t public.transactions;
 expected bigint; paid bigint=0; amount bigint; actual_date date=coalesce(p_date,public.financial_date());
 cfg jsonb; payload jsonb=jsonb_build_object('rule',p_rule,'due',p_due,'amount',p_amount,'date',p_date);result uuid;
begin
 result=public.financial_request_result(p_id,'recurring_payment',payload);if result is not null then return result;end if;
 select * into r from public.recurring_items where id=p_rule and user_id=u for update;
 if not found then raise exception 'Recorrência não encontrada';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due for update;
 cfg=coalesce(o.terms,jsonb_build_object('name',r.name,'type',r.type,'account_id',r.account_id,'category_id',r.category_id,'frequency',r.frequency));
 if exists(select 1 from public.transactions where id=p_id) then
  if o.transaction_id=p_id or exists(select 1 from public.recurring_payments where id=p_id and occurrence_id=o.id and user_id=u) then
   select * into t from public.transactions where id=p_id and user_id=u;
   if (p_amount is not null and t.amount_cents<>p_amount) or (p_date is not null and t.transaction_date<>p_date) then raise exception 'Requisição já usada com outros valores';end if;
   result=o.id;
  else raise exception 'Identificador de pagamento já utilizado';end if;
 end if;
 if result is null then
  if o.status='skipped' then raise exception 'Ocorrência pulada';end if;
  if o.status='recorded' then
   select * into t from public.transactions where id=o.transaction_id and user_id=u;
   if not found then raise exception 'Pagamento vinculado não encontrado';end if;
   if t.status='pending' then
    if p_amount is not null and p_amount<>t.amount_cents then raise exception 'Confirme o lançamento pendente antes de alterar o pagamento';end if;
    perform public.resolve_transaction(t.id,false,actual_date);result=o.id;
   else
    if t.status<>'realized' or t.type<>cfg->>'type' or t.transaction_date>public.financial_date() then raise exception 'Confira o pagamento no histórico';end if;
    paid=t.amount_cents;
    select paid+coalesce(sum(tx.amount_cents),0) into paid from public.recurring_payments p join public.transactions tx on tx.id=p.transaction_id and tx.user_id=p.user_id
     where p.occurrence_id=o.id and p.user_id=u and tx.status='realized' and tx.transaction_date<=public.financial_date() and tx.type=cfg->>'type';
   end if;
  end if;
  expected=coalesce(o.amount_cents,r.amount_cents);
  if result is null and paid>=expected then result=o.id;end if;
  if result is null then
   if o.id is null and not r.active then raise exception 'Recorrência pausada';end if;
   if p_due is null or (o.id is null and not public.is_recurring_date(r,p_due)) then raise exception 'Data fora da recorrência';end if;
   if actual_date>public.financial_date() then raise exception 'Data de realização deve ser até hoje';end if;
   amount=coalesce(p_amount,expected-paid);
   if amount not between 1 and expected-paid then raise exception 'Pagamento deve respeitar o saldo restante';end if;
   perform 1 from public.accounts where id=(cfg->>'account_id')::uuid and user_id=u and is_active and investment_id is null and not investment_retired;
   if not found then raise exception 'Conta da obrigação inválida ou arquivada';end if;
   insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency)
    values(p_id,u,(cfg->>'account_id')::uuid,(cfg->>'category_id')::uuid,cfg->>'type',amount,cfg->>'name',actual_date,true,coalesce(cfg->>'frequency',r.frequency));
   if o.status='recorded' then
    insert into public.recurring_payments(id,user_id,occurrence_id,transaction_id) values(p_id,u,o.id,p_id);
   elsif o.id is not null then update public.recurring_occurrences set status='recorded',transaction_id=p_id where id=o.id and user_id=u;
   else
    insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,transaction_id,amount_cents,terms)
     values(p_id,u,r.id,p_due,'recorded',p_id,expected,cfg) returning * into o;
   end if;
   result=o.id;
  end if;
 end if;
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'recurring_payment',payload,result);
 return result;
end $$;

create or replace function public.resolve_recurring(p_id uuid,p_rule uuid,p_due date,p_skip boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();r public.recurring_items;o public.recurring_occurrences;t public.transactions;
 payload jsonb=jsonb_build_object('rule',p_rule,'due',p_due);result uuid;
begin
 if p_skip is null then raise exception 'Informe a ação';end if;
 if not p_skip then return public.record_recurring_payment(p_id,p_rule,p_due);end if;
 result=public.financial_request_result(p_id,'recurring_skip',payload);if result is not null then return result;end if;
 select * into r from public.recurring_items where id=p_rule and user_id=u for update;
 if not found then raise exception 'Recorrência não encontrada';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due for update;
 if o.status='recorded' then
  select * into t from public.transactions where id=o.transaction_id and user_id=u;
  if t.status='pending' then perform public.resolve_transaction(t.id,true,public.financial_date());else raise exception 'Pagamento já registrado; não é possível pular';end if;
 elsif o.status<>'skipped' or o.id is null then
  if p_due is null or (o.id is null and (not r.active or not public.is_recurring_date(r,p_due))) then raise exception 'Data ou recorrência inválida';end if;
  if o.id is null then
   insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,amount_cents) values(p_id,u,r.id,p_due,'skipped',r.amount_cents) returning * into o;
  else update public.recurring_occurrences set status='skipped' where id=o.id and user_id=u;end if;
 end if;
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'recurring_skip',payload,o.id);return o.id;
end $$;

-- Unsafe compatibility routes must not undo bank history or bypass stale guards.
create or replace function public.delete_investment(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin if auth.uid() is null then raise exception 'Autenticação necessária';end if;if not exists(select 1 from public.investments where id=p_id and user_id=auth.uid()) then raise exception 'Investimento não encontrado';end if;raise exception 'Operação antiga desativada; use a exclusão com confirmação que preserva o histórico bancário';end $$;
revoke all on function public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text),public.adjust_account_balance(uuid,uuid,bigint) from public,anon,authenticated;

create function public.guard_recurring_transaction() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and (exists(select 1 from public.recurring_occurrences where transaction_id=old.id and user_id=old.user_id) or exists(select 1 from public.recurring_payments where transaction_id=old.id and user_id=old.user_id)) then
  if tg_op='DELETE' then raise exception 'Pagamento vinculado protegido; preserve a ocorrência e o histórico';end if;
  if (new.type,new.amount_cents,new.account_id,new.destination_account_id,new.transaction_date,new.status) is distinct from (old.type,old.amount_cents,old.account_id,old.destination_account_id,old.transaction_date,old.status) then raise exception 'Pagamento vinculado protegido; use a operação da ocorrência';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger recurring_transaction before update or delete on public.transactions for each row execute function public.guard_recurring_transaction();

alter function public.pay_card_invoice(uuid,uuid,text,uuid,bigint,date) rename to pay_card_invoice_before_audit;
revoke all on function public.pay_card_invoice_before_audit(uuid,uuid,text,uuid,bigint,date) from public,anon,authenticated;
create function public.pay_card_invoice(p_id uuid,p_card uuid,p_month text,p_account uuid,p_amount bigint,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); payload jsonb=jsonb_build_object('card',p_card,'month',p_month,'account',p_account,'amount',p_amount,'date',p_date); result uuid;
begin
 result=public.financial_request_result(p_id,'pay_card_invoice',payload);if result is not null then return result;end if;
 if exists(select 1 from public.card_payments where id=p_id and user_id=u) and not exists(select 1 from public.card_payments p join public.transactions t on t.id=p.transaction_id and t.user_id=p.user_id where p.id=p_id and p.user_id=u and p.card_id=p_card and p.due_month=p_month and t.account_id=p_account and p.amount_cents=p_amount and p.payment_date=p_date) then raise exception 'Requisição já utilizada com outros parâmetros';end if;
 result=public.pay_card_invoice_before_audit(p_id,p_card,p_month,p_account,p_amount,p_date);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'pay_card_invoice',payload,result);return result;
end $$;
revoke all on function public.pay_card_invoice(uuid,uuid,text,uuid,bigint,date) from public,anon;grant execute on function public.pay_card_invoice(uuid,uuid,text,uuid,bigint,date) to authenticated;

alter function public.pay_debt(uuid,uuid,uuid,bigint,date) rename to pay_debt_before_audit;
revoke all on function public.pay_debt_before_audit(uuid,uuid,uuid,bigint,date) from public,anon,authenticated;
create function public.pay_debt(p_id uuid,p_debt uuid,p_account uuid,p_amount bigint,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); payload jsonb=jsonb_build_object('debt',p_debt,'account',p_account,'amount',p_amount,'date',p_date); result uuid;
begin
 result=public.financial_request_result(p_id,'pay_debt',payload);if result is not null then return result;end if;
 if exists(select 1 from public.debt_payments where id=p_id and user_id=u) and not exists(select 1 from public.debt_payments p join public.transactions t on t.id=p.transaction_id and t.user_id=p.user_id where p.id=p_id and p.user_id=u and p.debt_id=p_debt and t.account_id=p_account and p.amount_cents=p_amount and p.payment_date=p_date) then raise exception 'Requisição já utilizada com outros parâmetros';end if;
 result=public.pay_debt_before_audit(p_id,p_debt,p_account,p_amount,p_date);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'pay_debt',payload,result);return result;
end $$;
revoke all on function public.pay_debt(uuid,uuid,uuid,bigint,date) from public,anon;grant execute on function public.pay_debt(uuid,uuid,uuid,bigint,date) to authenticated;

alter function public.set_card_invoice(uuid,uuid,bigint,date,text) rename to set_card_invoice_before_audit;
revoke all on function public.set_card_invoice_before_audit(uuid,uuid,bigint,date,text) from public,anon,authenticated;
create function public.set_card_invoice(p_id uuid,p_card uuid,p_amount bigint,p_due date,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); payload jsonb=jsonb_build_object('card',p_card,'amount',p_amount,'due',p_due,'description',p_description); result uuid;
begin
 result=public.financial_request_result(p_id,'set_card_invoice',payload);if result is not null then return result;end if;
 if exists(select 1 from public.card_invoices where user_id=u and (id=p_id or request_id=p_id)) then raise exception 'Requisição anterior sem comprovante completo; recarregue a fatura';end if;
 result=public.set_card_invoice_before_audit(p_id,p_card,p_amount,p_due,p_description);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'set_card_invoice',payload,result);return result;
end $$;
revoke all on function public.set_card_invoice(uuid,uuid,bigint,date,text) from public,anon;grant execute on function public.set_card_invoice(uuid,uuid,bigint,date,text) to authenticated;

alter function public.repeat_transaction(uuid,uuid,jsonb,boolean) rename to repeat_transaction_before_audit;
revoke all on function public.repeat_transaction_before_audit(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
create function public.repeat_transaction(p_id uuid,p_rule uuid,p_payload jsonb,p_existing boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); payload jsonb=jsonb_build_object('rule',p_rule,'payload',p_payload,'existing',p_existing); result uuid;
begin
 result=public.financial_request_result(p_id,'repeat_transaction',payload);if result is not null then return result;end if;
 if exists(select 1 from public.recurring_occurrences where transaction_id=p_id and user_id=u) then raise exception 'Lançamento já vinculado a uma recorrência';end if;
 result=public.repeat_transaction_before_audit(p_id,p_rule,p_payload,p_existing);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'repeat_transaction',payload,result);return result;
end $$;
revoke all on function public.repeat_transaction(uuid,uuid,jsonb,boolean) from public,anon;grant execute on function public.repeat_transaction(uuid,uuid,jsonb,boolean) to authenticated;

create or replace function public.set_recurring_occurrence_amount(p_rule uuid,p_due date,p_amount bigint) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();r public.recurring_items;o public.recurring_occurrences;
begin
 if u is null then raise exception 'Autenticação necessária';end if;
 select * into r from public.recurring_items where id=p_rule and user_id=u for update;
 if not found then raise exception 'Recorrência não encontrada';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due;
 if p_due is null or (o.id is null and (not r.active or not public.is_recurring_date(r,p_due))) then raise exception 'Data ou recorrência inválida';end if;
 if p_amount is null or p_amount not between 1 and 1000000000000 then raise exception 'Valor inválido';end if;
 if o.id is not null and o.status<>'planned' then raise exception 'Ocorrência já registrada; pagamento preservado';end if;
 insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,amount_cents) values(u,r.id,p_due,'planned',p_amount)
 on conflict(recurring_item_id,user_id,due_date) do update set amount_cents=excluded.amount_cents returning * into o;
 return o.id;
end $$;

-- Record which installments a single real payment settled; never duplicate cash.
create table public.debt_payment_allocations (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,payment_id uuid not null,debt_id uuid not null,
 scheduled_date date not null,amount_cents bigint not null check(amount_cents>0),obligation_amount_cents bigint not null check(obligation_amount_cents>=amount_cents),
 created_at timestamptz not null default now(),unique(payment_id,scheduled_date),
 foreign key(payment_id) references public.debt_payments(id) on delete restrict,
 foreign key(debt_id,user_id) references public.debts(id,user_id) on delete restrict
);
alter table public.debt_payment_allocations enable row level security;
create policy own_select on public.debt_payment_allocations for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.debt_payment_allocations from public,anon,authenticated;grant select on public.debt_payment_allocations to authenticated;
create index on public.debt_payment_allocations(user_id,debt_id,scheduled_date);
create function public.allocate_debt_payment() returns trigger language plpgsql security definer set search_path='' as $$
declare d public.debts;due date;leftover bigint=new.amount_cents;balance bigint;partial bigint;expected bigint;part bigint;n integer=0;
begin
 select * into d from public.debts where id=new.debt_id and user_id=new.user_id;
 if d.installment_amount_cents is null or d.next_due_date is null then return new;end if;
 balance=d.remaining_amount_cents;partial=d.installment_paid_cents;
 while leftover>0 loop
  due=public.month_day((d.next_due_date+n*interval '1 month')::date,d.due_anchor_day);
  expected=least(d.installment_amount_cents,balance+partial);part=least(leftover,expected-partial);
  if part<=0 then raise exception 'Parcela da dívida inconsistente';end if;
  insert into public.debt_payment_allocations(user_id,payment_id,debt_id,scheduled_date,amount_cents,obligation_amount_cents)
   values(new.user_id,new.id,new.debt_id,due,part,expected);
  leftover=leftover-part;balance=balance-part;partial=0;n=n+1;
 end loop;
 return new;
end $$;
create trigger allocate_debt_payment after insert on public.debt_payments for each row execute function public.allocate_debt_payment();

-- Append-only history for explicit edits, deletions, resolutions and metadata.
create table public.financial_audit (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,table_name text not null,row_id uuid not null,action text not null,
 before_row jsonb,after_row jsonb,created_at timestamptz not null default now()
);
alter table public.financial_audit enable row level security;
create policy own_select on public.financial_audit for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.financial_audit from public,anon,authenticated;grant select on public.financial_audit to authenticated;
create index on public.financial_audit(user_id,table_name,row_id);
create function public.capture_financial_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.financial_audit(user_id,table_name,row_id,action,before_row,after_row)
 values(case when tg_op='DELETE' then old.user_id else new.user_id end,tg_table_name,case when tg_op='DELETE' then old.id else new.id end,tg_op,
 case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end);
 if tg_op='DELETE' then return old;end if;return new;
end $$;
do $$ declare t text;begin
 foreach t in array array['transactions','accounts','recurring_items','recurring_occurrences','recurring_payments','debts','debt_payments','credit_cards','card_invoices','card_purchases','card_adjustments','card_purchase_audit','classification_reviews','investments','investment_movements','investment_rates','goals','goal_contributions'] loop
  execute format('create trigger financial_audit after insert or update or delete on public.%I for each row execute function public.capture_financial_audit()',t);
 end loop;
end $$;

create or replace function public.export_financial_snapshot() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare u uuid=auth.uid();t text;rows jsonb;data jsonb='{}'::jsonb;counts jsonb='{}'::jsonb;
begin
 if u is null then raise exception 'Autenticação necessária';end if;
 foreach t in array array['accounts','categories','transactions','goals','goal_contributions','recurring_items','recurring_occurrences','recurring_payments','credit_cards','card_purchases','card_invoices','card_payments','card_adjustments','debts','debt_payments','debt_payment_allocations','reserve_account_links','investments','investment_movements','investment_rates','investment_reconstructions','report_month_confirmations','financial_audit'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]''::jsonb) from public.%I r where r.user_id=$1',t) into rows using u;
  data=data||jsonb_build_object(t,rows);counts=counts||jsonb_build_object(t,jsonb_array_length(rows));
 end loop;
 return jsonb_build_object('schema_version',1,'owner',u,'generated_at',statement_timestamp(),'counts',counts,'data',data);
end $$;
create or replace function public.resolve_transaction(p_id uuid,p_cancel boolean,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); t public.transactions; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into t from public.transactions where id=p_id and user_id=u and payment_reference is null and type in ('income','expense','transfer') for update;
 if not found then raise exception 'Lançamento inválido'; end if;
 if t.status<>'pending' then
  if (p_cancel and t.status='cancelled') or (not p_cancel and t.status='realized' and t.transaction_date=p_date) then return t.id;end if;
  raise exception 'Lançamento já resolvido com outra ação ou data';
 end if;
 if not p_cancel then
  if p_date is null or p_date>public.financial_date() then raise exception 'Data de realização deve ser até hoje'; end if;
  perform 1 from public.accounts where id=t.account_id and user_id=u and is_active;
  if not found then raise exception 'Conta arquivada'; end if;
  if t.type='transfer' then
   perform 1 from public.accounts where id=t.destination_account_id and user_id=u and is_active;
   if not found then raise exception 'Conta de destino arquivada'; end if;
  end if;
 end if;
 update public.transactions set status=case when p_cancel then 'cancelled' else 'realized' end,
 transaction_date=case when p_cancel then transaction_date else p_date end where id=t.id and user_id=u;
 if p_cancel then update public.recurring_occurrences set status='skipped',transaction_id=null where transaction_id=t.id and user_id=u; end if;
 return t.id;
end $$;


create function public.create_financial_transaction(p_id uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();result uuid;kind text=p_payload->>'type';day date=(p_payload->>'transaction_date')::date;
begin
 result=public.financial_request_result(p_id,'create_transaction',p_payload);if result is not null then return result;end if;
 if kind is null or kind not in ('income','expense','transfer') or day is null then raise exception 'Lançamento inválido';end if;
 if exists(select 1 from public.transactions where id=p_id) then raise exception 'Identificador já utilizado; lançamento não alterado';end if;
 perform 1 from public.accounts where id=(p_payload->>'account_id')::uuid and user_id=u and is_active;
 if not found then raise exception 'Conta inválida ou arquivada';end if;
 if kind='transfer' then
  perform 1 from public.accounts where id=(p_payload->>'destination_account_id')::uuid and user_id=u and is_active;
  if not found then raise exception 'Conta de destino inválida ou arquivada';end if;
 end if;
 insert into public.transactions(id,user_id,type,account_id,destination_account_id,category_id,amount_cents,description,transaction_date,status,is_recurring,recurrence_frequency,planning_group,financial_commitment,commitment_due_date)
 values(p_id,u,kind,(p_payload->>'account_id')::uuid,(p_payload->>'destination_account_id')::uuid,(p_payload->>'category_id')::uuid,(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),day,
 case when day>public.financial_date() then 'pending' else coalesce(p_payload->>'status','realized') end,
 coalesce((p_payload->>'is_recurring')::boolean,false),p_payload->>'recurrence_frequency',coalesce(p_payload->>'planning_group','scheduled'),coalesce((p_payload->>'financial_commitment')::boolean,false),(p_payload->>'commitment_due_date')::date);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'create_transaction',p_payload,p_id);return p_id;
end $$;
revoke all on function public.create_financial_transaction(uuid,jsonb) from public,anon;grant execute on function public.create_financial_transaction(uuid,jsonb) to authenticated;

alter function public.delete_simple_investment(uuid,uuid,bigint,boolean) rename to delete_simple_investment_before_audit;
revoke all on function public.delete_simple_investment_before_audit(uuid,uuid,bigint,boolean) from public,anon,authenticated;
create function public.delete_simple_investment(p_request uuid,p_investment uuid,p_expected bigint,p_confirmed boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,12));
 if exists(select 1 from public.investment_movements m where m.investment_id=p_investment and m.user_id=auth.uid() and (
  exists(select 1 from public.recurring_occurrences where transaction_id=m.transaction_id) or exists(select 1 from public.recurring_payments where transaction_id=m.transaction_id) or
  exists(select 1 from public.debt_payments where transaction_id=m.transaction_id) or exists(select 1 from public.card_payments where transaction_id=m.transaction_id))) then raise exception 'Movimento vinculado a outros registros; exclusão bloqueada';end if;
 perform public.delete_simple_investment_before_audit(p_request,p_investment,p_expected,p_confirmed);
end $$;
revoke all on function public.delete_simple_investment(uuid,uuid,bigint,boolean) from public,anon;grant execute on function public.delete_simple_investment(uuid,uuid,bigint,boolean) to authenticated;

alter function public.adjust_card_purchase(uuid,uuid,date,bigint,text) rename to adjust_card_purchase_before_audit;
revoke all on function public.adjust_card_purchase_before_audit(uuid,uuid,date,bigint,text) from public,anon,authenticated;
create function public.adjust_card_purchase(p_id uuid,p_purchase uuid,p_due date,p_amount bigint,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();payload jsonb=jsonb_build_object('purchase',p_purchase,'due',p_due,'amount',p_amount,'description',p_description);result uuid;
begin
 result=public.financial_request_result(p_id,'adjust_card_purchase',payload);if result is not null then return result;end if;
 if exists(select 1 from public.card_adjustments where id=p_id and user_id=u and (purchase_id,due_date,amount_cents,description) is distinct from (p_purchase,p_due,p_amount,p_description)) then raise exception 'Requisição já utilizada com outros parâmetros';end if;
 result=public.adjust_card_purchase_before_audit(p_id,p_purchase,p_due,p_amount,p_description);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'adjust_card_purchase',payload,result);return result;
end $$;
revoke all on function public.adjust_card_purchase(uuid,uuid,date,bigint,text) from public,anon;grant execute on function public.adjust_card_purchase(uuid,uuid,date,bigint,text) to authenticated;

notify pgrst,'reload schema';
commit;
