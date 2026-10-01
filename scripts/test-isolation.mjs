// Uses two dedicated, confirmed test users and the public key; never needs service_role.
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
const required = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "TEST_A_EMAIL",
  "TEST_A_PASSWORD",
  "TEST_B_EMAIL",
  "TEST_B_PASSWORD",
];
for (const name of required)
  if (!process.env[name])
    throw new Error(
      `Defina ${name} no ambiente (não no Git). Consulte README.md.`,
    );
const clients = ["A", "B"].map(() =>
  createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  ),
);
const users = [];
const cleanup = [];
const stamp = crypto.randomUUID();
async function insert(client, table, payload) {
  const r = await client.from(table).insert(payload).select().single();
  if (r.error) throw r.error;
  cleanup.push({ client, table, id: r.data.id });
  return r.data;
}
async function denied(client, table, payload) {
  const r = await client.from(table).insert(payload).select();
  assert.ok(r.error, `INSERT indevido permitido em ${table}`);
}
try {
  for (let i = 0; i < 2; i++) {
    const k = i === 0 ? "A" : "B";
    const r = await clients[i].auth.signInWithPassword({
      email: process.env[`TEST_${k}_EMAIL`],
      password: process.env[`TEST_${k}_PASSWORD`],
    });
    if (r.error) throw r.error;
    users.push(r.data.user.id);
  }
  assert.notEqual(users[0], users[1], "Use dois usuários diferentes.");
  const fixtures = [];
  for (const client of clients) {
    const account = await insert(client, "accounts", {
      name: `Teste ${stamp}`,
      type: "checking",
    });
    const category = await insert(client, "categories", {
      name: `Teste ${stamp}`,
      type: "expense",
    });
    const transaction = await insert(client, "transactions", {
      account_id: account.id,
      category_id: category.id,
      type: "expense",
      amount_cents: 100,
      transaction_date: "2026-10-01",
    });
    const goal = await insert(client, "goals", {
      name: `Teste ${stamp}`,
      target_amount_cents: 1000,
    });
    const contribution = await insert(client, "goal_contributions", {
      goal_id: goal.id,
      amount_cents: 100,
      contribution_date: "2026-10-01",
    });
    fixtures.push({
      accounts: account,
      categories: category,
      transactions: transaction,
      goals: goal,
      goal_contributions: contribution,
    });
  }
  for (let actor = 0; actor < 2; actor++) {
    const client = clients[actor];
    const victim = fixtures[1 - actor];
    for (const [table, row] of Object.entries(victim)) {
      for (const query of [
        client
          .from(table)
          .select("id")
          .eq("user_id", users[1 - actor]),
        client.from(table).select("id").eq("id", row.id),
        client
          .from(table)
          .update({ user_id: users[actor] })
          .eq("id", row.id)
          .select("id"),
        client.from(table).delete().eq("id", row.id).select("id"),
      ]) {
        const r = await query;
        assert.ifError(r.error);
        assert.equal(
          r.data.length,
          0,
          `${table}: leitura/mutação entre usuários permitida`,
        );
      }
      const payload = {
        ...row,
        id: crypto.randomUUID(),
        user_id: users[1 - actor],
      };
      delete payload.created_at;
      delete payload.updated_at;
      await denied(client, table, payload);
    }
    await denied(client, "transactions", {
      account_id: victim.accounts.id,
      category_id: fixtures[actor].categories.id,
      type: "expense",
      amount_cents: 100,
      transaction_date: "2026-10-01",
    });
    await denied(client, "transactions", {
      account_id: fixtures[actor].accounts.id,
      category_id: victim.categories.id,
      type: "expense",
      amount_cents: 100,
      transaction_date: "2026-10-01",
    });
    await denied(client, "transactions", {
      account_id: fixtures[actor].accounts.id,
      destination_account_id: victim.accounts.id,
      type: "transfer",
      amount_cents: 100,
      transaction_date: "2026-10-01",
    });
    await denied(client, "goal_contributions", {
      goal_id: victim.goals.id,
      amount_cents: 100,
      contribution_date: "2026-10-01",
    });
  }
  console.log(
    "PASS: isolamento A↔B nas cinco tabelas e ownership das relações.",
  );
} finally {
  for (const item of cleanup.reverse()) {
    const r = await item.client.from(item.table).delete().eq("id", item.id);
    if (r.error) console.error(`Limpeza pendente: ${item.table}/${item.id}`);
  }
  await Promise.all(clients.map((client) => client.auth.signOut()));
}
