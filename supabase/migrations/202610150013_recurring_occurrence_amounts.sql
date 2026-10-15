begin;
-- Values on historical occurrences come only from their linked transaction.
-- No historical rule amount, date, account balance or transaction is rewritten.
alter table public.recurring_occurrences add column amount_cents bigint check(amount_cents between 1 and 1000000000000);
update public.recurring_occurrences o set amount_cents=t.amount_cents
from public.transactions t where t.id=o.transaction_id and t.user_id=o.user_id and o.status='recorded';
alter table public.recurring_occurrences drop constraint recurring_occurrences_status_check;
alter table public.recurring_occurrences drop constraint recurring_occurrences_check;
alter table public.recurring_occurrences add constraint recurring_occurrences_status_check check(status in ('planned','recorded','skipped'));
alter table public.recurring_occurrences add constraint recurring_occurrences_shape check(
 (status='recorded' and transaction_id is not null) or (status in ('planned','skipped') and transaction_id is null));

create function public.capture_recurring_amount() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and old.status='recorded' and new.amount_cents is distinct from old.amount_cents then
  raise exception 'Valor da obrigação registrada é imutável';
 end if;
 if new.amount_cents is null then
  if new.transaction_id is not null then
   select amount_cents into new.amount_cents from public.transactions where id=new.transaction_id and user_id=new.user_id;
  else
   select amount_cents into new.amount_cents from public.recurring_items where id=new.recurring_item_id and user_id=new.user_id;
  end if;
 end if;
 return new;
end $$;
create trigger capture_recurring_amount before insert or update on public.recurring_occurrences for each row execute function public.capture_recurring_amount();

-- Only supplementary partial payments. The original linked transaction remains
-- the primary payment; all financial movements stay in the existing ledger.
create table public.recurring_payments (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id),
 occurrence_id uuid not null, transaction_id uuid not null unique,
 created_at timestamptz not null default now(),
 foreign key(occurrence_id) references public.recurring_occurrences(id) on delete restrict,
 foreign key(transaction_id,user_id) references public.transactions(id,user_id) on delete restrict
);
alter table public.recurring_occurrences add constraint recurring_occurrences_id_user_unique unique(id,user_id);
alter table public.recurring_payments add constraint recurring_payments_owner foreign key(occurrence_id,user_id) references public.recurring_occurrences(id,user_id) on delete restrict;
alter table public.recurring_payments enable row level security;
create policy own_select on public.recurring_payments for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.recurring_payments from public,anon,authenticated;
grant select on public.recurring_payments to authenticated;
create index on public.recurring_payments(user_id,occurrence_id);

create function public.set_recurring_occurrence_amount(p_rule uuid,p_due date,p_amount bigint) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; o public.recurring_occurrences;
begin
 if u is null then raise exception 'Autenticação necessária';end if;
 select * into r from public.recurring_items where id=p_rule and user_id=u and active for update;
 if not found then raise exception 'Recorrência não encontrada ou pausada';end if;
 if p_due is null or not public.is_recurring_date(r,p_due) then raise exception 'Data fora da recorrência';end if;
 if p_amount is null or p_amount not between 1 and 1000000000000 then raise exception 'Valor inválido';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due;
 if found and o.status<>'planned' then raise exception 'Ocorrência já registrada; pagamento preservado';end if;
 insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,amount_cents)
 values(u,r.id,p_due,'planned',p_amount)
 on conflict(recurring_item_id,user_id,due_date) do update set amount_cents=excluded.amount_cents returning * into o;
 return o.id;
end $$;

-- A default value change applies to upcoming dates. Capture overdue forecasts
-- from the OLD rule while it is still known, without guessing migration history.
create function public.preserve_due_recurring_amounts() returns trigger language plpgsql security definer set search_path='' as $$
declare due date; n integer=0;
begin
 if new.amount_cents is not distinct from old.amount_cents then return new;end if;
 loop
  due=case old.frequency when 'weekly' then old.start_date+n*7
    else public.month_day((old.start_date+n*(case old.frequency when 'yearly' then 12 else 1 end)*interval '1 month')::date,extract(day from old.start_date)::integer) end;
  exit when due>public.financial_date() or (old.end_date is not null and due>old.end_date);
  insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,amount_cents)
   values(old.user_id,old.id,due,'planned',old.amount_cents)
   on conflict(recurring_item_id,user_id,due_date) do nothing;
  n=n+1;
 end loop;
 return new;
end $$;
create trigger preserve_due_recurring_amounts before update of amount_cents on public.recurring_items for each row execute function public.preserve_due_recurring_amounts();

create function public.record_recurring_payment(p_id uuid,p_rule uuid,p_due date,p_amount bigint default null,p_date date default null) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; o public.recurring_occurrences; t public.transactions;
 expected bigint; paid bigint=0; amount bigint; actual_date date=coalesce(p_date,public.financial_date());
begin
 if u is null then raise exception 'Autenticação necessária';end if;
 -- Rule lock serializes concurrent resolutions/edits of the same occurrence.
 select * into r from public.recurring_items where id=p_rule and user_id=u for update;
 if not found then raise exception 'Recorrência não encontrada';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due for update;
 -- Exact retries succeed; reusing a request for another obligation fails.
 if exists(select 1 from public.transactions where id=p_id) then
  if o.transaction_id=p_id or exists(select 1 from public.recurring_payments where id=p_id and occurrence_id=o.id and user_id=u) then
   select * into t from public.transactions where id=p_id and user_id=u;
   if (p_amount is not null and t.amount_cents<>p_amount) or (p_date is not null and t.transaction_date<>p_date) then raise exception 'Requisição já usada com outros valores';end if;
   return o.id;
  end if;
  raise exception 'Identificador de pagamento já utilizado';
 end if;
 if o.status='skipped' then raise exception 'Ocorrência pulada';end if;
 if o.status='recorded' then
  select * into t from public.transactions where id=o.transaction_id and user_id=u;
  if not found then raise exception 'Pagamento vinculado não encontrado';end if;
  if t.status='pending' then
   if p_amount is not null and p_amount<>t.amount_cents then raise exception 'Confirme o lançamento pendente antes de alterar o pagamento';end if;
   perform public.resolve_transaction(t.id,false,actual_date);return o.id;
  end if;
  if t.status<>'realized' or t.type<>r.type or t.transaction_date>public.financial_date() then raise exception 'Confira o pagamento no histórico';end if;
  paid=t.amount_cents;
  select paid+coalesce(sum(tx.amount_cents),0) into paid from public.recurring_payments p join public.transactions tx on tx.id=p.transaction_id and tx.user_id=p.user_id
   where p.occurrence_id=o.id and p.user_id=u and tx.status='realized' and tx.transaction_date<=public.financial_date() and tx.type=r.type;
 end if;
 expected=coalesce(o.amount_cents,r.amount_cents);
 if paid>=expected then return o.id;end if;
 if not r.active then raise exception 'Recorrência pausada';end if;
 if p_due is null or not public.is_recurring_date(r,p_due) then raise exception 'Data fora da recorrência';end if;
 if p_due>public.financial_date() then raise exception 'Ocorrência futura: aguarde a data para realizar';end if;
 if actual_date>public.financial_date() then raise exception 'Data de realização deve ser até hoje';end if;
 amount=coalesce(p_amount,expected-paid);
 if amount not between 1 and expected-paid then raise exception 'Pagamento deve respeitar o saldo restante';end if;
 perform 1 from public.accounts where id=r.account_id and user_id=u and is_active and investment_id is null and not investment_retired;
 if not found then raise exception 'Conta inválida ou arquivada';end if;
 insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency)
 values(p_id,u,r.account_id,r.category_id,r.type,amount,r.name,actual_date,true,r.frequency);
 if o.status='recorded' then
  insert into public.recurring_payments(id,user_id,occurrence_id,transaction_id) values(p_id,u,o.id,p_id);
 elsif o.id is not null then
  update public.recurring_occurrences set status='recorded',transaction_id=p_id where id=o.id and user_id=u;
 else
  insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,transaction_id,amount_cents)
  values(p_id,u,r.id,p_due,'recorded',p_id,expected) returning * into o;
 end if;
 return o.id;
end $$;

create or replace function public.resolve_recurring(p_id uuid,p_rule uuid,p_due date,p_skip boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; o public.recurring_occurrences; t public.transactions;
begin
 if u is null then raise exception 'Autenticação necessária';end if;
 if p_skip is null then raise exception 'Informe a ação';end if;
 if not p_skip then return public.record_recurring_payment(p_id,p_rule,p_due);end if;
 select * into r from public.recurring_items where id=p_rule and user_id=u for update;
 if not found then raise exception 'Recorrência não encontrada';end if;
 select * into o from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due for update;
 if o.status='skipped' then return o.id;end if;
 if o.status='recorded' then
  select * into t from public.transactions where id=o.transaction_id and user_id=u;
  if t.status='pending' then perform public.resolve_transaction(t.id,true,public.financial_date());return o.id;end if;
  raise exception 'Pagamento já registrado; não é possível pular';
 end if;
 if not r.active or p_due is null or not public.is_recurring_date(r,p_due) then raise exception 'Data ou recorrência inválida';end if;
 if o.id is not null then
  update public.recurring_occurrences set status='skipped' where id=o.id and user_id=u;return o.id;
 end if;
 insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,amount_cents) values(p_id,u,r.id,p_due,'skipped',r.amount_cents);
 return p_id;
end $$;
revoke all on function public.set_recurring_occurrence_amount(uuid,date,bigint),public.record_recurring_payment(uuid,uuid,date,bigint,date) from public,anon;
grant execute on function public.set_recurring_occurrence_amount(uuid,date,bigint),public.record_recurring_payment(uuid,uuid,date,bigint,date) to authenticated;

create or replace function public.export_financial_snapshot() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare u uuid=auth.uid(); t text; rows jsonb; data jsonb='{}'::jsonb; counts jsonb='{}'::jsonb;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 foreach t in array array['accounts','categories','transactions','goals','goal_contributions','recurring_items','recurring_occurrences','recurring_payments','credit_cards','card_purchases','card_invoices','card_payments','card_adjustments','debts','debt_payments','reserve_account_links','investments','investment_movements','investment_rates','investment_reconstructions','report_month_confirmations'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]''::jsonb) from public.%I r where r.user_id=$1',t) into rows using u;
  data=data||jsonb_build_object(t,rows);counts=counts||jsonb_build_object(t,jsonb_array_length(rows));
 end loop;
 return jsonb_build_object('schema_version',1,'owner',u,'generated_at',statement_timestamp(),'counts',counts,'data',data);
end $$;

notify pgrst,'reload schema';
commit;
