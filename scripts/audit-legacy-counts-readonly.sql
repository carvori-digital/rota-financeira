-- Authorized diagnostic only: aggregate counts, no identities or money values.
-- Works before 013 and after 014. Never infer missing historical obligations.
begin transaction read only;
set local statement_timeout = '15s';
select jsonb_build_object(
 'read_only',current_setting('transaction_read_only'),
 'postgres_version',current_setting('server_version'),
 'has_013',exists(select 1 from information_schema.columns where table_schema='public' and table_name='recurring_occurrences' and column_name='amount_cents'),
 'has_014',to_regclass('public.financial_requests') is not null,
 'inventory',jsonb_build_object(
   'transactions',(select count(*) from public.transactions),
   'recurring_rules',(select count(*) from public.recurring_items),
   'occurrences',(select count(*) from public.recurring_occurrences),
   'debt_payments',(select count(*) from public.debt_payments),
   'card_payments',(select count(*) from public.card_payments)),
 'recorded_cash_review',coalesce((select jsonb_agg(s) from (
   select t.status as transaction_status,t.type as transaction_type,
          t.id is not null as transaction_present,
          o.due_date>public.financial_date() as future_competence,
          t.transaction_date>public.financial_date() as future_cash_date,
          count(*) as occurrences
   from public.recurring_occurrences o
   left join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id
   where o.status='recorded' and (t.id is null or t.status<>'realized' or t.type not in ('expense','income'))
   group by t.status,t.type,t.id is not null,
            o.due_date>public.financial_date(),t.transaction_date>public.financial_date()
 ) s),'[]'::jsonb),
 'signals',jsonb_build_object(
   'debt_payment_without_matching_cash',(select count(*) from public.debt_payments p left join public.transactions t on t.id=p.transaction_id and t.user_id=p.user_id where t.id is null or t.type<>'expense' or t.status<>'realized' or t.amount_cents<>p.amount_cents or t.transaction_date<>p.payment_date),
   'card_payment_without_matching_cash',(select count(*) from public.card_payments p left join public.transactions t on t.id=p.transaction_id and t.user_id=p.user_id where t.id is null or t.type<>'card_payment' or t.status<>'realized' or t.amount_cents<>p.amount_cents or t.transaction_date<>p.payment_date),
   'legacy_multi_installment_evidence',(select count(*) from public.debt_payments p where p.obligation_amount_cents is not null and p.amount_cents>p.obligation_amount_cents),
   'debt_payment_without_original_obligation',(select count(*) from public.debt_payments p where p.obligation_amount_cents is null),
   'recorded_occurrence_without_captured_amount',(select count(*) from public.recurring_occurrences o where o.status='recorded' and to_jsonb(o)->>'amount_cents' is null),
   'occurrence_without_frozen_terms',(select count(*) from public.recurring_occurrences o where to_jsonb(o)->>'terms' is null),
   'recorded_occurrence_without_matching_cash',(select count(*) from public.recurring_occurrences o left join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id where o.status='recorded' and (t.id is null or t.status<>'realized' or t.type not in ('expense','income'))),
   'rule_differs_from_recorded_fact',(select count(*) from public.recurring_occurrences o join public.recurring_items r on r.id=o.recurring_item_id and r.user_id=o.user_id join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id where o.status='recorded' and (r.type,r.account_id,r.category_id) is distinct from (t.type,t.account_id,t.category_id)),
   'stored_obligation_outside_current_calendar',(select count(*) from public.recurring_occurrences o join public.recurring_items r on r.id=o.recurring_item_id and r.user_id=o.user_id where o.status='planned' and (not r.active or not public.is_recurring_date(r,o.due_date))),
   'recorded_terms_incompatible_with_014_owner_fks',(select count(*) from public.recurring_occurrences o join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id left join public.accounts a on a.id=t.account_id and a.user_id=o.user_id left join public.categories c on c.id=t.category_id and c.user_id=o.user_id and c.type=t.type where a.id is null or (t.category_id is not null and c.id is null)),
   'future_card_purchase',(select count(*) from public.card_purchases where cancelled_at is null and purchase_date>public.financial_date())
 )) as diagnostic;
rollback;
