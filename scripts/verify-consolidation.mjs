// Private, local comparison of two read-only remote snapshots. No remote writes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  wealthSummary,
  investmentValue,
} from "../src/features/investments/calculations.ts";
import { balance } from "../src/utils/finance.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
const paths = process.argv.slice(2);
assert.equal(paths.length, 2);
const snapshots = [];
for (const path of paths) {
  assert.ok(path.startsWith("test-results/"));
  const bytes = await readFile(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    (await readFile(path + ".sha256", "utf8")).trim(),
  );
  snapshots.push(JSON.parse(bytes));
}
const [before, after] = snapshots,
  changes = [],
  missing = [],
  added = {};
for (const [table, rows] of Object.entries(before.data)) {
  const current = after.data[table] ?? [];
  added[table] = current.filter((r) => !rows.some((b) => b.id === r.id)).length;
  for (const old of rows) {
    const row = current.find((r) => r.id === old.id);
    if (!row) {
      missing.push({ table, id: old.id });
      continue;
    }
    for (const [key, value] of Object.entries(old)) {
      if (
        table === "accounts" &&
        row.investment_id &&
        ["is_active", "updated_at"].includes(key)
      )
        continue;
      if (!isDeepStrictEqual(row[key], value))
        changes.push({ table, id: old.id, field: key });
    }
  }
}
const users = [
  ...new Set(
    Object.values(before.data)
      .flat()
      .map((r) => r.user_id),
  ),
];
const failures = [];
for (const user of users) {
  const own = (data) =>
    Object.fromEntries(
      Object.entries(data).map(([t, rows]) => [
        t,
        rows.filter((r) => r.user_id === user),
      ]),
    );
  const b = own(before.data),
    a = own(after.data),
    date = before.reference_date;
  const start = wealthSummary(b, { ...emptyPlanning, ...b }, date),
    end = wealthSummary(a, { ...emptyPlanning, ...a }, date);
  for (const key of ["available", "invested", "gross", "net", "debts", "cards"])
    if (start[key] !== end[key])
      failures.push({ user_id: user, invariant: key });
  for (const i of a.investments ?? []) {
    if (!i.source_account_id) continue;
    const old = b.accounts.find((r) => r.id === i.source_account_id),
      current = a.accounts.find((r) => r.id === i.source_account_id);
    if (
      !old ||
      current?.investment_id !== i.id ||
      current.is_active !== false ||
      investmentValue(i, a.investment_movements ?? [], date).current !==
        balance(old, b.transactions, date)
    )
      failures.push({
        user_id: user,
        invariant: "source_account",
        investment_id: i.id,
      });
  }
}
const report = {
  before: paths[0],
  after: paths[1],
  missing,
  changes,
  added,
  failures,
  rls: after.tables.every((t) => t.rls),
  migrations: after.migrations.map((m) => m.version).sort(),
  preserved: !missing.length && !changes.length,
  invariants: !failures.length,
  countsBefore: before.invariants.counts,
  countsAfter: after.invariants.counts,
};
await writeFile(
  paths[1] + ".verification.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      preserved: report.preserved,
      invariants: report.invariants,
      rls: report.rls,
      migrations: report.migrations,
      countsBefore: report.countsBefore,
      countsAfter: report.countsAfter,
      newRowsInExistingTables: added,
      reviewRequired: !!(changes.length || failures.length),
    },
    null,
    2,
  ),
);
assert.ok(
  report.preserved && report.invariants && report.rls,
  "Differences require reconciliation against current user activity; do not restore a snapshot.",
);
assert.deepEqual(report.migrations, [
  "202610010001",
  "202610010002",
  "202610010003",
  "202610020004",
  "202610030005",
  "202610030006",
]);
