// Native PostgreSQL only, spawned from explicit local test binaries. No remote DB.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID as id } from "node:crypto";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  bin = process.env.PG_TEST_BIN;
if (!bin || !process.env.PG_TEST_MODULE)
  throw new Error(
    "Configure PG_TEST_BIN (native bin directory) and PG_TEST_MODULE (local pg module). Only a new localhost cluster is used.",
  );
const module = await import(pathToFileURL(process.env.PG_TEST_MODULE).href),
  { Client } = module.default ?? module;
await mkdir("test-results/audit", { recursive: true });
const root = await mkdtemp(resolve("test-results/audit/pg-")),
  port = 55483;
const env = {
  ...process.env,
  LD_LIBRARY_PATH:
    resolve(bin, "../lib") +
    (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""),
};
let started = false;
const clients = [],
  checks = [];
const connect = async () => {
  const c = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await c.connect();
  clients.push(c);
  return c;
};
const as = async (c, u) => {
  await c.query("select set_config('request.jwt.claim.sub',$1,false)", [u]);
  await c.query("set role authenticated");
};
const q = async (c, s, p = []) => (await c.query(s, p)).rows;
const race = async (label, calls, success) => {
  const results = await Promise.allSettled(calls);
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    success,
    label +
      ": " +
      results
        .map((r) => (r.status === "rejected" ? r.reason.message : "ok"))
        .join(";"),
  );
  checks.push(label);
};
try {
  await exec(
    resolve(bin, "initdb"),
    [
      "-D",
      root + "/data",
      "-U",
      "postgres",
      "--auth=trust",
      "--no-locale",
      "-E",
      "UTF8",
    ],
    { env, timeout: 30000 },
  );
  await exec(
    resolve(bin, "pg_ctl"),
    [
      "-D",
      root + "/data",
      "-l",
      root + "/server.log",
      "-o",
      // pg_ctl parses -o again: quote socket paths that contain spaces.
      // Windows tests use TCP only and do not need a Unix socket directory.
      `-p ${port} -h 127.0.0.1${process.platform === "win32" ? ' -k ""' : ` -k "${root}"`}`,
      "-w",
      "start",
    ],
    { env, timeout: 30000 },
  );
  started = true;
  const admin = await connect(),
    version = (await q(admin, "select version() v"))[0].v;
  await admin.query(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on sequences to anon,authenticated;",
  );
  for (const f of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await admin.query(await readFile("supabase/migrations/" + f, "utf8"));
  await admin.query(
    "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-15'$$",
  );
  const a = id(),
    b = id();
  await q(admin, "insert into auth.users values($1),($2)", [a, b]);
  const c1 = await connect(),
    c2 = await connect(),
    cb = await connect();
  await as(c1, a);
  await as(c2, a);
  await as(cb, b);
  const cash = (
    await q(
      c1,
      "insert into accounts(name,type,initial_balance_cents) values('Banco sintético','checking',1000000) returning id",
    )
  )[0].id;
  const cat = (
    await q(c1, "select id from categories where type='expense' limit 1")
  )[0].id;
  const inc = (
    await q(c1, "select id from categories where type='income' limit 1")
  )[0].id;
  const makeRule = async () =>
    (
      await q(
        c1,
        "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Conta','expense',10000,$1,$2,'monthly','2026-10-13') returning id",
        [cash, cat],
      )
    )[0].id;
  const pay = (c, req, r, amount = 10000) =>
    q(
      c,
      "select record_recurring_payment($1,$2,'2026-10-13',$3,'2026-10-15')",
      [req, r, amount],
    );
  let r = await makeRule(),
    req = id();
  await race(
    "same recurring request concurrently: one debit, two successful exact replies",
    [pay(c1, req, r), pay(c2, req, r)],
    2,
  );
  assert.equal(
    (await q(c1, "select * from transactions where id=$1", [req])).length,
    1,
  );
  r = await makeRule();
  await race(
    "different requests for one full obligation: never two debits",
    [pay(c1, id(), r), pay(c2, id(), r)],
    2,
  );
  assert.equal(
    (
      await q(
        c1,
        "select * from recurring_occurrences where recurring_item_id=$1",
        [r],
      )
    ).length,
    1,
  );
  assert.equal(
    Number(
      (
        await q(
          c1,
          "select count(*) n from transactions t join recurring_occurrences o on t.id=o.transaction_id where o.recurring_item_id=$1",
          [r],
        )
      )[0].n,
    ),
    1,
  );
  r = await makeRule();
  await race(
    "concurrent partials cannot exceed amount owed",
    [pay(c1, id(), r, 6000), pay(c2, id(), r, 6000)],
    1,
  );
  const debt = (
    await q(
      c1,
      "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents,next_due_date,payment_account_id) values('Dívida',10000,10000,10000,'2026-10-13',$1) returning id",
      [cash],
    )
  )[0].id;
  await race(
    "concurrent debt payments cannot exceed remaining principal",
    [
      q(c1, "select pay_debt($1,$2,$3,7000,'2026-10-15')", [id(), debt, cash]),
      q(c2, "select pay_debt($1,$2,$3,7000,'2026-10-15')", [id(), debt, cash]),
    ],
    1,
  );
  assert.equal(
    Number(
      (
        await q(c1, "select remaining_amount_cents from debts where id=$1", [
          debt,
        ])
      )[0].remaining_amount_cents,
    ),
    3000,
  );
  const card = (
    await q(
      c1,
      "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cartão',1,13,$1) returning id",
      [cash],
    )
  )[0].id;
  await q(c1, "select set_card_invoice($1,$2,10000,'2026-10-13','Fatura')", [
    id(),
    card,
  ]);
  await race(
    "concurrent invoice payments cannot exceed invoice due",
    [
      q(c1, "select pay_card_invoice($1,$2,'2026-10',$3,7000,'2026-10-15')", [
        id(),
        card,
        cash,
      ]),
      q(c2, "select pay_card_invoice($1,$2,'2026-10',$3,7000,'2026-10-15')", [
        id(),
        card,
        cash,
      ]),
    ],
    1,
  );
  r = await makeRule();
  await q(c1, "select set_recurring_occurrence_amount($1,'2026-10-13',10000)", [
    r,
  ]);
  req = id();
  await race(
    "editing future rule and paying captured obligation preserve original expense",
    [
      q(
        c1,
        "update recurring_items set type='income',category_id=$2,start_date='2026-11-20' where id=$1",
        [r, inc],
      ),
      pay(c2, req, r),
    ],
    2,
  );
  assert.equal(
    (await q(c1, "select type from transactions where id=$1", [req]))[0].type,
    "expense",
  );
  const payload = {
    type: "transfer",
    account_id: cash,
    destination_account_id: (
      await q(
        c1,
        "insert into accounts(name,type) values('Destino','checking') returning id",
      )
    )[0].id,
    category_id: null,
    amount_cents: 1000,
    transaction_date: "2026-10-15",
    description: "Transferência real",
    is_recurring: false,
    recurrence_frequency: null,
  };
  req = id();
  await race(
    "transfer request retries concurrently preserve one origin and destination movement",
    [
      q(c1, "select create_financial_transaction($1,$2)", [req, payload]),
      q(c2, "select create_financial_transaction($1,$2)", [req, payload]),
    ],
    2,
  );
  await assert.rejects(
    q(c1, "select create_financial_transaction($1,$2)", [
      req,
      { ...payload, amount_cents: 2000 },
    ]),
    /outros parâmetros/,
  );
  assert.equal(
    Number(
      (
        await q(c1, "select amount_cents from transactions where id=$1", [req])
      )[0].amount_cents,
    ),
    1000,
  );
  const actual = Number(
    (
      await q(
        c1,
        "select a.initial_balance_cents+coalesce(sum(case when t.account_id=a.id then case when t.type='income' then t.amount_cents when t.type='adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end),0) balance from accounts a left join transactions t on (t.account_id=a.id or t.destination_account_id=a.id) and t.status='realized' group by a.id having a.id=$1",
        [cash],
      )
    )[0].balance,
  );
  await race(
    "two balance reconciliations with the same expected balance reject the stale one",
    [
      q(c1, "select reconcile_operational_balance($1,$2,$3,$4)", [
        id(),
        cash,
        actual + 100,
        actual,
      ]),
      q(c2, "select reconcile_operational_balance($1,$2,$3,$4)", [
        id(),
        cash,
        actual + 200,
        actual,
      ]),
    ],
    1,
  );
  const investment = id();
  await q(c1, "select create_simple_investment($1,$2)", [
    investment,
    {
      name: "Posição",
      institution: "Banco",
      type: "RDB",
      initial_date: "2026-10-01",
      initial_cents: 10000,
      yield_type: "manual",
      yield_rate: 0,
      reserve: true,
      acknowledged: true,
    },
  ]);
  await race(
    "concurrent withdrawals with the same expected position cannot duplicate credit",
    [
      q(
        c1,
        "select simple_investment_movement($1,$2,'withdrawal',7000,'2026-10-15',$3,'Conferido: sintético',null,10000,true)",
        [id(), investment, cash],
      ),
      q(
        c2,
        "select simple_investment_movement($1,$2,'withdrawal',7000,'2026-10-15',$3,'Conferido: sintético',null,10000,true)",
        [id(), investment, cash],
      ),
    ],
    1,
  );
  assert.equal(
    Number(
      (
        await q(c1, "select investment_value($1,'2026-10-15') v", [investment])
      )[0].v,
    ),
    3000,
  );
  const mirror = (
    await q(
      c1,
      "insert into accounts(name,type) values('Origem sintética','savings') returning id",
    )
  )[0].id;
  const transferId = id();
  await q(c1, "select create_financial_transaction($1,$2)", [
    transferId,
    { ...payload, destination_account_id: mirror },
  ]);
  await q(
    admin,
    "update accounts set investment_retired=true,is_active=false where id=$1",
    [mirror],
  );
  const reconcileInvestment = id();
  await q(c1, "select create_simple_investment($1,$2)", [
    reconcileInvestment,
    {
      name: "Conciliada",
      institution: "Banco",
      type: "RDB",
      initial_date: "2026-10-01",
      initial_cents: 0,
      yield_type: "manual",
      yield_rate: 0,
      reserve: true,
      acknowledged: true,
    },
  ]);
  const ledgerBefore = await q(c1, "select * from transactions order by id");
  await race(
    "concurrent reconciliation of an existing transfer adds one position and no bank debit",
    [
      q(
        c1,
        "select simple_investment_movement($1,$2,'contribution',1000,'2026-10-15',$3,'Conciliação',$4,0,true)",
        [id(), reconcileInvestment, cash, transferId],
      ),
      q(
        c2,
        "select simple_investment_movement($1,$2,'contribution',1000,'2026-10-15',$3,'Conciliação',$4,0,true)",
        [id(), reconcileInvestment, cash, transferId],
      ),
    ],
    1,
  );
  assert.deepEqual(
    await q(c1, "select * from transactions order by id"),
    ledgerBefore,
  );
  assert.equal(
    Number(
      (
        await q(c1, "select investment_value($1,'2026-10-15') v", [
          reconcileInvestment,
        ])
      )[0].v,
    ),
    1000,
  );
  // Subscription operations share card locks with manual baselines and payments.
  const subscriptionCard = (
    await q(
      c1,
      "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Assinaturas sintéticas',20,28,$1) returning id",
      [cash],
    )
  )[0].id;
  const terms = {
    name: "Mensal sintética",
    card_id: subscriptionCard,
    category_id: cat,
    amount_cents: 2000,
    start_date: "2026-10-01",
    billing_day: 13,
    status: "active",
    end_date: null,
  };
  const subSave = (c, request, subscription, expected = null, extra = {}) =>
    q(c, "select save_card_subscription($1,$2,$3,$4)", [
      request,
      subscription,
      expected,
      { ...terms, ...extra },
    ]);
  const subResolve = (
    c,
    request,
    subscription,
    action = "confirm",
    purchase = null,
    coverage = null,
  ) =>
    q(c, "select resolve_card_subscription($1,$2,'2026-10-01',$3,null,$4,$5)", [
      request,
      subscription,
      action,
      purchase,
      coverage,
    ]);
  const subscription = id(),
    subscriptionRequest = id();
  await race(
    "same subscription create request yields one version",
    [
      subSave(c1, subscriptionRequest, subscription),
      subSave(c2, subscriptionRequest, subscription),
    ],
    2,
  );
  assert.equal(
    (
      await q(
        c1,
        "select * from card_subscription_versions where subscription_id=$1",
        [subscription],
      )
    ).length,
    1,
  );
  await race(
    "concurrent future subscription edits reject stale expected version",
    [
      subSave(c1, id(), subscription, subscriptionRequest, {
        effective_month: "2026-11-01",
        amount_cents: 2300,
      }),
      subSave(c2, id(), subscription, subscriptionRequest, {
        effective_month: "2026-11-01",
        amount_cents: 2400,
      }),
    ],
    1,
  );
  await race(
    "different confirmations of one monthly charge create one purchase and no bank debit",
    [subResolve(c1, id(), subscription), subResolve(c2, id(), subscription)],
    2,
  );
  const occurrence = (
    await q(
      c1,
      "select * from card_subscription_occurrences where subscription_id=$1",
      [subscription],
    )
  )[0];
  assert.equal(
    (
      await q(c1, "select * from card_purchases where id=$1", [
        occurrence.purchase_id,
      ])
    ).length,
    1,
  );
  assert.equal(
    (
      await q(c1, "select * from transactions where id=$1", [
        occurrence.purchase_id,
      ])
    ).length,
    0,
  );
  const linkPurchase = id();
  await q(c1, "select create_card_purchase($1,$2)", [
    linkPurchase,
    {
      card_id: subscriptionCard,
      category_id: cat,
      amount_cents: 3000,
      purchase_date: "2026-10-13",
      installments: 1,
    },
  ]);
  const linkA = id(),
    linkB = id();
  await subSave(c1, id(), linkA);
  await subSave(c1, id(), linkB);
  await race(
    "one existing purchase cannot be linked to two subscriptions concurrently",
    [
      subResolve(c1, id(), linkA, "link", linkPurchase),
      subResolve(c2, id(), linkB, "link", linkPurchase),
    ],
    1,
  );
  const baselineSubscription = id();
  await subSave(c1, id(), baselineSubscription);
  await race(
    "manual invoice and included confirmation reconcile under the same lock",
    [
      q(
        c1,
        "select set_card_invoice($1,$2,10000,'2026-10-28','Fatura sintética')",
        [id(), subscriptionCard],
      ),
      subResolve(c2, id(), baselineSubscription, "confirm", null, "included"),
    ],
    2,
  );
  assert.equal(
    Number(
      (
        await q(admin, "select invoice_total($1,'2026-10',$2) n", [
          subscriptionCard,
          a,
        ])
      )[0].n,
    ),
    10000,
  );
  const paymentId = id();
  await race(
    "same subscription invoice payment is one bank debit",
    [
      q(c1, "select pay_card_invoice($1,$2,'2026-10',$3,10000,'2026-10-15')", [
        paymentId,
        subscriptionCard,
        cash,
      ]),
      q(c2, "select pay_card_invoice($1,$2,'2026-10',$3,10000,'2026-10-15')", [
        paymentId,
        subscriptionCard,
        cash,
      ]),
    ],
    2,
  );
  assert.equal(
    (await q(c1, "select * from transactions where id=$1", [paymentId])).length,
    1,
  );
  const paidSubscription = id();
  await subSave(c1, id(), paidSubscription);
  await subResolve(c1, id(), paidSubscription, "confirm", null, "included");
  assert.equal(
    Number(
      (
        await q(admin, "select invoice_total($1,'2026-10',$2) n", [
          subscriptionCard,
          a,
        ])
      )[0].n,
    ),
    10000,
  );
  await assert.rejects(subResolve(cb, id(), subscription));
  for (const table of [
    "card_subscriptions",
    "card_subscription_versions",
    "card_subscription_occurrences",
  ])
    assert.equal((await q(cb, "select * from " + table)).length, 0);
  checks.push(
    "subscription RLS, fully paid baseline and explicit purchase evidence",
  );
  await assert.rejects(pay(cb, id(), r));
  await assert.rejects(
    q(cb, "select create_financial_transaction($1,$2)", [req, payload]),
  );
  for (const table of [
    "financial_audit",
    "financial_requests",
    "debt_payment_allocations",
    "transactions",
  ])
    assert.equal((await q(cb, "select * from " + table)).length, 0);
  checks.push("RLS across simultaneous A/B sessions and replay keys");
  const chronologyCard = (
    await q(
      c1,
      "insert into credit_cards(name,closing_day,due_day) values('Ordem dos eventos',20,28) returning id",
    )
  )[0].id;
  // Transaction begins before a concurrent purchase, but the baseline is saved
  // afterwards: its coverage must include the now committed purchase.
  await c1.query("begin");
  await q(c2, "select create_card_purchase($1,$2)", [
    id(),
    {
      card_id: chronologyCard,
      category_id: cat,
      amount_cents: 2000,
      purchase_date: "2026-10-13",
      installments: 1,
    },
  ]);
  await q(
    c1,
    "select set_card_invoice($1,$2,10000,'2026-10-28','Extrato sintético')",
    [id(), chronologyCard],
  );
  await c1.query("commit");
  assert.equal(
    Number(
      (
        await q(admin, "select invoice_total($1,'2026-10',$2) n", [
          chronologyCard,
          a,
        ])
      )[0].n,
    ),
    10000,
  );
  // Transaction begins before the baseline but creates a purchase afterwards:
  // that purchase is additional and must not be silently swallowed.
  await c1.query("begin");
  await q(
    c2,
    "select set_card_invoice($1,$2,10000,'2026-10-28','Extrato sintético')",
    [id(), chronologyCard],
  );
  await q(c1, "select create_card_purchase($1,$2)", [
    id(),
    {
      card_id: chronologyCard,
      category_id: cat,
      amount_cents: 1500,
      purchase_date: "2026-10-13",
      installments: 1,
    },
  ]);
  await c1.query("commit");
  assert.equal(
    Number(
      (
        await q(admin, "select invoice_total($1,'2026-10',$2) n", [
          chronologyCard,
          a,
        ])
      )[0].n,
    ),
    11500,
  );
  checks.push(
    "card coverage and new purchase timestamps follow event order after the lock, not transaction start",
  );
  const overdraftAccount = (
    await q(
      c1,
      "insert into accounts(name,type) values('Cheque sintético','checking') returning id",
    )
  )[0].id;
  const overdraftConfigTerms = {
    tracking_start: "2026-10-01",
    effective_date: "2026-10-01",
    limit_cents: 100000,
    active: true,
    statement_model: "negative_balance",
    change_reason: "Contrato sintético",
  };
  const configure = (c, request, expected = null, extra = {}) =>
    q(c, "select save_account_overdraft($1,$2,$3,$4)", [
      request,
      overdraftAccount,
      expected,
      { ...overdraftConfigTerms, ...extra },
    ]);
  const configRequest = id();
  await race(
    "same overdraft configuration retry preserves one immutable version",
    [configure(c1, configRequest), configure(c2, configRequest)],
    2,
  );
  assert.equal(
    (
      await q(
        c1,
        "select * from account_overdraft_versions where account_id=$1",
        [overdraftAccount],
      )
    ).length,
    1,
  );
  await race(
    "competing overdraft limit versions reject stale expected revision",
    [
      configure(c1, id(), configRequest, {
        effective_date: "2026-10-15",
        limit_cents: 50000,
      }),
      configure(c2, id(), configRequest, {
        effective_date: "2026-10-15",
        limit_cents: 20000,
      }),
    ],
    1,
  );
  const debit = {
    type: "expense",
    account_id: overdraftAccount,
    category_id: cat,
    amount_cents: 30000,
    transaction_date: "2026-10-13",
  };
  await race(
    "concurrent independent negative-balance debit and receipt preserve the algebraic ledger",
    [
      q(c1, "select create_financial_transaction($1,$2)", [id(), debit]),
      q(c2, "select create_financial_transaction($1,$2)", [
        id(),
        { ...debit, type: "income", category_id: inc, amount_cents: 20000 },
      ]),
    ],
    2,
  );
  const chargeRequest = id(),
    charge = {
      ...debit,
      amount_cents: 1000,
      financial_charge: "overdraft_interest",
    };
  await race(
    "concurrent charged-interest retry creates one bank expense",
    [
      q(c1, "select create_financial_transaction($1,$2)", [
        chargeRequest,
        charge,
      ]),
      q(c2, "select create_financial_transaction($1,$2)", [
        chargeRequest,
        charge,
      ]),
    ],
    2,
  );
  assert.equal(
    Number(
      (
        await q(
          c1,
          "select sum(case when type='income' then amount_cents else -amount_cents end) n from transactions where account_id=$1",
          [overdraftAccount],
        )
      )[0].n,
    ),
    -11000,
  );
  // A concurrent uncommitted historical entry must not contaminate the
  // observation's captured ledger. Its later commit may change live history.
  await c1.query("begin");
  await q(c1, "select create_financial_transaction($1,$2)", [
    id(),
    { ...debit, amount_cents: 5000, transaction_date: "2026-10-01" },
  ]);
  const observation = id();
  await q(
    c2,
    "select record_bank_reconciliation($1,$2,'2026-10-15',-16000,-11000,'Extrato sintético com conferência explícita',true)",
    [observation, overdraftAccount],
  );
  await c1.query("commit");
  const captured = (
    await q(c2, "select * from bank_reconciliations where id=$1", [observation])
  )[0];
  assert.equal(Number(captured.calculated_balance_cents), -11000);
  assert.equal(captured.ledger_snapshot.transactions.length, 3);
  assert.equal(
    Number(
      (
        await q(
          c2,
          "select sum(case when type='income' then amount_cents else -amount_cents end) n from transactions where account_id=$1",
          [overdraftAccount],
        )
      )[0].n,
    ),
    -16000,
  );
  checks.push(
    "reconciliation captures consistent committed evidence while retroactive entry is in flight",
  );
  await assert.rejects(configure(cb, id()));
  for (const table of ["account_overdraft_versions", "bank_reconciliations"])
    assert.equal((await q(cb, "select * from " + table)).length, 0);
  checks.push(
    "overdraft contract and reconciliation RLS across concurrent owners",
  );
  const report = {
    passed: checks.length,
    checks,
    engine: version,
    host: "127.0.0.1",
    synthetic: true,
    remote_database: false,
  };
  await writeFile(
    "test-results/audit/concurrency.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const c of clients) await c.end();
  if (started)
    await exec(
      resolve(bin, "pg_ctl"),
      ["-D", root + "/data", "-m", "immediate", "-w", "stop"],
      { env, timeout: 30000 },
    );
}
