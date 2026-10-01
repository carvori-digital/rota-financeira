// Real integration test. Only the two generated fixture users are touched.
// Credentials exist in memory and an ignored temporary SQL file, never in Git or logs.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { balance, monthly, goalProgress, today } from "../src/utils/finance.ts";
const exec = promisify(execFile);
const env = Object.fromEntries(
  (await readFile(".env.local", "utf8"))
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
const ref = new URL(env.VITE_SUPABASE_URL).hostname.split(".")[0];
assert.equal(
  ref,
  "lgcozsoenycvifiygdsj",
  "Only the confirmed Rota Financeira project is allowed.",
);
assert.equal(
  (await readFile("supabase/.temp/project-ref", "utf8")).trim(),
  ref,
  "Confirm the CLI link first.",
);
assert.ok(
  env.VITE_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_"),
  "Use only a public publishable key.",
);
assert.ok(process.env.npm_execpath, "Run via npm run test:live.");
const runId = randomUUID();
const actors = ["a", "b"].map((label) => ({
  id: randomUUID(),
  email: `rf-v01-${runId}-${label}@example.com`,
  password: randomBytes(24).toString("base64url"),
}));
const files = [];
const directory = resolve("test-results");
await mkdir(directory, { recursive: true });
async function sql(contents, label) {
  const path = join(directory, `${runId}-${label}.sql`);
  files.push(path);
  await writeFile(path, contents, { mode: 0o600 });
  try {
    return (
      await exec(
        process.execPath,
        [
          process.env.npm_execpath,
          "exec",
          "--yes",
          "--package=supabase@2.119.0",
          "--",
          "supabase",
          "db",
          "query",
          "--linked",
          "--file",
          path,
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      )
    ).stdout;
  } catch {
    throw new Error(
      `CLI ${label} failed. Credentials and query contents were not logged.`,
    );
  } finally {
    await unlink(path).catch(() => {});
  }
}
const ids = actors.map((a) => `'${a.id}'`).join(",");
const storageAdapters = actors.map(() => {
  const storage = new Map();
  return {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => {
      storage.set(k, v);
    },
    removeItem: (k) => {
      storage.delete(k);
    },
  };
});
const clients = actors.map((_, i) => {
  return createClient(
    env.VITE_SUPABASE_URL,
    env.VITE_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: true,
        storage: storageAdapters[i],
      },
    },
  );
});
async function write(client, table, payload, id) {
  const q = id
    ? client.from(table).update(payload).eq("id", id)
    : client
        .from(table)
        .upsert({ ...payload, id: randomUUID() }, { onConflict: "id" });
  const result = await q.select().single();
  assert.equal(
    result.error,
    null,
    `${table}: ${result.error?.code ?? "write failed"}`,
  );
  return result.data;
}
async function read(client, table) {
  const result = await client.from(table).select("*");
  assert.equal(result.error, null);
  return result.data;
}
async function remove(client, table, id) {
  const result = await client.from(table).delete().eq("id", id).select("id");
  assert.equal(result.error, null);
  assert.equal(result.data.length, 1);
}
try {
  // Fixture-only confirmed users: does not change email confirmation settings or send mail.
  await sql(
    `begin;
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change_token_new,email_change,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values ${actors.map((a) => `('${a.id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${a.email}',extensions.crypt('${a.password}',extensions.gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now())`).join(",")};
 insert into auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at)
 values ${actors.map((a) => `('${a.id}','${a.id}','{"sub":"${a.id}","email":"${a.email}","email_verified":true}','email',now(),now())`).join(",")};
 commit; select 'fixture users ready' as result;`,
    "setup",
  );
  for (let i = 0; i < 2; i++) {
    const login = await clients[i].auth.signInWithPassword({
      email: actors[i].email,
      password: actors[i].password,
    });
    assert.equal(login.error, null, `Actor ${i}: login failed`);
    assert.equal(login.data.user.id, actors[i].id);
    const session = await clients[i].auth.getSession();
    assert.ok(session.data.session);
    const current = await clients[i].auth.getUser();
    assert.equal(current.data.user.id, actors[i].id);
    assert.equal(
      (await read(clients[i], "categories")).length,
      15,
      "Default categories missing.",
    );
  }
  const client = clients[0];
  const date = today();
  const origin = await write(client, "accounts", {
    name: "Live fixture principal",
    type: "checking",
    initial_balance_cents: 10000,
  });
  const destination = await write(client, "accounts", {
    name: "Live fixture carteira",
    type: "wallet",
    initial_balance_cents: 2000,
  });
  const category = await write(client, "categories", {
    name: "Live fixture income",
    type: "income",
  });
  await write(
    client,
    "categories",
    { name: "Live fixture renamed" },
    category.id,
  );
  const expenseCategory = (await read(client, "categories")).find(
    (c) => c.type === "expense",
  );
  const income = await write(client, "transactions", {
    type: "income",
    account_id: origin.id,
    category_id: category.id,
    amount_cents: 20000,
    description: "Live fixture",
    transaction_date: date,
    is_recurring: false,
    recurrence_frequency: null,
  });
  const expense = await write(client, "transactions", {
    type: "expense",
    account_id: origin.id,
    category_id: expenseCategory.id,
    amount_cents: 1234,
    description: "Live fixture",
    transaction_date: date,
    is_recurring: true,
    recurrence_frequency: "monthly",
  });
  const transfer = await write(client, "transactions", {
    type: "transfer",
    account_id: origin.id,
    destination_account_id: destination.id,
    category_id: null,
    amount_cents: 5000,
    description: "Live fixture",
    transaction_date: date,
    is_recurring: false,
    recurrence_frequency: null,
  });
  let transactions = await read(client, "transactions");
  assert.equal(
    balance(origin, transactions) + balance(destination, transactions),
    30766,
  );
  assert.deepEqual(monthly(transactions, date.slice(0, 7)), {
    income: 20000,
    expense: 1234,
    result: 18766,
    saved: 93.83,
  });
  await write(client, "transactions", { amount_cents: 2234 }, expense.id);
  await remove(client, "transactions", income.id);
  transactions = await read(client, "transactions");
  assert.equal(
    balance(origin, transactions) + balance(destination, transactions),
    9766,
  );
  await write(client, "transactions", { amount_cents: 3000 }, transfer.id);
  await remove(client, "transactions", transfer.id);
  const goal = await write(client, "goals", {
    name: "Live fixture reserva",
    target_amount_cents: 10000,
    initial_amount_cents: 1000,
  });
  const contribution = await write(client, "goal_contributions", {
    goal_id: goal.id,
    amount_cents: 2000,
    contribution_date: date,
    description: "Live fixture",
  });
  assert.deepEqual(
    goalProgress(goal, await read(client, "goal_contributions")),
    { accumulated: 3000, remaining: 7000, percent: 30 },
  );
  await remove(client, "goal_contributions", contribution.id);
  await write(client, "accounts", { is_active: false }, origin.id);
  assert.ok(
    (await read(client, "transactions")).some((t) => t.id === expense.id),
    "Archiving lost history.",
  );
  await write(client, "accounts", { is_active: true }, origin.id);
  await write(
    client,
    "goals",
    { name: "Live fixture edited", is_active: false },
    goal.id,
  );
  for (const table of [
    "accounts",
    "categories",
    "transactions",
    "goals",
    "goal_contributions",
  ]) {
    const foreign = await clients[1]
      .from(table)
      .select("id")
      .eq("user_id", actors[0].id);
    assert.equal(foreign.error, null);
    assert.equal(foreign.data.length, 0);
  }
  const blocked = await clients[1].from("transactions").insert({
    account_id: origin.id,
    category_id: expenseCategory.id,
    type: "expense",
    amount_cents: 1,
    transaction_date: date,
  });
  assert.ok(blocked.error);
  // Reinstantiate Auth using the same in-memory storage to exercise persisted session restoration.
  const stored = await client.auth.getSession();
  assert.ok(stored.data.session);
  const restored = createClient(
    env.VITE_SUPABASE_URL,
    env.VITE_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        storage: storageAdapters[0],
      },
    },
  );
  const restore = await restored.auth.getUser();
  assert.equal(restore.error, null);
  assert.equal(restore.data.user.id, actors[0].id);
  const out = await restored.auth.signOut();
  assert.equal(out.error, null);
  assert.equal((await restored.auth.getSession()).data.session, null);
  console.log(
    "PASS: real Auth login/session/logout, seeded categories, account/category CRUD, income/expense CRUD, atomic transfer, goal/contribution, archive/history, dashboard totals and cross-user blocking.",
  );
} finally {
  await Promise.all(clients.map((c) => c.auth.signOut().catch(() => {})));
  // Explicit fixture UUIDs ensure that cleanup never touches another user.
  const cleanupOutput = await sql(
    `begin;
 delete from public.transactions where user_id in (${ids});
 delete from public.goal_contributions where user_id in (${ids});
 delete from public.goals where user_id in (${ids});
 delete from public.categories where user_id in (${ids});
 delete from public.accounts where user_id in (${ids});
 delete from auth.users where id in (${ids}) and email like 'rf-v01-${runId}-%@example.com';
 commit; select count(*) as remaining_fixture_users from auth.users where id in (${ids});`,
    "cleanup",
  );
  assert.equal(
    JSON.parse(cleanupOutput).rows[0].remaining_fixture_users,
    0,
    "Fixture users remain.",
  );
  for (const path of files) await unlink(path).catch(() => {});
  console.log("Cleanup complete: fixture users and records removed.");
}
