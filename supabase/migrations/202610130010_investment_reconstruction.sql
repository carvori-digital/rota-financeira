begin;
-- No account/transaction/history backfill and no automatic reconstruction.
alter table public.investments add column replaced_by_id uuid;
alter table public.investments add foreign key(replaced_by_id,user_id) references public.investments(id,user_id);
create table public.investment_reconstructions (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id), old_investment_id uuid not null unique, new_investment_id uuid not null unique,
 recorded_value_cents bigint not null, historical_net_cents bigint not null, real_value_cents bigint not null,
 difference_cents bigint not null, reconciliation_note text not null check(length(trim(reconciliation_note)) between 1 and 240),
 payload jsonb not null, created_at timestamptz not null default now(),
 foreign key(old_investment_id,user_id) references public.investments(id,user_id), foreign key(new_investment_id,user_id) references public.investments(id,user_id)
);
alter table public.investment_reconstructions enable row level security;
create policy own_select on public.investment_reconstructions for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.investment_reconstructions from public,anon,authenticated;
grant select on public.investment_reconstructions to authenticated;
create index on public.investment_reconstructions(user_id);
create or replace function public.guard_investment_terms() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.yield_type,new.yield_rate,new.initial_date,new.source_account_id) is distinct from (old.yield_type,old.yield_rate,old.initial_date,old.source_account_id) then raise exception 'Condições e origem preservadas; use sincronização';end if;
 if current_user='authenticated' and (old.replaced_by_id is not null or new.replaced_by_id is distinct from old.replaced_by_id) then raise exception 'Histórico de substituição protegido';end if;
 return new;
end $$;
create function public.guard_replacement_insert() returns trigger language plpgsql set search_path='' as $$
begin
 if new.replaced_by_id is not null then raise exception 'Substituição reservada à reconstrução';end if;return new;
end $$;
create trigger replacement_insert before insert on public.investments for each row execute function public.guard_replacement_insert();
create function public.reconstruct_investment(p_id uuid,p_old uuid,p_new uuid,p_expected bigint,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); old public.investments; a public.accounts; previous public.investment_reconstructions; row jsonb; net bigint=0; amount bigint; day date; initial date; real_value bigint; existing_value bigint; kind text; last_day date; begin
 if u is null then raise exception 'Autenticação necessária';end if;
 select * into previous from public.investment_reconstructions where id=p_id;
 if found then
  if previous.user_id<>u or previous.old_investment_id<>p_old or previous.new_investment_id<>p_new or previous.recorded_value_cents<>p_expected or previous.payload is distinct from p_payload then raise exception 'Requisição já utilizada';end if;return previous.new_investment_id;
 end if;
 select * into old from public.investments where id=p_old and user_id=u and source_account_id is not null and active and replaced_by_id is null for update;
 if not found then raise exception 'Investimento migrado inválido ou já substituído';end if;
 select * into a from public.accounts where id=old.source_account_id and user_id=u and investment_id=old.id and not is_active for update;
 if not found then raise exception 'Vínculo de origem inconsistente';end if;
 perform 1 from public.investment_movements where investment_id=old.id and user_id=u for update;
 if exists(select 1 from public.investment_movements m where m.investment_id=old.id and (m.user_id<>u or (m.transaction_id is not null and not exists(select 1 from public.transactions t where t.id=m.transaction_id and t.user_id=u)) or (m.source_transaction_id is not null and not exists(select 1 from public.transactions t where t.id=m.source_transaction_id and t.user_id=u)))) then raise exception 'Histórico com vínculos inconsistentes';end if;
 existing_value=public.investment_value(old.id,public.financial_date());
 if p_expected is null or existing_value<>p_expected then raise exception 'Posição mudou; recarregue e revise novamente';end if;
 if coalesce((p_payload->>'acknowledged')::boolean,false) is not true then raise exception 'Confirme reconciliação e ausência de novo débito';end if;
 if length(trim(coalesce(p_payload->>'note','')))=0 then raise exception 'Informe a referência de reconciliação';end if;
 initial=(p_payload->>'initial_date')::date;real_value=(p_payload->>'real_value_cents')::bigint;
 if initial is null or initial>public.financial_date() or real_value is null or real_value<0 or real_value>1000000000000 then raise exception 'Data/posição inválida';end if;
 if jsonb_typeof(p_payload->'history') is distinct from 'array' or jsonb_array_length(p_payload->'history')=0 or jsonb_array_length(p_payload->'history')>1000 then raise exception 'Informe histórico (até 1000 movimentos)';end if;
 -- Review all history before persisting anything. Dates must be chronological;
 -- historical withdrawals cannot create a negative imported capital position.
 for row in select value from jsonb_array_elements(p_payload->'history') loop
  amount=(row->>'amount_cents')::bigint;day=(row->>'date')::date;kind=row->>'type';
  if amount is null or amount<=0 or amount>1000000000000 or day is null or day<initial or day>public.financial_date() or (last_day is not null and day<last_day) or kind is null or kind not in ('contribution','withdrawal') then raise exception 'Movimento histórico inválido';end if;
  net=net+case when kind='withdrawal' then -amount else amount end;
  if net<0 or net>1000000000000 then raise exception 'Capital histórico inválido; revise os aportes/resgates';end if;last_day=day;
 end loop;
 insert into public.investments(id,user_id,name,institution,type,initial_date,yield_type,yield_rate,is_emergency_reserve)
 values(p_new,u,p_payload->>'name',p_payload->>'institution',p_payload->>'product',initial,p_payload->>'yield_type',(p_payload->>'yield_rate')::numeric,old.is_emergency_reserve);
 for row in select value from jsonb_array_elements(p_payload->'history') loop
  insert into public.investment_movements(user_id,investment_id,type,amount_cents,date,description,source_account_id,accounting_kind)
  values(u,p_new,row->>'type',(row->>'amount_cents')::bigint,(row->>'date')::date,'Histórico reconstruído; sem movimentação bancária',a.id,'historical_position');
 end loop;
 -- This is valuation, never cash. For fixed models calculate their own estimate
 -- at confirmation date; CDI uses recorded capital until market history exists.
 insert into public.investment_movements(user_id,investment_id,type,amount_cents,date,description,source_account_id,accounting_kind,sync_value_cents)
 values(u,p_new,'adjustment',real_value-public.investment_value(p_new,public.financial_date()),public.financial_date(),'Reconciliação · '||left(p_payload->>'note',220),a.id,'valuation',real_value);
 insert into public.investment_reconstructions(id,user_id,old_investment_id,new_investment_id,recorded_value_cents,historical_net_cents,real_value_cents,difference_cents,reconciliation_note,payload)
 values(p_id,u,p_old,p_new,existing_value,net,real_value,real_value-existing_value,p_payload->>'note',p_payload);
 update public.investments set active=false,replaced_by_id=p_new where id=old.id and user_id=u;
 return p_new;
end $$;
revoke all on function public.reconstruct_investment(uuid,uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.reconstruct_investment(uuid,uuid,uuid,bigint,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
