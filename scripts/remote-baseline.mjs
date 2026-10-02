import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { remoteSql } from "./remote-sql.mjs";
const mode = process.argv[2],
  path = "test-results/remote-data-baseline.json";
const tables = [
  "accounts",
  "categories",
  "transactions",
  "goals",
  "goal_contributions",
];
async function snapshot() {
  const query =
    tables
      .map(
        (table) =>
          "select '" +
          table +
          "' as table_name,id,md5((to_jsonb(t)-'updated_at'-'status'-'planning_group'-'adjustment_delta_cents'-'payment_reference'-'is_emergency_reserve')::text) fingerprint from public." +
          table +
          " t",
      )
      .join(" union all ") +
    " union all select 'users',id,md5(jsonb_build_object('id',id,'email',email,'password',encrypted_password,'created_at',created_at,'metadata',raw_user_meta_data)::text) fingerprint from auth.users";
  const result = Object.fromEntries([...tables, "users"].map((t) => [t, []]));
  for (const row of (await remoteSql(query, "snapshot-all")).rows)
    result[row.table_name].push({ id: row.id, fingerprint: row.fingerprint });
  return result;
}

if (mode === "snapshot") {
  const s = await snapshot();
  await writeFile(path, JSON.stringify(s), { mode: 0o600 });
  console.log(
    "Baseline de preservação salvo: " +
      Object.entries(s)
        .map(([k, v]) => k + "=" + v.length)
        .join(", "),
  );
} else if (mode === "verify") {
  const before = JSON.parse(await readFile(path, "utf8")),
    after = await snapshot();
  for (const [table, rows] of Object.entries(before)) {
    const current = new Map(after[table].map((r) => [r.id, r.fingerprint]));
    for (const row of rows)
      assert.equal(
        current.get(row.id),
        row.fingerprint,
        table + ": registro preexistente alterado ou removido",
      );
  }
  console.log(
    "PASS: identidades e conteúdo dos registros preexistentes preservados, inclusive usuários.",
  );
} else if (mode === "dry-run") {
  let migrations = [];
  for (const f of [
    "202610010002_planning.sql",
    "202610010003_planning_integrity.sql",
    "202610020004_financial_clarity.sql",
  ])
    migrations.push(
      (await readFile("supabase/migrations/" + f, "utf8"))
        .replace(/^begin;\s*$/gim, "")
        .replace(/^commit;\s*$/gim, ""),
    );
  await remoteSql(
    "begin;\n" +
      migrations.join("\n") +
      "\nrollback;select true as dry_run_valid;",
    "migration-dry-run",
  );
  console.log(
    "PASS: migrations 002+003+004 validadas no remoto com ROLLBACK, sem mudança persistida.",
  );
} else throw new Error("Use snapshot, dry-run ou verify.");
