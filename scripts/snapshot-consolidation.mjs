import { remoteSql } from "./remote-sql.mjs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { balance, balanceSummary } from "../src/utils/finance.ts";
import { invoices } from "../src/features/cards/calculations.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
const candidates = [
  "accounts",
  "categories",
  "transactions",
  "goals",
  "goal_contributions",
  "credit_cards",
  "card_purchases",
  "card_invoices",
  "card_payments",
  "debts",
  "debt_payments",
  "recurring_items",
  "recurring_occurrences",
  "reserve_account_links",
  "investments",
  "investment_movements",
  "classification_reviews",
  "card_purchase_audit",
  "card_adjustments",
];
const inventory = await remoteSql(
  "begin read only; select tablename from pg_tables where schemaname='public' order by tablename; commit;",
  "retomada-inventory-read-only",
);
const existing = inventory.rows.map((r) => r.tablename);
const unknown = existing.filter((t) => !candidates.includes(t));
if (unknown.length)
  throw new Error(
    "Inspecionar tabelas públicas adicionais antes do snapshot: " +
      unknown.join(","),
  );
const tables = candidates.filter((t) => existing.includes(t));
const sql = `begin isolation level repeatable read read only;
select jsonb_build_object(
'captured_at',now(),'reference_date',public.financial_date(),'database_date', (now() at time zone 'America/Sao_Paulo')::date,'project','lgcozsoenycvifiygdsj',
'tables',(select jsonb_agg(jsonb_build_object('table',tablename,'rls',rowsecurity)) from pg_tables where schemaname='public'),
'columns',(select jsonb_agg(to_jsonb(c)) from information_schema.columns c where table_schema='public'),
'constraints',(select jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid))) from pg_constraint where connamespace='public'::regnamespace),
'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid))) from pg_trigger where not tgisinternal and tgrelid in(select oid from pg_class where relnamespace='public'::regnamespace)),
'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public'),
'grants',(select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g where table_schema='public'),
'functions',(select jsonb_agg(jsonb_build_object('name',proname,'definition',pg_get_functiondef(oid))) from pg_proc where pronamespace='public'::regnamespace and prokind='f'),
'migrations',(select jsonb_agg(to_jsonb(m)) from supabase_migrations.schema_migrations m),
'account_balances_sql',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'user_id',a.user_id,'cents',a.initial_balance_cents+coalesce((select sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then coalesce(t.adjustment_delta_cents,0) else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end) from public.transactions t where t.user_id=a.user_id and t.status='realized' and t.transaction_date<=public.financial_date()),0))),'[]'::jsonb) from public.accounts a),
'data',jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.${t} t)`).join(",")})) snapshot;
commit;`;
const result = await remoteSql(sql, "retomada-snapshot-read-only");
const snapshot = result.rows[0].snapshot;
const d = snapshot.data,
  asOf = snapshot.reference_date;
const users = [
  ...new Set(
    Object.values(d)
      .flat()
      .map((r) => r.user_id)
      .filter(Boolean),
  ),
];
snapshot.invariants = {
  asOf,
  counts: Object.fromEntries(tables.map((t) => [t, d[t].length])),
  byUser: users.map((user) => {
    const accounts = d.accounts.filter((a) => a.user_id === user),
      transactions = d.transactions.filter((t) => t.user_id === user);
    const summary = balanceSummary(accounts, transactions, asOf);
    const own = Object.fromEntries(
      Object.entries(d).map(([table, rows]) => [
        table,
        rows.filter((r) => r.user_id === user),
      ]),
    );
    const wealth = wealthSummary(own, { ...emptyPlanning, ...own }, asOf);
    const debts = d.debts
      .filter((t) => t.user_id === user)
      .reduce((s, r) => s + r.remaining_amount_cents, 0);
    const bills = invoices(
      d.credit_cards.filter((t) => t.user_id === user),
      d.card_purchases.filter((t) => t.user_id === user),
      d.card_invoices.filter((t) => t.user_id === user),
      d.card_payments.filter((t) => t.user_id === user),
      (d.card_adjustments ?? []).filter((t) => t.user_id === user),
    );
    const cards = bills.reduce((s, r) => s + r.pending, 0);
    const accountBalances = accounts.map((a) => ({
      id: a.id,
      type: a.type,
      cents: balance(a, transactions, asOf),
    }));
    for (const row of accountBalances) {
      const remote = snapshot.account_balances_sql.find((x) => x.id === row.id);
      if (remote.cents !== row.cents)
        throw new Error(
          "Divergência entre saldo SQL e motor local; registrar para revisão sem alterar dados.",
        );
    }
    return {
      user_id: user,
      wealth,
      accountBalances,
      available_cents: summary.available,
      legacy_reserve_investments_cents: summary.reserve,
      account_assets_cents: summary.total,
      debts_cents: debts,
      cards_pending_cents: cards,
      net_account_assets_cents: summary.total - debts - cards,
      bills,
    };
  }),
  rawTotals: Object.fromEntries(
    tables.map((t) => [
      t,
      {
        amount_cents: d[t].reduce((s, r) => s + (r.amount_cents ?? 0), 0),
        byStatus: d[t].reduce((s, r) => {
          const k = r.status ?? "unspecified";
          s[k] = (s[k] ?? 0) + 1;
          return s;
        }, {}),
      },
    ]),
  ),
};
const filename =
  "test-results/consolidation-current-" + asOf + "-" + Date.now() + ".json";
const contents = JSON.stringify(snapshot, null, 2);
await writeFile(filename, contents, { mode: 0o600, flag: "wx" });
await writeFile(
  filename + ".sha256",
  createHash("sha256").update(contents).digest("hex") + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      filename,
      readOnly: true,
      counts: snapshot.invariants.counts,
      migrations: snapshot.migrations.map((m) => m.version),
      rls: snapshot.tables.every((t) => t.rls),
      accountBalanceCrossCheck: true,
    },
    null,
    2,
  ),
);
