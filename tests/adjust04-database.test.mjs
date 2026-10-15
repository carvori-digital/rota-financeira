import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID as id } from "node:crypto";

test("Ajuste 04: isolated accounting, deletion, reconciliation, reversals and RLS", async (t) => {
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
    for (const f of files.filter((f) => f < "202610030005"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec(
      "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-14'$$",
    );
    await q("insert into auth.users values($1),($2)", [a, b]);
    await as(a);
    const cash = (
      await q(
        "insert into accounts(name,type,initial_balance_cents) values('Nubank','checking',50000) returning id",
      )
    )[0].id;
    const oldAccount = (
      await q(
        "insert into accounts(name,type,initial_balance_cents,created_at) values('Reserva','savings',10000,'2026-10-01') returning id",
      )
    )[0].id;
    const transfer = (
      await q(
        "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$2,'transfer',1000,'2026-10-03') returning id",
        [cash, oldAccount],
      )
    )[0].id;
    const reconstructedAccount = (
      await q(
        "insert into accounts(name,type,initial_balance_cents,created_at) values('Reconstruída','savings',1000,'2026-10-01') returning id",
      )
    )[0].id;
    await db.exec("reset role");
    for (const f of files.filter(
      (f) => f >= "202610030005" && f < "202610140012",
    ))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    const beforeTx = await q("select * from transactions order by id"),
      beforeAccounts = await q("select * from accounts order by id");
    await db.exec(
      await readFile(
        "supabase/migrations/" +
          files.find((f) => f.startsWith("202610140012")),
        "utf8",
      ),
    );
    assert.deepEqual(
      await q("select * from transactions order by id"),
      beforeTx,
    );
    for (const row of await q("select * from accounts order by id")) {
      const { investment_retired, ...existing } = row;
      assert.equal(investment_retired, false);
      assert.deepEqual(
        existing,
        beforeAccounts.find((a) => a.id === row.id),
      );
    }
    await as(a);
    const old = (
      await q("select * from investments where source_account_id=$1", [
        oldAccount,
      ])
    )[0];
    const value = async (inv) =>
      Number(
        (await q("select investment_value($1,'2026-10-14') v", [inv]))[0].v,
      );
    const bank = async () =>
      Number(
        (
          await q(
            "select 50000+coalesce(sum(case when account_id=$1 then case type when 'income' then amount_cents when 'adjustment' then adjustment_delta_cents else -amount_cents end else 0 end+case when type='transfer' and destination_account_id=$1 then amount_cents else 0 end),0) v from transactions where status='realized'",
            [cash],
          )
        )[0].v,
      );
    const inv = id(),
      payload = {
        name: "Caixinha Turbo",
        institution: "Nubank",
        type: "RDB",
        initial_date: "2026-10-01",
        yield_type: "percent_cdi",
        yield_rate: 115,
        reserve: true,
        initial_cents: 50000,
        acknowledged: true,
      };
    const move = async (
      kind,
      amount,
      date = "2026-10-14",
      request = id(),
      tr = null,
      expected = null,
    ) => {
      await q(
        "select simple_investment_movement($1,$2,$3,$4,$5,$6,$7,$8,$9,true)",
        [
          request,
          inv,
          kind,
          amount,
          date,
          kind === "adjustment" ? null : cash,
          "Teste isolado",
          tr,
          expected ?? (await value(inv)),
        ],
      );
      return request;
    };
    await t.test(
      "B: initial position does not move bank, repeat payload cannot overwrite",
      async () => {
        const balance = await bank();
        await q("select create_simple_investment($1,$2)", [inv, payload]);
        await q("select create_simple_investment($1,$2)", [inv, payload]);
        assert.equal(await value(inv), 50000);
        assert.equal(await bank(), balance);
        assert.equal(
          (
            await q(
              "select * from investment_movements where investment_id=$1",
              [inv],
            )
          ).length,
          1,
        );
        await assert.rejects(
          q("select create_simple_investment($1,$2)", [
            inv,
            { ...payload, initial_cents: 60000 },
          ]),
        );
      },
    );
    let contribution;
    await t.test(
      "C/D/F: past cash, wealth conservation, retry, withdrawal and chronological rollback",
      async () => {
        const total = (await bank()) + (await value(inv));
        contribution = await move("contribution", 10000, "2026-10-10");
        assert.equal(await value(inv), 60000);
        assert.equal((await bank()) + (await value(inv)), total);
        await move(
          "contribution",
          10000,
          "2026-10-10",
          contribution,
          null,
          50000,
        );
        assert.equal(await value(inv), 60000);
        await assert.rejects(
          move("contribution", 10001, "2026-10-10", contribution),
        );
        await move("withdrawal", 15000, "2026-10-12");
        assert.equal(await value(inv), 45000);
        assert.equal((await bank()) + (await value(inv)), total);
        await move("contribution", 1000, "2026-10-11");
        assert.equal(await value(inv), 46000);
        const rows = await q("select * from transactions order by id");
        await assert.rejects(
          move("withdrawal", 70000, "2026-10-11"),
          /negativa/,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
        assert.equal(
          (
            await q(
              "select * from transactions where type in ('income','expense') or financial_commitment",
            )
          ).length,
          0,
        );
      },
    );
    await t.test(
      "safe cash reversal is traceable, exact retry, second reversal rejected",
      async () => {
        const bankBefore = await bank(),
          position = await value(inv),
          request = id();
        await q("select reverse_simple_investment_movement($1,$2)", [
          request,
          contribution,
        ]);
        await q("select reverse_simple_investment_movement($1,$2)", [
          request,
          contribution,
        ]);
        assert.equal(await bank(), bankBefore + 10000);
        assert.equal(await value(inv), position - 10000);
        await assert.rejects(
          q("select reverse_simple_investment_movement($1,$2)", [
            id(),
            contribution,
          ]),
        );
      },
    );
    await t.test(
      "G: tenant B and anon cannot access/mutate A; metadata cannot be forged",
      async () => {
        await as(b);
        assert.equal((await q("select * from investments")).length, 0);
        await assert.rejects(
          q("select delete_simple_investment($1,$2,11000,true)", [
            id(),
            old.id,
          ]),
        );
        await assert.rejects(move("withdrawal", 100));
        await assert.rejects(
          q("select create_simple_investment($1,$2)", [inv, payload]),
        );
        assert.equal(
          (await q("select * from investment_operations")).length,
          0,
        );
        await db.exec("reset role;set role anon");
        await assert.rejects(
          q("select create_simple_investment($1,$2)", [id(), payload]),
        );
        await as(a);
        await assert.rejects(
          q("update investments set deleted_at=now() where id=$1", [inv]),
        );
        await assert.rejects(
          q(
            "insert into investment_operations(id,user_id,kind,investment_id,payload) values($1,$2,'delete',$3,'{}')",
            [id(), a, inv],
          ),
        );
      },
    );
    await t.test(
      "A: physical legacy deletion preserves ALL bank rows and inactive origin, retry has no effect",
      async () => {
        const rows = await q("select * from transactions order by id"),
          balance = await bank(),
          request = id();
        await q("select delete_simple_investment($1,$2,11000,true)", [
          request,
          old.id,
        ]);
        await q("select delete_simple_investment($1,$2,11000,true)", [
          request,
          old.id,
        ]);
        assert.equal(
          (await q("select * from investments where id=$1", [old.id])).length,
          0,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
        assert.equal(await bank(), balance);
        const origin = (
          await q("select * from accounts where id=$1", [oldAccount])
        )[0];
        assert.equal(origin.investment_retired, true);
        assert.equal(origin.investment_id, null);
        assert.equal(origin.is_active, false);
        await assert.rejects(
          q("update accounts set is_active=true where id=$1", [oldAccount]),
        );
        await assert.rejects(
          q("delete from transactions where id=$1", [transfer]),
        );
      },
    );
    await t.test(
      "E: existing bank transfer reconciles once without new bank debit, mismatches reject",
      async () => {
        const rows = await q("select * from transactions order by id"),
          position = await value(inv);
        await assert.rejects(
          move("contribution", 1001, "2026-10-03", id(), transfer),
        );
        const req = await move(
          "contribution",
          1000,
          "2026-10-03",
          id(),
          transfer,
        );
        await move("contribution", 1000, "2026-10-03", req, transfer, position);
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
        assert.equal(await value(inv), position + 1000);
        await assert.rejects(
          move("contribution", 1000, "2026-10-03", id(), transfer),
          /já considerada/,
        );
      },
    );
    await t.test(
      "sync blocks stale requests and past entries covered by anchor; safe sync reversal",
      async () => {
        await assert.rejects(
          move("adjustment", 40000, "2026-10-14", id(), null, 1),
          /mudou/,
        );
        const initial = await value(inv),
          request = await move("adjustment", 40000);
        await assert.rejects(
          move("contribution", 100, "2026-10-13"),
          /sincronizado posterior/,
        );
        await q("select reverse_simple_investment_movement($1,$2)", [
          id(),
          request,
        ]);
        assert.equal(await value(inv), initial);
      },
    );
    await t.test(
      "account reconciliation has stale guard, exact retries and no income",
      async () => {
        const actual = await bank(),
          request = id();
        await assert.rejects(
          q("select reconcile_operational_balance($1,$2,$3,$4)", [
            request,
            cash,
            actual + 200,
            actual - 1,
          ]),
          /mudou/,
        );
        await q("select reconcile_operational_balance($1,$2,$3,$4)", [
          request,
          cash,
          actual + 200,
          actual,
        ]);
        await q("select reconcile_operational_balance($1,$2,$3,$4)", [
          request,
          cash,
          actual + 200,
          actual,
        ]);
        assert.equal(await bank(), actual + 200);
        await assert.rejects(
          q("select reconcile_operational_balance($1,$2,$3,$4)", [
            request,
            cash,
            actual + 300,
            actual,
          ]),
        );
      },
    );
    await t.test(
      "reconstruction references retain only an invisible investment tombstone",
      async () => {
        const oldRebuilt = (
          await q("select * from investments where source_account_id=$1", [
            reconstructedAccount,
          ])
        )[0];
        const next = id(),
          request = id(),
          rebuild = {
            name: "Reconstruída nova",
            institution: "Synthetic",
            product: "RDB",
            initial_date: "2026-10-01",
            yield_type: "manual",
            yield_rate: 0,
            history: [
              { type: "contribution", date: "2026-10-01", amount_cents: 1000 },
            ],
            real_value_cents: 1000,
            note: "Synthetic",
            acknowledged: true,
          };
        await q("select reconstruct_investment($1,$2,$3,1000,$4)", [
          request,
          oldRebuilt.id,
          next,
          rebuild,
        ]);
        const rows = await q("select * from transactions order by id");
        await q("select delete_simple_investment($1,$2,1000,true)", [
          id(),
          oldRebuilt.id,
        ]);
        await q("select delete_simple_investment($1,$2,1000,true)", [
          id(),
          next,
        ]);
        const tombstones = await q(
          "select * from investments where id=$1 or id=$2",
          [oldRebuilt.id, next],
        );
        assert.equal(tombstones.length, 2);
        assert.ok(tombstones.every((i) => i.deleted_at && !i.active));
        assert.equal(
          (
            await q(
              "select * from investment_movements where investment_id=$1 or investment_id=$2",
              [oldRebuilt.id, next],
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await q("select * from investment_reconstructions where id=$1", [
              request,
            ])
          ).length,
          1,
        );
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
        await assert.rejects(
          q("update investments set active=true where id=$1", [next]),
        );
      },
    );
    await t.test(
      "deleting a new investment preserves legitimate operational entries",
      async () => {
        const rows = await q("select * from transactions order by id"),
          balance = await bank();
        await q("select delete_simple_investment($1,$2,$3,true)", [
          id(),
          inv,
          await value(inv),
        ]);
        assert.deepEqual(
          await q("select * from transactions order by id"),
          rows,
        );
        assert.equal(await bank(), balance);
        await assert.rejects(
          q("delete from transactions where id=$1", [contribution]),
          /protegido/,
        );
      },
    );
  } finally {
    await db.close();
  }
});
