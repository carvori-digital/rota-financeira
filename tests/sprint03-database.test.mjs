import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
test("sprint03: additive migrations, reconstruction accounting, CDI and tenant isolation", async (t) => {
  const db = new PGlite(),
    a = randomUUID(),
    b = randomUUID();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const as = async (u) => {
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub',$1,false)", [u]);
    await db.exec("set role authenticated");
  };
  try {
    await db.exec(
      "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;",
    );
    const fs = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of fs.filter((f) => f < "202610030005"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec(
      "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-13'$$;",
    );
    await q("insert into auth.users values($1),($2)", [a, b]);
    await as(a);
    const cash = (
      await q(
        "insert into accounts(name,type,initial_balance_cents) values('Cash','checking',100000) returning *",
      )
    )[0];
    const reserve = (
      await q(
        "insert into accounts(name,type,initial_balance_cents,created_at) values('Reserva','savings',10000,'2026-09-01T00:00:00Z') returning *",
      )
    )[0];
    await q(
      "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$2,'transfer',5000,'2026-09-02')",
      [cash.id, reserve.id],
    );
    await db.exec("reset role");
    for (const f of fs.filter((f) => f >= "202610030005" && f < "202610130008"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await as(a);
    const old = (
      await q("select * from investments where source_account_id=$1", [
        reserve.id,
      ])
    )[0];
    const before = JSON.stringify({
      transactions: await q("select * from transactions order by id"),
      accounts: await q("select * from accounts order by id"),
      movements: await q("select * from investment_movements order by id"),
      investments: await q("select * from investments order by id"),
    });
    await db.exec("reset role");
    for (const f of fs.filter((f) => f >= "202610130008"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await as(a);
    const after = {
      transactions: await q("select * from transactions order by id"),
      accounts: await q("select * from accounts order by id"),
      movements: await q("select * from investment_movements order by id"),
      investments: await q("select * from investments order by id"),
    };
    const original = JSON.parse(before);
    for (const table of Object.keys(original))
      for (let i = 0; i < original[table].length; i++)
        for (const [k, v] of Object.entries(original[table][i]))
          assert.deepEqual(
            JSON.parse(JSON.stringify(after[table][i][k])),
            v,
            `${table}.${k} changed during structural migrations`,
          );
    const request = randomUUID(),
      replacement = randomUUID(),
      payload = {
        name: "Reserva nova",
        institution: "Nubank",
        product: "RDB",
        initial_date: "2026-09-01",
        yield_type: "percent_cdi",
        yield_rate: 115,
        history: [
          { type: "contribution", date: "2026-09-01", amount_cents: 10000 },
          { type: "contribution", date: "2026-09-02", amount_cents: 5000 },
        ],
        real_value_cents: 15500,
        note: "Fixture reconciliation",
        acknowledged: true,
      };
    await t.test(
      "invalid requests rollback and stale reconciliation blocks",
      async () => {
        await assert.rejects(
          q("select reconstruct_investment($1,$2,$3,14999,$4)", [
            request,
            old.id,
            replacement,
            payload,
          ]),
        );
        await assert.rejects(
          q("select reconstruct_investment($1,$2,$3,15000,$4)", [
            request,
            old.id,
            replacement,
            {
              ...payload,
              history: [
                { type: "withdrawal", date: "2026-09-01", amount_cents: 20000 },
              ],
            },
          ]),
        );
        assert.equal((await q("select * from investments")).length, 1);
      },
    );
    await t.test(
      "replacement atomic/idempotent, preserved bank ledger and imported flows",
      async () => {
        const beforeTx = await q("select * from transactions order by id"),
          beforeAccounts = await q("select * from accounts order by id"),
          beforeM = await q(
            "select * from investment_movements where investment_id=$1 order by id",
            [old.id],
          );
        await q("select reconstruct_investment($1,$2,$3,15000,$4)", [
          request,
          old.id,
          replacement,
          payload,
        ]);
        await q("select reconstruct_investment($1,$2,$3,15000,$4)", [
          request,
          old.id,
          replacement,
          payload,
        ]);
        assert.deepEqual(
          await q("select * from transactions order by id"),
          beforeTx,
        );
        assert.deepEqual(
          await q("select * from accounts order by id"),
          beforeAccounts,
        );
        assert.deepEqual(
          await q(
            "select * from investment_movements where investment_id=$1 order by id",
            [old.id],
          ),
          beforeM,
        );
        const retired = (
          await q("select * from investments where id=$1", [old.id])
        )[0];
        assert.equal(retired.active, false);
        assert.equal(retired.replaced_by_id, replacement);
        const rows = await q(
          "select * from investment_movements where investment_id=$1",
          [replacement],
        );
        assert.equal(rows.length, 3);
        assert.equal(
          rows.filter((m) => m.accounting_kind === "historical_position")
            .length,
          2,
        );
        assert.ok(rows.every((m) => m.transaction_id === null));
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-13') value", [
                replacement,
              ])
            )[0].value,
          ),
          15500,
        );
        await assert.rejects(
          q("update investments set active=true where id=$1", [old.id]),
        );
        await assert.rejects(q("select delete_investment($1)", [replacement]));
        await assert.rejects(
          q("select reconstruct_investment($1,$2,$3,15000,$4)", [
            request,
            old.id,
            replacement,
            { ...payload, real_value_cents: 999 },
          ]),
        );
      },
    );
    await t.test(
      "CDI synchronization and real cash do not double debit historical position",
      async () => {
        const sync = randomUUID();
        await q(
          "select record_investment_movement($1,$2,'adjustment',16000,'2026-10-13',null,'Real')",
          [sync, replacement],
        );
        await q(
          "select record_investment_movement($1,$2,'adjustment',16000,'2026-10-13',null,'Real')",
          [sync, replacement],
        );
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-13') value", [
                replacement,
              ])
            )[0].value,
          ),
          16000,
        );
        const id = randomUUID();
        await q(
          "select record_investment_movement($1,$2,'contribution',1000,'2026-10-13',$3,'Real')",
          [id, replacement, cash.id],
        );
        assert.equal(
          (await q("select * from transactions where id=$1", [id]))[0]
            .adjustment_delta_cents,
          -1000,
        );
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-13') value", [
                replacement,
              ])
            )[0].value,
          ),
          17000,
        );
        await assert.rejects(
          q(
            "select record_investment_movement($1,$2,'withdrawal',18000,'2026-10-13',$3,'Too much')",
            [randomUUID(), replacement, cash.id],
          ),
        );
        await q("select append_investment_rate($1,$2,'2026-10-14',100)", [
          randomUUID(),
          replacement,
        ]);
        await assert.rejects(
          q("select append_investment_rate($1,$2,'2026-10-12',100)", [
            randomUUID(),
            replacement,
          ]),
        );
      },
    );
    await t.test(
      "scheduled evidence captured only at actual scheduling; no realized expense inference",
      async () => {
        const cat = (
          await q("select id from categories where type='expense' limit 1")
        )[0].id;
        const normal = (
          await q(
            "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',100,'2026-10-01') returning *",
            [cash.id, cat],
          )
        )[0];
        assert.equal(normal.financial_commitment, false);
        const scheduled = (
          await q(
            "insert into transactions(account_id,category_id,type,status,amount_cents,transaction_date) values($1,$2,'expense','pending',100,'2026-10-01') returning *",
            [cash.id, cat],
          )
        )[0];
        await q("select resolve_transaction($1,false,'2026-10-13')", [
          scheduled.id,
        ]);
        const row = (
          await q("select * from transactions where id=$1", [scheduled.id])
        )[0];
        assert.equal(row.financial_commitment, true);
        assert.equal(
          String(
            row.commitment_due_date instanceof Date
              ? row.commitment_due_date.toISOString()
              : row.commitment_due_date,
          ).slice(0, 10),
          "2026-10-01",
        );
      },
    );
    await t.test(
      "export complete arrays beyond row limits, month confirmation and snapshot owner",
      async () => {
        await q(
          "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) select $1,(select id from categories where type='income' limit 1),'income',1,'2026-09-01' from generate_series(1,1100)",
          [cash.id],
        );
        const count = (
          await q("select count(*)::integer n from transactions")
        )[0].n;
        let snapshot = (await q("select export_financial_snapshot() value"))[0]
          .value;
        assert.equal(snapshot.owner, a);
        assert.equal(snapshot.data.transactions.length, count);
        assert.equal(snapshot.counts.transactions, count);
        assert.ok(count > 1000);
        assert.equal(snapshot.data.report_month_confirmations.length, 0);
        await q("select confirm_report_month('2026-09-01',true)");
        snapshot = (await q("select export_financial_snapshot() value"))[0]
          .value;
        assert.equal(
          snapshot.data.report_month_confirmations[0].complete,
          true,
        );
        await q("select confirm_report_month('2026-09-01',false)");
        await assert.rejects(
          q("select confirm_report_month('2026-10-01',true)"),
        );
        await as(b);
        const other = (await q("select export_financial_snapshot() value"))[0]
          .value;
        assert.equal(other.data.transactions.length, 0);
        assert.equal(other.data.investments.length, 0);
        await as(a);
      },
    );
    await t.test("A/B isolation and protected functions", async () => {
      await as(b);
      for (const table of [
        "investment_reconstructions",
        "investment_rates",
        "investments",
        "investment_movements",
      ])
        assert.equal((await q("select * from " + table)).length, 0);
      await assert.rejects(
        q("select reconstruct_investment($1,$2,$3,15000,$4)", [
          request,
          old.id,
          replacement,
          payload,
        ]),
      );
      await assert.rejects(
        q("select append_investment_rate($1,$2,'2026-10-15',100)", [
          randomUUID(),
          replacement,
        ]),
      );
      await db.exec("reset role;set role anon");
      await assert.rejects(q("select * from investment_reconstructions"));
    });
  } finally {
    await db.close();
  }
});
