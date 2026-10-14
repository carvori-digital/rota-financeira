begin;
create table public.report_month_confirmations (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references auth.users(id),
 month date not null check(extract(day from month)=1),complete boolean not null default false,
 confirmed_at timestamptz not null default now(),created_at timestamptz not null default now(),unique(user_id,month)
);
alter table public.report_month_confirmations enable row level security;
create policy own_select on public.report_month_confirmations for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.report_month_confirmations from public,anon,authenticated;grant select on public.report_month_confirmations to authenticated;
create index on public.report_month_confirmations(user_id);
create function public.confirm_report_month(p_month date,p_complete boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or p_month is null or extract(day from p_month)<>1 or p_month>=date_trunc('month',public.financial_date())::date or p_complete is null then raise exception 'Confirme somente mês encerrado';end if;
 insert into public.report_month_confirmations(user_id,month,complete) values(auth.uid(),p_month,p_complete)
 on conflict(user_id,month) do update set complete=excluded.complete,confirmed_at=now();
end $$;
-- One stable statement snapshot; explicit ownership + RLS, no pagination/API
-- row limit on nested JSON arrays. All needed records, or the call fails.
create function public.export_financial_snapshot() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare u uuid=auth.uid(); t text; rows jsonb; data jsonb='{}'::jsonb; counts jsonb='{}'::jsonb;begin
 if u is null then raise exception 'Autenticação necessária';end if;
 foreach t in array array['accounts','categories','transactions','goals','goal_contributions','recurring_items','recurring_occurrences','credit_cards','card_purchases','card_invoices','card_payments','card_adjustments','debts','debt_payments','reserve_account_links','investments','investment_movements','investment_rates','investment_reconstructions','report_month_confirmations'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]''::jsonb) from public.%I r where r.user_id=$1',t) into rows using u;
  data=data||jsonb_build_object(t,rows);counts=counts||jsonb_build_object(t,jsonb_array_length(rows));
 end loop;
 return jsonb_build_object('schema_version',1,'owner',u,'generated_at',statement_timestamp(),'counts',counts,'data',data);
end $$;
revoke all on function public.confirm_report_month(date,boolean),public.export_financial_snapshot() from public,anon;
grant execute on function public.confirm_report_month(date,boolean),public.export_financial_snapshot() to authenticated;
notify pgrst,'reload schema';
commit;
