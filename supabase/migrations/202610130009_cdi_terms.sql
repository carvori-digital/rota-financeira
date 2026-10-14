begin;
alter table public.investments drop constraint investments_yield_type_check;
alter table public.investments add constraint investments_yield_type_check check(yield_type in ('manual','fixed_annual','fixed_monthly','percent_cdi'));
alter table public.investments drop constraint investments_yield_rate_check;
alter table public.investments add constraint investments_yield_rate_check check(yield_rate>=0 and yield_rate<=case when yield_type='percent_cdi' then 1000 else 100 end);
alter table public.investment_movements add column ledger_order bigint generated always as identity;
-- Supabase defaults grant sequence UPDATE/USAGE to API roles. Only the
-- definer RPCs may advance this technical order; clients must not reset it.
revoke all on sequence public.investment_movements_ledger_order_seq from public,anon,authenticated;
alter table public.investment_movements add column sync_value_cents bigint check(sync_value_cents between 0 and 1000000000000);
alter table public.investment_movements add column accounting_kind text check(accounting_kind in ('real_cash','historical_position','valuation'));
create table public.investment_rates (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id),
 investment_id uuid not null, effective_date date not null, percent numeric not null check(percent between 0 and 1000),
 created_at timestamptz not null default now(), unique(investment_id,effective_date),
 foreign key(investment_id,user_id) references public.investments(id,user_id)
);
alter table public.investment_rates enable row level security;
create policy own_select on public.investment_rates for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.investment_rates from public,anon,authenticated;
grant select on public.investment_rates to authenticated;
create index on public.investment_rates(user_id);
create function public.append_investment_rate(p_id uuid,p_investment uuid,p_date date,p_percent numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare i public.investments; existing public.investment_rates;begin
 select * into i from public.investments where id=p_investment and user_id=auth.uid() and active and yield_type='percent_cdi' for update;
 if not found then raise exception 'Investimento CDI inválido';end if;
 select * into existing from public.investment_rates where id=p_id and user_id=auth.uid();
 if found then
  if (existing.investment_id,existing.effective_date,existing.percent) is distinct from (p_investment,p_date,p_percent) then raise exception 'Requisição já utilizada';end if;return p_id;
 end if;
 if p_date is null or p_date<public.financial_date() or p_date<i.initial_date or p_percent is null or p_percent<0 or p_percent>1000 then raise exception 'Data/percentual inválido; passado preservado';end if;
 if exists(select 1 from public.investment_rates where investment_id=i.id and effective_date>=p_date) then raise exception 'Informe vigência posterior à última taxa';end if;
 insert into public.investment_rates(id,user_id,investment_id,effective_date,percent) values(p_id,i.user_id,i.id,p_date,p_percent);return p_id;
end $$;
-- The backend is a recorded-position ledger, not an online market oracle.
-- For CDI, withdrawal limits use the last bank synchronization + later cash.
-- Estimates never silently credit the operational account.
alter function public.investment_value(uuid,date) rename to investment_value_fixed;
create function public.investment_value(p_investment uuid,p_date date) returns bigint language plpgsql stable security definer set search_path='' as $$
declare i public.investments; anchor public.investment_movements; value numeric;begin
 select * into i from public.investments where id=p_investment and user_id=auth.uid();if not found then raise exception 'Investimento inválido';end if;
 if i.yield_type<>'percent_cdi' then return public.investment_value_fixed(p_investment,p_date);end if;
 select * into anchor from public.investment_movements where investment_id=i.id and user_id=i.user_id and date<=p_date and sync_value_cents is not null order by date desc,ledger_order desc limit 1;
 select coalesce(anchor.sync_value_cents,0)+coalesce(sum(case when type='withdrawal' then -amount_cents else amount_cents end),0) into value
  from public.investment_movements where investment_id=i.id and user_id=i.user_id and date<=p_date and (anchor.id is null or (date,ledger_order)>(anchor.date,anchor.ledger_order));
 if abs(value)>1000000000000 then raise exception 'Posição fora do limite';end if;return round(value)::bigint;
end $$;
alter function public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text) rename to record_investment_movement_legacy;
revoke all on function public.record_investment_movement_legacy(uuid,uuid,text,bigint,date,uuid,text) from public,anon,authenticated;
create function public.record_investment_movement(p_id uuid,p_investment uuid,p_type text,p_amount bigint,p_date date,p_account uuid,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare existing public.investment_movements; i public.investments; result uuid;begin
 select * into i from public.investments where id=p_investment and user_id=auth.uid() and active for update;if not found then raise exception 'Investimento inválido';end if;
 select * into existing from public.investment_movements where id=p_id;
 if found then
  if existing.user_id<>auth.uid() or existing.investment_id<>p_investment or existing.type<>p_type or existing.date<>p_date
   or (p_type='adjustment' and existing.sync_value_cents is distinct from p_amount)
   or (p_type<>'adjustment' and (existing.amount_cents<>p_amount or not exists(select 1 from public.transactions where id=existing.transaction_id and account_id=p_account and user_id=auth.uid()))) then raise exception 'Requisição já utilizada';end if;
  return p_id;
 end if;
 result=public.record_investment_movement_legacy(p_id,p_investment,p_type,p_amount,p_date,p_account,p_description);
 update public.investment_movements set accounting_kind=case when p_type='adjustment' then 'valuation' else 'real_cash' end,sync_value_cents=case when p_type='adjustment' then p_amount else null end where id=result and user_id=auth.uid();return result;
end $$;
revoke all on function public.investment_value_fixed(uuid,date) from public,anon,authenticated;
revoke all on function public.investment_value(uuid,date),public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text),public.append_investment_rate(uuid,uuid,date,numeric) from public,anon;
grant execute on function public.investment_value(uuid,date),public.record_investment_movement(uuid,uuid,text,bigint,date,uuid,text),public.append_investment_rate(uuid,uuid,date,numeric) to authenticated;
notify pgrst,'reload schema';
commit;
