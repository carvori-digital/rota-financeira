begin;
alter table public.credit_cards alter column payment_account_id drop not null;
alter table public.credit_cards add column holder_name text check(length(holder_name)<=80);
alter table public.card_purchases add column cancelled_at timestamptz;
create table public.card_purchase_audit (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), purchase_id uuid not null references public.card_purchases(id),
 before_row jsonb not null, after_row jsonb not null, created_at timestamptz not null default now()
);
alter table public.card_purchase_audit enable row level security;
create policy own_select on public.card_purchase_audit for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.card_purchase_audit from public,anon,authenticated;
grant select on public.card_purchase_audit to authenticated;
revoke update on public.card_purchases from authenticated;
-- Direct inserts retain normal date calculation. Only the correction RPC edits.
create or replace function public.purchase_dates() returns trigger language plpgsql set search_path='' as $$
declare c public.credit_cards; m date; begin
 select * into c from public.credit_cards where id=new.card_id and user_id=new.user_id for update;
 if not found or not c.active then raise exception 'Cartão inválido ou arquivado'; end if;
 if tg_op='INSERT' then
  if new.cancelled_at is not null then raise exception 'Compra nova não pode estar cancelada'; end if;
  m=date_trunc('month',new.purchase_date)::date;
  if new.purchase_date>public.month_day(m,c.closing_day) then m=(m+interval '1 month')::date; end if;
  if c.due_day<=c.closing_day then m=(m+interval '1 month')::date; end if;
  new.first_due_date=coalesce(new.first_due_date,public.month_day(m,c.due_day));
  new.due_anchor_day=extract(day from new.first_due_date);
 end if;
 return new;
end $$;
-- INSERT-only idempotency: a reused key may never overwrite a purchase.
create function public.create_card_purchase(p_id uuid,p_payload jsonb) returns uuid language plpgsql set search_path='' as $$
declare r public.card_purchases; c public.credit_cards; due date; m date; u uuid=auth.uid(); begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into c from public.credit_cards where id=(p_payload->>'card_id')::uuid and user_id=u for update;
 if not found or not c.active then raise exception 'Cartão inválido ou arquivado'; end if;
 m=date_trunc('month',(p_payload->>'purchase_date')::date)::date;
 if (p_payload->>'purchase_date')::date>public.month_day(m,c.closing_day) then m=(m+interval '1 month')::date; end if;
 if c.due_day<=c.closing_day then m=(m+interval '1 month')::date; end if;
 due=coalesce((p_payload->>'first_due_date')::date,public.month_day(m,c.due_day));
 insert into public.card_purchases(id,user_id,card_id,category_id,amount_cents,description,purchase_date,installments,first_due_date)
 values(p_id,u,c.id,(p_payload->>'category_id')::uuid,(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),(p_payload->>'purchase_date')::date,(p_payload->>'installments')::integer,due)
 on conflict(id) do nothing;
 select * into r from public.card_purchases where id=p_id and user_id=u;
 if not found or r.cancelled_at is not null or
 (r.card_id,r.category_id,r.amount_cents,r.description,r.purchase_date,r.installments,r.first_due_date) is distinct from
 (c.id,(p_payload->>'category_id')::uuid,(p_payload->>'amount_cents')::bigint,coalesce(p_payload->>'description',''),(p_payload->>'purchase_date')::date,(p_payload->>'installments')::integer,due)
 then raise exception 'Identificador já utilizado; compra não alterada'; end if;
 return p_id;
end $$;
revoke all on function public.create_card_purchase(uuid,jsonb) from public,anon;
grant execute on function public.create_card_purchase(uuid,jsonb) to authenticated;
create function public.correct_card_purchase(p_id uuid,p_payload jsonb,p_cancel boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); oldrow public.card_purchases; newrow public.card_purchases; target uuid; x record; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 -- Serialize with payments and invoice baseline changes, always in UUID order.
 perform 1 from public.credit_cards where user_id=u order by id for update;
 select * into oldrow from public.card_purchases where id=p_id and user_id=u for update;
 if not found then raise exception 'Compra inválida'; end if;
 if oldrow.cancelled_at is not null then
  if p_cancel then return p_id; end if;
  raise exception 'Compra cancelada; histórico preservado';
 end if;
 target=case when p_cancel then oldrow.card_id else (p_payload->>'card_id')::uuid end;
 perform 1 from public.credit_cards where id=target and user_id=u and active;
 if not found then raise exception 'Cartão inválido'; end if;
 newrow=oldrow;
 if p_cancel then newrow.cancelled_at=now();
 else
  newrow.card_id=target; newrow.description=coalesce(p_payload->>'description','');
  newrow.amount_cents=(p_payload->>'amount_cents')::bigint; newrow.category_id=(p_payload->>'category_id')::uuid;
  newrow.purchase_date=(p_payload->>'purchase_date')::date; newrow.installments=(p_payload->>'installments')::integer;
  newrow.first_due_date=(p_payload->>'first_due_date')::date; newrow.due_anchor_day=extract(day from newrow.first_due_date);
  if newrow.installments is null or newrow.installments not between 1 and 120 or newrow.amount_cents<newrow.installments then raise exception 'Parcelamento inválido'; end if;
 end if;
 if exists(select 1 from public.card_payments pay where pay.user_id=u and (
  (pay.card_id=oldrow.card_id and pay.due_month in(select to_char(oldrow.first_due_date+n*interval '1 month','YYYY-MM') from generate_series(0,oldrow.installments-1) n)) or
  (not p_cancel and pay.card_id=newrow.card_id and pay.due_month in(select to_char(newrow.first_due_date+n*interval '1 month','YYYY-MM') from generate_series(0,newrow.installments-1) n)))) then
  raise exception 'Compra em fatura com pagamento: use ajuste rastreável de fatura';
 end if;
 -- Update only baselines that explicitly covered this purchase; keep covered_at.
 for x in select card,month_key,sum(delta)::bigint delta from (
  select oldrow.card_id card,to_char(oldrow.first_due_date+n*interval '1 month','YYYY-MM') as month_key,-(oldrow.amount_cents/oldrow.installments+case when n<oldrow.amount_cents%oldrow.installments then 1 else 0 end) delta from generate_series(0,oldrow.installments-1) n
  union all
  select newrow.card_id,to_char(newrow.first_due_date+n*interval '1 month','YYYY-MM'),newrow.amount_cents/newrow.installments+case when n<newrow.amount_cents%newrow.installments then 1 else 0 end from generate_series(0,newrow.installments-1) n where not p_cancel
 ) changes group by card,month_key loop
  update public.card_invoices set amount_cents=amount_cents+x.delta where user_id=u and card_id=x.card and due_month=x.month_key and covered_at>=oldrow.created_at;
 end loop;
 update public.card_purchases set card_id=newrow.card_id,description=newrow.description,amount_cents=newrow.amount_cents,category_id=newrow.category_id,purchase_date=newrow.purchase_date,
 installments=newrow.installments,first_due_date=newrow.first_due_date,due_anchor_day=newrow.due_anchor_day,cancelled_at=newrow.cancelled_at where id=p_id returning * into newrow;
 insert into public.card_purchase_audit(user_id,purchase_id,before_row,after_row) values(u,p_id,to_jsonb(oldrow),to_jsonb(newrow));
 return p_id;
end $$;
create table public.card_adjustments (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id), card_id uuid not null,
 purchase_id uuid not null references public.card_purchases(id), due_month text not null check(due_month ~ '^\d{4}-\d{2}$'),
 due_date date not null, amount_cents bigint not null check(amount_cents<>0 and abs(amount_cents)<=1000000000000), description text not null check(length(trim(description)) between 1 and 240),
 created_at timestamptz not null default now(), check(due_month=to_char(due_date,'YYYY-MM')),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id)
);
alter table public.card_adjustments enable row level security;
create policy own_select on public.card_adjustments for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.card_adjustments from public,anon,authenticated;
grant select on public.card_adjustments to authenticated;
create or replace function public.invoice_total(p_card uuid,p_month text,p_user uuid) returns bigint language sql stable set search_path='' as $$
 select coalesce((select amount_cents from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),0)+coalesce((
 select sum(p.amount_cents/p.installments+case when n.i<p.amount_cents%p.installments then 1 else 0 end)
 from public.card_purchases p cross join lateral generate_series(0,p.installments-1) n(i)
 where p.cancelled_at is null and p.card_id=p_card and p.user_id=p_user and to_char(p.first_due_date+n.i*interval '1 month','YYYY-MM')=p_month
 and p.created_at>coalesce((select covered_at from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),'-infinity'::timestamptz)),0)
 +coalesce((select sum(amount_cents) from public.card_adjustments where card_id=p_card and user_id=p_user and due_month=p_month),0)
$$;
create or replace function public.set_card_invoice(p_id uuid,p_card uuid,p_amount bigint,p_due date,p_description text)
returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); paid bigint; correction bigint; result uuid; begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 perform 1 from public.credit_cards where id=p_card and user_id=u and active for update;
 if not found then raise exception 'Cartão inválido'; end if;
 select id into result from public.card_invoices where (id=p_id or request_id=p_id) and user_id=u;
 if found then return result; end if;
 select coalesce(sum(amount_cents),0) into paid from public.card_payments where card_id=p_card and user_id=u and due_month=to_char(p_due,'YYYY-MM');
 select coalesce(sum(amount_cents),0) into correction from public.card_adjustments where card_id=p_card and user_id=u and due_month=to_char(p_due,'YYYY-MM');
 if p_amount<paid or p_amount-correction<0 then raise exception 'Fatura incompatível com pagamentos ou ajustes existentes'; end if;
 insert into public.card_invoices(id,user_id,card_id,amount_cents,due_date,due_month,description,request_id)
 values(p_id,u,p_card,p_amount-correction,p_due,to_char(p_due,'YYYY-MM'),p_description,p_id)
 on conflict(card_id,user_id,due_month) do update set request_id=excluded.request_id,amount_cents=excluded.amount_cents,due_date=excluded.due_date,description=excluded.description,covered_at=now()
 returning id into result;
 return result;
end $$;
create function public.adjust_card_purchase(p_id uuid,p_purchase uuid,p_due date,p_amount bigint,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.card_purchases; paid bigint; total bigint; u uuid=auth.uid(); begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 perform 1 from public.credit_cards where user_id=u order by id for update;
 select * into p from public.card_purchases where id=p_purchase and user_id=u;
 if not found or p.cancelled_at is not null then raise exception 'Compra inválida'; end if;
 if exists(select 1 from public.card_adjustments where id=p_id and user_id=u and purchase_id=p.id) then return p_id; end if;
 if p_due is null or p_due<public.financial_date() then raise exception 'Escolha uma fatura atual ou futura'; end if;
 total=public.invoice_total(p.card_id,to_char(p_due,'YYYY-MM'),u);
 select coalesce(sum(amount_cents),0) into paid from public.card_payments where card_id=p.card_id and user_id=u and due_month=to_char(p_due,'YYYY-MM');
 if total+p_amount<paid then raise exception 'Crédito supera o saldo da fatura escolhida'; end if;
 insert into public.card_adjustments(id,user_id,card_id,purchase_id,due_month,due_date,amount_cents,description)
 values(p_id,u,p.card_id,p.id,to_char(p_due,'YYYY-MM'),p_due,p_amount,p_description);
 return p_id;
end $$;
revoke all on function public.correct_card_purchase(uuid,jsonb,boolean),public.adjust_card_purchase(uuid,uuid,date,bigint,text) from public,anon;
grant execute on function public.correct_card_purchase(uuid,jsonb,boolean),public.adjust_card_purchase(uuid,uuid,date,bigint,text) to authenticated;
notify pgrst,'reload schema';
commit;
