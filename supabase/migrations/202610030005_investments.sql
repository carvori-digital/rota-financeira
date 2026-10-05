begin;
-- Keep the mechanical import consistent with concurrent production activity.
lock table public.accounts,public.transactions,public.recurring_items,public.credit_cards,public.debts,public.reserve_account_links in share row exclusive mode;
create table public.investments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id),
 name text not null check(length(trim(name)) between 1 and 80), institution text not null default '' check(length(institution)<=120),
 type text not null default 'other' check(length(type) between 1 and 80), initial_date date not null,
 yield_type text not null default 'manual' check(yield_type in ('manual','fixed_annual','fixed_monthly')),
 yield_rate numeric not null default 0 check(yield_rate between 0 and 100),
 is_emergency_reserve boolean not null default false, active boolean not null default true,
 source_account_id uuid unique, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id),
 foreign key(source_account_id,user_id) references public.accounts(id,user_id)
);
alter table public.accounts add column investment_id uuid;
alter table public.accounts add foreign key(investment_id,user_id) references public.investments(id,user_id);
create table public.investment_movements (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id), investment_id uuid not null,
 type text not null check(type in ('contribution','withdrawal','adjustment')), amount_cents bigint not null check(abs(amount_cents)<=1000000000000),
 date date not null, description text not null default '' check(length(description)<=240),
 transaction_id uuid unique, source_transaction_id uuid, source_account_id uuid,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(type='adjustment' or amount_cents>0),
 foreign key(investment_id,user_id) references public.investments(id,user_id),
 foreign key(transaction_id,user_id) references public.transactions(id,user_id),
 foreign key(source_transaction_id,user_id) references public.transactions(id,user_id),
 foreign key(source_account_id,user_id) references public.accounts(id,user_id)
);
create table public.classification_reviews (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id),
 source_table text not null check(source_table in ('accounts','card_purchases','debts','transactions')), source_id uuid not null,
 reason text not null, confidence text not null check(confidence in ('LOW','MEDIUM')),
 status text not null default 'pending' check(status in ('pending','kept')), resolution text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,source_table,source_id)
);
do $$ declare t text; begin
 foreach t in array array['investments','investment_movements','classification_reviews'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_select on public.%I for select to authenticated using(user_id=(select auth.uid()))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(user_id)',t);
  execute format('create trigger protect_row before update on public.%I for each row execute function public.protect_financial_row()',t);
 end loop;
end $$;
create policy own_insert on public.investments for insert to authenticated with check(user_id=(select auth.uid()) and source_account_id is null);
create policy own_update on public.investments for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant insert(id,user_id,name,institution,type,initial_date,yield_type,yield_rate,is_emergency_reserve,active) on public.investments to authenticated;
grant update(name,institution,type,is_emergency_reserve,active) on public.investments to authenticated;
grant insert,update on public.investments to authenticated;
create function public.guard_investment_terms() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.yield_type,new.yield_rate,new.initial_date,new.source_account_id) is distinct from (old.yield_type,old.yield_rate,old.initial_date,old.source_account_id) then raise exception 'Condições e origem preservadas; use sincronização'; end if;
 return new;
end $$;
create trigger investment_terms before update on public.investments for each row execute function public.guard_investment_terms();
-- Yield terms are immutable after creation: changing them would rewrite past estimates.
create function public.investment_value(p_investment uuid,p_date date) returns bigint language plpgsql stable security definer set search_path='' as $$
declare i public.investments; m record; value numeric=0; days numeric; begin
 select * into i from public.investments where id=p_investment and user_id=auth.uid();
 if not found then raise exception 'Investimento inválido'; end if;
 for m in select * from public.investment_movements where investment_id=i.id and user_id=i.user_id and date<=p_date loop
  days=p_date-m.date;
  value=value+(case when m.type='withdrawal' then -m.amount_cents else m.amount_cents end)*
   case i.yield_type when 'fixed_annual' then power(1+i.yield_rate/100,days/365) when 'fixed_monthly' then power(1+i.yield_rate/100,days/30) else 1 end;
 end loop;
 if abs(value)>1000000000000 then raise exception 'Estimativa fora do limite'; end if;
 return round(value)::bigint;
end $$;
create function public.record_investment_movement(p_id uuid,p_investment uuid,p_type text,p_amount bigint,p_date date,p_account uuid,p_description text)
returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); i public.investments; delta bigint; available bigint; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into i from public.investments where id=p_investment and user_id=u and active for update;
 if not found then raise exception 'Investimento inválido'; end if;
 if exists(select 1 from public.investment_movements where id=p_id and user_id=u and investment_id=i.id) then return p_id; end if;
 if p_date is null or p_date<i.initial_date or p_date>public.financial_date() then raise exception 'Data inválida'; end if;
 if p_amount is null or p_amount<0 or p_amount>1000000000000 then raise exception 'Valor inválido'; end if;
 if p_type='adjustment' then
  if p_account is not null then raise exception 'Sincronização não movimenta conta'; end if;
  if exists(select 1 from public.investment_movements where investment_id=i.id and date>p_date) then raise exception 'Sincronize na data mais recente'; end if;
  delta=p_amount-public.investment_value(i.id,p_date);
 else
  if p_type not in ('contribution','withdrawal') or p_type is null or p_amount=0 then raise exception 'Movimento inválido'; end if;
  if exists(select 1 from public.investment_movements where investment_id=i.id and date>p_date) then raise exception 'Use data igual ou posterior ao último movimento'; end if;
  perform 1 from public.accounts where id=p_account and user_id=u and is_active and investment_id is null and type in ('checking','wallet','other') for update;
  if not found then raise exception 'Escolha uma conta operacional ativa'; end if;
  if p_type='withdrawal' and p_amount>public.investment_value(i.id,p_date) then raise exception 'Retirada supera o investimento'; end if;
  if p_type='contribution' then
   select a.initial_balance_cents+coalesce((select sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end) from public.transactions t where t.user_id=u and t.status='realized' and t.transaction_date<=p_date),0) into available from public.accounts a where id=p_account and user_id=u;
   if p_amount>available then raise exception 'Aporte supera o saldo disponível na data'; end if;
  end if;
  delta=p_amount;
  insert into public.transactions(id,user_id,account_id,type,amount_cents,adjustment_delta_cents,description,transaction_date)
  values(p_id,u,p_account,'adjustment',p_amount,case when p_type='contribution' then -p_amount else p_amount end,
   case when p_type='contribution' then 'Aporte · ' else 'Resgate · ' end||i.name,p_date);
 end if;
 insert into public.investment_movements(id,user_id,investment_id,type,amount_cents,date,description,transaction_id)
 values(p_id,u,i.id,p_type,delta,p_date,coalesce(p_description,''),case when p_type='adjustment' then null else p_id end);
 return p_id;
end $$;
create function public.keep_classification(p_id uuid,p_resolution text) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or length(trim(coalesce(p_resolution,'')))=0 then raise exception 'Informe a confirmação'; end if;
 update public.classification_reviews set status='kept',resolution=p_resolution where id=p_id and user_id=auth.uid();
 if not found then raise exception 'Revisão inválida'; end if;
end $$;
-- Import only mechanically unambiguous balances. Linked future obligations remain untouched.
do $$ declare a record; i uuid; begin
 for a in select * from public.accounts where type in ('savings','investment') loop
  if exists(select 1 from public.transactions where (account_id=a.id or destination_account_id=a.id) and (status='pending' or transaction_date>public.financial_date()))
   or exists(select 1 from public.recurring_items where account_id=a.id and active)
   or exists(select 1 from public.credit_cards where payment_account_id=a.id)
   or exists(select 1 from public.debts where payment_account_id=a.id and remaining_amount_cents>0) then
   insert into public.classification_reviews(user_id,source_table,source_id,reason,confidence) values(a.user_id,'accounts',a.id,'Conta de investimento com obrigações vinculadas; preservar até revisão.','LOW');
   continue;
  end if;
  i=gen_random_uuid();
  insert into public.investments(id,user_id,name,type,initial_date,is_emergency_reserve,active,source_account_id)
  values(i,a.user_id,a.name,'legacy',least((a.created_at at time zone 'America/Sao_Paulo')::date,coalesce((select min(transaction_date) from public.transactions where account_id=a.id or destination_account_id=a.id),(a.created_at at time zone 'America/Sao_Paulo')::date)),
   a.type='savings' or lower(trim(a.name)) in ('reserva','reserva de emergência') or exists(select 1 from public.reserve_account_links where account_id=a.id),a.is_active,a.id);
  insert into public.investment_movements(user_id,investment_id,type,amount_cents,date,description,source_account_id)
  values(a.user_id,i,'adjustment',a.initial_balance_cents,(a.created_at at time zone 'America/Sao_Paulo')::date,'Saldo inicial importado; origem preservada',a.id);
  insert into public.investment_movements(user_id,investment_id,type,amount_cents,date,description,source_transaction_id,source_account_id)
  select a.user_id,i,'adjustment',
   case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+
   case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end,
   t.transaction_date,'Histórico importado · '||left(t.description,210),t.id,a.id from public.transactions t
   where t.user_id=a.user_id and t.status='realized' and t.transaction_date<=public.financial_date() and (t.account_id=a.id or t.destination_account_id=a.id);
  update public.accounts set investment_id=i,is_active=false where id=a.id;
 end loop;
end $$;
create function public.guard_converted_account() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='accounts' then
  if tg_op='INSERT' then
   if new.investment_id is not null then raise exception 'Vínculo de migração reservado'; end if;
  elsif old.investment_id is not null or new.investment_id is distinct from old.investment_id then raise exception 'Conta migrada: use Investimentos; histórico preservado'; end if;
 elsif tg_op='DELETE' then
  if exists(select 1 from public.investment_movements where transaction_id=old.id) then raise exception 'Movimento de investimento protegido'; end if;
  if exists(select 1 from public.accounts where investment_id is not null and id in(old.account_id,old.destination_account_id)) then raise exception 'Histórico migrado protegido'; end if;
 else
  if tg_op='UPDATE' and exists(select 1 from public.investment_movements where transaction_id=old.id) then raise exception 'Movimento de investimento protegido'; end if;
  if exists(select 1 from public.accounts where investment_id is not null and (id in(new.account_id,new.destination_account_id) or (tg_op='UPDATE' and id in(old.account_id,old.destination_account_id)))) then raise exception 'Use movimentos de investimento'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger converted_account before insert or update or delete on public.accounts for each row execute function public.guard_converted_account();
create trigger converted_transaction before insert or update or delete on public.transactions for each row execute function public.guard_converted_account();
-- Possible duplicates are review items, never automatic deletions.
insert into public.classification_reviews(user_id,source_table,source_id,reason,confidence)
select p.user_id,'card_purchases',p.id,'Compras com mesma descrição, cartão e data. Verifique se são distintas; valores preservados.','LOW'
from public.card_purchases p where trim(p.description)<>'' and exists(select 1 from public.card_purchases q where q.id<>p.id and q.user_id=p.user_id and q.card_id=p.card_id and lower(trim(q.description))=lower(trim(p.description)) and q.purchase_date=p.purchase_date);
insert into public.classification_reviews(user_id,source_table,source_id,reason,confidence)
select user_id,'debts',id,'Descrição menciona cartão/fatura. Verifique se é dívida independente; nenhuma compra foi criada ou removida.','LOW'
from public.debts where lower(name) ~ '(fatura|cartão|cartao|\mcc\M)' on conflict do nothing;
revoke all on function public.investment_value(uuid,date),public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text),public.keep_classification(uuid,text) from public,anon;
grant execute on function public.investment_value(uuid,date),public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text),public.keep_classification(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
