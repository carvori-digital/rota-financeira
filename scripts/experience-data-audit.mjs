// Read-only preservation audit. No QA rows, migrations or data mutations.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { remoteSql } from "./remote-sql.mjs";
const tables = [
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
];
const path = "test-results/experience-data-baseline.json";
const mode = process.argv[2];
assert.ok(["snapshot", "verify"].includes(mode));
const sql =
  "begin read only; " +
  tables
    .map(
      (t) =>
        `select '${t}' as table_name,id,md5((to_jsonb(t)-'updated_at')::text) as fingerprint from public.${t} t`,
    )
    .join(" union all ") +
  "; commit;";
const after = (await remoteSql(sql, "experience-read-only")).rows;
await mkdir("test-results", { recursive: true });
if (mode === "snapshot")
  await writeFile(path, JSON.stringify(after), { mode: 0o600 });
else {
  const before = JSON.parse(await readFile(path, "utf8"));
  const current = new Map(
    after.map((r) => [r.table_name + ":" + r.id, r.fingerprint]),
  );
  for (const r of before)
    assert.equal(
      current.get(r.table_name + ":" + r.id),
      r.fingerprint,
      `${r.table_name}: registro removido/alterado desde o snapshot; conferir possível ação do usuário.`,
    );
  console.log(
    `PASS: ${before.length} registros preexistentes idênticos; ${after.length - before.length} novos registros aceitos.`,
  );
}
console.log(
  JSON.stringify({
    readOnly: true,
    tables: Object.fromEntries(
      tables.map((t) => [t, after.filter((r) => r.table_name === t).length]),
    ),
  }),
);
