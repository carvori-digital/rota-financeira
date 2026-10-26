import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as id } from "node:crypto";
import { readFile } from "node:fs/promises";
import { financialFixture, normalizeRows } from "./financial-fixture.mjs";
import { emptyPlanning } from "../src/features/planning/types.ts";
import {
  subscriptionCharge,
  subscriptionCharges,
  planningInvoices,
} from "../src/features/subscriptions/calculations.ts";
import { projection, realized } from "../src/features/planning/calculations.ts";
import { wealthSummary } from "../src/features/investments/calculations.ts";

async function fixture() {
  const f = await financialFixture();
  f.card = (
    await f.q(
      "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cartão sintético',20,28,$1) returning id",
      [f.cash],
    )
  )[0].id;
  f.terms = {
    name: "Assinatura sintética",
    card_id: f.card,
    category_id: f.cat,
    amount_cents: 2000,
    start_date: "2026-10-01",
    billing_day: 13,
    status: "active",
    end_date: null,
  };
  f.save = async (
    subscription = id(),
    payload = {},
    expected = null,
    request = id(),
  ) => {
    await f.q("select save_card_subscription($1,$2,$3,$4)", [
      request,
      subscription,
      expected,
      { ...f.terms, ...payload },
    ]);
    return subscription;
  };
  f.resolve = (
    subscription,
    month = "2026-10-01",
    action = "confirm",
    amount = null,
    purchase = null,
    coverage = null,
    request = id(),
  ) =>
    f.q("select resolve_card_subscription($1,$2,$3,$4,$5,$6,$7)", [
      request,
      subscription,
      month,
      action,
      amount,
      purchase,
      coverage,
    ]);
  f.plan = async () => {
    const plan = { ...emptyPlanning };
    for (const table of Object.keys(emptyPlanning))
      plan[table] = normalizeRows(await f.q("select * from " + table));
    return plan;
  };
  f.version = async (s) =>
    (
      await f.q(
        "select id from card_subscription_versions where subscription_id=$1 order by effective_month desc,revision desc limit 1",
        [s],
      )
    )[0].id;
  return f;
}

test("monthly forecasts clamp short months and match SQL closing/due semantics without ledger writes", async () => {
  const f = await fixture();
  try {
    const s = await f.save(undefined, {
      billing_day: 31,
      start_date: "2026-01-31",
    });
    const plan = await f.plan();
    const charges = subscriptionCharges(plan, "2026-04-30");
    assert.deepEqual(
      charges.map((c) => c.charge_date),
      ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"],
    );
    assert.deepEqual(
      charges.map((c) => c.due_date),
      ["2026-02-28", "2026-03-28", "2026-04-28", "2026-05-28"],
    );
    await f.db.exec("reset role");
    for (const closing of [5, 20, 31])
      for (const due of [5, 28, 31]) {
        for (const date of [
          "2026-02-20",
          "2026-02-28",
          "2026-03-01",
          "2026-03-31",
        ]) {
          const { firstInvoiceDate } =
            await import("../src/features/cards/calculations.ts");
          const row = (
            await f.q("select card_charge_due($1,$2,$3)::text d", [
              date,
              closing,
              due,
            ])
          )[0];
          assert.equal(row.d, firstInvoiceDate(date, closing, due));
        }
      }
    await f.as(f.a);
    assert.equal((await f.q("select * from transactions")).length, 0);
    assert.equal((await f.q("select * from card_purchases")).length, 0);
    assert.equal(await f.bank(), 1000000);
    assert.equal(subscriptionCharge(plan, s, "2025-12"), null);
    await assert.rejects(f.resolve(s, "2026-11-01"), /somente após/);
  } finally {
    await f.db.close();
  }
});

test("future value/card changes, individual override, pause, resume, end and cancellation preserve past terms", async () => {
  const f = await fixture();
  try {
    const s = await f.save();
    await f.resolve(s, "2026-11-01", "adjust", 3500);
    const c2 = (
      await f.q(
        "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Outro cartão',10,5,$1) returning id",
        [f.cash],
      )
    )[0].id;
    await f.save(
      s,
      { effective_month: "2026-11-01", amount_cents: 3000, card_id: c2 },
      await f.version(s),
    );
    let plan = await f.plan();
    assert.equal(subscriptionCharge(plan, s, "2026-10").amount_cents, 2000);
    assert.equal(subscriptionCharge(plan, s, "2026-11").amount_cents, 3500);
    assert.equal(subscriptionCharge(plan, s, "2026-11").card_id, c2);
    assert.equal(subscriptionCharge(plan, s, "2026-11").due_date, "2027-01-05");
    assert.equal(subscriptionCharge(plan, s, "2026-12").amount_cents, 3000);
    await assert.rejects(
      f.save(s, { effective_month: "2026-10-01" }, await f.version(s)),
      /futuros/,
    );
    await f.save(
      s,
      { effective_month: "2026-12-01", status: "paused" },
      await f.version(s),
    );
    plan = await f.plan();
    assert.equal(subscriptionCharge(plan, s, "2026-12"), null);
    assert.equal(subscriptionCharge(plan, s, "2026-11").amount_cents, 3500);
    await f.save(
      s,
      { effective_month: "2027-01-01", end_date: "2027-02-13" },
      await f.version(s),
    );
    plan = await f.plan();
    assert.ok(subscriptionCharge(plan, s, "2027-02"));
    assert.equal(subscriptionCharge(plan, s, "2027-03"), null);
    await f.save(
      s,
      { effective_month: "2027-02-01", status: "cancelled" },
      await f.version(s),
    );
    assert.equal(subscriptionCharge(await f.plan(), s, "2027-02"), null);
    await assert.rejects(
      f.save(s, { effective_month: "2027-03-01" }, await f.version(s)),
      /cancelada/,
    );
    assert.equal((await f.q("select * from card_purchases")).length, 0);
  } finally {
    await f.db.close();
  }
});

test("confirmation creates one ordinary purchase; forecasts do not affect wealth or cash; audited payment debits once", async () => {
  const f = await fixture();
  try {
    const s = await f.save();
    let plan = await f.plan();
    const data = await f.data();
    assert.equal(planningInvoices(plan, [], "2026-10-15")[0].forecast, 2000);
    assert.equal(planningInvoices(plan, [], "2026-10-15")[0].payable, 0);
    assert.equal(wealthSummary(data, plan, "2026-10-15").cards, 0);
    assert.equal(projection(data, plan, "2026-10-15")[0].cards, 2000);
    await assert.rejects(
      f.q("select pay_card_invoice($1,$2,'2026-10',$3,2000,'2026-10-15')", [
        id(),
        f.card,
        f.cash,
      ]),
      /supera/,
    );
    const request = id();
    await f.resolve(s, undefined, undefined, 2100, null, null, request);
    await f.resolve(s, undefined, undefined, 2100, null, null, request);
    await f.resolve(s, undefined, undefined, 2100);
    plan = await f.plan();
    assert.equal(plan.card_purchases.length, 1);
    assert.equal(plan.card_purchases[0].installments, 1);
    assert.equal(planningInvoices(plan, [], "2026-10-15")[0].total, 2100);
    assert.equal(planningInvoices(plan, [], "2026-10-15")[0].forecast ?? 0, 0);
    assert.equal(wealthSummary(data, plan, "2026-10-15").cards, 2100);
    assert.equal(
      realized([], plan.card_purchases, "2026-10", "2026-10-15").expense,
      2100,
    );
    assert.equal(await f.bank(), 1000000);
    const payment = id();
    for (let i = 0; i < 2; i++)
      await f.q(
        "select pay_card_invoice($1,$2,'2026-10',$3,2100,'2026-10-15')",
        [payment, f.card, f.cash],
      );
    assert.equal(await f.bank(), 997900);
    assert.equal(
      planningInvoices(await f.plan(), undefined, "2026-10-15")[0].pending,
      0,
    );
    await assert.rejects(f.resolve(s, undefined, "adjust", 2500), /confirmada/);
    await assert.rejects(
      f.q("select correct_card_purchase($1,'{}',true)", [request]),
    );
    assert.ok(
      (
        await f.q(
          "select * from financial_audit where table_name='card_subscription_occurrences'",
        )
      ).length,
    );
  } finally {
    await f.db.close();
  }
});

test("manual invoices suppress uncertain forecasts; included/additional confirmation preserves partial and full payments", async () => {
  const f = await fixture();
  try {
    const s = await f.save();
    await f.q(
      "select set_card_invoice($1,$2,10000,'2026-10-28','Total sintético')",
      [id(), f.card],
    );
    await f.q("select pay_card_invoice($1,$2,'2026-10',$3,4000,'2026-10-15')", [
      id(),
      f.card,
      f.cash,
    ]);
    let bill = planningInvoices(await f.plan(), undefined, "2026-10-15")[0];
    assert.equal(bill.total, 10000);
    assert.equal(bill.pending, 6000);
    await assert.rejects(f.resolve(s), /já está incluída/);
    await f.resolve(s, undefined, "confirm", 2000, null, "included");
    bill = planningInvoices(await f.plan(), undefined, "2026-10-15")[0];
    assert.equal(bill.total, 10000);
    const s2 = await f.save();
    await f.resolve(s2, undefined, "confirm", 2500, null, "additional");
    bill = planningInvoices(await f.plan(), undefined, "2026-10-15")[0];
    assert.equal(bill.total, 12500);
    assert.equal(bill.pending, 8500);
    await f.q("select pay_card_invoice($1,$2,'2026-10',$3,8500,'2026-10-15')", [
      id(),
      f.card,
      f.cash,
    ]);
    const s3 = await f.save();
    await f.resolve(s3, undefined, "confirm", 500, null, "included");
    bill = planningInvoices(await f.plan(), undefined, "2026-10-15")[0];
    assert.equal(bill.pending, 0);
    assert.equal(await f.bank(), 987500);
  } finally {
    await f.db.close();
  }
});

test("explicit linking preserves existing purchase and invoice totals and refuses duplicate or foreign links", async () => {
  const f = await fixture();
  try {
    const purchase = id();
    await f.q("select create_card_purchase($1,$2)", [
      purchase,
      {
        card_id: f.card,
        category_id: f.cat,
        amount_cents: 1800,
        purchase_date: "2026-10-12",
        installments: 1,
        description: "Descrição sem correspondência automática",
      },
    ]);
    const before = await f.q("select * from card_purchases");
    await f.q("select set_card_invoice($1,$2,8000,'2026-10-28','Manual')", [
      id(),
      f.card,
    ]);
    const s = await f.save();
    assert.equal(
      (await f.q("select * from card_subscription_occurrences")).length,
      0,
    );
    await f.resolve(s, undefined, "link", null, purchase);
    assert.deepEqual(await f.q("select * from card_purchases"), before);
    assert.equal(
      planningInvoices(await f.plan(), undefined, "2026-10-15")[0].total,
      8000,
    );
    const s2 = await f.save();
    await assert.rejects(
      f.resolve(s2, undefined, "link", null, purchase),
      /já vinculada/,
    );
    await assert.rejects(
      f.q("select correct_card_purchase($1,'{}',true)", [purchase]),
      /vinculada protegida/,
    );
    assert.deepEqual(await f.q("select * from card_purchases"), before);
    await f.as(f.b);
    await assert.rejects(
      f.resolve(s, undefined, "link", null, purchase),
      /não encontrada/,
    );
    for (const t of [
      "card_subscriptions",
      "card_subscription_versions",
      "card_subscription_occurrences",
      "financial_requests",
      "financial_audit",
    ])
      assert.equal((await f.q("select * from " + t)).length, 0);
    await assert.rejects(f.save(), /cartão ativo/);
    await assert.rejects(
      f.q(
        "insert into card_subscriptions(id,user_id,start_date,billing_day) values($1,$2,'2026-10-01',13)",
        [id(), f.a],
      ),
      /permission denied/,
    );
  } finally {
    await f.db.close();
  }
});

test("stable request keys reject changed payloads, stale edits and unsupported direct writes; skip persists", async () => {
  const f = await fixture();
  try {
    const request = id(),
      s = id();
    await f.save(s, {}, null, request);
    await f.save(s, {}, null, request);
    await assert.rejects(
      f.save(s, { amount_cents: 9999 }, null, request),
      /outros parâmetros/,
    );
    const old = await f.version(s);
    await f.save(s, { effective_month: "2026-11-01", amount_cents: 2500 }, old);
    await assert.rejects(
      f.save(s, { effective_month: "2026-11-01" }, old),
      /outra sessão/,
    );
    const adjust = id();
    await f.resolve(s, "2026-11-01", "adjust", 2600, null, null, adjust);
    await f.save(
      s,
      { effective_month: "2026-11-01", amount_cents: 2700 },
      await f.version(s),
    );
    await f.resolve(s, "2026-11-01", "adjust", 2600, null, null, adjust);
    assert.equal(
      subscriptionCharge(await f.plan(), s, "2026-11").amount_cents,
      2600,
    );
    await f.resolve(s, "2026-12-01", "skip");
    assert.equal(
      subscriptionCharge(await f.plan(), s, "2026-12").status,
      "skipped",
    );
    for (const table of [
      "card_subscriptions",
      "card_subscription_versions",
      "card_subscription_occurrences",
    ])
      await assert.rejects(f.q(`delete from ${table}`), /permission denied/);
    await assert.rejects(
      f.q("select card_subscription_terms($1,'2026-10-01',$2)", [s, f.a]),
      /permission denied/,
    );
    const snapshot = (await f.q("select export_financial_snapshot() s"))[0].s;
    assert.equal(snapshot.data.card_subscriptions.length, 1);
    assert.equal(snapshot.counts.card_subscription_versions, 3);
    assert.equal(await f.bank(), 1000000);
  } finally {
    await f.db.close();
  }
});

test("015 changes no historical financial row when applied after 014", async () => {
  const f = await financialFixture("202610160015");
  try {
    const rule = await f.rule();
    await f.q("select resolve_recurring($1,$2,'2026-10-13',false)", [
      id(),
      rule,
    ]);
    const snapshot = (await f.q("select export_financial_snapshot() s"))[0].s;
    await f.db.exec("reset role");
    await f.db.exec(
      await readFile(
        "supabase/migrations/202610160015_card_subscriptions.sql",
        "utf8",
      ),
    );
    await f.as(f.a);
    const after = (await f.q("select export_financial_snapshot() s"))[0].s;
    for (const [table, rows] of Object.entries(snapshot.data))
      assert.deepEqual(after.data[table], rows, table);
    assert.equal(after.counts.card_subscriptions, 0);
  } finally {
    await f.db.close();
  }
});

test("card calendar edits preserve past dates and scheduled amount/card changes", async () => {
  const f = await fixture();
  try {
    const s = await f.save();
    await f.save(
      s,
      { effective_month: "2026-12-01", amount_cents: 3000 },
      await f.version(s),
    );
    const secondCard = (
      await f.q(
        "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Futuro cartão',20,28,$1) returning id",
        [f.cash],
      )
    )[0].id;
    await f.save(
      s,
      {
        effective_month: "2027-01-01",
        card_id: secondCard,
        amount_cents: 4000,
      },
      await f.version(s),
    );
    await f.q("update credit_cards set closing_day=10,due_day=5 where id=$1", [
      f.card,
    ]);
    const plan = await f.plan();
    assert.equal(subscriptionCharge(plan, s, "2026-10").due_date, "2026-10-28");
    assert.equal(subscriptionCharge(plan, s, "2026-11").due_date, "2027-01-05");
    assert.equal(subscriptionCharge(plan, s, "2026-11").amount_cents, 2000);
    assert.equal(subscriptionCharge(plan, s, "2026-12").due_date, "2027-02-05");
    assert.equal(subscriptionCharge(plan, s, "2026-12").amount_cents, 3000);
    assert.equal(subscriptionCharge(plan, s, "2027-01").card_id, secondCard);
    assert.equal(subscriptionCharge(plan, s, "2027-01").amount_cents, 4000);
    assert.equal(subscriptionCharge(plan, s, "2027-01").due_date, "2027-01-28");
    await f.save(
      s,
      {
        effective_month: "2027-02-01",
        amount_cents: 4500,
        card_id: secondCard,
      },
      await f.version(s),
    );
    assert.equal(
      subscriptionCharge(await f.plan(), s, "2027-02").amount_cents,
      4500,
    );
    assert.equal((await f.q("select * from card_purchases")).length, 0);
    assert.equal(await f.bank(), 1000000);
  } finally {
    await f.db.close();
  }
});
