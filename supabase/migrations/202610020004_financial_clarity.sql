begin;
-- Preserve every existing amount and identity. Future legacy entries become
-- explicitly pending; the arrival of their date never posts cash automatically.
alter table public.transactions add column status text not null default 'realized' check(status in ('realized','pending','cancelled'));
alter table public.transactions add column planning_group text not null default 'scheduled' check(planning_group in ('scheduled','other'));
alter table public.transactions add column adjustment_delta_cents bigint;
update public.transactions set status='pending' where transaction_date>public.financial_date() and payment_reference is null;
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check(type in ('income','expense','transfer','card_payment','adjustment'));
alter table public.transactions drop constraint transaction_shape;
alter table public.transactions add constraint transaction_shape check(
 (type='transfer' and destination_account_id is not null and destination_account_id<>account_id and category_id is null and adjustment_delta_cents is null) or
 (type in ('income','expense') and destination_account_id is null and category_id is not null and adjustment_delta_cents is null) or
 (type='card_payment' and destination_account_id is null and category_id is null and payment_reference='card' and adjustment_delta_cents is null) or
 (type='adjustment' and destination_account_id is null and category_id is null and payment_reference is null and status='realized' and adjustment_delta_cents is not null and abs(adjustment_delta_cents)=amount_cents));
alter table public.debts add column installment_number integer not null default 1 check(installment_number>=1);
alter table public.debts add column total_installments integer check(total_installments between 1 and 600);
alter table public.debts add constraint debt_numbering_valid check(total_installments is null or
 (installment_amount_cents is not null and installment_number<=total_installments+1 and
 remaining_amount_cents <= (total_installments-installment_number+1)*installment_amount_cents-installment_paid_cents and
 (remaining_amount_cents=0 or next_due_date is not null)));

create or replace function public.guard_payment_transaction() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' then
  if (tg_op='INSERT' and (new.payment_reference is not null or new.type in ('card_payment','adjustment'))) or
     (tg_op<>'INSERT' and (old.payment_reference is not null or old.type='adjustment')) or
     (tg_op='UPDATE' and (new.payment_reference is not null or new.type in ('card_payment','adjustment'))) then
   raise exception 'Pagamentos e ajustes devem usar a operação atômica';
  end if;
  if tg_op='UPDATE' and new.status is distinct from old.status then raise exception 'Use confirmar ou cancelar lançamento'; end if;
  if tg_op in ('INSERT','UPDATE') and new.transaction_date>public.financial_date() and new.status='realized' then new.status='pending'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;

create function public.resolve_transaction(p_id uuid,p_cancel boolean,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); t public.transactions; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into t from public.transactions where id=p_id and user_id=u and payment_reference is null and type in ('income','expense','transfer') for update;
 if not found then raise exception 'Lançamento inválido'; end if;
 if t.status<>'pending' then return t.id; end if;
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

create function public.adjust_account_balance(p_id uuid,p_account uuid,p_target bigint) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); a public.accounts; actual bigint; delta bigint; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into a from public.accounts where id=p_account and user_id=u and is_active for update;
 if not found then raise exception 'Conta inválida'; end if;
 if exists(select 1 from public.transactions where id=p_id and user_id=u and type='adjustment') then return p_id; end if;
 if p_target is null or abs(p_target)>1000000000000 then raise exception 'Saldo inválido'; end if;
 select a.initial_balance_cents+coalesce(sum(
 case when account_id=a.id then case type when 'income' then amount_cents when 'adjustment' then adjustment_delta_cents else -amount_cents end else 0 end+
 case when type='transfer' and destination_account_id=a.id then amount_cents else 0 end),0)
 into actual from public.transactions where user_id=u and status='realized' and transaction_date<=public.financial_date();
 delta=p_target-actual;
 if delta=0 then return p_id; end if;
 insert into public.transactions(id,user_id,account_id,type,amount_cents,adjustment_delta_cents,description,transaction_date)
 values(p_id,u,a.id,'adjustment',abs(delta),delta,'Ajuste de saldo atual',public.financial_date());
 return p_id;
end $$;
revoke all on function public.resolve_transaction(uuid,boolean,date),public.adjust_account_balance(uuid,uuid,bigint) from public,anon;
grant execute on function public.resolve_transaction(uuid,boolean,date),public.adjust_account_balance(uuid,uuid,bigint) to authenticated;

-- Definitions below extend existing atomic operations without rebuilding tables.

create or replace function public.guard_debt() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.due_anchor_day=extract(day from new.next_due_date);new.installment_paid_cents=0;
 elsif current_user='authenticated' then
  if (new.remaining_amount_cents,new.original_amount_cents,new.installment_paid_cents,new.installment_number) is distinct from (old.remaining_amount_cents,old.original_amount_cents,old.installment_paid_cents,old.installment_number) then
   raise exception 'Saldo da dívida é alterado pelos pagamentos';
  end if;
  if (new.next_due_date,new.due_anchor_day,new.total_installments,new.installment_amount_cents) is distinct from (old.next_due_date,old.due_anchor_day,old.total_installments,old.installment_amount_cents) then
   if exists(select 1 from public.debt_payments where debt_id=old.id and user_id=old.user_id) then
    raise exception 'Calendário da dívida é alterado pelos pagamentos';
   end if;
   new.due_anchor_day=extract(day from new.next_due_date);
  end if;
 end if;
 return new;
end $$;
create or replace function public.pay_debt(p_id uuid,p_debt uuid,p_account uuid,p_amount bigint,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); d public.debts; category uuid; combined bigint; advance integer; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into d from public.debts where id=p_debt and user_id=u for update;
 if not found then raise exception 'Dívida inválida'; end if;
 if exists(select 1 from public.debt_payments where id=p_id and user_id=u) then return p_id; end if;
 perform 1 from public.accounts where id=p_account and user_id=u and is_active;
 if not found then raise exception 'Conta inválida'; end if;
 if p_date>public.financial_date() then raise exception 'Pagamento deve ser realizado até hoje'; end if;
 if p_amount<=0 or p_amount>d.remaining_amount_cents then raise exception 'Pagamento supera o saldo restante'; end if;
 insert into public.categories(user_id,name,type) values(u,'Dívidas','expense') on conflict(user_id,type,name) do nothing;
 select id into category from public.categories where user_id=u and name='Dívidas' and type='expense';
 insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,payment_reference) values(p_id,u,p_account,category,'expense',p_amount,'Dívida · '||d.name,p_date,'debt');
 insert into public.debt_payments(id,user_id,debt_id,transaction_id,amount_cents,payment_date,scheduled_date) values(p_id,u,p_debt,p_id,p_amount,p_date,d.next_due_date);
 combined=d.installment_paid_cents+p_amount;
 if d.installment_amount_cents is not null and d.next_due_date is not null then
  advance=(combined/d.installment_amount_cents)::integer;
  update public.debts set remaining_amount_cents=remaining_amount_cents-p_amount,
   installment_number=case when remaining_amount_cents=p_amount and total_installments is not null then total_installments+1 else installment_number+advance end,
   installment_paid_cents=case when remaining_amount_cents=p_amount then 0 else combined%d.installment_amount_cents end,
   next_due_date=case when remaining_amount_cents=p_amount then null else public.month_day((d.next_due_date+advance*interval '1 month')::date,d.due_anchor_day) end where id=d.id and user_id=u;
 else update public.debts set remaining_amount_cents=remaining_amount_cents-p_amount where id=d.id and user_id=u; end if;
 return p_id;
end $$;
create or replace function public.resolve_recurring(p_id uuid,p_rule uuid,p_due date,p_skip boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; existing public.recurring_occurrences; begin
 select * into r from public.recurring_items where id=p_rule and user_id=u and active for update;
 if not found then raise exception 'Recorrência inválida'; end if;
 if not public.is_recurring_date(r,p_due) then raise exception 'Data fora da recorrência'; end if;
 select * into existing from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due;
 if found then
 if existing.transaction_id is not null then perform public.resolve_transaction(existing.transaction_id,p_skip,public.financial_date()); end if;
 return existing.id; end if;
 if not p_skip then
  if p_due>public.financial_date() then raise exception 'Ocorrência futura: aguarde a data para realizar'; end if;
  perform 1 from public.accounts where id=r.account_id and user_id=u and is_active;
  if not found then raise exception 'Conta arquivada'; end if;
  insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency) values(p_id,u,r.account_id,r.category_id,r.type,r.amount_cents,r.name,public.financial_date(),true,r.frequency);
 end if;
 insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,transaction_id) values(p_id,u,r.id,p_due,case when p_skip then 'skipped' else 'recorded' end,case when p_skip then null else p_id end);
 return p_id;
end $$;
create or replace function public.repeat_transaction(p_id uuid,p_rule uuid,p_payload jsonb,p_existing boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); t public.transactions; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 if exists(select 1 from public.recurring_occurrences where transaction_id=p_id and user_id=u) then return p_id; end if;
 if p_existing then
  select * into t from public.transactions where id=p_id and user_id=u and type in ('income','expense') and payment_reference is null for update;
  if not found then raise exception 'Lançamento inválido'; end if;
 else
  insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency,status)
  values(p_id,u,(p_payload->>'account_id')::uuid,(p_payload->>'category_id')::uuid,p_payload->>'type',(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),(p_payload->>'transaction_date')::date,true,p_payload->>'recurrence_frequency',case when (p_payload->>'transaction_date')::date>public.financial_date() or p_payload->>'status'='pending' then 'pending' else 'realized' end) returning * into t;
 end if;
 insert into public.recurring_items(id,user_id,name,type,amount_cents,account_id,category_id,frequency,start_date,is_essential)
 values(p_rule,u,coalesce(nullif(t.description,''),'Lançamento recorrente'),t.type,t.amount_cents,t.account_id,t.category_id,coalesce(p_payload->>'recurrence_frequency',t.recurrence_frequency,'monthly'),t.transaction_date,coalesce((p_payload->>'is_essential')::boolean,false));
 insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,transaction_id) values(u,p_rule,t.transaction_date,'recorded',t.id);
 return p_id;
end $$;
create function public.guard_account_opening_balance() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and new.initial_balance_cents is distinct from old.initial_balance_cents then raise exception 'Use ajustar saldo atual para preservar o histórico'; end if;
 return new;
end $$;
create trigger guard_opening_balance before update on public.accounts for each row execute function public.guard_account_opening_balance();
notify pgrst, 'reload schema';
commit;
