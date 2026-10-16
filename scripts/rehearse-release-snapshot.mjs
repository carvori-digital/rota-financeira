// Private backup restore/upgrade verification. All writes are in local PGlite.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { isDeepStrictEqual } from "node:util";
import { balanceSummary } from "../src/utils/finance.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
const path = process.argv[2];
assert.ok(path?.startsWith("test-results/"), "Use a private local backup");
const bytes = await readFile(path);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  (await readFile(path + ".sha256", "utf8")).trim(),
);
const snapshot = JSON.parse(bytes),
  original = snapshot.data;
assert.equal(snapshot.project, "lgcozsoenycvifiygdsj");
assert.match(snapshot.reference_date, /^\d{4}-\d{2}-\d{2}$/);
const db = new PGlite(),
  q = async (sql, p = []) => (await db.query(sql, p)).rows;
const tables = Object.keys(original).sort();
tables.forEach((t) => assert.match(t, /^[a-z_]+$/));
const users = [
  ...new Set(
    Object.values(original)
      .flat()
      .map((r) => r.user_id)
      .filter(Boolean),
  ),
];
const summaries = (data) =>
  users.map((user) => {
    const own = Object.fromEntries(
      Object.entries(data).map(([t, rows]) => [
        t,
        rows.filter((r) => r.user_id === user),
      ]),
    );
    return {
      user,
      bank: balanceSummary(
        own.accounts,
        own.transactions,
        snapshot.reference_date,
      ),
      wealth: wealthSummary(
        own,
        { ...emptyPlanning, ...own },
        snapshot.reference_date,
      ),
    };
  });
try {
  await db.exec("set timezone='UTC'");
  await db.exec(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on sequences to anon,authenticated;",
  );
  const files = (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    snapshot.migrations.map((m) => m.version).sort(),
    files.filter((f) => f < "202610150013").map((f) => f.split("_")[0]),
  );
  for (const f of files.filter((f) => f < "202610150013"))
    await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
  const available = (
    await q("select tablename from pg_tables where schemaname='public'")
  )
    .map((r) => r.tablename)
    .sort();
  assert.deepEqual(
    tables,
    available,
    "Backup must cover every existing financial table",
  );
  await db.exec(
    `create or replace function public.financial_date() returns date language sql stable as $$select date '${snapshot.reference_date}'$$;set session_replication_role=replica;`,
  );
  for (const user of users)
    await q("insert into auth.users values($1)", [user]);
  for (const table of tables) {
    const columns = (
      await q(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position",
        [table],
      )
    ).map((r) => r.column_name);
    columns.forEach((c) => assert.match(c, /^[a-z_]+$/));
    await q(
      `insert into public.${table}(${columns.join(",")}) overriding system value select ${columns.map((c) => "r." + c).join(",")} from jsonb_populate_recordset(null::public.${table},$1::jsonb) r`,
      [JSON.stringify(original[table])],
    );
  }
  await db.exec("set session_replication_role=origin");
  const restored = {};
  for (const table of tables)
    restored[table] = (
      await q(`select to_jsonb(r) row from public.${table} r order by id`)
    ).map((r) => r.row);
  for (const table of tables) {
    assert.equal(
      restored[table].length,
      original[table].length,
      "Backup count mismatch: " + table,
    );
    for (let i = 0; i < original[table].length; i++)
      for (const [key, value] of Object.entries(original[table][i]))
        if (!isDeepStrictEqual(restored[table][i][key], value))
          throw Error("Backup restore mismatch: " + table + "." + key);
  }
  const baseline = summaries(restored);
  await db.exec(
    await readFile(
      "supabase/migrations/202610150013_recurring_occurrence_amounts.sql",
      "utf8",
    ),
  );
  const after013 = (
    await q("select to_jsonb(r) row from recurring_occurrences r order by id")
  ).map((r) => r.row);
  await db.exec(
    await readFile(
      "supabase/migrations/202610150014_financial_boundaries.sql",
      "utf8",
    ),
  );
  const migrated = {};
  for (const table of tables)
    migrated[table] = (
      await q(`select to_jsonb(r) row from public.${table} r order by id`)
    ).map((r) => r.row);
  for (const table of tables) {
    assert.equal(
      migrated[table].length,
      restored[table].length,
      "Count changed: " + table,
    );
    for (let i = 0; i < restored[table].length; i++)
      for (const [key, value] of Object.entries(restored[table][i])) {
        if (table === "recurring_occurrences" && key === "updated_at") continue; // existing 013 metadata backfill
        assert.deepEqual(
          migrated[table][i][key],
          value,
          "Existing fact changed: " + table + "." + key,
        );
      }
  }
  for (let i = 0; i < after013.length; i++)
    for (const [key, value] of Object.entries(after013[i]))
      assert.deepEqual(
        migrated.recurring_occurrences[i][key],
        value,
        "014 changed occurrence field: " + key,
      );
  assert.deepEqual(
    summaries(migrated),
    baseline,
    "Upgrade changed bank/assets/debts/wealth",
  );
  assert.equal(
    (await q("select count(*)::int n from debt_payment_allocations"))[0].n,
    0,
    "Do not fabricate legacy allocations",
  );
  const report = {
    backup: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    reference_date: snapshot.reference_date,
    financial_tables: tables.length,
    counts: Object.fromEntries(tables.map((t) => [t, original[t].length])),
    backup_restored_exactly: true,
    migrations_013_014_passed: true,
    existing_financial_rows_preserved: true,
    bank_and_wealth_preserved: true,
    legacy_debt_allocations_invented: false,
    remote_writes: false,
    engine: "PGlite disposable local PostgreSQL",
  };
  await writeFile(
    path + ".release-verified.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
