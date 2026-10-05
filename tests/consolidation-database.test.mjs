import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
test("consolidação: patrimônio, movimentos atômicos, compras corrigíveis e RLS", async (t) => {
  const db = new PGlite();
  const user = randomUUID(),
    other = randomUUID();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const as = async (u) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [u]);
    await db.exec("set role authenticated");
  };
  try {
    await db.exec(
      `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`,
    );
    const migrations = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of migrations.filter((f) => f < "202610030005"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec(
      "create or replace function public.financial_date() returns date language sql stable as $$ select date '2026-10-03' $$",
    );
    await q("insert into auth.users values($1),($2)", [user, other]);
    await as(user);
    const account = (
      await q(
        "insert into accounts(name,type,initial_balance_cents) values('Caixa','checking',100000) returning *",
      )
    )[0];
    const reserve = (
      await q(
        "insert into accounts(name,type,initial_balance_cents,created_at) values('Reserva','investment',50000,'2026-10-01T00:00:00Z') returning *",
      )
    )[0];
    const tx = (
      await q(
        "insert into transactions(account_id,destination_account_id,type,amount_cents,transaction_date) values($1,$2,'transfer',1000,'2026-10-01') returning *",
        [account.id, reserve.id],
      )
    )[0];
    const overnight = (
      await q(
        "insert into accounts(name,type,initial_balance_cents,created_at) values('Reserva noturna','savings',123,'2026-10-04T01:00:00Z') returning *",
      )
    )[0];
    await db.exec("reset role");
    for (const f of migrations.filter((f) => f >= "202610030005"))
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await as(user);
    const investment = (
      await q("select * from investments where source_account_id=$1", [
        reserve.id,
      ])
    )[0];
    await t.test(
      "migração preserva IDs/histórico e saldo equivalente",
      async () => {
        assert.equal(investment.source_account_id, reserve.id);
        assert.equal(investment.is_emergency_reserve, true);
        assert.equal(
          Number(
            (
              await q(
                "select investment_value(id,'2026-10-03') value from investments where source_account_id=$1",
                [overnight.id],
              )
            )[0].value,
          ),
          123,
        );
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-03') value", [
                investment.id,
              ])
            )[0].value,
          ),
          51000,
        );
        assert.equal(
          (await q("select * from transactions where id=$1", [tx.id]))[0]
            .amount_cents,
          1000,
        );
        assert.equal(
          (await q("select * from accounts where id=$1", [reserve.id]))[0]
            .is_active,
          false,
        );
        await assert.rejects(
          q("delete from transactions where id=$1", [tx.id]),
        );
        await assert.rejects(
          q("update accounts set is_active=true where id=$1", [reserve.id]),
        );
      },
    );
    await t.test(
      "aporte/resgate/sincronização idempotentes e atômicos",
      async () => {
        const id = randomUUID();
        await q(
          "select record_investment_movement($1,$2,'contribution',2000,'2026-10-03',$3,'aporte')",
          [id, investment.id, account.id],
        );
        await q(
          "select record_investment_movement($1,$2,'contribution',2000,'2026-10-03',$3,'aporte')",
          [id, investment.id, account.id],
        );
        assert.equal(
          (await q("select * from transactions where id=$1", [id])).length,
          1,
        );
        assert.equal(
          (await q("select * from transactions where id=$1", [id]))[0]
            .adjustment_delta_cents,
          -2000,
        );
        await assert.rejects(q("delete from transactions where id=$1", [id]));
        await assert.rejects(
          q("update transactions set adjustment_delta_cents=-1 where id=$1", [
            id,
          ]),
        );
        await assert.rejects(
          q(
            "insert into accounts(name,type,investment_id) values('Forjado','checking',$1)",
            [investment.id],
          ),
        );
        await q(
          "select record_investment_movement($1,$2,'withdrawal',1000,'2026-10-03',$3,'resgate')",
          [randomUUID(), investment.id, account.id],
        );
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-03') value", [
                investment.id,
              ])
            )[0].value,
          ),
          52000,
        );
        await q(
          "select record_investment_movement($1,$2,'adjustment',52100,'2026-10-03',null,'saldo real')",
          [randomUUID(), investment.id],
        );
        assert.equal(
          Number(
            (
              await q("select investment_value($1,'2026-10-03') value", [
                investment.id,
              ])
            )[0].value,
          ),
          52100,
        );
        await assert.rejects(
          q(
            "select record_investment_movement($1,$2,'withdrawal',53000,'2026-10-03',$3,'excesso')",
            [randomUUID(), investment.id, account.id],
          ),
        );
        await assert.rejects(
          q(
            "select record_investment_movement($1,$2,'contribution',1000000,'2026-10-03',$3,'excesso')",
            [randomUUID(), investment.id, account.id],
          ),
        );
        await assert.rejects(q("delete from investment_movements"));
      },
    );
    const card = (
      await q(
        "insert into credit_cards(name,holder_name,closing_day,due_day) values('Terceiro','Titular',5,12) returning *",
      )
    )[0];
    const category = (
      await q("select id from categories where type='expense' limit 1")
    )[0].id;
    const payload = {
      card_id: card.id,
      category_id: category,
      amount_cents: 10001,
      description: "Compra",
      purchase_date: "2026-10-01",
      installments: 3,
      first_due_date: "2026-10-12",
    };
    await t.test(
      "criação idempotente sem UPDATE genérico e sem sobrescrita",
      async () => {
        const id = randomUUID();
        await q("select create_card_purchase($1,$2)", [id, payload]);
        await q("select create_card_purchase($1,$2)", [id, payload]);
        assert.equal(
          (await q("select * from card_purchases where id=$1", [id])).length,
          1,
        );
        await assert.rejects(
          q("select create_card_purchase($1,$2)", [
            id,
            { ...payload, amount_cents: 999 },
          ]),
        );
        await assert.rejects(
          q("update card_purchases set amount_cents=999 where id=$1", [id]),
        );
        await as(other);
        await assert.rejects(
          q("select create_card_purchase($1,$2)", [id, payload]),
        );
        await as(user);
        await q("select correct_card_purchase($1,$2,true)", [id, {}]);
      },
    );
    const purchase = (
      await q(
        "insert into card_purchases(card_id,category_id,amount_cents,purchase_date,installments,description) values($1,$2,10001,'2026-10-01',3,'Compra') returning *",
        [card.id, category],
      )
    )[0];
    await t.test(
      "cartão sem conta; edição e cancelamento conservam razão auditável",
      async () => {
        assert.equal(card.payment_account_id, null);
        assert.equal(card.holder_name, "Titular");
        await q("select correct_card_purchase($1,$2,false)", [
          purchase.id,
          { ...payload, amount_cents: 12000 },
        ]);
        assert.equal(
          (
            await q("select amount_cents from card_purchases where id=$1", [
              purchase.id,
            ])
          )[0].amount_cents,
          12000,
        );
        await q("select correct_card_purchase($1,$2,true)", [purchase.id, {}]);
        assert.ok(
          (
            await q("select cancelled_at from card_purchases where id=$1", [
              purchase.id,
            ])
          )[0].cancelled_at,
        );
        assert.equal(
          (
            await q("select * from card_purchase_audit where purchase_id=$1", [
              purchase.id,
            ])
          ).length,
          2,
        );
        await assert.rejects(
          q("delete from card_purchases where id=$1", [purchase.id]),
        );
      },
    );
    await t.test(
      "fatura manual coberta é recalculada; pagamento impede reescrever compra",
      async () => {
        const p = (
          await q(
            "insert into card_purchases(card_id,category_id,amount_cents,purchase_date,installments) values($1,$2,10000,'2026-10-01',1) returning *",
            [card.id, category],
          )
        )[0];
        await q(
          "select set_card_invoice($1,$2,10000,'2026-10-12','baseline')",
          [randomUUID(), card.id],
        );
        await q("select correct_card_purchase($1,$2,false)", [
          p.id,
          { ...payload, amount_cents: 9000, installments: 1 },
        ]);
        assert.equal(
          (
            await q("select amount_cents from card_invoices where card_id=$1", [
              card.id,
            ])
          )[0].amount_cents,
          9000,
        );
        await q(
          "select pay_card_invoice($1,$2,'2026-10',$3,1000,'2026-10-03')",
          [randomUUID(), card.id, account.id],
        );
        await assert.rejects(
          q("select correct_card_purchase($1,$2,true)", [p.id, {}]),
        );
        await q(
          "select adjust_card_purchase($1,$2,'2026-10-12',-500,'correção rastreável')",
          [randomUUID(), p.id],
        );
        assert.equal((await q("select * from card_adjustments")).length, 1);
        await assert.rejects(
          q("select adjust_card_purchase($1,$2,'2026-10-12',-9000,'excesso')", [
            randomUUID(),
            p.id,
          ]),
        );
      },
    );
    await t.test("isolamento A↔B e grants de razão financeira", async () => {
      await as(other);
      for (const table of [
        "investments",
        "investment_movements",
        "classification_reviews",
        "card_purchase_audit",
        "card_adjustments",
      ])
        assert.equal((await q("select * from " + table)).length, 0);
      await assert.rejects(
        q("select investment_value($1,'2026-10-03')", [investment.id]),
      );
      await assert.rejects(
        q(
          "select record_investment_movement($1,$2,'adjustment',1,'2026-10-03',null,'forjado')",
          [randomUUID(), investment.id],
        ),
      );
      await assert.rejects(
        q("select correct_card_purchase($1,$2,true)", [purchase.id, {}]),
      );
      await assert.rejects(
        q(
          "insert into investments(user_id,name,initial_date) values($1,'Forjado','2026-10-01')",
          [user],
        ),
      );
      await db.exec("reset role;set role anon");
      await assert.rejects(q("select * from investments"));
    });
  } finally {
    await db.close();
  }
});
