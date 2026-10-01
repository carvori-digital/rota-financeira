begin;
-- Incremental: existing financial rows and historical migration are untouched.
alter table public.transactions add constraint transactions_id_user_unique unique(id,user_id);
alter table public.transactions add column payment_reference text check(payment_reference in ('card','debt'));
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions drop constraint transactions_check;
alter table public.transactions add constraint transactions_type_check check(type in ('income','expense','transfer','card_payment'));
alter table public.transactions add constraint transaction_shape check(
 (type='transfer' and destination_account_id is not null and destination_account_id<>account_id and category_id is null) or
 (type in ('income','expense') and destination_account_id is null and category_id is not null) or
 (type='card_payment' and destination_account_id is null and category_id is null and payment_reference='card'));
alter table public.goals add column is_emergency_reserve boolean not null default false;
create unique index one_emergency_reserve on public.goals(user_id) where is_emergency_reserve;
create table public.recurring_items (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), type text not null check(type in ('income','expense')),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000), account_id uuid not null, category_id uuid not null,
 frequency text not null check(frequency in ('weekly','monthly','yearly')), start_date date not null, end_date date,
 active boolean not null default true, is_essential boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id),
 check(end_date is null or end_date>=start_date),
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict,
 foreign key(category_id,user_id,type) references public.categories(id,user_id,type) on delete restrict
);
create table public.recurring_occurrences (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 recurring_item_id uuid not null, due_date date not null, status text not null check(status in ('recorded','skipped')), transaction_id uuid,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(recurring_item_id,user_id,due_date),
 check((status='recorded' and transaction_id is not null) or (status='skipped' and transaction_id is null)),
 foreign key(recurring_item_id,user_id) references public.recurring_items(id,user_id) on delete restrict,
 foreign key(transaction_id,user_id) references public.transactions(id,user_id) on delete cascade
);
create table public.credit_cards (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), limit_cents bigint check(limit_cents between 1 and 1000000000000),
 closing_day integer not null check(closing_day between 1 and 31), due_day integer not null check(due_day between 1 and 31), payment_account_id uuid not null,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id),
 foreign key(payment_account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
create table public.card_purchases (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 card_id uuid not null, category_id uuid not null, category_type text not null default 'expense' check(category_type='expense'),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000), description text not null default '' check(length(description)<=240),
 purchase_date date not null, installments integer not null default 1 check(installments between 1 and 120), first_due_date date not null, due_anchor_day integer not null check(due_anchor_day between 1 and 31),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check(amount_cents>=installments),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id) on delete restrict,
 foreign key(category_id,user_id,category_type) references public.categories(id,user_id,type) on delete restrict
);
create table public.card_invoices (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 card_id uuid not null, due_date date not null, amount_cents bigint not null check(amount_cents between 0 and 100000000000000),
 description text not null default '' check(length(description)<=240), covered_at timestamptz not null default now(),
 due_month text not null check(due_month=to_char(due_date,'YYYY-MM')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(card_id,user_id,due_month),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id) on delete restrict
);
create table public.card_payments (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 card_id uuid not null, due_month text not null check(due_month ~ '^\d{4}-\d{2}$'), transaction_id uuid not null,
 amount_cents bigint not null check(amount_cents>0), payment_date date not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(transaction_id,user_id),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id) on delete restrict,
 foreign key(transaction_id,user_id) references public.transactions(id,user_id) on delete restrict
);
create table public.debts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), original_amount_cents bigint not null check(original_amount_cents between 1 and 1000000000000),
 remaining_amount_cents bigint not null check(remaining_amount_cents>=0 and remaining_amount_cents<=original_amount_cents),
 installment_amount_cents bigint check(installment_amount_cents between 1 and 1000000000000), next_due_date date, due_anchor_day integer check(due_anchor_day between 1 and 31),
 installment_paid_cents bigint not null default 0 check(installment_paid_cents>=0), payment_account_id uuid,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id),
 foreign key(payment_account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
create table public.debt_payments (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 debt_id uuid not null, transaction_id uuid not null, amount_cents bigint not null check(amount_cents>0), payment_date date not null, scheduled_date date,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(transaction_id,user_id),
 foreign key(debt_id,user_id) references public.debts(id,user_id) on delete restrict,
 foreign key(transaction_id,user_id) references public.transactions(id,user_id) on delete restrict
);
create table public.reserve_account_links (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 goal_id uuid not null, account_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(goal_id,user_id,account_id),
 foreign key(goal_id,user_id) references public.goals(id,user_id) on delete restrict,
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
do $$ declare t text; begin
 foreach t in array array['recurring_items','recurring_occurrences','credit_cards','card_purchases','card_invoices','card_payments','debts','debt_payments','reserve_account_links'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_select on public.%I for select to authenticated using(user_id=(select auth.uid()))',t);
  execute format('create policy own_insert on public.%I for insert to authenticated with check(user_id=(select auth.uid()))',t);
  execute format('create policy own_update on public.%I for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()))',t);
  execute format('create policy own_delete on public.%I for delete to authenticated using(user_id=(select auth.uid()))',t);
  execute format('revoke all on public.%I from anon',t);
  execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  execute format('create index on public.%I(user_id)',t);
  execute format('create trigger protect_row before update on public.%I for each row execute function public.protect_financial_row()',t);
 end loop;
end $$;
-- Receipts are only written by atomic, authenticated RPCs.
revoke insert,update,delete on public.card_payments,public.debt_payments,public.recurring_occurrences,public.card_invoices,public.reserve_account_links from authenticated;
create function public.month_day(p_month date,p_day integer) returns date language sql immutable set search_path='' as $$
 select (date_trunc('month',p_month)::date + (least(p_day,extract(day from (date_trunc('month',p_month)+interval '1 month - 1 day'))::integer)-1))::date
$$;
create function public.purchase_dates() returns trigger language plpgsql set search_path='' as $$
declare c public.credit_cards; m date; begin
 select * into c from public.credit_cards where id=new.card_id and user_id=new.user_id;
 if not found then raise exception 'Cartão inválido'; end if;
 if tg_op='UPDATE' and (new.card_id,new.amount_cents,new.purchase_date,new.installments,new.first_due_date,new.due_anchor_day) is distinct from (old.card_id,old.amount_cents,old.purchase_date,old.installments,old.first_due_date,old.due_anchor_day) then raise exception 'Compra registrada: valores e parcelamento são imutáveis'; end if;
 if tg_op='INSERT' then
  if not c.active then raise exception 'Cartão arquivado'; end if;
  m=date_trunc('month',new.purchase_date)::date;
  if new.purchase_date>public.month_day(m,c.closing_day) then m=(m+interval '1 month')::date; end if;
  if c.due_day<=c.closing_day then m=(m+interval '1 month')::date; end if;
  new.first_due_date=public.month_day(m,c.due_day); new.due_anchor_day=c.due_day;
 end if; return new;
end $$;
create trigger set_purchase_dates before insert or update on public.card_purchases for each row execute function public.purchase_dates();
create function public.invoice_total(p_card uuid,p_month text,p_user uuid) returns bigint language sql stable set search_path='' as $$
 select coalesce((select amount_cents from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),0)+coalesce((
 select sum(p.amount_cents/p.installments + case when n.i<p.amount_cents%p.installments then 1 else 0 end)
 from public.card_purchases p cross join lateral generate_series(0,p.installments-1) n(i)
 where p.card_id=p_card and p.user_id=p_user and to_char(public.month_day((p.first_due_date+n.i*interval '1 month')::date,p.due_anchor_day),'YYYY-MM')=p_month
 and p.created_at>coalesce((select covered_at from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),'-infinity'::timestamptz)),0)
$$;
revoke all on function public.invoice_total(uuid,text,uuid) from public,anon,authenticated;
create function public.financial_date() returns date language sql stable set search_path='' as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function public.guard_payment_transaction() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and ((tg_op='INSERT' and (new.payment_reference is not null or new.type='card_payment')) or (tg_op<>'INSERT' and old.payment_reference is not null) or (tg_op='UPDATE' and new.payment_reference is not null)) then raise exception 'Pagamentos devem usar a operação atômica'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger guard_payment before insert or update or delete on public.transactions for each row execute function public.guard_payment_transaction();
create function public.guard_debt() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then new.due_anchor_day=extract(day from new.next_due_date); new.installment_paid_cents=0;
 elsif current_user='authenticated' and (new.remaining_amount_cents,new.original_amount_cents,new.installment_paid_cents,new.next_due_date,new.due_anchor_day) is distinct from (old.remaining_amount_cents,old.original_amount_cents,old.installment_paid_cents,old.next_due_date,old.due_anchor_day) then raise exception 'Saldo e calendário da dívida são alterados pelos pagamentos'; end if;
 return new;
end $$;
create trigger guard_debt before insert or update on public.debts for each row execute function public.guard_debt();
create function public.seed_debt_category() returns trigger language plpgsql security definer set search_path='' as $$ begin
 insert into public.categories(user_id,name,type) values(new.id,'Dívidas','expense') on conflict(user_id,type,name) do nothing; return new;
end $$;
revoke all on function public.seed_debt_category() from public,anon,authenticated;
create trigger seed_debt_category after insert on auth.users for each row execute function public.seed_debt_category();
insert into public.categories(user_id,name,type) select id,'Dívidas','expense' from auth.users on conflict(user_id,type,name) do nothing;

create function public.set_card_invoice(p_id uuid,p_card uuid,p_amount bigint,p_due date,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); paid bigint; result uuid; begin
 perform 1 from public.credit_cards where id=p_card and user_id=u and active for update;
 if not found then raise exception 'Cartão inválido'; end if;
 select coalesce(sum(amount_cents),0) into paid from public.card_payments where card_id=p_card and user_id=u and due_month=to_char(p_due,'YYYY-MM');
 if p_amount<paid then raise exception 'Fatura não pode ser menor que o valor já pago'; end if;
 insert into public.card_invoices(id,user_id,card_id,amount_cents,due_date,due_month,description) values(p_id,u,p_card,p_amount,p_due,to_char(p_due,'YYYY-MM'),p_description)
 on conflict(card_id,user_id,due_month) do update set amount_cents=excluded.amount_cents,due_date=excluded.due_date,description=excluded.description,covered_at=now() returning id into result;
 return result;
end $$;
create function public.pay_card_invoice(p_id uuid,p_card uuid,p_month text,p_account uuid,p_amount bigint,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); pending bigint; c public.credit_cards; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into c from public.credit_cards where id=p_card and user_id=u for update;
 if not found then raise exception 'Cartão inválido'; end if;
 if exists(select 1 from public.card_payments where id=p_id and user_id=u) then return p_id; end if;
 perform 1 from public.accounts where id=p_account and user_id=u and is_active;
 if not found then raise exception 'Conta inválida'; end if;
 if p_date>public.financial_date() then raise exception 'Pagamento deve ser realizado até hoje'; end if;
 select public.invoice_total(p_card,p_month,u)-coalesce(sum(amount_cents),0) into pending from public.card_payments where card_id=p_card and user_id=u and due_month=p_month;
 if p_amount<=0 or p_amount>pending then raise exception 'Pagamento supera o saldo pendente da fatura'; end if;
 insert into public.transactions(id,user_id,account_id,type,amount_cents,description,transaction_date,payment_reference) values(p_id,u,p_account,'card_payment',p_amount,'Fatura · '||c.name||' · '||p_month,p_date,'card');
 insert into public.card_payments(id,user_id,card_id,due_month,transaction_id,amount_cents,payment_date) values(p_id,u,p_card,p_month,p_id,p_amount,p_date);
 return p_id;
end $$;
create function public.pay_debt(p_id uuid,p_debt uuid,p_account uuid,p_amount bigint,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
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
   installment_paid_cents=case when remaining_amount_cents=p_amount then 0 else combined%d.installment_amount_cents end,
   next_due_date=case when remaining_amount_cents=p_amount then null else public.month_day((d.next_due_date+advance*interval '1 month')::date,d.due_anchor_day) end where id=d.id and user_id=u;
 else update public.debts set remaining_amount_cents=remaining_amount_cents-p_amount where id=d.id and user_id=u; end if;
 return p_id;
end $$;
create function public.is_recurring_date(r public.recurring_items,p_due date) returns boolean language plpgsql immutable set search_path='' as $$
declare months integer; begin
 if p_due<r.start_date or (r.end_date is not null and p_due>r.end_date) then return false; end if;
 months=(extract(year from p_due)::integer-extract(year from r.start_date)::integer)*12+extract(month from p_due)::integer-extract(month from r.start_date)::integer;
 return case r.frequency when 'weekly' then (p_due-r.start_date)%7=0 when 'monthly' then p_due=public.month_day(p_due,extract(day from r.start_date)::integer) when 'yearly' then months%12=0 and p_due=public.month_day(p_due,extract(day from r.start_date)::integer) else false end;
end $$;
create function public.resolve_recurring(p_id uuid,p_rule uuid,p_due date,p_skip boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); r public.recurring_items; existing public.recurring_occurrences; begin
 select * into r from public.recurring_items where id=p_rule and user_id=u and active for update;
 if not found then raise exception 'Recorrência inválida'; end if;
 if not public.is_recurring_date(r,p_due) then raise exception 'Data fora da recorrência'; end if;
 select * into existing from public.recurring_occurrences where recurring_item_id=r.id and user_id=u and due_date=p_due;
 if found then return existing.id; end if;
 if not p_skip then
  if p_due>public.financial_date() then raise exception 'Ocorrência futura: aguarde a data para realizar'; end if;
  perform 1 from public.accounts where id=r.account_id and user_id=u and is_active;
  if not found then raise exception 'Conta arquivada'; end if;
  insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency) values(p_id,u,r.account_id,r.category_id,r.type,r.amount_cents,r.name,p_due,true,r.frequency);
 end if;
 insert into public.recurring_occurrences(id,user_id,recurring_item_id,due_date,status,transaction_id) values(p_id,u,r.id,p_due,case when p_skip then 'skipped' else 'recorded' end,case when p_skip then null else p_id end);
 return p_id;
end $$;
create function public.repeat_transaction(p_id uuid,p_rule uuid,p_payload jsonb,p_existing boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); t public.transactions; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 if exists(select 1 from public.recurring_occurrences where transaction_id=p_id and user_id=u) then return p_id; end if;
 if p_existing then
  select * into t from public.transactions where id=p_id and user_id=u and type in ('income','expense') and payment_reference is null for update;
  if not found then raise exception 'Lançamento inválido'; end if;
 else
  insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,description,transaction_date,is_recurring,recurrence_frequency)
  values(p_id,u,(p_payload->>'account_id')::uuid,(p_payload->>'category_id')::uuid,p_payload->>'type',(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),(p_payload->>'transaction_date')::date,true,p_payload->>'recurrence_frequency') returning * into t;
 end if;
 insert into public.recurring_items(id,user_id,name,type,amount_cents,account_id,category_id,frequency,start_date,is_essential)
 values(p_rule,u,coalesce(nullif(t.description,''),'Lançamento recorrente'),t.type,t.amount_cents,t.account_id,t.category_id,coalesce(p_payload->>'recurrence_frequency',t.recurrence_frequency,'monthly'),t.transaction_date,coalesce((p_payload->>'is_essential')::boolean,false));
 insert into public.recurring_occurrences(user_id,recurring_item_id,due_date,status,transaction_id) values(u,p_rule,t.transaction_date,'recorded',t.id);
 return p_id;
end $$;
create function public.save_emergency_reserve(p_id uuid,p_cost bigint,p_months integer,p_accounts uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); result uuid; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 if p_cost<0 or p_cost>1000000000000 or p_months not between 1 and 120 then raise exception 'Reserva inválida'; end if;
 perform 1 from auth.users where id=u for update;
 if exists(select 1 from unnest(p_accounts) x where not exists(select 1 from public.accounts where id=x and user_id=u and type in ('savings','investment'))) then raise exception 'Conta da reserva inválida'; end if;
 insert into public.goals(id,user_id,name,target_amount_cents,essential_monthly_cents,reserve_months,is_emergency_reserve)
 values(p_id,u,'Reserva de emergência',greatest(1,coalesce(p_cost,0)*p_months),p_cost,p_months,true)
 on conflict(user_id) where is_emergency_reserve do update set essential_monthly_cents=excluded.essential_monthly_cents,reserve_months=excluded.reserve_months,target_amount_cents=excluded.target_amount_cents returning id into result;
 delete from public.reserve_account_links where user_id=u and goal_id=result;
 insert into public.reserve_account_links(user_id,goal_id,account_id) select u,result,x from (select distinct unnest(p_accounts) x) v;
 return result;
end $$;
do $$ declare f text; begin
 foreach f in array array['set_card_invoice(uuid,uuid,bigint,date,text)','pay_card_invoice(uuid,uuid,text,uuid,bigint,date)','pay_debt(uuid,uuid,uuid,bigint,date)','resolve_recurring(uuid,uuid,date,boolean)','repeat_transaction(uuid,uuid,jsonb,boolean)','save_emergency_reserve(uuid,bigint,integer,uuid[])'] loop
  execute 'revoke all on function public.'||f||' from public,anon';
  execute 'grant execute on function public.'||f||' to authenticated';
 end loop;
end $$;
commit;
