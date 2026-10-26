begin;
-- Forecasts are read models. Only explicit confirmation creates a card purchase;
-- no scheduler, bank transaction or real-user seed is installed by this migration.
create table public.card_subscriptions (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id),
 start_date date not null, billing_day integer not null check(billing_day between 1 and 31),
 frequency text not null default 'monthly' check(frequency='monthly'),
 created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.card_subscription_versions (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id), subscription_id uuid not null,
 revision integer not null check(revision>0), effective_month date not null check(extract(day from effective_month)=1),
 name text not null check(length(trim(name)) between 1 and 80), card_id uuid not null, category_id uuid not null,
 category_type text not null default 'expense' check(category_type='expense'),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000),
 closing_day integer not null check(closing_day between 1 and 31), due_day integer not null check(due_day between 1 and 31),
 status text not null check(status in ('active','paused','cancelled')), end_date date,
 created_at timestamptz not null default now(), unique(subscription_id,user_id,revision),
 foreign key(subscription_id,user_id) references public.card_subscriptions(id,user_id),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id),
 foreign key(category_id,user_id,category_type) references public.categories(id,user_id,type)
);
alter table public.card_purchases add constraint card_purchase_owner_unique unique(id,user_id);
alter table public.card_invoices add constraint card_invoice_owner_unique unique(id,user_id);
create table public.card_subscription_occurrences (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id), subscription_id uuid not null,
 charge_month date not null check(extract(day from charge_month)=1),
 charge_date date not null, due_date date not null, card_id uuid not null, category_id uuid not null,
 category_type text not null default 'expense' check(category_type='expense'), name text not null,
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000),
 status text not null check(status in ('planned','confirmed','skipped')), purchase_id uuid,
 covered_invoice_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(subscription_id,user_id,charge_month), unique(purchase_id,user_id),
 check((status='confirmed')=(purchase_id is not null)), check(covered_invoice_id is null or status='confirmed'),
 foreign key(subscription_id,user_id) references public.card_subscriptions(id,user_id),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id),
 foreign key(category_id,user_id,category_type) references public.categories(id,user_id,type),
 foreign key(purchase_id,user_id) references public.card_purchases(id,user_id),
 foreign key(covered_invoice_id,user_id) references public.card_invoices(id,user_id)
);
do $$ declare t text; begin
 foreach t in array array['card_subscriptions','card_subscription_versions','card_subscription_occurrences'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_select on public.%I for select to authenticated using(user_id=(select auth.uid()))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(user_id)',t);
  execute format('create trigger financial_audit after insert or update or delete on public.%I for each row execute function public.capture_financial_audit()',t);
 end loop;
end $$;
create trigger protect_row before update on public.card_subscription_occurrences for each row execute function public.protect_financial_row();

create function public.card_charge_due(p_date date,p_closing integer,p_due integer) returns date language sql immutable set search_path='' as $$
 select public.month_day((date_trunc('month',p_date)+
  (case when p_date>public.month_day(p_date,p_closing) then 1 else 0 end + case when p_due<=p_closing then 1 else 0 end)*interval '1 month')::date,p_due)
$$;
-- Resolve an immutable monthly version and, if present, the explicit override.
create function public.card_subscription_terms(p_subscription uuid,p_month date,p_user uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare s public.card_subscriptions; v public.card_subscription_versions; o public.card_subscription_occurrences; d date;
begin
 if p_month is null or extract(day from p_month)<>1 then raise exception 'Informe o mês de cobrança';end if;
 select * into s from public.card_subscriptions where id=p_subscription and user_id=p_user;
 if not found then return null;end if;
 select * into o from public.card_subscription_occurrences where subscription_id=s.id and user_id=p_user and charge_month=p_month;
 if o.status in ('confirmed','skipped') then return to_jsonb(o);end if;
 select * into v from public.card_subscription_versions where subscription_id=s.id and user_id=p_user and effective_month<=p_month order by effective_month desc,revision desc limit 1;
 d=public.month_day(p_month,s.billing_day);
 if v.id is null or v.status<>'active' or d<s.start_date or (v.end_date is not null and d>v.end_date) then return null;end if;
 return jsonb_build_object('subscription_id',s.id,'charge_month',p_month,'charge_date',d,
  'due_date',public.card_charge_due(d,v.closing_day,v.due_day),'card_id',v.card_id,'category_id',v.category_id,
  'name',v.name,'amount_cents',coalesce(o.amount_cents,v.amount_cents),'status','planned','purchase_id',null,'covered_invoice_id',null);
end $$;
revoke all on function public.card_subscription_terms(uuid,date,uuid) from public,anon,authenticated;

create function public.save_card_subscription(p_request uuid,p_subscription uuid,p_expected uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();s public.card_subscriptions;v public.card_subscription_versions;c public.credit_cards;next_revision integer;
 m date=(p_payload->>'effective_month')::date;result uuid;payload jsonb=jsonb_build_object('subscription',p_subscription,'expected',p_expected,'terms',p_payload);
begin
 result=public.financial_request_result(p_request,'save_card_subscription',payload);if result is not null then return result;end if;
 -- All card operations take card locks before entity locks, in UUID order.
 perform 1 from public.credit_cards where user_id=u order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_subscription::text,15));
 select * into s from public.card_subscriptions where id=p_subscription and user_id=u for update;
 if not found then
  if p_expected is not null then raise exception 'Assinatura não encontrada';end if;
  insert into public.card_subscriptions(id,user_id,start_date,billing_day) values(p_subscription,u,(p_payload->>'start_date')::date,(p_payload->>'billing_day')::integer) returning * into s;
  m=date_trunc('month',s.start_date)::date;
 else
  select * into v from public.card_subscription_versions where subscription_id=s.id and user_id=u order by effective_month desc,revision desc limit 1;
  if p_expected is distinct from v.id then raise exception 'Assinatura alterada em outra sessão; atualize os dados';end if;
  if v.status='cancelled' then raise exception 'Assinatura cancelada; crie uma nova para retomar';end if;
  if m is null or m<date_trunc('month',public.financial_date())+interval '1 month' or m<v.effective_month then raise exception 'Alterações devem valer para meses futuros, sem reescrever o histórico';end if;
 end if;
 if p_payload->>'status' is null or (p_payload->>'end_date')::date<s.start_date then raise exception 'Status ou data final inválidos';end if;
 select * into c from public.credit_cards where id=(p_payload->>'card_id')::uuid and user_id=u;
 if not found or (not c.active and (p_payload->>'status'='active')) then raise exception 'Escolha um cartão ativo';end if;
 select coalesce(max(revision),0)+1 into next_revision from public.card_subscription_versions where subscription_id=s.id and user_id=u;
 insert into public.card_subscription_versions(id,user_id,subscription_id,revision,effective_month,name,card_id,category_id,amount_cents,closing_day,due_day,status,end_date)
 values(p_request,u,s.id,next_revision,m,trim(p_payload->>'name'),c.id,(p_payload->>'category_id')::uuid,(p_payload->>'amount_cents')::bigint,c.closing_day,c.due_day,p_payload->>'status',(p_payload->>'end_date')::date);
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_request,u,'save_card_subscription',payload,s.id);return s.id;
end $$;

create function public.resolve_card_subscription(p_request uuid,p_subscription uuid,p_month date,p_action text,p_amount bigint default null,p_purchase uuid default null,p_coverage text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();o public.card_subscription_occurrences;cfg jsonb; p public.card_purchases;b public.card_invoices;
 result uuid;amount bigint;covered uuid;payload jsonb=jsonb_build_object('subscription',p_subscription,'month',p_month,'action',p_action,'amount',p_amount,'purchase',p_purchase,'coverage',p_coverage);
begin
 result=public.financial_request_result(p_request,'resolve_card_subscription',payload);if result is not null then return result;end if;
 perform 1 from public.credit_cards where user_id=u order by id for update;
 perform 1 from public.card_subscriptions where id=p_subscription and user_id=u for update;
 if not found then raise exception 'Assinatura não encontrada';end if;
 cfg=public.card_subscription_terms(p_subscription,p_month,u);
 if cfg is null then raise exception 'Não há cobrança ativa neste mês';end if;
 select * into o from public.card_subscription_occurrences where subscription_id=p_subscription and user_id=u and charge_month=p_month for update;
 if o.status='confirmed' then
  if p_action not in ('confirm','link') or (p_purchase is not null and o.purchase_id<>p_purchase) or (p_amount is not null and o.amount_cents<>p_amount) then raise exception 'Cobrança já confirmada; histórico protegido';end if;
  result=o.id;
 elsif o.status='skipped' then raise exception 'Cobrança dispensada; histórico preservado';
 else
  amount=coalesce(p_amount,(cfg->>'amount_cents')::bigint);
  if amount is null or amount not between 1 and 1000000000000 then raise exception 'Valor inválido';end if;
  if p_action not in ('adjust','skip','confirm','link') or p_action is null then raise exception 'Ação inválida';end if;
  if p_action in ('confirm','link') then
   if (cfg->>'charge_date')::date>public.financial_date() then raise exception 'Confirme a cobrança somente após sua data';end if;
   select * into b from public.card_invoices where card_id=(cfg->>'card_id')::uuid and user_id=u and due_month=to_char((cfg->>'due_date')::date,'YYYY-MM');
   if p_action='link' then
    select * into p from public.card_purchases where id=p_purchase and user_id=u for update;
    if not found or p.cancelled_at is not null or p.installments<>1 or p.card_id<>(cfg->>'card_id')::uuid or to_char(p.first_due_date,'YYYY-MM')<>to_char((cfg->>'due_date')::date,'YYYY-MM') or p.purchase_date>public.financial_date() then raise exception 'Escolha uma compra avulsa do mesmo cartão e competência';end if;
    if exists(select 1 from public.card_subscription_occurrences where purchase_id=p.id and user_id=u) then raise exception 'Compra já vinculada a uma assinatura';end if;
    amount=p.amount_cents;
    if b.id is not null and p.created_at<=b.covered_at then covered=b.id;end if;
    cfg=cfg||jsonb_build_object('charge_date',p.purchase_date,'due_date',p.first_due_date,'category_id',p.category_id,'name',p.description);
   else
    if p_purchase is not null then raise exception 'Para vincular uma compra use a ação de vínculo';end if;
    if exists(select 1 from public.card_purchases where id=p_request) then raise exception 'Para compra existente use o vínculo explícito';end if;
    if b.id is not null then
     if p_coverage is null or p_coverage not in ('included','additional') then raise exception 'Informe se a cobrança já está incluída na fatura manual';end if;
     if p_coverage='included' then covered=b.id;end if;
    end if;
    perform public.create_card_purchase(p_request,jsonb_build_object('card_id',cfg->>'card_id','category_id',cfg->>'category_id','amount_cents',amount,'description',cfg->>'name','purchase_date',cfg->>'charge_date','installments',1,'first_due_date',cfg->>'due_date'));
    select * into p from public.card_purchases where id=p_request and user_id=u;
   end if;
  elsif p_purchase is not null or p_coverage is not null then raise exception 'Parâmetros incompatíveis com a ação';
  end if;
  insert into public.card_subscription_occurrences(id,user_id,subscription_id,charge_month,charge_date,due_date,card_id,category_id,name,amount_cents,status,purchase_id,covered_invoice_id)
  values(coalesce(o.id,p_request),u,p_subscription,p_month,(cfg->>'charge_date')::date,(cfg->>'due_date')::date,(cfg->>'card_id')::uuid,(cfg->>'category_id')::uuid,cfg->>'name',amount,
   case p_action when 'adjust' then 'planned' when 'skip' then 'skipped' else 'confirmed' end,p.id,covered)
  on conflict(subscription_id,user_id,charge_month) do update set charge_date=excluded.charge_date,due_date=excluded.due_date,card_id=excluded.card_id,category_id=excluded.category_id,name=excluded.name,amount_cents=excluded.amount_cents,status=excluded.status,purchase_id=excluded.purchase_id,covered_invoice_id=excluded.covered_invoice_id
  returning id into result;
 end if;
 insert into public.financial_requests(id,user_id,operation,payload,result) values(p_request,u,'resolve_card_subscription',payload,result);return result;
end $$;
revoke all on function public.save_card_subscription(uuid,uuid,uuid,jsonb),public.resolve_card_subscription(uuid,uuid,date,text,bigint,uuid,text) from public,anon;
grant execute on function public.save_card_subscription(uuid,uuid,uuid,jsonb),public.resolve_card_subscription(uuid,uuid,date,text,bigint,uuid,text) to authenticated;

-- Editing a card calendar is an explicit configuration change. Snapshot it for
-- future charge months, preserving past terms AND already scheduled price/card
-- changes. No occurrence or purchase is created by this trigger.
create function public.version_subscription_card_calendar() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.card_subscriptions;v public.card_subscription_versions;n integer;
 next_month date=(date_trunc('month',public.financial_date())+interval '1 month')::date;
begin
 if (new.closing_day,new.due_day) is not distinct from (old.closing_day,old.due_day) then return new;end if;
 for s in select sub.* from public.card_subscriptions sub where sub.user_id=new.user_id and exists(select 1 from public.card_subscription_versions ver where ver.subscription_id=sub.id and ver.user_id=sub.user_id and ver.card_id=new.id) order by sub.id for update loop
  select max(revision) into n from public.card_subscription_versions where subscription_id=s.id and user_id=s.user_id;
  for v in select distinct on (greatest(effective_month,next_month)) * from public.card_subscription_versions
   where subscription_id=s.id and user_id=s.user_id order by greatest(effective_month,next_month),effective_month desc,revision desc loop
   if v.card_id=new.id and v.status<>'cancelled' and (v.closing_day,v.due_day) is distinct from (new.closing_day,new.due_day) then
    n=n+1;
    insert into public.card_subscription_versions(id,user_id,subscription_id,revision,effective_month,name,card_id,category_id,amount_cents,closing_day,due_day,status,end_date)
     values(gen_random_uuid(),s.user_id,s.id,n,greatest(v.effective_month,next_month),v.name,v.card_id,v.category_id,v.amount_cents,new.closing_day,new.due_day,v.status,v.end_date);
   end if;
  end loop;
 end loop;return new;
end $$;
create trigger subscription_card_calendar after update of closing_day,due_day on public.credit_cards for each row execute function public.version_subscription_card_calendar();

-- Linking preserves purchase IDs and prevents generic corrections from silently
-- breaking the evidence. Paid corrections still use the existing adjustment RPC.
create function public.guard_subscription_purchase() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.card_subscription_occurrences where purchase_id=old.id and user_id=old.user_id) then
  if tg_op='DELETE' then raise exception 'Compra vinculada protegida; preserve o histórico da assinatura';end if;
  if (new.card_id,new.category_id,new.amount_cents,new.purchase_date,new.installments,new.first_due_date,new.cancelled_at) is distinct from (old.card_id,old.category_id,old.amount_cents,old.purchase_date,old.installments,old.first_due_date,old.cancelled_at) then raise exception 'Compra vinculada protegida; use ajuste rastreável de fatura';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger subscription_purchase before update or delete on public.card_purchases for each row execute function public.guard_subscription_purchase();
-- The settled invoice model stays authoritative. Forecasts are never payable.
create or replace function public.invoice_total(p_card uuid,p_month text,p_user uuid) returns bigint language sql stable set search_path='' as $$
 select coalesce((select amount_cents from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),0)+coalesce((
 select sum(p.amount_cents/p.installments+case when n.i<p.amount_cents%p.installments then 1 else 0 end)
 from public.card_purchases p cross join lateral generate_series(0,p.installments-1) n(i)
 where p.cancelled_at is null and p.card_id=p_card and p.user_id=p_user and to_char(p.first_due_date+n.i*interval '1 month','YYYY-MM')=p_month
 and p.created_at>coalesce((select covered_at from public.card_invoices where card_id=p_card and user_id=p_user and due_month=p_month),'-infinity'::timestamptz)
 and not exists(select 1 from public.card_subscription_occurrences o join public.card_invoices b on b.id=o.covered_invoice_id and b.user_id=o.user_id where o.purchase_id=p.id and o.user_id=p_user and b.card_id=p_card and b.due_month=p_month)),0)
 +coalesce((select sum(amount_cents) from public.card_adjustments where card_id=p_card and user_id=p_user and due_month=p_month),0)
$$;
alter function public.export_financial_snapshot() rename to export_financial_snapshot_before_subscriptions;
revoke all on function public.export_financial_snapshot_before_subscriptions() from public,anon;
create function public.export_financial_snapshot() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb=public.export_financial_snapshot_before_subscriptions();t text;rows jsonb;
begin
 foreach t in array array['card_subscriptions','card_subscription_versions','card_subscription_occurrences'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]''::jsonb) from public.%I r where r.user_id=$1',t) into rows using auth.uid();
  result=jsonb_set(result,array['data',t],rows);result=jsonb_set(result,array['counts',t],to_jsonb(jsonb_array_length(rows)));
 end loop;return result;
end $$;
revoke all on function public.export_financial_snapshot() from public,anon;grant execute on function public.export_financial_snapshot() to authenticated;
notify pgrst,'reload schema';
commit;
