begin;
-- Capabilities only. No existing financial row is changed during deployment.
alter table public.accounts add column investment_retired boolean not null default false;
alter table public.investments add column deleted_at timestamptz;
alter table public.investment_movements add column reversed_by uuid;
alter table public.investment_movements drop constraint investment_movements_accounting_kind_check;
alter table public.investment_movements add constraint investment_movements_accounting_kind_check
 check(accounting_kind in ('real_cash','historical_position','valuation','initial_position','reconciled_transfer'));
create table public.investment_operations (
 id uuid primary key, user_id uuid not null references auth.users(id),
 kind text not null, investment_id uuid not null, payload jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.investment_operations enable row level security;
create policy own_select on public.investment_operations for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.investment_operations from public,anon,authenticated;
grant select on public.investment_operations to authenticated;
create index on public.investment_operations(user_id);

create function public.guard_simple_investments() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='investments' then
  if current_user='authenticated' and (new.deleted_at is not null or (tg_op='UPDATE' and old.deleted_at is not null)) then raise exception 'Investimento excluído protegido';end if;
 elsif tg_table_name='accounts' then
  if current_user='authenticated' and (new.investment_retired or (tg_op='UPDATE' and old.investment_retired)) then raise exception 'Origem contábil preservada';end if;
 end if;
 return new;
end $$;
create trigger simple_investment before insert or update on public.investments for each row execute function public.guard_simple_investments();
create trigger retired_account before insert or update on public.accounts for each row execute function public.guard_simple_investments();

create or replace function public.guard_converted_account() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='accounts' then
  if tg_op='INSERT' then
   if new.investment_id is not null then raise exception 'Vínculo de migração reservado';end if;
  elsif tg_op='DELETE' then
   if old.investment_id is not null or old.investment_retired then raise exception 'Origem contábil preservada';end if;
  elsif old.investment_id is not null or new.investment_id is distinct from old.investment_id then
   -- The only permitted unlink is the authenticated definer deletion, retaining an inert origin.
   if current_user='authenticated' or not new.investment_retired or new.is_active or new.investment_id is not null then raise exception 'Conta migrada: use Investimentos; histórico preservado';end if;
  end if;
 else
  if tg_op in ('UPDATE','DELETE') then
   if exists(select 1 from public.investment_movements where transaction_id=old.id or source_transaction_id=old.id)
    or exists(select 1 from public.investment_operations where kind='delete' and payload->'transaction_ids' ? old.id::text)
    or exists(select 1 from public.accounts where (investment_id is not null or investment_retired) and id in(old.account_id,old.destination_account_id)) then raise exception 'Histórico de investimento protegido';end if;
  end if;
  if tg_op<>'DELETE' and exists(select 1 from public.accounts where (investment_id is not null or investment_retired) and id in(new.account_id,new.destination_account_id)) then raise exception 'Use movimentos de investimento';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;

-- All yield models use confirmed positions as the withdrawal limit, never estimates.
create or replace function public.investment_value(p_investment uuid,p_date date) returns bigint language plpgsql stable security definer set search_path='' as $$
declare i public.investments; anchor public.investment_movements; value numeric;begin
 select * into i from public.investments where id=p_investment and user_id=auth.uid() and deleted_at is null;
 if not found then raise exception 'Investimento inválido';end if;
 select * into anchor from public.investment_movements where investment_id=i.id and user_id=i.user_id and date<=p_date and sync_value_cents is not null order by date desc,ledger_order desc limit 1;
 select coalesce(anchor.sync_value_cents,0)+coalesce(sum(case when type='withdrawal' then -amount_cents else amount_cents end),0) into value
 from public.investment_movements where investment_id=i.id and user_id=i.user_id and date<=p_date and (anchor.id is null or (date,ledger_order)>(anchor.date,anchor.ledger_order));
 if abs(value)>1000000000000 then raise exception 'Posição fora do limite';end if;return value::bigint;
end $$;

create function public.create_simple_investment(p_id uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); previous public.investment_operations; amount bigint; day date;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,12));
 select * into previous from public.investment_operations where id=p_id;
 if found then
  if previous.user_id<>u or previous.kind<>'create' or previous.payload is distinct from p_payload then raise exception 'Requisição já utilizada';end if;return p_id;
 end if;
 amount=coalesce((p_payload->>'initial_cents')::bigint,0);day=(p_payload->>'initial_date')::date;
 if amount<0 or amount>1000000000000 or day is null or day>public.financial_date() or (p_payload->>'acknowledged')::boolean is distinct from true then raise exception 'Confira data, posição e ausência de duplicidade';end if;
 insert into public.investments(id,user_id,name,institution,type,initial_date,yield_type,yield_rate,is_emergency_reserve)
 values(p_id,u,p_payload->>'name',coalesce(p_payload->>'institution',''),p_payload->>'type',day,p_payload->>'yield_type',(p_payload->>'yield_rate')::numeric,coalesce((p_payload->>'reserve')::boolean,false));
 insert into public.investment_movements(user_id,investment_id,type,amount_cents,date,description,accounting_kind,sync_value_cents)
 values(u,p_id,'adjustment',amount,day,'Posição inicial informada; sem movimentação bancária','initial_position',amount);
 insert into public.investment_operations values(p_id,u,'create',p_id,p_payload,now());return p_id;
end $$;

-- Historical entries are allowed before later cash, but never before a later balance
-- anchor: an anchor already includes that period and would silently swallow the entry.
create function public.simple_investment_movement(p_id uuid,p_investment uuid,p_type text,p_amount bigint,p_date date,p_account uuid,p_description text,p_transfer uuid,p_expected bigint,p_confirmed boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); i public.investments; prev public.investment_operations; payload jsonb; delta bigint; available bigint; tr public.transactions; mirror uuid;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,12));
 payload=jsonb_build_object('type',p_type,'amount',p_amount,'date',p_date,'account',p_account,'description',p_description,'transfer',p_transfer,'expected',p_expected,'confirmed',p_confirmed);
 select * into prev from public.investment_operations where id=p_id;
 if found then
  if prev.user_id<>u or prev.investment_id<>p_investment or prev.kind<>'movement' or prev.payload is distinct from payload then raise exception 'Requisição já utilizada';end if;return p_id;
 end if;
 select * into i from public.investments where id=p_investment and user_id=u and active and deleted_at is null and replaced_by_id is null for update;
 if not found then raise exception 'Investimento inválido';end if;
 if p_date is null or p_date<i.initial_date or p_date>public.financial_date() or p_amount is null or p_amount<0 or p_amount>1000000000000 then raise exception 'Data/valor inválido';end if;
 if p_expected is null or p_expected<>public.investment_value(i.id,public.financial_date()) then raise exception 'Posição mudou; recarregue e confira';end if;
 if p_confirmed is distinct from true then raise exception 'Confirme se a movimentação já está registrada';end if;
 if exists(select 1 from public.investment_movements where investment_id=i.id and date>p_date and sync_value_cents is not null) then raise exception 'Existe saldo sincronizado posterior. Registre após essa posição ou corrija a sincronização primeiro';end if;
 if p_type='adjustment' then
  if p_account is not null or p_transfer is not null or length(trim(coalesce(p_description,'')))=0 then raise exception 'Sincronização exige motivo e não movimenta conta';end if;
  if exists(select 1 from public.investment_movements where investment_id=i.id and date>p_date) then raise exception 'Sincronize após o último movimento';end if;
  delta=p_amount-public.investment_value(i.id,p_date);
 else
  if p_type is null or p_type not in ('contribution','withdrawal') or p_amount=0 then raise exception 'Movimento inválido';end if;
  perform 1 from public.accounts where id=p_account and user_id=u and is_active and investment_id is null and not investment_retired and type in ('checking','wallet','other') for update;
  if not found then raise exception 'Escolha uma conta operacional ativa';end if;
  delta=p_amount;
  if p_transfer is not null then
   select * into tr from public.transactions where id=p_transfer and user_id=u and type='transfer' and status='realized' for update;
   if not found or tr.amount_cents<>p_amount or tr.transaction_date<>p_date then raise exception 'Valor/data da transferência não conferem';end if;
   if p_type='contribution' and tr.account_id=p_account then mirror=tr.destination_account_id;
   elsif p_type='withdrawal' and tr.destination_account_id=p_account then mirror=tr.account_id;
   else raise exception 'Sentido da transferência não confere';end if;
   perform 1 from public.accounts where id=mirror and user_id=u and not is_active and (investment_retired or investment_id=i.id) for update;
   if not found then raise exception 'A outra ponta precisa ser a origem contábil preservada deste investimento. Confira as contas antes de reconciliar';end if;
   if exists(select 1 from public.investment_movements where transaction_id=tr.id or source_transaction_id=tr.id) then raise exception 'Transferência já considerada em um investimento';end if;
  else
   if exists(select 1 from public.transactions where user_id=u and type='transfer' and status='realized' and amount_cents=p_amount and transaction_date=p_date and p_account in(account_id,destination_account_id)) and p_description not like 'Conferido:%' then raise exception 'Há transferência semelhante. Selecione-a ou use descrição iniciada por Conferido: após verificar que são operações distintas';end if;
   if p_type='contribution' then
    select a.initial_balance_cents+coalesce((select sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end) from public.transactions t where t.user_id=u and t.status='realized' and t.transaction_date<=p_date),0) into available from public.accounts a where id=p_account;
    if p_amount>available then raise exception 'Aporte supera o saldo disponível na data';end if;
   end if;
   insert into public.transactions(id,user_id,account_id,type,amount_cents,adjustment_delta_cents,description,transaction_date,financial_commitment)
   values(p_id,u,p_account,'adjustment',p_amount,case when p_type='contribution' then -p_amount else p_amount end,left(case when p_type='contribution' then 'Aporte · ' else 'Resgate · ' end||i.name,240),p_date,false);
  end if;
 end if;
 insert into public.investment_movements(id,user_id,investment_id,type,amount_cents,date,description,transaction_id,source_transaction_id,source_account_id,accounting_kind,sync_value_cents)
 values(p_id,u,i.id,p_type,delta,p_date,coalesce(p_description,''),case when p_type<>'adjustment' and p_transfer is null then p_id end,p_transfer,mirror,
 case when p_type='adjustment' then 'valuation' when p_transfer is not null then 'reconciled_transfer' else 'real_cash' end,case when p_type='adjustment' then p_amount end);
 -- Every later end-of-day position must remain nonnegative after a backdated entry.
 if exists(select 1 from public.investment_movements m where m.investment_id=i.id and m.date>=p_date and public.investment_value(i.id,m.date)<0) then raise exception 'Movimento deixaria a posição negativa; confira a cronologia';end if;
 insert into public.investment_operations values(p_id,u,'movement',i.id,payload,now());return p_id;
end $$;

create function public.delete_simple_investment(p_request uuid,p_investment uuid,p_expected bigint,p_confirmed boolean) returns void language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); i public.investments; prev public.investment_operations; payload jsonb; ids jsonb;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,12));
 select * into prev from public.investment_operations where id=p_request;
 if found then
  if prev.user_id<>u or prev.kind<>'delete' or prev.investment_id<>p_investment or (prev.payload->>'expected')::bigint is distinct from p_expected or p_confirmed is distinct from true then raise exception 'Requisição já utilizada';end if;return;
 end if;
 select * into i from public.investments where id=p_investment and user_id=u and deleted_at is null for update;
 if not found then raise exception 'Investimento inválido ou já excluído';end if;
 if p_confirmed is distinct from true or p_expected is null or p_expected<>public.investment_value(i.id,public.financial_date()) then raise exception 'Confirme a posição atual antes de excluir';end if;
 select coalesce(jsonb_agg(transaction_id) filter(where transaction_id is not null),'[]'::jsonb) into ids from public.investment_movements where investment_id=i.id and user_id=u;
 payload=jsonb_build_object('expected',p_expected,'investment',to_jsonb(i),'transaction_ids',ids,'movements',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.investment_movements m where investment_id=i.id and user_id=u),'rates',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.investment_rates r where investment_id=i.id and user_id=u));
 insert into public.investment_operations values(p_request,u,'delete',i.id,payload,now());
 -- Preserve ALL bank transactions, including transfers and operational cash entries.
 -- The old account remains an inert historical origin, excluded from totals.
 update public.accounts set investment_retired=true,investment_id=null,is_active=false where investment_id=i.id and user_id=u;
 delete from public.reserve_account_links where user_id=u and account_id=i.source_account_id;
 delete from public.investment_rates where investment_id=i.id and user_id=u;
 delete from public.investment_movements where investment_id=i.id and user_id=u;
 if exists(select 1 from public.investment_reconstructions where old_investment_id=i.id or new_investment_id=i.id)
  or exists(select 1 from public.investments where replaced_by_id=i.id) then
  -- Reconstruction FKs require this minimal tombstone, invisible in UI and totals.
  update public.investments set active=false,deleted_at=now() where id=i.id;
 else
  delete from public.investments where id=i.id and user_id=u;
 end if;
end $$;

create function public.reverse_simple_investment_movement(p_request uuid,p_movement uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); m public.investment_movements; i public.investments; tr public.transactions; previous public.investment_operations; kind text; target bigint; result uuid;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,12));
 select * into previous from public.investment_operations where id=p_request;
 if found then
  if previous.user_id<>u or previous.kind<>'reverse' or previous.payload->>'movement'<>p_movement::text then raise exception 'Requisição já utilizada';end if;return p_request;
 end if;
 select * into m from public.investment_movements where id=p_movement and user_id=u for update;
 if not found or m.reversed_by is not null then raise exception 'Movimento inválido ou já estornado';end if;
 select * into i from public.investments where id=m.investment_id and user_id=u and active and deleted_at is null and replaced_by_id is null for update;
 if not found then raise exception 'Investimento inválido';end if;
 if m.accounting_kind='real_cash' then
  select * into tr from public.transactions where id=m.transaction_id and user_id=u;
  if not found or tr.type<>'adjustment' or tr.id<>m.id or tr.amount_cents<>m.amount_cents then raise exception 'Vínculo financeiro inesperado';end if;
  kind=case when m.type='contribution' then 'withdrawal' else 'contribution' end;target=m.amount_cents;
 elsif m.accounting_kind='valuation' then
  if exists(select 1 from public.investment_movements where investment_id=i.id and (date,ledger_order)>(m.date,m.ledger_order)) then raise exception 'Há movimentos posteriores; sincronize novamente pelo saldo real';end if;
  kind='adjustment';target=m.sync_value_cents-m.amount_cents;
 else raise exception 'Posição inicial/importada ou transferência preservada. Corrija pela reconciliação de saldo';end if;
 result=public.simple_investment_movement(p_request,i.id,kind,target,public.financial_date(),case when kind<>'adjustment' then tr.account_id end,'Estorno rastreável · '||m.id,null,public.investment_value(i.id,public.financial_date()),true);
 update public.investment_movements set reversed_by=p_request where id=m.id;
 update public.investment_operations set kind='reverse',payload=jsonb_build_object('movement',m.id) where id=p_request;
 return result;
end $$;
revoke all on function public.create_simple_investment(uuid,jsonb),public.simple_investment_movement(uuid,uuid,text,bigint,date,uuid,text,uuid,bigint,boolean),public.delete_simple_investment(uuid,uuid,bigint,boolean),public.reverse_simple_investment_movement(uuid,uuid) from public,anon;
grant execute on function public.create_simple_investment(uuid,jsonb),public.simple_investment_movement(uuid,uuid,text,bigint,date,uuid,text,uuid,bigint,boolean),public.delete_simple_investment(uuid,uuid,bigint,boolean),public.reverse_simple_investment_movement(uuid,uuid) to authenticated;

create function public.reconcile_operational_balance(p_id uuid,p_account uuid,p_target bigint,p_expected bigint) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); actual bigint; previous public.investment_operations; payload jsonb;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,12));
 payload=jsonb_build_object('account',p_account,'target',p_target,'expected',p_expected);
 select * into previous from public.investment_operations where id=p_id;
 if found then
  if previous.user_id<>u or previous.kind<>'account_reconciliation' or previous.payload is distinct from payload then raise exception 'Requisição já utilizada';end if;return p_id;
 end if;
 perform 1 from public.accounts where id=p_account and user_id=u and is_active and not investment_retired and investment_id is null for update;
 if not found then raise exception 'Conta operacional inválida';end if;
 select a.initial_balance_cents+coalesce((select sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end) from public.transactions t where t.user_id=u and t.status='realized' and t.transaction_date<=public.financial_date()),0) into actual from public.accounts a where id=p_account;
 if p_expected is null or actual<>p_expected then raise exception 'Saldo mudou; recarregue e confira novamente';end if;
 perform public.adjust_account_balance(p_id,p_account,p_target);
 insert into public.investment_operations values(p_id,u,'account_reconciliation',p_account,payload,now());return p_id;
end $$;
revoke all on function public.reconcile_operational_balance(uuid,uuid,bigint,bigint) from public,anon;
grant execute on function public.reconcile_operational_balance(uuid,uuid,bigint,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
