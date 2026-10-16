-- Metadata only. No financial rows, secrets, DDL, or repair commands.
begin transaction read only;
set local statement_timeout = '15s';
select jsonb_build_object(
 'read_only',current_setting('transaction_read_only'),
 'postgres_version',current_setting('server_version'),
 'migrations',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'columns',(select jsonb_agg(c order by table_name,ordinal_position) from (
select table_name,column_name,data_type,ordinal_position
from information_schema.columns
where table_schema='public' and table_name in
 ('recurring_occurrences','recurring_payments','debt_payments','debt_payment_allocations','transactions')
) c)) as metadata;
rollback;
