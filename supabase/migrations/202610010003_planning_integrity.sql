begin;
-- Additional integrity checks; neither historical migration nor existing rows are rewritten.
alter table public.debts add constraint debt_partial_installment_valid check (
 (installment_amount_cents is null and installment_paid_cents=0) or
 (installment_amount_cents is not null and installment_paid_cents<installment_amount_cents)
);
-- Registered purchases preserve the invoice/payment ledger. Archive cards instead.
revoke delete on public.card_purchases from authenticated;
alter table public.card_invoices add column request_id uuid;

-- A debt imported without a schedule can be scheduled before its first payment.
-- Once payments exist, their calendar and outstanding balance stay authoritative.
create or replace function public.guard_debt() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.due_anchor_day=extract(day from new.next_due_date);new.installment_paid_cents=0;
 elsif current_user='authenticated' then
  if (new.remaining_amount_cents,new.original_amount_cents,new.installment_paid_cents) is distinct from (old.remaining_amount_cents,old.original_amount_cents,old.installment_paid_cents) then
   raise exception 'Saldo da dívida é alterado pelos pagamentos';
  end if;
  if (new.next_due_date,new.due_anchor_day) is distinct from (old.next_due_date,old.due_anchor_day) then
   if exists(select 1 from public.debt_payments where debt_id=old.id and user_id=old.user_id) then
    raise exception 'Calendário da dívida é alterado pelos pagamentos';
   end if;
   new.due_anchor_day=extract(day from new.next_due_date);
  end if;
 end if;
 return new;
end $$;

-- A retry of the same invoice request must not move the coverage timestamp and
-- accidentally hide purchases recorded after the original successful request.
create or replace function public.set_card_invoice(p_id uuid,p_card uuid,p_amount bigint,p_due date,p_description text)
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
 on conflict(card_id,user_id,due_month) do update set request_id=excluded.request_id,amount_cents=excluded.amount_cents,due_date=excluded.due_date,description=excluded.description,covered_at=now()
 returning id into result;
 return result;
end $$;
commit;
