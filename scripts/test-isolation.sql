-- Run only on the confirmed project via:
-- npx supabase db query --linked --file scripts/test-isolation.sql
-- All fixtures, including temporary Auth users, are rolled back.
begin;
create temporary table rf_test_ids (
 user_id uuid default gen_random_uuid(), account_id uuid default gen_random_uuid(),
 destination_id uuid default gen_random_uuid(), category_id uuid default gen_random_uuid(),
 transaction_id uuid default gen_random_uuid(), goal_id uuid default gen_random_uuid(),
 contribution_id uuid default gen_random_uuid()
);
insert into rf_test_ids default values;
insert into rf_test_ids default values;
insert into auth.users(id) select user_id from rf_test_ids;
insert into public.accounts(id,user_id,name,type)
 select account_id,user_id,'CLI isolation fixture','checking' from rf_test_ids
 union all select destination_id,user_id,'CLI isolation destination','wallet' from rf_test_ids;
insert into public.categories(id,user_id,name,type)
 select category_id,user_id,'CLI isolation fixture','expense' from rf_test_ids;
insert into public.transactions(id,user_id,account_id,category_id,type,amount_cents,transaction_date)
 select transaction_id,user_id,account_id,category_id,'expense',100,current_date from rf_test_ids;
insert into public.goals(id,user_id,name,target_amount_cents)
 select goal_id,user_id,'CLI isolation fixture',1000 from rf_test_ids;
insert into public.goal_contributions(id,user_id,goal_id,amount_cents,contribution_date)
 select contribution_id,user_id,goal_id,100,current_date from rf_test_ids;
create temporary table rf_test_records(table_name text, owner uuid, id uuid, row_data jsonb);
insert into rf_test_records
 select 'accounts',a.user_id,a.id,to_jsonb(a) from public.accounts a join rf_test_ids f on f.account_id=a.id
 union all select 'categories',a.user_id,a.id,to_jsonb(a) from public.categories a join rf_test_ids f on f.category_id=a.id
 union all select 'transactions',a.user_id,a.id,to_jsonb(a) from public.transactions a join rf_test_ids f on f.transaction_id=a.id
 union all select 'goals',a.user_id,a.id,to_jsonb(a) from public.goals a join rf_test_ids f on f.goal_id=a.id
 union all select 'goal_contributions',a.user_id,a.id,to_jsonb(a) from public.goal_contributions a join rf_test_ids f on f.contribution_id=a.id;
grant select on rf_test_ids,rf_test_records to authenticated;
set local role authenticated;
do $$
declare actor record; victim record; item record; count_rows bigint; affected bigint; payload jsonb; transfer_id uuid;
begin
 for actor in select * from rf_test_ids loop
  perform set_config('request.jwt.claim.sub',actor.user_id::text,true);
  if auth.uid() is distinct from actor.user_id then raise exception 'JWT fixture mismatch'; end if;
  select * into strict victim from rf_test_ids where user_id <> actor.user_id;
  for item in select * from rf_test_records where owner = victim.user_id loop
   execute format('select count(*) from public.%I where user_id=$1',item.table_name) into count_rows using victim.user_id;
   if count_rows <> 0 then raise exception 'Cross-user list permitted: %',item.table_name; end if;
   execute format('select count(*) from public.%I where id=$1',item.table_name) into count_rows using item.id;
   if count_rows <> 0 then raise exception 'Cross-user read permitted: %',item.table_name; end if;
   execute format('update public.%I set user_id=$1 where id=$2',item.table_name) using actor.user_id,item.id;
   get diagnostics affected = row_count;
   if affected <> 0 then raise exception 'Cross-user update permitted: %',item.table_name; end if;
   execute format('delete from public.%I where id=$1',item.table_name) using item.id;
   get diagnostics affected = row_count;
   if affected <> 0 then raise exception 'Cross-user delete permitted: %',item.table_name; end if;
   payload = item.row_data || jsonb_build_object('id',gen_random_uuid());
   begin
    execute format('insert into public.%I select (jsonb_populate_record(null::public.%I,$1)).*',item.table_name,item.table_name) using payload;
    raise exception 'Forged owner insert permitted: %',item.table_name;
   exception when insufficient_privilege then null;
   end;
  end loop;
  begin
   insert into public.transactions(account_id,category_id,type,amount_cents,transaction_date)
    values(victim.account_id,actor.category_id,'expense',100,current_date);
   raise exception 'Cross-user account reference permitted';
  exception when foreign_key_violation then null; end;
  begin
   insert into public.transactions(account_id,category_id,type,amount_cents,transaction_date)
    values(actor.account_id,victim.category_id,'expense',100,current_date);
   raise exception 'Cross-user category reference permitted';
  exception when foreign_key_violation then null; end;
  begin
   insert into public.transactions(account_id,destination_account_id,type,amount_cents,transaction_date)
    values(actor.account_id,victim.destination_id,'transfer',100,current_date);
   raise exception 'Cross-user transfer permitted';
  exception when foreign_key_violation then null; end;
  begin
   insert into public.goal_contributions(goal_id,amount_cents,contribution_date)
    values(victim.goal_id,100,current_date);
   raise exception 'Cross-user goal reference permitted';
  exception when foreign_key_violation then null; end;
  -- Verify that permitted writes work under the authenticated role, too.
  insert into public.transactions(account_id,destination_account_id,type,amount_cents,transaction_date)
   values(actor.account_id,actor.destination_id,'transfer',300,current_date) returning id into transfer_id;
  update public.transactions set amount_cents=400 where id=transfer_id;
  if not exists(select 1 from public.transactions where id=transfer_id and amount_cents=400 and user_id=actor.user_id) then
   raise exception 'Own transfer write failed';
  end if;
  delete from public.transactions where id=transfer_id;
  if exists(select 1 from public.transactions where id=transfer_id) then raise exception 'Own transfer delete failed'; end if;
 end loop;
end $$;
reset role;
rollback;
select 'PASS: RLS A↔B across all five tables; related ownership; own atomic transfer; all fixtures rolled back' as result;
