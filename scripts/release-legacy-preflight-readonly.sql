-- Release preflight: counts and opaque fingerprints only; no repairs or exports.
begin isolation level repeatable read read only;
set local statement_timeout='15s';
select jsonb_build_object(
 'read_only',current_setting('transaction_read_only'),
 'reference_date',public.financial_date(),
 'migration_versions',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'ledger_count',(select count(*) from public.transactions),
 'ledger_fingerprint',(select md5(string_agg(md5(to_jsonb(t)::text),',' order by t.id)) from public.transactions t),
 'opening_balance_fingerprint',(select md5(string_agg(md5(jsonb_build_array(id,user_id,initial_balance_cents)::text),',' order by id)) from public.accounts),
 'debt_state_fingerprint',(select md5(string_agg(md5(to_jsonb(d)::text),',' order by d.id)) from public.debts d),
 'recorded_terms_backfill_invalid_fk',(select count(*) from public.recurring_occurrences o join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id left join public.accounts a on a.id=t.account_id and a.user_id=o.user_id left join public.categories c on c.id=t.category_id and c.user_id=o.user_id and c.type=t.type where a.id is null or t.type not in ('income','expense') or (t.category_id is not null and c.id is null)),
 'recurring_missing_linked_transaction',(select count(*) from public.recurring_occurrences o left join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id where o.status='recorded' and t.id is null),
 'recorded_realized_amount_comparison',(select jsonb_build_object('less_than_current_rule',count(*) filter(where t.amount_cents<r.amount_cents),'equal_current_rule',count(*) filter(where t.amount_cents=r.amount_cents),'greater_than_current_rule',count(*) filter(where t.amount_cents>r.amount_cents)) from public.recurring_occurrences o join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id join public.recurring_items r on r.id=o.recurring_item_id and r.user_id=o.user_id where o.status='recorded' and t.status='realized'),
 'legacy_debt_payments_without_obligation',(select count(*) from public.debt_payments where obligation_amount_cents is null),
 'legacy_debt_payment_without_cash',(select count(*) from public.debt_payments p left join public.transactions t on t.id=p.transaction_id and t.user_id=p.user_id where t.id is null or t.status<>'realized' or t.type<>'expense' or t.amount_cents<>p.amount_cents or t.transaction_date<>p.payment_date),
 'active_debt_invalid_next_installment',(select count(*) from public.debts where active and remaining_amount_cents>0 and installment_amount_cents is not null and next_due_date is not null and installment_paid_cents>=installment_amount_cents),
 'legacy_payments_on_active_remaining_debts',(select count(*) from public.debt_payments p join public.debts d on d.id=p.debt_id and d.user_id=p.user_id where p.obligation_amount_cents is null and d.active and d.remaining_amount_cents>0)
) preflight;
rollback;
