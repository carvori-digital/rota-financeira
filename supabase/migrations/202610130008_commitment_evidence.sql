begin;
-- Structure only: no UPDATE/backfill of historical financial records.
alter table public.transactions add column financial_commitment boolean not null default false;
alter table public.transactions add column commitment_due_date date;
alter table public.debt_payments add column obligation_amount_cents bigint check(obligation_amount_cents>0);
create function public.capture_commitment_evidence() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='transactions' then
  if tg_op='INSERT' then
   if new.type='expense' and (new.status='pending' or new.transaction_date>public.financial_date() or new.financial_commitment) then
    new.financial_commitment=true;new.commitment_due_date=coalesce(new.commitment_due_date,new.transaction_date);
   else new.financial_commitment=false;new.commitment_due_date=null;end if;
  elsif old.type='expense' and old.status='pending' and new.status='realized' then
   new.financial_commitment=true;new.commitment_due_date=coalesce(old.commitment_due_date,old.transaction_date);
  elsif old.financial_commitment and new.type='expense' then
   new.financial_commitment=true;
   if old.status='realized' then new.commitment_due_date=old.commitment_due_date;end if;
  end if;
 else
  -- pay_debt inserts before changing the debt; capture the exact current
  -- installment (including final smaller installments) without guessing later.
  select least(d.installment_amount_cents,d.remaining_amount_cents+d.installment_paid_cents)
   into new.obligation_amount_cents from public.debts d where d.id=new.debt_id and d.user_id=new.user_id and d.next_due_date=new.scheduled_date;
 end if;
 return new;
end $$;
create trigger commitment_evidence before insert or update on public.transactions for each row execute function public.capture_commitment_evidence();
create trigger debt_obligation_evidence before insert on public.debt_payments for each row execute function public.capture_commitment_evidence();
notify pgrst,'reload schema';
commit;
