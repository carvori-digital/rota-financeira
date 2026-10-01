begin;
create table public.accounts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check (length(trim(name)) between 1 and 80), type text not null check (type in ('checking','wallet','savings','investment','other')),
 initial_balance_cents bigint not null default 0 check (abs(initial_balance_cents) <= 1000000000000), currency text not null default 'BRL' check (currency = 'BRL'),
 is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id)
);
create table public.categories (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check (length(trim(name)) between 1 and 80), type text not null check (type in ('income','expense')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id,type), unique(user_id,type,name)
);
create table public.transactions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 account_id uuid not null, destination_account_id uuid, category_id uuid, type text not null check(type in ('income','expense','transfer')),
 amount_cents bigint not null check(amount_cents > 0 and amount_cents <= 1000000000000), description text not null default '' check(length(description) <= 240),
 transaction_date date not null, is_recurring boolean not null default false, recurrence_frequency text check(recurrence_frequency in ('weekly','monthly','yearly')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict,
 foreign key(destination_account_id,user_id) references public.accounts(id,user_id) on delete restrict,
 foreign key(category_id,user_id,type) references public.categories(id,user_id,type) on delete restrict,
 check ((type = 'transfer' and destination_account_id is not null and destination_account_id <> account_id and category_id is null) or (type <> 'transfer' and destination_account_id is null and category_id is not null)),
 check ((is_recurring and recurrence_frequency is not null) or (not is_recurring and recurrence_frequency is null))
);
create table public.goals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), target_amount_cents bigint not null check(target_amount_cents > 0 and target_amount_cents <= 1000000000000),
 initial_amount_cents bigint not null default 0 check(initial_amount_cents between 0 and 1000000000000), target_date date, is_active boolean not null default true,
 essential_monthly_cents bigint check(essential_monthly_cents between 0 and 1000000000000), reserve_months integer check(reserve_months between 1 and 120),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id)
);
create table public.goal_contributions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 goal_id uuid not null, amount_cents bigint not null check(amount_cents > 0 and amount_cents <= 1000000000000), contribution_date date not null,
 description text not null default '' check(length(description) <= 240), created_at timestamptz not null default now(),
 foreign key(goal_id,user_id) references public.goals(id,user_id) on delete restrict
);
-- user_id defaults to the authenticated identity. RLS rejects forged identities.
-- Composite foreign keys enforce ownership and transaction/category type even outside the UI.
create function public.protect_financial_row() returns trigger language plpgsql set search_path = '' as $$
begin
 if new.user_id is distinct from old.user_id or new.id is distinct from old.id then raise exception 'Identidade do registro é imutável'; end if;
 new.created_at = old.created_at;
 if tg_table_name <> 'goal_contributions' then new.updated_at = now(); end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['accounts','categories','transactions','goals','goal_contributions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_select on public.%I for select to authenticated using (user_id = (select auth.uid()))',t);
  execute format('create policy own_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',t);
  execute format('create policy own_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',t);
  execute format('create policy own_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))',t);
  execute format('revoke all on public.%I from anon',t);
  execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  execute format('create index on public.%I(user_id)',t);
  execute format('create trigger protect_row before update on public.%I for each row execute function public.protect_financial_row()',t);
 end loop;
end $$;
create index on public.transactions(user_id,transaction_date desc);
create index on public.transactions(account_id);
create index on public.transactions(destination_account_id);
create index on public.transactions(category_id);
create index on public.goal_contributions(goal_id);
create function public.seed_user_categories() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.categories(user_id,name,type)
 select new.id, name, 'expense' from unnest(array['Alimentação','Transporte','Moradia','Saúde','Educação','Lazer','Assinaturas','Compras','Veículo','Outros']) name;
 insert into public.categories(user_id,name,type)
 select new.id, name, 'income' from unnest(array['Salário','Comissão','Renda extra','Reembolso','Outros']) name;
 return new;
end $$;
revoke all on function public.seed_user_categories() from public,anon,authenticated;
create trigger seed_categories after insert on auth.users for each row execute function public.seed_user_categories();
-- Backfill users created before this migration.
insert into public.categories(user_id,name,type)
select u.id,c.name,c.type from auth.users u cross join (values
 ('Alimentação','expense'),('Transporte','expense'),('Moradia','expense'),('Saúde','expense'),('Educação','expense'),('Lazer','expense'),('Assinaturas','expense'),('Compras','expense'),('Veículo','expense'),('Outros','expense'),
 ('Salário','income'),('Comissão','income'),('Renda extra','income'),('Reembolso','income'),('Outros','income')) c(name,type)
on conflict(user_id,type,name) do nothing;
commit;
