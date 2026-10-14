// Local comparison only. Never connects to or restores a database.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const files = process.argv.slice(2);
if (files.length !== 2)
  throw new Error(
    "Usage: node scripts/verify-sprint03-snapshots.mjs BEFORE AFTER",
  );
const snapshots = [];
for (const path of files) {
  const bytes = await readFile(path),
    expected = (await readFile(path + ".sha256", "utf8")).trim();
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Snapshot integrity failed");
  snapshots.push(JSON.parse(bytes));
}
const [before, after] = snapshots,
  changed = [],
  missing = [],
  added = {};
if (before.project !== after.project)
  throw new Error("Snapshots from different projects");
for (const [table, rows] of Object.entries(before.data)) {
  const next = new Map((after.data[table] ?? []).map((r) => [r.id, r]));
  const oldIds = new Set(rows.map((r) => r.id));
  added[table] = (after.data[table] ?? []).filter(
    (r) => !oldIds.has(r.id),
  ).length;
  for (const old of rows) {
    const now = next.get(old.id);
    if (!now) {
      missing.push({ table, id: old.id });
      continue;
    }
    for (const [key, value] of Object.entries(old))
      if (!isDeepStrictEqual(value, now[key]))
        changed.push({ table, id: old.id, field: key });
  }
}
const structuralOnly =
  changed.length === 0 &&
  missing.length === 0 &&
  Object.values(added).every((n) => n === 0);
console.log(
  JSON.stringify(
    {
      sameProject: true,
      preexistingFieldsUnchanged: changed.length === 0 && missing.length === 0,
      structuralOnly,
      added,
      changed,
      missing,
      interpretation: structuralOnly
        ? "No preexisting record changed; verify financial invariants and new schema privately."
        : "Review live user activity and all differences privately. Deployment must not change existing records; never restore an old snapshot.",
    },
    null,
    2,
  ),
);
if (changed.length || missing.length) process.exitCode = 1;
