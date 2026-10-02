// Real integration test. Only explicitly generated QA identities and their temporary financial records are touched. QA users are preserved.
// Credentials exist in memory and an ignored temporary SQL file, never in Git or logs.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { projection } from "../src/features/planning/calculations.ts";
import { invoices } from "../src/features/cards/calculations.ts";
import { addMonths } from "../src/features/planning/dates.ts";
import {
  startProductionBrowser,
  validateProduction,
} from "./validate-production.mjs";
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
  email: `rf-v02-${runId}-${label}@example.com`,
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
 values ${actors.map((a) => `('${a.id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${a.email}',extensions.crypt('${a.password}',extensions.gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{"purpose":"rota-v02-validation"}',now(),now())`).join(",")};
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
      16,
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
  const call = async (name, args) => {
    const r = await client.rpc(name, args);
    assert.equal(r.error, null, name + " failed");
    return r.data;
  };
  const beforePending = balance(origin, await read(client, "transactions"));
  const pending = await write(client, "transactions", {
    account_id: origin.id,
    category_id: expenseCategory.id,
    type: "expense",
    amount_cents: 321,
    transaction_date: "2020-01-01",
    description: "QA programada vencida",
    status: "pending",
    planning_group: "other",
  });
  assert.equal(
    balance(origin, await read(client, "transactions")),
    beforePending,
  );
  assert.ok(
    (
      await clients[1].rpc("resolve_transaction", {
        p_id: pending.id,
        p_cancel: false,
        p_date: date,
      })
    ).error,
  );
  await call("resolve_transaction", {
    p_id: pending.id,
    p_cancel: false,
    p_date: date,
  });
  await call("resolve_transaction", {
    p_id: pending.id,
    p_cancel: false,
    p_date: date,
  });
  assert.equal(
    balance(origin, await read(client, "transactions")),
    beforePending - 321,
  );
  const cancelled = await write(client, "transactions", {
    account_id: origin.id,
    category_id: expenseCategory.id,
    type: "expense",
    amount_cents: 100,
    transaction_date: date,
    description: "QA cancelar",
    status: "pending",
  });
  await call("resolve_transaction", {
    p_id: cancelled.id,
    p_cancel: true,
    p_date: null,
  });
  assert.equal(
    balance(origin, await read(client, "transactions")),
    beforePending - 321,
  );
  const card = await write(client, "credit_cards", {
    name: "QA cartão",
    closing_day: 20,
    due_day: 28,
    payment_account_id: origin.id,
  });
  await write(client, "card_purchases", {
    card_id: card.id,
    category_id: expenseCategory.id,
    amount_cents: 10001,
    description: "QA 3 parcelas",
    purchase_date: date,
    installments: 3,
    first_due_date: date,
    due_anchor_day: 28,
  });
  await call("set_card_invoice", {
    p_id: randomUUID(),
    p_card: card.id,
    p_amount: 2500,
    p_due: date.slice(0, 7) + "-28",
    p_description: "QA importada",
  });
  await write(client, "card_purchases", {
    card_id: card.id,
    category_id: expenseCategory.id,
    amount_cents: 300,
    description: "QA compra após fatura",
    purchase_date: date,
    installments: 1,
    first_due_date: date,
    due_anchor_day: 28,
  });
  const cardPayment = {
    p_id: randomUUID(),
    p_card: card.id,
    p_month: date.slice(0, 7),
    p_account: origin.id,
    p_amount: 1000,
    p_date: date,
  };
  await call("pay_card_invoice", cardPayment);
  await call("pay_card_invoice", cardPayment);
  let bills = invoices(
    await read(client, "credit_cards"),
    await read(client, "card_purchases"),
    await read(client, "card_invoices"),
    await read(client, "card_payments"),
  );
  assert.equal(bills.find((i) => i.month === date.slice(0, 7)).pending, 1800);
  const debt = await write(client, "debts", {
    name: "QA parcela 8/14",
    original_amount_cents: 13500,
    remaining_amount_cents: 6500,
    installment_amount_cents: 1000,
    installment_number: 8,
    total_installments: 14,
    next_due_date: date.slice(0, 7) + "-31",
    payment_account_id: origin.id,
  });
  const debtPay = {
    p_id: randomUUID(),
    p_debt: debt.id,
    p_account: origin.id,
    p_amount: 1500,
    p_date: date,
  };
  await call("pay_debt", debtPay);
  await call("pay_debt", debtPay);
  let currentDebt = (await read(client, "debts"))[0];
  assert.equal(currentDebt.remaining_amount_cents, 5000);
  assert.equal(currentDebt.installment_number, 9);
  assert.equal(currentDebt.installment_paid_cents, 500);
  assert.ok(
    (
      await client.rpc("pay_debt", {
        ...debtPay,
        p_id: randomUUID(),
        p_amount: 5001,
      })
    ).error,
  );
  await call("pay_debt", { ...debtPay, p_id: randomUUID(), p_amount: 5000 });
  assert.equal((await read(client, "debts"))[0].remaining_amount_cents, 0);
  const rule = await write(client, "recurring_items", {
    name: "QA recorrente",
    type: "expense",
    amount_cents: 200,
    account_id: origin.id,
    category_id: expenseCategory.id,
    frequency: "monthly",
    start_date: date,
    is_essential: true,
  });
  const resolveRule = {
    p_id: randomUUID(),
    p_rule: rule.id,
    p_due: date,
    p_skip: false,
  };
  await call("resolve_recurring", resolveRule);
  await call("resolve_recurring", { ...resolveRule, p_id: randomUUID() });
  assert.equal(
    (await read(client, "recurring_occurrences")).filter(
      (o) => o.recurring_item_id === rule.id,
    ).length,
    1,
  );
  await call("resolve_recurring", {
    p_id: randomUUID(),
    p_rule: rule.id,
    p_due: addMonths(date, 1),
    p_skip: true,
  });
  const future = await write(client, "transactions", {
    account_id: origin.id,
    category_id: category.id,
    type: "income",
    amount_cents: 5000,
    transaction_date: addMonths(date, 1),
    description: "QA salário futuro",
  });
  assert.equal(future.status, "pending");
  const reserve = await write(client, "accounts", {
    name: "QA reserva",
    type: "savings",
    initial_balance_cents: 50000,
  });
  await call("save_emergency_reserve", {
    p_id: randomUUID(),
    p_cost: null,
    p_months: 6,
    p_accounts: [reserve.id],
  });
  const adjust = { p_id: randomUUID(), p_account: origin.id, p_target: -500 };
  await call("adjust_account_balance", adjust);
  await call("adjust_account_balance", adjust);
  assert.equal(balance(origin, await read(client, "transactions")), -500);
  assert.equal(
    (await read(client, "accounts")).find((a) => a.id === origin.id)
      .initial_balance_cents,
    10000,
  );
  assert.ok(
    (
      await client
        .from("accounts")
        .update({ initial_balance_cents: 0 })
        .eq("id", origin.id)
    ).error,
  );
  const plan = Object.fromEntries(
    await Promise.all(
      [
        "credit_cards",
        "card_purchases",
        "card_invoices",
        "card_payments",
        "debts",
        "debt_payments",
        "recurring_items",
        "recurring_occurrences",
        "reserve_account_links",
      ].map(async (table) => [table, await read(client, table)]),
    ),
  );
  const finance = Object.fromEntries(
    await Promise.all(
      [
        "accounts",
        "categories",
        "transactions",
        "goals",
        "goal_contributions",
      ].map(async (table) => [table, await read(client, table)]),
    ),
  );
  assert.equal(
    projection(finance, plan, date)[0].opening,
    balance(origin, finance.transactions) +
      balance(destination, finance.transactions),
  );
  for (const table of Object.keys(plan)) {
    const cross = await clients[1]
      .from(table)
      .select("id")
      .eq("user_id", actors[0].id);
    assert.equal(cross.error, null);
    assert.equal(cross.data.length, 0);
  }
  console.log(
    "PASS V0.2: programadas, encargos, confirmação/cancelamento, cartão/fatura/parcelas, pagamentos idempotentes, dívida parcial/quitada, recorrência, reserva, ajuste negativo e RLS real.",
  );
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
 do $qa$ begin if (select count(*) from auth.users where id in (${ids}) and email like 'rf-v02-${runId}-%@example.com' and raw_user_meta_data->>'purpose'='rota-v02-validation')<>2 then raise exception 'Escopo QA inválido'; end if; end $qa$;
 delete from public.reserve_account_links where user_id in (${ids});
 delete from public.recurring_occurrences where user_id in (${ids});
 delete from public.card_payments where user_id in (${ids});
 delete from public.debt_payments where user_id in (${ids});
 delete from public.card_invoices where user_id in (${ids});
 delete from public.card_purchases where user_id in (${ids});
 delete from public.recurring_items where user_id in (${ids});
 delete from public.credit_cards where user_id in (${ids});
 delete from public.debts where user_id in (${ids});
 delete from public.transactions where user_id in (${ids});
 delete from public.goal_contributions where user_id in (${ids});
 delete from public.goals where user_id in (${ids});
 delete from public.categories where user_id in (${ids});
 delete from public.accounts where user_id in (${ids});
 commit; select count(*) as remaining_fixture_users from auth.users where id in (${ids});`,
    "cleanup",
  );
  assert.equal(
    JSON.parse(cleanupOutput).rows[0].remaining_fixture_users,
    2,
    "QA identities must remain preserved.",
  );
  for (const path of files) await unlink(path).catch(() => {});
  console.log(
    "Cleanup complete: temporary financial records removed; QA users preserved.",
  );
}

if (process.argv.includes("--await-production")) {
  const started = Date.now();
  const browser = await startProductionBrowser();
  console.log(
    "READY: validação remota concluída, registros financeiros limpos; aguardando deploy.",
  );
  try {
    let signal;
    while (Date.now() - started < 1200000) {
      try {
        const candidate = JSON.parse(
          await readFile("test-results/production-ready.json", "utf8"),
        );
        if (candidate.created_at >= started) {
          signal = candidate;
          break;
        }
      } catch {
        /* A fresh deploy signal is not available yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!signal) throw new Error("Deploy não sinalizado em 20 minutos.");
    await validateProduction(browser, actors[0], signal);
    await writeFile(
      "test-results/production-validation.json",
      JSON.stringify(
        {
          passed: true,
          commit: signal.commit,
          url: signal.url,
          auth: true,
          pwa: true,
          mobile: [375, 390, 430],
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.browser.close();
  }
}
