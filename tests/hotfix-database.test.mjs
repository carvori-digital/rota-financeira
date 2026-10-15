import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID as id } from "node:crypto";

test("hotfix 013: migration preserves history; variable, partial, skipped, archived, idempotent and isolated occurrences", async (t) => {
  const db = new PGlite(),
    a = id(),
    b = id();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const as = async (u) => {
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub',$1,false)", [u]);
    await db.exec("set role authenticated");
  };
  try {
    await db.exec(
      "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on sequences to anon,authenticated;",
    );
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files.filter((f) => f < "202610150013"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec(
      "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-15'$$",
    );
    await q("insert into auth.users values($1),($2)", [a, b]);
    await as(a);
    const cash = (
      await q(
        "insert into accounts(name,type,initial_balance_cents) values('Sintética','checking',100000) returning id",
      )
    )[0].id;
    const cat = (
      await q("select id from categories where type='expense' limit 1")
    )[0].id;
    const rule = (
      await q(
        "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Cemig','expense',36337,$1,$2,'monthly','2026-10-13') returning id",
        [cash, cat],
      )
    )[0].id;
    const october = id();
    await q("select resolve_recurring($1,$2,'2026-10-13',false)", [
      october,
      rule,
    ]);
    await q("update recurring_items set amount_cents=39678 where id=$1", [
      rule,
    ]);
    const txBefore = await q("select * from transactions order by id"),
      accountsBefore = await q("select * from accounts order by id");
    await db.exec("reset role");
    await db.exec(
      await readFile(
        "supabase/migrations/" +
          files.find((f) => f.startsWith("202610150013")),
        "utf8",
      ),
    );
    await as(a);
    await t.test(
      "migration snapshots actual October amount without rewriting ledger, date or bank balance",
      async () => {
        assert.deepEqual(
          await q("select * from transactions order by id"),
          txBefore,
        );
        assert.deepEqual(
          await q("select * from accounts order by id"),
          accountsBefore,
        );
        assert.equal(
          Number(
            (
              await q(
                "select amount_cents from recurring_occurrences where id=$1",
                [october],
              )
            )[0].amount_cents,
          ),
          36337,
        );
        await assert.rejects(
          q("update recurring_occurrences set amount_cents=39678 where id=$1", [
            october,
          ]),
        );
        await db.exec("reset role");
        await assert.rejects(
          q("update recurring_occurrences set amount_cents=39678 where id=$1", [
            october,
          ]),
          /imutável/,
        );
        await as(a);
      },
    );
    await t.test(
      "November has its own forecast, survives future rule edits and never changes October",
      async () => {
        await q(
          "select set_recurring_occurrence_amount($1,'2026-11-13',39678)",
          [rule],
        );
        await q("update recurring_items set amount_cents=42000 where id=$1", [
          rule,
        ]);
        const rows = await q(
          "select due_date::text,amount_cents,status from recurring_occurrences where recurring_item_id=$1 order by due_date",
          [rule],
        );
        assert.deepEqual(
          rows.map((o) => [o.due_date, Number(o.amount_cents), o.status]),
          [
            ["2026-10-13", 36337, "recorded"],
            ["2026-11-13", 39678, "planned"],
          ],
        );
        await assert.rejects(
          q("select set_recurring_occurrence_amount($1,'2026-10-13',1)", [
            rule,
          ]),
          /já registrada/,
        );
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-11-13')", [
            id(),
            rule,
          ]),
          /futura/,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          txBefore,
        );
      },
    );
    await t.test(
      "completed occurrence cannot post twice or be skipped, including after archive",
      async () => {
        await q("select resolve_recurring($1,$2,'2026-10-13',false)", [
          id(),
          rule,
        ]);
        await assert.rejects(
          q("select resolve_recurring($1,$2,'2026-10-13',true)", [id(), rule]),
          /já registrado/,
        );
        await q("update recurring_items set active=false where id=$1", [rule]);
        await q("select resolve_recurring($1,$2,'2026-10-13',false)", [
          id(),
          rule,
        ]);
        await assert.rejects(
          q("select set_recurring_occurrence_amount($1,'2026-12-13',1)", [
            rule,
          ]),
          /pausada/,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          txBefore,
        );
        await q("update recurring_items set active=true where id=$1", [rule]);
      },
    );
    await t.test(
      "default changes preserve unpaid due amounts and affect upcoming months only",
      async () => {
        const overdue = (
          await q(
            "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Gás','expense',10000,$1,$2,'monthly','2026-10-15') returning id",
            [cash, cat],
          )
        )[0].id;
        const before = await q("select * from transactions order by id");
        await q("update recurring_items set amount_cents=20000 where id=$1", [
          overdue,
        ]);
        const rows = await q(
          "select amount_cents,status from recurring_occurrences where recurring_item_id=$1",
          [overdue],
        );
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].amount_cents), 10000);
        assert.equal(rows[0].status, "planned");
        assert.deepEqual(
          await q("select * from transactions order by id"),
          before,
        );
      },
    );
    let variable, first, second;
    await t.test(
      "variable occurrence supports partial then integral payment with exact retry and no duplicate",
      async () => {
        variable = (
          await q(
            "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Água','expense',10000,$1,$2,'monthly','2026-10-14') returning id",
            [cash, cat],
          )
        )[0].id;
        await q(
          "select set_recurring_occurrence_amount($1,'2026-10-14',15000)",
          [variable],
        );
        first = id();
        await q(
          "select record_recurring_payment($1,$2,'2026-10-14',5000,'2026-10-14')",
          [first, variable],
        );
        await q(
          "select record_recurring_payment($1,$2,'2026-10-14',5000,'2026-10-14')",
          [first, variable],
        );
        await assert.rejects(
          q(
            "select record_recurring_payment($1,$2,'2026-10-14',6000,'2026-10-14')",
            [first, variable],
          ),
          /outros valores/,
        );
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-10-14',10001)", [
            id(),
            variable,
          ]),
          /saldo restante/,
        );
        await assert.rejects(
          q("select resolve_recurring($1,$2,'2026-10-14',true)", [
            id(),
            variable,
          ]),
          /já registrado/,
        );
        second = id();
        await q(
          "select record_recurring_payment($1,$2,'2026-10-14',10000,'2026-10-15')",
          [second, variable],
        );
        await q(
          "select record_recurring_payment($1,$2,'2026-10-14',10000,'2026-10-15')",
          [second, variable],
        );
        await q("select resolve_recurring($1,$2,'2026-10-14',false)", [
          id(),
          variable,
        ]);
        assert.equal((await q("select * from recurring_payments")).length, 1);
        assert.equal(
          Number(
            (
              await q(
                "select sum(amount_cents) total from transactions where id=$1 or id=$2",
                [first, second],
              )
            )[0].total,
          ),
          15000,
        );
        assert.equal(
          Number(
            (
              await q(
                "select amount_cents from recurring_occurrences where recurring_item_id=$1",
                [variable],
              )
            )[0].amount_cents,
          ),
          15000,
        );
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-10-13',10000)", [
            second,
            rule,
          ]),
          /utilizado/,
        );
      },
    );
    await t.test(
      "skipping a planned occurrence is idempotent and never creates money",
      async () => {
        const before = await q("select * from transactions order by id");
        await q("select resolve_recurring($1,$2,'2026-11-13',true)", [
          id(),
          rule,
        ]);
        await q("select resolve_recurring($1,$2,'2026-11-13',true)", [
          id(),
          rule,
        ]);
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-11-13')", [
            id(),
            rule,
          ]),
          /pulada/,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          before,
        );
      },
    );
    await t.test(
      "missing rules, invalid dates and cross-user references fail safely; RLS and export isolate A/B",
      async () => {
        await assert.rejects(
          q("select resolve_recurring($1,$2,'2026-10-13',false)", [id(), id()]),
          /não encontrada/,
        );
        await assert.rejects(
          q("select set_recurring_occurrence_amount($1,'2026-10-12',1)", [
            rule,
          ]),
          /Data fora/,
        );
        const snapshot = (await q("select export_financial_snapshot() s"))[0].s;
        assert.equal(snapshot.data.recurring_payments.length, 1);
        assert.ok(
          Object.values(snapshot.data)
            .flat()
            .every((r) => r.user_id === a),
        );
        await as(b);
        for (const table of [
          "recurring_items",
          "recurring_occurrences",
          "recurring_payments",
          "transactions",
        ])
          assert.equal((await q("select * from " + table)).length, 0);
        await assert.rejects(
          q("select set_recurring_occurrence_amount($1,'2026-12-13',1)", [
            rule,
          ]),
        );
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-10-14',1)", [
            id(),
            variable,
          ]),
        );
        await assert.rejects(
          q("select resolve_recurring($1,$2,'2026-10-13',true)", [id(), rule]),
        );
        await assert.rejects(
          q(
            "insert into recurring_payments(id,user_id,occurrence_id,transaction_id) values($1,$2,$3,$4)",
            [id(), b, october, second],
          ),
        );
        await as(a);
        assert.equal((await q("select * from recurring_payments")).length, 1);
        await db.exec("reset role;set role anon");
        await assert.rejects(
          q("select record_recurring_payment($1,$2,'2026-10-14',1)", [
            id(),
            variable,
          ]),
        );
      },
    );
  } finally {
    await db.close();
  }
});
