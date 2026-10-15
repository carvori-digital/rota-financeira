import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export function normalizeRows(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        v instanceof Date
          ? v
              .toISOString()
              .slice(0, k === "date" || k.endsWith("_date") ? 10 : 24)
          : v,
      ]),
    ),
  );
}
export async function financialFixture(through = "9999") {
  const db = new PGlite(),
    a = randomUUID(),
    b = randomUUID();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const as = async (u) => {
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub',$1,false)", [u]);
    await db.exec("set role authenticated");
  };
  await db.exec(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on sequences to anon,authenticated;",
  );
  for (const f of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql") && f < through)
    .sort())
    await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
  await db.exec(
    "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-15'$$",
  );
  await q("insert into auth.users values($1),($2)", [a, b]);
  await as(a);
  const cash = (
    await q(
      "insert into accounts(name,type,initial_balance_cents) values('Banco A','checking',1000000) returning id",
    )
  )[0].id;
  const other = (
    await q(
      "insert into accounts(name,type,initial_balance_cents) values('Banco B','checking',100000) returning id",
    )
  )[0].id;
  const cat = (
    await q("select id from categories where type='expense' limit 1")
  )[0].id;
  const income = (
    await q("select id from categories where type='income' limit 1")
  )[0].id;
  const rule = async (extra = {}) =>
    (
      await q(
        "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values($1,$2,$3,$4,$5,$6,$7) returning id",
        [
          extra.name ?? "Conta variável",
          extra.type ?? "expense",
          extra.amount ?? 10000,
          extra.account ?? cash,
          extra.category ?? cat,
          extra.frequency ?? "monthly",
          extra.start ?? "2026-10-13",
        ],
      )
    )[0].id;
  const bank = async (account = cash) =>
    Number(
      (
        await q(
          "select a.initial_balance_cents+coalesce((select sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end) from transactions t where t.status='realized' and t.transaction_date<=financial_date()),0) balance from accounts a where a.id=$1",
          [account],
        )
      )[0].balance,
    );
  const data = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "accounts",
          "categories",
          "transactions",
          "goals",
          "goal_contributions",
        ].map(async (t) => [t, await q("select * from " + t)]),
      ),
    );
  return { db, q, as, a, b, cash, other, cat, income, rule, bank, data };
}
