import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as id } from "node:crypto";
import { readFile } from "node:fs/promises";
import { financialFixture, normalizeRows } from "./financial-fixture.mjs";
import { emptyPlanning } from "../src/features/planning/types.ts";
import { monthlyCommitments } from "../src/features/planning/commitments.ts";
import { projection } from "../src/features/planning/calculations.ts";

for (const [label, through, has013, has014] of [
  ["012", "202610150013", false, false],
  ["013", "202610150014", true, false],
  ["014", "9999", true, true],
]) {
  test(`legacy diagnostic: read-only aggregate counts on ${label}`, async () => {
    const { db, q, rule } = await financialFixture(through);
    try {
      const r = await rule();
      await q("select resolve_recurring($1,$2,'2026-10-13',false)", [id(), r]);
      const before = await q("select * from transactions order by id");
      const results = await db.exec(
        await readFile("scripts/audit-legacy-counts-readonly.sql", "utf8"),
      );
      const report = results
        .flatMap((result) => result.rows)
        .find((row) => row.diagnostic).diagnostic;
      assert.equal(report.read_only, "on");
      assert.equal(report.has_013, has013);
      assert.equal(report.has_014, has014);
      assert.equal(report.inventory.transactions, 1);
      assert.equal(report.signals.recorded_occurrence_without_matching_cash, 0);
      assert.equal(
        report.signals.recorded_occurrence_without_captured_amount,
        has013 ? 0 : 1,
      );
      assert.equal(
        report.signals.occurrence_without_frozen_terms,
        has014 ? 0 : 1,
      );
      assert.deepEqual(
        await q("select * from transactions order by id"),
        before,
      );
    } finally {
      await db.close();
    }
  });
}

test("012 → 013 → 014 preserves legacy future recurring income until explicit confirmation or cancellation", async () => {
  const { db, q, as, a, cash, income, bank } =
    await financialFixture("202610150013");
  try {
    const requests = [id(), id()],
      rules = [id(), id()];
    for (let i = 0; i < 2; i++) {
      await q(
        "insert into transactions(id,type,account_id,category_id,amount_cents,transaction_date,status,description) values($1,'income',$2,$3,7000,'2026-11-13','pending','Receita sintética futura')",
        [requests[i], cash, income],
      );
      await q("select repeat_transaction($1,$2,$3,true)", [
        requests[i],
        rules[i],
        { recurrence_frequency: "monthly" },
      ]);
    }
    const ledger = await q("select * from transactions order by id");
    let occurrences = await q(
      "select * from recurring_occurrences order by id",
    );
    const balance = await bank();
    for (const file of [
      "202610150013_recurring_occurrence_amounts.sql",
      "202610150014_financial_boundaries.sql",
    ]) {
      await db.exec("reset role");
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
      await as(a);
      assert.deepEqual(
        await q("select * from transactions order by id"),
        ledger,
      );
      assert.equal(await bank(), balance);
      const migrated = await q(
        "select * from recurring_occurrences order by id",
      );
      for (let i = 0; i < occurrences.length; i++) {
        for (const key of Object.keys(occurrences[i])) {
          // 013 already backfills amount through protect_row, updating this
          // metadata timestamp. 014 must preserve every column from 013.
          if (file.startsWith("202610150013") && key === "updated_at") {
            assert.ok(migrated[i][key] >= occurrences[i][key]);
            continue;
          }
          assert.deepEqual(migrated[i][key], occurrences[i][key]);
        }
        assert.equal(Number(migrated[i].amount_cents), 7000);
      }
      occurrences = migrated;
    }
    const request = id();
    await q(
      "select record_recurring_payment($1,$2,'2026-11-13',7000,'2026-10-15')",
      [request, rules[0]],
    );
    await q(
      "select record_recurring_payment($1,$2,'2026-11-13',7000,'2026-10-15')",
      [request, rules[0]],
    );
    await q("select resolve_recurring($1,$2,'2026-11-13',true)", [
      id(),
      rules[1],
    ]);
    assert.equal(await bank(), balance + 7000);
    assert.equal((await q("select * from transactions")).length, 2);
    assert.equal(
      (await q("select status from transactions where id=$1", [requests[0]]))[0]
        .status,
      "realized",
    );
    assert.equal(
      (await q("select status from transactions where id=$1", [requests[1]]))[0]
        .status,
      "cancelled",
    );
    assert.equal(
      (
        await q(
          "select due_date::text d from recurring_occurrences where recurring_item_id=$1",
          [rules[0]],
        )
      )[0].d,
      "2026-11-13",
    );
  } finally {
    await db.close();
  }
});

test("structural audit: preserve facts, snapshots, allocations, request binding and user isolation", async (t) => {
  const f = await financialFixture("202610150014"),
    { db, q, as, a, b, cash, other, cat, income, rule, bank } = f;
  const r = await rule(),
    first = id();
  await q(
    "select record_recurring_payment($1,$2,'2026-10-13',4000,'2026-10-13')",
    [first, r],
  );
  await db.exec(
    await readFile("scripts/audit-financial-preflight.sql", "utf8"),
  );
  const ledgerBefore = await q("select * from transactions order by id");
  const occurrencesBefore = await q(
    "select * from recurring_occurrences order by id",
  );
  await db.exec("reset role");
  await db.exec(
    await readFile(
      "supabase/migrations/202610150014_financial_boundaries.sql",
      "utf8",
    ),
  );
  await as(a);
  const snapshot = async () => {
    const raw = (await q("select export_financial_snapshot() s"))[0].s;
    const data = {};
    const plan = { ...emptyPlanning };
    for (const [table, rows] of Object.entries(raw.data)) {
      if (
        [
          "accounts",
          "categories",
          "transactions",
          "goals",
          "goal_contributions",
        ].includes(table)
      )
        data[table] = normalizeRows(rows);
      else if (table in plan) plan[table] = normalizeRows(rows);
    }
    return { data, plan, raw };
  };
  try {
    await t.test(
      "014 adds structure without modifying bank facts or opening balances",
      async () => {
        await db.exec(
          await readFile("scripts/audit-financial-preflight.sql", "utf8"),
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          ledgerBefore,
        );
        const added = new Set([
          "terms",
          "obligation_account_id",
          "obligation_category_id",
          "obligation_type",
        ]);
        assert.deepEqual(
          (await q("select * from recurring_occurrences order by id")).map(
            (row) =>
              Object.fromEntries(
                Object.entries(row).filter(([key]) => !added.has(key)),
              ),
          ),
          occurrencesBefore,
        );
        assert.equal(await bank(), 996000);
      },
    );
    await t.test(
      "P1: changing rule type/account/category/calendar cannot reclassify or reopen historical partials",
      async () => {
        await q(
          "update recurring_items set type='income',account_id=$2,category_id=$3,frequency='weekly',start_date='2026-11-20',amount_cents=20000 where id=$1",
          [r, other, income],
        );
        let { data, plan } = await snapshot();
        let c = monthlyCommitments(data, plan, "2026-10-15").find(
          (c) => c.entity === r,
        );
        assert.equal(c.paid, 4000);
        assert.equal(c.impact, -6000);
        assert.equal(c.direction, "expense");
        const next = id();
        await q(
          "select record_recurring_payment($1,$2,'2026-10-13',6000,'2026-10-15')",
          [next, r],
        );
        const tx = (
          await q("select * from transactions where id=$1", [next])
        )[0];
        assert.equal(tx.type, "expense");
        assert.equal(tx.account_id, cash);
        assert.equal(tx.category_id, cat);
        ({ data, plan } = await snapshot());
        c = monthlyCommitments(data, plan, "2026-10-15").find(
          (c) => c.entity === r,
        );
        assert.equal(c.status, "completed");
        assert.equal(c.amount, 10000);
      },
    );
    await t.test(
      "P0: realized linked payments and supplementary payments cannot be rewritten or deleted",
      async () => {
        const before = await bank();
        await assert.rejects(
          q("update transactions set amount_cents=1000 where id=$1", [first]),
          /protegido/,
        );
        await assert.rejects(
          q("delete from transactions where id=$1", [first]),
          /protegido/,
        );
        assert.equal(await bank(), before);
      },
    );
    await t.test(
      "P1: planned overdue obligation survives date, frequency, price and archive changes",
      async () => {
        const rr = await rule();
        await q(
          "select set_recurring_occurrence_amount($1,'2026-10-13',15000)",
          [rr],
        );
        await q(
          "update recurring_items set start_date='2026-11-20',frequency='weekly',amount_cents=30000,active=false,type='income',category_id=$2,account_id=$3 where id=$1",
          [rr, income, other],
        );
        const { data, plan } = await snapshot();
        const c = projection(data, plan, "2026-10-15")[0].items.find(
          (c) => c.entity === rr,
        );
        assert.equal(c.amount, 15000);
        assert.equal(c.due, "2026-10-13");
        const payment = id();
        await q(
          "select record_recurring_payment($1,$2,'2026-10-13',15000,'2026-10-15')",
          [payment, rr],
        );
        const actual = (
          await q("select type,account_id from transactions where id=$1", [
            payment,
          ])
        )[0];
        assert.equal(actual.type, "expense");
        assert.equal(actual.account_id, cash);
      },
    );
    await t.test(
      "P1: a future competence can be paid today without future cash or a second obligation",
      async () => {
        const rr = await rule({ start: "2026-11-13" }),
          request = id(),
          before = await bank();
        await q(
          "select record_recurring_payment($1,$2,'2026-11-13',10000,'2026-10-15')",
          [request, rr],
        );
        await q(
          "select record_recurring_payment($1,$2,'2026-11-13',10000,'2026-10-15')",
          [request, rr],
        );
        assert.equal(await bank(), before - 10000);
        const { data, plan } = await snapshot();
        assert.equal(
          projection(data, plan, "2026-10-15")
            .flatMap((m) => m.items)
            .filter((c) => c.entity === rr && c.due === "2026-11-13").length,
          0,
        );
      },
    );
    await t.test(
      "P0: legacy investment delete cannot recreate bank money; safe deletion preserves all bank facts",
      async () => {
        const investment = id();
        await q("select create_simple_investment($1,$2)", [
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
        await q(
          "select simple_investment_movement($1,$2,'contribution',1000,'2026-10-15',$3,'Conferido: teste',null,10000,true)",
          [id(), investment, cash],
        );
        const before = await bank(),
          rows = await q("select * from transactions order by id");
        await assert.rejects(
          q("select delete_investment($1)", [investment]),
          /antiga desativada/,
        );
        await assert.rejects(
          q(
            "select record_investment_movement($1,$2,'withdrawal',1000,'2026-10-15',$3,'antiga')",
            [id(), investment, cash],
          ),
          /permission denied/,
        );
        await q("select delete_simple_investment($1,$2,11000,true)", [
          id(),
          investment,
        ]);
        assert.equal(await bank(), before);
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
      },
    );
    let debt, pay;
    await t.test(
      "P1: one advance debt payment allocates multiple competences with one bank debit",
      async () => {
        debt = (
          await q(
            "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents,next_due_date,payment_account_id) values('Parcelas',30000,30000,10000,'2026-10-13',$1) returning id",
            [cash],
          )
        )[0].id;
        pay = id();
        const before = await bank();
        await q("select pay_debt($1,$2,$3,25000,'2026-10-15')", [
          pay,
          debt,
          cash,
        ]);
        await q("select pay_debt($1,$2,$3,25000,'2026-10-15')", [
          pay,
          debt,
          cash,
        ]);
        assert.equal(await bank(), before - 25000);
        assert.deepEqual(
          normalizeRows(
            await q(
              "select scheduled_date,amount_cents,obligation_amount_cents from debt_payment_allocations where payment_id=$1 order by scheduled_date",
              [pay],
            ),
          ).map((x) => [
            x.scheduled_date,
            Number(x.amount_cents),
            Number(x.obligation_amount_cents),
          ]),
          [
            ["2026-10-13", 10000, 10000],
            ["2026-11-13", 10000, 10000],
            ["2026-12-13", 5000, 10000],
          ],
        );
        const { data, plan } = await snapshot();
        assert.equal(
          monthlyCommitments(data, plan, "2026-10-15", "2026-11").find(
            (c) => c.entity === debt,
          ).status,
          "completed",
        );
        assert.equal(
          monthlyCommitments(data, plan, "2026-10-15", "2026-12").find(
            (c) => c.entity === debt,
          ).impact,
          -5000,
        );
        await assert.rejects(
          q("select pay_debt($1,$2,$3,1,'2026-10-15')", [pay, debt, cash]),
          /outros parâmetros/,
        );
      },
    );
    await t.test(
      "debt terms are protected after payment; archiving cannot hide a recorded partial remainder",
      async () => {
        await assert.rejects(
          q("update debts set installment_amount_cents=20000 where id=$1", [
            debt,
          ]),
          /Calendário/,
        );
        await q("update debts set active=false where id=$1", [debt]);
        const { data, plan } = await snapshot();
        const c = projection(data, plan, "2026-10-15")
          .flatMap((m) => m.items)
          .find((c) => c.entity === debt);
        assert.equal(c.amount, 5000);
      },
    );
    await t.test(
      "P1: invoice request journal survives later corrections and rejects changed replay",
      async () => {
        const card = (
          await q(
            "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cartão',1,13,$1) returning id",
            [cash],
          )
        )[0].id;
        const req1 = id(),
          req2 = id(),
          req3 = id();
        for (const [req, value] of [
          [req1, 10000],
          [req2, 20000],
          [req3, 30000],
        ])
          await q(
            "select set_card_invoice($1,$2,$3,'2026-10-13','Fatura sintética')",
            [req, card, value],
          );
        const before = await q("select * from card_invoices where card_id=$1", [
          card,
        ]);
        await q(
          "select set_card_invoice($1,$2,20000,'2026-10-13','Fatura sintética')",
          [req2, card],
        );
        assert.deepEqual(
          await q("select * from card_invoices where card_id=$1", [card]),
          before,
        );
        await assert.rejects(
          q(
            "select set_card_invoice($1,$2,9999,'2026-10-13','Fatura sintética')",
            [req2, card],
          ),
          /outros parâmetros/,
        );
        const cp = id();
        await q(
          "select pay_card_invoice($1,$2,'2026-10',$3,5000,'2026-10-15')",
          [cp, card, cash],
        );
        await assert.rejects(
          q("select pay_card_invoice($1,$2,'2026-10',$3,6000,'2026-10-15')", [
            cp,
            card,
            cash,
          ]),
          /outros parâmetros/,
        );
        const purchase = id(),
          adjustment = id();
        await q("select create_card_purchase($1,$2)", [
          purchase,
          {
            card_id: card,
            category_id: cat,
            amount_cents: 1000,
            description: "Compra sintética",
            purchase_date: "2026-10-13",
            installments: 1,
            first_due_date: "2026-11-13",
          },
        ]);
        for (let n = 0; n < 2; n++)
          await q(
            "select adjust_card_purchase($1,$2,'2026-11-13',-100,'Crédito')",
            [adjustment, purchase],
          );
        await assert.rejects(
          q("select adjust_card_purchase($1,$2,'2026-11-13',-200,'Crédito')", [
            adjustment,
            purchase,
          ]),
          /outros parâmetros/,
        );
        assert.equal(
          Number(
            (
              await q("select amount_cents from card_adjustments where id=$1", [
                adjustment,
              ])
            )[0].amount_cents,
          ),
          -100,
        );
      },
    );
    await t.test(
      "transaction creation binds retries and scheduled cash needs explicit resolution",
      async () => {
        const request = id();
        const payload = {
          type: "transfer",
          account_id: cash,
          destination_account_id: other,
          category_id: null,
          amount_cents: 1234,
          description: "Transferência futura",
          transaction_date: "2026-11-01",
          status: "realized",
        };
        const before = await bank();
        for (let n = 0; n < 2; n++)
          await q("select create_financial_transaction($1,$2)", [
            request,
            payload,
          ]);
        assert.equal(await bank(), before);
        assert.equal(
          (await q("select status from transactions where id=$1", [request]))[0]
            .status,
          "pending",
        );
        await assert.rejects(
          q("select create_financial_transaction($1,$2)", [
            request,
            { ...payload, amount_cents: 5678 },
          ]),
          /outros parâmetros/,
        );
        await q("select resolve_transaction($1,false,'2026-10-15')", [request]);
        await q("select resolve_transaction($1,false,'2026-10-15')", [request]);
        assert.equal(await bank(), before - 1234);
        await assert.rejects(
          q("select resolve_transaction($1,true,'2026-10-15')", [request]),
          /outra ação/,
        );
      },
    );
    await t.test(
      "explicit ordinary transaction edits/deletions retain append-only history",
      async () => {
        const tt = (
          await q(
            "insert into transactions(account_id,category_id,type,amount_cents,description,transaction_date) values($1,$2,'expense',100,'Gasto','2026-10-15') returning id",
            [cash, cat],
          )
        )[0].id;
        await q("update transactions set amount_cents=200 where id=$1", [tt]);
        await q("delete from transactions where id=$1", [tt]);
        const audit = await q(
          "select action,before_row,after_row from financial_audit where row_id=$1 order by created_at,id",
          [tt],
        );
        assert.equal(audit.length, 3);
        assert.ok(
          audit.some(
            (e) =>
              e.action === "UPDATE" &&
              Number(e.before_row.amount_cents) === 100 &&
              Number(e.after_row.amount_cents) === 200,
          ),
        );
        assert.ok(
          audit.some((e) => e.action === "DELETE" && e.before_row.id === tt),
        );
        await assert.rejects(
          q("delete from financial_audit where row_id=$1", [tt]),
          /permission denied/,
        );
      },
    );
    await t.test(
      "RLS: B cannot inspect facts, snapshots, requests, allocations or audit of A",
      async () => {
        await as(b);
        for (const table of [
          "financial_audit",
          "financial_requests",
          "debt_payment_allocations",
          "recurring_occurrences",
          "transactions",
        ])
          assert.equal((await q("select * from " + table)).length, 0);
        await assert.rejects(
          q(
            "select record_recurring_payment($1,$2,'2026-10-13',1,'2026-10-15')",
            [id(), r],
          ),
        );
        await assert.rejects(
          q("select pay_debt($1,$2,$3,1,'2026-10-15')", [pay, debt, cash]),
        );
        const s = (await q("select export_financial_snapshot() s"))[0].s;
        assert.equal(s.data.financial_audit.length, 0);
        await as(a);
      },
    );
  } finally {
    await db.close();
  }
});
