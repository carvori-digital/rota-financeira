// Rehearse only in an in-memory PostgreSQL instance. Never connects remotely.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { balance, balanceSummary } from "../src/utils/finance.ts";
import {
  wealthSummary,
  investmentValue,
} from "../src/features/investments/calculations.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
const path = process.argv[2];
assert.ok(path?.startsWith("test-results/"), "Use a private local snapshot");
const bytes = await readFile(path);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  (await readFile(path + ".sha256", "utf8")).trim(),
);
const snapshot = JSON.parse(bytes),
  before = snapshot.data;
assert.deepEqual(snapshot.migrations.map((m) => m.version).sort(), [
  "202610010001",
  "202610010002",
  "202610010003",
  "202610020004",
]);
const db = new PGlite();
const users = [
  ...new Set(
    Object.values(before)
      .flat()
      .map((r) => r.user_id),
  ),
];
try {
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`,
  );
  const migrations = (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations.filter((f) => f < "202610030005"))
    await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
  assert.match(snapshot.reference_date, /^\d{4}-\d{2}-\d{2}$/);
  await db.exec(
    `create or replace function public.financial_date() returns date language sql stable as $$select date '${snapshot.reference_date}'$$;set session_replication_role=replica;`,
  );
  for (const user of users)
    await db.query("insert into auth.users values($1)", [user]);
  for (const [table, rows] of Object.entries(before)) {
    assert.match(table, /^[a-z_]+$/);
    for (const row of rows) {
      const keys = Object.keys(row);
      keys.forEach((k) => assert.match(k, /^[a-z_]+$/));
      await db.query(
        `insert into public.${table}(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
        Object.values(row),
      );
    }
  }
  await db.exec("set session_replication_role=origin");
  for (const file of migrations.filter((f) => f >= "202610030005"))
    await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
  await db.exec("set timezone='UTC'");
  const after = {};
  for (const { tablename } of (
    await db.query("select tablename from pg_tables where schemaname='public'")
  ).rows)
    after[tablename] = (
      await db.query(`select to_jsonb(t) row from public.${tablename} t`)
    ).rows.map((r) => r.row);
  for (const [table, rows] of Object.entries(before))
    for (const old of rows) {
      const row = after[table].find((r) => r.id === old.id);
      assert.ok(row, "Original row missing");
      for (const [key, value] of Object.entries(old)) {
        if (
          table === "accounts" &&
          row.investment_id &&
          ["is_active", "updated_at"].includes(key)
        )
          continue;
        assert.deepEqual(
          row[key],
          value,
          `Preservation mismatch in ${table}.${key}`,
        );
      }
    }
  const forUser = (data, u) =>
    Object.fromEntries(
      Object.entries(data).map(([t, rows]) => [
        t,
        rows.filter((r) => r.user_id === u),
      ]),
    );
  for (const user of users) {
    const b = forUser(before, user),
      a = forUser(after, user),
      plan = { ...emptyPlanning, ...a };
    const initial = wealthSummary(
      b,
      { ...emptyPlanning, ...b },
      snapshot.reference_date,
    );
    const final = wealthSummary(a, plan, snapshot.reference_date);
    for (const key of [
      "available",
      "invested",
      "gross",
      "net",
      "debts",
      "cards",
    ])
      assert.equal(final[key], initial[key], `Financial invariant: ${key}`);
    assert.equal(
      final.gross,
      balanceSummary(b.accounts, b.transactions, snapshot.reference_date).total,
    );
    for (const i of a.investments) {
      const account = b.accounts.find((r) => r.id === i.source_account_id);
      assert.ok(account);
      assert.equal(
        investmentValue(i, a.investment_movements, snapshot.reference_date)
          .current,
        balance(account, b.transactions, snapshot.reference_date),
      );
    }
  }
  const report = {
    snapshot: path,
    localOnly: true,
    preserved: true,
    invariants: true,
    countsBefore: Object.fromEntries(
      Object.entries(before).map(([k, v]) => [k, v.length]),
    ),
    countsAfter: Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v.length]),
    ),
  };
  await writeFile(path + ".rehearsal.json", JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
