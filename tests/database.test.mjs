import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("migration, RLS A↔B, ownership, constraints e transferência atômica", async () => {
  const db = new PGlite();
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610010001_initial.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.query("insert into auth.users(id) values ($1),($2)", [a, b]);
    assert.equal((await db.query("select * from categories")).rows.length, 30);
    const asUser = async (id) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ]);
      await db.exec("set role authenticated");
    };
    const fixtures = [];
    for (const id of [a, b]) {
      await asUser(id);
      const account = (
        await db.query(
          "insert into accounts(name,type) values('Conta','checking') returning *",
        )
      ).rows[0];
      const destination = (
        await db.query(
          "insert into accounts(name,type) values('Destino','wallet') returning *",
        )
      ).rows[0];
      assert.equal(account.user_id, id);
      const category = (
        await db.query("select * from categories where type='expense' limit 1")
      ).rows[0];
      const transaction = (
        await db.query(
          "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',100,'2026-10-01') returning *",
          [account.id, category.id],
        )
      ).rows[0];
      const goal = (
        await db.query(
          "insert into goals(name,target_amount_cents) values('Reserva',1000) returning *",
        )
      ).rows[0];
      const contribution = (
        await db.query(
          "insert into goal_contributions(goal_id,amount_cents,contribution_date) values($1,100,'2026-10-01') returning *",
          [goal.id],
        )
      ).rows[0];
      fixtures.push({
        accounts: account,
        categories: category,
        transactions: transaction,
        goals: goal,
        goal_contributions: contribution,
        destination,
      });
    }
    for (let actor = 0; actor < 2; actor++) {
      await asUser([a, b][actor]);
      const own = fixtures[actor],
        victim = fixtures[1 - actor];
      for (const table of [
        "accounts",
        "categories",
        "transactions",
        "goals",
        "goal_contributions",
      ]) {
        const id = victim[table].id;
        assert.equal(
          (
            await db.query(`select * from ${table} where user_id=$1`, [
              [a, b][1 - actor],
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (await db.query(`select * from ${table} where id=$1`, [id])).rows
            .length,
          0,
        );
        assert.equal(
          (
            await db.query(
              `update ${table} set user_id=$1 where id=$2 returning id`,
              [[a, b][actor], id],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(`delete from ${table} where id=$1 returning id`, [
              id,
            ])
          ).rows.length,
          0,
        );
        const row = { ...victim[table], id: crypto.randomUUID() };
        delete row.created_at;
        delete row.updated_at;
        const keys = Object.keys(row);
        await assert.rejects(
          () =>
            db.query(
              `insert into ${table}(${keys.join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
              Object.values(row),
            ),
          /row-level security/,
        );
        await assert.rejects(
          () =>
            db.query(`update ${table} set user_id=$1 where id=$2`, [
              [a, b][1 - actor],
              own[table].id,
            ]),
          /imutável|row-level security/,
        );
      }
      await assert.rejects(
        () =>
          db.query(
            "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',100,'2026-10-01')",
            [victim.accounts.id, own.categories.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',100,'2026-10-01')",
            [own.accounts.id, victim.categories.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$2,'transfer',100,'2026-10-01')",
            [own.accounts.id, victim.accounts.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into goal_contributions(goal_id,amount_cents,contribution_date) values($1,100,'2026-10-01')",
            [victim.goals.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$1,'transfer',100,'2026-10-01')",
            [own.accounts.id],
          ),
        /check constraint/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'income',100,'2026-10-01')",
            [own.accounts.id, own.categories.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          db.query(
            "insert into goal_contributions(goal_id,amount_cents,contribution_date) values($1,-1,'2026-10-01')",
            [own.goals.id],
          ),
        /check constraint/,
      );
      await assert.rejects(
        () => db.query("delete from accounts where id=$1", [own.accounts.id]),
        /foreign key/,
      );
      await db.query("update accounts set is_active=false where id=$1", [
        own.accounts.id,
      ]);
      assert.equal(
        (
          await db.query("select * from transactions where id=$1", [
            own.transactions.id,
          ])
        ).rows.length,
        1,
      );
      const transfer = (
        await db.query(
          "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$2,'transfer',300,'2026-10-01') returning *",
          [own.accounts.id, own.destination.id],
        )
      ).rows[0];
      assert.equal(transfer.category_id, null);
      await db.query("update transactions set amount_cents=500 where id=$1", [
        transfer.id,
      ]);
      await db.query("delete from transactions where id=$1", [transfer.id]);
      assert.equal(
        (
          await db.query("select * from transactions where id=$1", [
            transfer.id,
          ])
        ).rows.length,
        0,
      );
    }
    await db.exec("reset role; set role anon;");
    for (const table of [
      "accounts",
      "categories",
      "transactions",
      "goals",
      "goal_contributions",
    ])
      await assert.rejects(
        () => db.query(`select * from ${table}`),
        /permission denied/,
      );
  } finally {
    await db.close();
  }
});
