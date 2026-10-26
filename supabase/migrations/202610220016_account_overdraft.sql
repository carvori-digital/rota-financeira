begin;
-- Optional contract metadata, never another money account or debt principal.
create table public.account_overdraft_versions (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id),
 account_id uuid not null, revision integer not null check(revision>0),
 tracking_start date not null, effective_date date not null check(effective_date>=tracking_start),
 limit_cents bigint not null check(limit_cents between 0 and 1000000000000),
 active boolean not null, statement_model text not null check(statement_model in ('negative_balance','needs_reconciliation')),
 monthly_interest_rate numeric check(monthly_interest_rate between 0 and 1000),
 contract_notes text not null default '' check(length(contract_notes)<=2000),
 change_reason text not null check(length(trim(change_reason)) between 1 and 2000),
 created_at timestamptz not null default now(), unique(account_id,user_id,revision),
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
-- Observations capture evidence and the actual ledger used. No automatic
-- financial adjustment, initial-balance overwrite, or inferred bank credit.
create table public.bank_reconciliations (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id), account_id uuid not null,
 statement_date date not null, statement_balance_cents bigint not null check(abs(statement_balance_cents)<=1000000000000),
 calculated_balance_cents bigint not null,
 difference_cents bigint generated always as (statement_balance_cents-calculated_balance_cents) stored,
 evidence text not null check(length(trim(evidence)) between 1 and 2000), ledger_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
do $$ declare t text; begin
 foreach t in array array['account_overdraft_versions','bank_reconciliations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_select on public.%I for select to authenticated using(user_id=(select auth.uid()))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(user_id,account_id)',t);
  execute format('create trigger financial_audit after insert or update or delete on public.%I for each row execute function public.capture_financial_audit()',t);
 end loop;
end $$;
create function public.save_account_overdraft(p_id uuid,p_account uuid,p_expected uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); prev public.account_overdraft_versions; result uuid;
 payload jsonb=jsonb_build_object('account',p_account,'expected',p_expected,'terms',p_payload); day date=(p_payload->>'effective_date')::date; start_day date;
begin
 result=public.financial_request_result(p_id,'account_overdraft',payload);if result is not null then return result;end if;
 perform 1 from public.accounts where id=p_account and user_id=u and type='checking' and investment_id is null and not investment_retired for update;
 if not found then raise exception 'Escolha uma conta corrente existente';end if;
 select * into prev from public.account_overdraft_versions where account_id=p_account and user_id=u order by revision desc limit 1;
 if prev.id is distinct from p_expected then raise exception 'Configuração mudou; recarregue e confira';end if;
 if prev.id is null then
  start_day=(p_payload->>'tracking_start')::date;
  if start_day is null or start_day>public.financial_date() or day is distinct from start_day then raise exception 'Informe início até hoje; primeira vigência deve coincidir com o início';end if;
 else
  start_day=prev.tracking_start;
  if day is null or day<public.financial_date() or day<prev.effective_date then raise exception 'Mudanças não podem reescrever datas passadas ou versões futuras';end if;
 end if;
 insert into public.account_overdraft_versions(id,user_id,account_id,revision,tracking_start,effective_date,limit_cents,active,statement_model,monthly_interest_rate,contract_notes,change_reason)
 values(p_id,u,p_account,coalesce(prev.revision,0)+1,start_day,day,(p_payload->>'limit_cents')::bigint,(p_payload->>'active')::boolean,p_payload->>'statement_model',(p_payload->>'monthly_interest_rate')::numeric,coalesce(p_payload->>'contract_notes',''),p_payload->>'change_reason');
 insert into public.financial_requests values(p_id,u,'account_overdraft',payload,p_id,now());return p_id;
end $$;
revoke all on function public.save_account_overdraft(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.save_account_overdraft(uuid,uuid,uuid,jsonb) to authenticated;
create function public.record_bank_reconciliation(p_id uuid,p_account uuid,p_date date,p_statement bigint,p_expected bigint,p_evidence text,p_confirmed boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); result uuid; actual bigint; snapshot jsonb;
 payload jsonb=jsonb_build_object('account',p_account,'date',p_date,'statement',p_statement,'expected',p_expected,'evidence',p_evidence,'confirmed',p_confirmed);
begin
 result=public.financial_request_result(p_id,'bank_reconciliation',payload);if result is not null then return result;end if;
 if p_confirmed is distinct from true or p_date is null or p_date>public.financial_date() then raise exception 'Confirme a conferência do extrato e a data até hoje';end if;
 -- One SQL snapshot, including balance and rows, is auditable even if a later
 -- backdated write changes today's interpretation. No cached balance is saved.
 select a.initial_balance_cents+coalesce(sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end),0),
 jsonb_build_object('initial_balance_cents',a.initial_balance_cents,'transactions',coalesce(jsonb_agg(to_jsonb(t) order by t.transaction_date,t.id) filter(where t.id is not null),'[]'::jsonb)) into actual,snapshot
 from public.accounts a left join public.transactions t on t.user_id=u and t.status='realized' and t.transaction_date<=p_date and (t.account_id=a.id or t.destination_account_id=a.id)
 where a.id=p_account and a.user_id=u and a.type='checking' and a.investment_id is null and not a.investment_retired group by a.id;
 if actual is null then raise exception 'Conta corrente não encontrada';end if;
 if p_expected is null or actual<>p_expected then raise exception 'Saldo mudou; recarregue e confira novamente';end if;
 insert into public.bank_reconciliations(id,user_id,account_id,statement_date,statement_balance_cents,calculated_balance_cents,evidence,ledger_snapshot)
 values(p_id,u,p_account,p_date,p_statement,actual,p_evidence,snapshot);
 insert into public.financial_requests values(p_id,u,'bank_reconciliation',payload,p_id,now());return p_id;
end $$;
revoke all on function public.record_bank_reconciliation(uuid,uuid,date,bigint,bigint,text,boolean) from public,anon;
grant execute on function public.record_bank_reconciliation(uuid,uuid,date,bigint,bigint,text,boolean) to authenticated;
-- Financial charges remain ordinary bank expenses. The marker classifies the
-- expense; it never creates a second entry or estimates an automatic charge.
alter table public.transactions add column financial_charge text check(financial_charge in ('overdraft_interest','overdraft_iof'));
alter table public.transactions add constraint financial_charge_expense check(financial_charge is null or (type='expense' and not is_recurring));
create function public.guard_overdraft_account() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.type<>'checking' or new.investment_id is not null or new.investment_retired) and exists(select 1 from public.account_overdraft_versions where account_id=new.id and user_id=new.user_id) then raise exception 'Preserve o tipo da conta corrente com histórico de cheque especial';end if;
 return new;
end $$;
create trigger overdraft_account before update on public.accounts for each row execute function public.guard_overdraft_account();
create function public.guard_financial_charge() returns trigger language plpgsql set search_path='' as $$
begin
 if new.financial_charge is not null and not exists(select 1 from public.accounts where id=new.account_id and user_id=new.user_id and type='checking' and investment_id is null and not investment_retired) then raise exception 'Encargos de cheque especial exigem a conta corrente correta';end if;
 return new;
end $$;
create trigger financial_charge before insert or update on public.transactions for each row execute function public.guard_financial_charge();

create or replace function public.create_financial_transaction(p_id uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
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
 insert into public.transactions(id,user_id,type,account_id,destination_account_id,category_id,amount_cents,description,transaction_date,status,is_recurring,recurrence_frequency,planning_group,financial_commitment,commitment_due_date,financial_charge)
 values(p_id,u,kind,(p_payload->>'account_id')::uuid,(p_payload->>'destination_account_id')::uuid,(p_payload->>'category_id')::uuid,(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),day,
 case when day>public.financial_date() then 'pending' else coalesce(p_payload->>'status','realized') end,
 coalesce((p_payload->>'is_recurring')::boolean,false),p_payload->>'recurrence_frequency',coalesce(p_payload->>'planning_group','scheduled'),coalesce((p_payload->>'financial_commitment')::boolean,false),(p_payload->>'commitment_due_date')::date,p_payload->>'financial_charge');
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_id,u,'create_transaction',p_payload,p_id);return p_id;
end $$;
revoke all on function public.create_financial_transaction(uuid,jsonb) from public,anon;grant execute on function public.create_financial_transaction(uuid,jsonb) to authenticated;

alter function public.export_financial_snapshot() rename to export_financial_snapshot_before_overdraft;
revoke all on function public.export_financial_snapshot_before_overdraft() from public,anon;
create function public.export_financial_snapshot() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb=public.export_financial_snapshot_before_overdraft();t text;rows jsonb;
begin
 foreach t in array array['account_overdraft_versions','bank_reconciliations'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]''::jsonb) from public.%I r where r.user_id=$1',t) into rows using auth.uid();
  result=jsonb_set(result,array['data',t],rows);result=jsonb_set(result,array['counts',t],to_jsonb(jsonb_array_length(rows)));
 end loop;return result;
end $$;
revoke all on function public.export_financial_snapshot() from public,anon;grant execute on function public.export_financial_snapshot() to authenticated;
-- New event timestamps must reflect insertion AFTER the card lock, rather
-- than transaction start (which may precede a concurrent baseline/purchase).
-- No existing timestamp, invoice, purchase or payment is rewritten.
alter table public.card_purchases alter column created_at set default clock_timestamp();
alter table public.card_invoices alter column covered_at set default clock_timestamp();
create or replace function public.set_card_invoice_before_audit(p_id uuid,p_card uuid,p_amount bigint,p_due date,p_description text)
returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); paid bigint; result uuid; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 perform 1 from public.credit_cards where id=p_card and user_id=u and active for update;
 if not found then raise exception 'Cartão inválido'; end if;
 select id into result from public.card_invoices where (id=p_id or request_id=p_id) and user_id=u;
 if found then return result; end if;
 select coalesce(sum(amount_cents),0) into paid from public.card_payments where card_id=p_card and user_id=u and due_month=to_char(p_due,'YYYY-MM');
 if p_amount<paid then raise exception 'Fatura não pode ser menor que o valor já pago'; end if;
 insert into public.card_invoices(id,user_id,card_id,amount_cents,due_date,due_month,description,request_id)
 values(p_id,u,p_card,p_amount,p_due,to_char(p_due,'YYYY-MM'),p_description,p_id)
 on conflict(card_id,user_id,due_month) do update set request_id=excluded.request_id,amount_cents=excluded.amount_cents,due_date=excluded.due_date,description=excluded.description,covered_at=clock_timestamp()
 returning id into result;
 return result;
end $$;
notify pgrst,'reload schema';
commit;
