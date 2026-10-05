begin;
-- Capability only: no existing row is modified by applying this migration.
create function public.delete_card_purchase(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); p public.card_purchases; x record; affected_cards uuid[];
begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 -- Same lock order as corrections/payments; prevents a payment racing deletion.
 perform 1 from public.credit_cards where user_id=u order by id for update;
 select * into p from public.card_purchases where id=p_id and user_id=u for update;
 if not found then raise exception 'Compra não encontrada'; end if;
 select array_agg(card_id) into affected_cards from (
  select p.card_id card_id union select card_id from public.card_adjustments where purchase_id=p.id and user_id=u
 ) affected;
 if exists(select 1 from public.card_payments pay where pay.user_id=u and (
   (pay.card_id=p.card_id and pay.due_month in(select to_char(p.first_due_date+n*interval '1 month','YYYY-MM') from generate_series(0,p.installments-1) n))
   or exists(select 1 from public.card_adjustments a where a.purchase_id=p.id and a.card_id=pay.card_id and a.due_month=pay.due_month))) then
  raise exception 'Esta compra está ligada a uma fatura com pagamento. Use um ajuste de fatura para corrigir.';
 end if;
 if p.cancelled_at is null then
  for x in select to_char(p.first_due_date+n*interval '1 month','YYYY-MM') month_key,
    p.amount_cents/p.installments+case when n<p.amount_cents%p.installments then 1 else 0 end amount
    from generate_series(0,p.installments-1) n loop
   if exists(select 1 from public.card_invoices where user_id=u and card_id=p.card_id and due_month=x.month_key and covered_at>=p.created_at and amount_cents<x.amount) then
    raise exception 'A fatura informada não comporta esta exclusão. Confira o valor da fatura antes de excluir.';
   end if;
   update public.card_invoices set amount_cents=amount_cents-x.amount
    where user_id=u and card_id=p.card_id and due_month=x.month_key and covered_at>=p.created_at;
  end loop;
 end if;
 delete from public.card_adjustments where purchase_id=p.id and user_id=u;
 delete from public.card_purchase_audit where purchase_id=p.id and user_id=u;
 delete from public.classification_reviews where source_table='card_purchases' and source_id=p.id and user_id=u;
 delete from public.card_purchases where id=p.id and user_id=u;
 -- Removing a positive adjustment must not leave another credit below zero.
 if exists(select 1 from (
   select card_id,due_month from public.card_invoices where card_id=any(affected_cards) and user_id=u
   union select card_id,due_month from public.card_adjustments where card_id=any(affected_cards) and user_id=u
  ) m where public.invoice_total(m.card_id,m.due_month,u)<0) then
  raise exception 'Há outros ajustes nesta fatura. Corrija os ajustes antes de excluir a compra.';
 end if;
end $$;

create function public.delete_goal(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();
begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 perform 1 from public.goals where id=p_id and user_id=u for update;
 if not found then raise exception 'Meta não encontrada'; end if;
 -- Reserve links only configure the goal: the linked accounts/investments survive.
 delete from public.reserve_account_links where goal_id=p_id and user_id=u;
 delete from public.goal_contributions where goal_id=p_id and user_id=u;
 delete from public.goals where id=p_id and user_id=u;
end $$;
revoke delete on public.goals from authenticated;

create function public.delete_investment(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid(); i public.investments; ids uuid[];
begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 select * into i from public.investments where id=p_id and user_id=u for update;
 if not found then raise exception 'Investimento não encontrado'; end if;
 if i.source_account_id is not null then
  raise exception 'Este investimento foi migrado de uma conta com histórico financeiro e não pode ser excluído diretamente.';
 end if;
 if exists(select 1 from public.investment_movements where investment_id=p_id and (user_id<>u or source_account_id is not null or source_transaction_id is not null))
   or exists(select 1 from public.accounts where investment_id=p_id) then
  raise exception 'Este investimento possui histórico vinculado que precisa ser preservado.';
 end if;
 perform 1 from public.accounts where user_id=u and id in(
  select t.account_id from public.transactions t join public.investment_movements m on m.transaction_id=t.id where m.investment_id=p_id
 ) order by id for update;
 perform 1 from public.investment_movements where investment_id=p_id for update;
 perform 1 from public.transactions where id in(select transaction_id from public.investment_movements where investment_id=p_id) order by id for update;
 -- Only the exact operational transaction created by record_investment_movement.
 if exists(select 1 from public.investment_movements m left join public.transactions t on t.id=m.transaction_id
  where m.investment_id=p_id and (
   (m.type='adjustment' and m.transaction_id is not null) or
   (m.type in ('contribution','withdrawal') and (t.id is null or t.id<>m.id or t.user_id<>u or t.type<>'adjustment'
    or t.status<>'realized' or t.payment_reference is not null or t.destination_account_id is not null
    or t.transaction_date<>m.date or t.amount_cents<>m.amount_cents
    or t.adjustment_delta_cents is distinct from case when m.type='contribution' then -m.amount_cents else m.amount_cents end))
  )) then raise exception 'Um movimento possui vínculo financeiro diferente do esperado. Exclusão bloqueada.'; end if;
 select array_agg(transaction_id) filter(where transaction_id is not null) into ids from public.investment_movements where investment_id=p_id and user_id=u;
 if exists(select 1 from public.recurring_occurrences where transaction_id=any(ids))
  or exists(select 1 from public.debt_payments where transaction_id=any(ids))
  or exists(select 1 from public.card_payments where transaction_id=any(ids))
  or exists(select 1 from public.investment_movements where investment_id<>p_id and source_transaction_id=any(ids)) then
  raise exception 'Os movimentos estão ligados a outros registros. Exclusão bloqueada.';
 end if;
 delete from public.investment_movements where investment_id=p_id and user_id=u;
 delete from public.classification_reviews where user_id=u and source_table='transactions' and source_id=any(ids);
 delete from public.transactions where id=any(ids) and user_id=u;
 delete from public.investments where id=p_id and user_id=u;
end $$;

create function public.delete_unused_record(p_kind text,p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid=auth.uid();
begin
 if u is null then raise exception 'Autenticação necessária'; end if;
 if p_kind='card' then
  perform 1 from public.credit_cards where id=p_id and user_id=u for update;
  if not found then raise exception 'Cartão não encontrado'; end if;
  if exists(select 1 from public.card_purchases where card_id=p_id) or exists(select 1 from public.card_payments where card_id=p_id)
   or exists(select 1 from public.card_invoices where card_id=p_id) or exists(select 1 from public.card_adjustments where card_id=p_id) then
   raise exception 'Este cartão possui compras, faturas ou pagamentos. Arquive para preservar o histórico.';
  end if;
  delete from public.credit_cards where id=p_id and user_id=u;
 elsif p_kind='debt' then
  perform 1 from public.debts where id=p_id and user_id=u for update;
  if not found then raise exception 'Dívida não encontrada'; end if;
  if exists(select 1 from public.debt_payments where debt_id=p_id) then raise exception 'Esta dívida possui pagamentos e não pode ser excluída.'; end if;
  delete from public.classification_reviews where user_id=u and source_table='debts' and source_id=p_id;
  delete from public.debts where id=p_id and user_id=u;
 elsif p_kind='recurring' then
  perform 1 from public.recurring_items where id=p_id and user_id=u for update;
  if not found then raise exception 'Recorrência não encontrada'; end if;
  if exists(select 1 from public.recurring_occurrences where recurring_item_id=p_id) then raise exception 'Esta recorrência possui ocorrências. Pause para preservar o histórico.'; end if;
  delete from public.recurring_items where id=p_id and user_id=u;
 else raise exception 'Tipo de registro inválido';
 end if;
end $$;
revoke all on function public.delete_card_purchase(uuid),public.delete_goal(uuid),public.delete_investment(uuid),public.delete_unused_record(text,uuid) from public,anon;
grant execute on function public.delete_card_purchase(uuid),public.delete_goal(uuid),public.delete_investment(uuid),public.delete_unused_record(text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
