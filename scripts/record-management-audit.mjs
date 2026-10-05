// Private snapshots only. Rehearsal is in-memory and never connects remotely.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const [mode, beforePath, afterPath] = process.argv.slice(2);
const load = async (path) => {
  assert.ok(path?.startsWith("test-results/"));
  const bytes = await readFile(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    (await readFile(path + ".sha256", "utf8")).trim(),
  );
  return JSON.parse(bytes);
};
const before = await load(beforePath);
const normalize = (data) =>
  Object.fromEntries(
    Object.entries(data)
      .sort()
      .map(([k, rows]) => [
        k,
        [...rows].sort((a, b) => a.id.localeCompare(b.id)),
      ]),
  );
const names = [
  "delete_card_purchase",
  "delete_goal",
  "delete_investment",
  "delete_unused_record",
];
let report;
if (mode === "compare") {
  const after = await load(afterPath);
  // Exact comparison; never ignore financial fields or assume old snapshots current.
  assert.deepEqual(
    normalize(after.data),
    normalize(before.data),
    "Current data changed between immediate snapshots; investigate, do not restore.",
  );
  assert.deepEqual(after.invariants, before.invariants);
  assert.ok(after.tables.every((t) => t.rls));
  for (const name of names)
    assert.ok(after.functions.some((f) => f.name === name));
  assert.ok(after.migrations.some((m) => m.version === "202610050007"));
  report = {
    recordsPreserved: true,
    invariantsPreserved: true,
    rls: true,
    counts: after.invariants.counts,
  };
} else {
  assert.equal(mode, "rehearse");
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;",
    );
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied = before.migrations.map((m) => m.version).sort();
    assert.deepEqual(
      applied,
      files
        .filter((f) => !f.startsWith("202610050007"))
        .map((f) => f.split("_")[0]),
    );
    for (const f of files.filter((f) => !f.startsWith("202610050007")))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec("set timezone='UTC';set session_replication_role=replica");
    const users = [
      ...new Set(
        Object.values(before.data)
          .flat()
          .map((r) => r.user_id),
      ),
    ];
    for (const user of users)
      await db.query("insert into auth.users values($1)", [user]);
    for (const [table, rows] of Object.entries(before.data)) {
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
    const capture = async () => {
      const data = {};
      for (const table of Object.keys(before.data))
        data[table] = (
          await db.query(
            `select to_jsonb(t) row from public.${table} t order by id`,
          )
        ).rows.map((r) => r.row);
      return data;
    };
    const initial = await capture();
    const constraints = (
      await db.query(
        "select conrelid::regclass::text t,conname,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace order by 1,2",
      )
    ).rows;
    const policies = (
      await db.query(
        "select * from pg_policies where schemaname='public' order by tablename,policyname",
      )
    ).rows;
    await db.exec(
      await readFile(
        "supabase/migrations/202610050007_record_management.sql",
        "utf8",
      ),
    );
    assert.deepEqual(await capture(), initial);
    assert.deepEqual(
      (
        await db.query(
          "select conrelid::regclass::text t,conname,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace order by 1,2",
        )
      ).rows,
      constraints,
    );
    assert.deepEqual(
      (
        await db.query(
          "select * from pg_policies where schemaname='public' order by tablename,policyname",
        )
      ).rows,
      policies,
    );
    const permissions = (
      await db.query(
        "select proname,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated from pg_proc where proname=any($1::text[])",
        [names],
      )
    ).rows;
    assert.equal(permissions.length, 4);
    assert.ok(
      permissions.every((p) => p.prosecdef && !p.anon && p.authenticated),
    );
    report = {
      localOnly: true,
      recordsPreserved: true,
      foreignKeysAndCascadesPreserved: true,
      policiesPreserved: true,
      permissions,
      counts: before.invariants.counts,
    };
  } finally {
    await db.close();
  }
}
await writeFile(
  beforePath + "." + mode + ".json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
