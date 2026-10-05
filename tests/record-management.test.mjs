import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("007: exclusões atômicas, dependências e isolamento", async (t) => {
  const db = new PGlite(),
    user = randomUUID(),
    other = randomUUID();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const as = async (id) => {
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  };
  const snapshot = async () => {
    const result = {};
    for (const { tablename } of await q(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    ))
      result[tablename] = await q(
        `select * from public.${tablename} order by id`,
      );
    return result;
  };
  const rejectsUnchanged = async (sql, args, pattern) => {
    const before = await snapshot();
    await assert.rejects(q(sql, args), pattern);
    assert.deepEqual(await snapshot(), before);
  };
  try {
    await db.exec(
      "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;",
    );
    for (const f of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
    await db.exec(
      "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-05'$$",
    );
    await q("insert into auth.users values($1),($2)", [user, other]);
    await as(user);
    const account = (
      await q(
        "insert into accounts(name,type,initial_balance_cents) values('Caixa','checking',100000) returning id",
      )
    )[0].id;
    const category = (
      await q("select id from categories where type='expense' limit 1")
    )[0].id;
    const card = async () =>
      (
        await q(
          "insert into credit_cards(name,closing_day,due_day) values('Cartão',5,12) returning id",
        )
      )[0].id;
    const purchase = async (c, amount = 10001, installments = 3) => {
      const id = randomUUID();
      await q("select create_card_purchase($1,$2)", [
        id,
        {
          card_id: c,
          category_id: category,
          amount_cents: amount,
          installments,
          purchase_date: "2026-10-01",
          first_due_date: "2026-10-12",
          description: "Compra",
        },
      ]);
      return id;
    };
    const investment = async () =>
      (
        await q(
          "insert into investments(name,initial_date) values('Manual','2026-10-01') returning id",
        )
      )[0].id;
    const movement = async (i, type, amount) => {
      const id = randomUUID();
      await q(
        "select record_investment_movement($1,$2,$3,$4,'2026-10-05',$5,'Teste local')",
        [id, i, type, amount, type === "adjustment" ? null : account],
      );
      return id;
    };
    await t.test(
      "compra parcelada: limpa ajustes/reviews/auditoria e desconta somente faturas cobertas",
      async () => {
        const c = await card(),
          p = await purchase(c);
        await q("select set_card_invoice($1,$2,3334,'2026-10-12','')", [
          randomUUID(),
          c,
        ]);
        await q("select set_card_invoice($1,$2,3334,'2026-11-12','')", [
          randomUUID(),
          c,
        ]);
        await q("select correct_card_purchase($1,$2,false)", [
          p,
          {
            card_id: c,
            category_id: category,
            amount_cents: 10001,
            installments: 3,
            purchase_date: "2026-10-01",
            first_due_date: "2026-10-12",
            description: "Editada",
          },
        ]);
        await q(
          "select adjust_card_purchase($1,$2,'2026-12-12',100,'Ajuste')",
          [randomUUID(), p],
        );
        await db.exec("reset role");
        await q(
          "insert into classification_reviews(user_id,source_table,source_id,reason,confidence) values($1,'card_purchases',$2,'Teste','LOW')",
          [user, p],
        );
        await as(user);
        await q("select delete_card_purchase($1)", [p]);
        for (const table of [
          "card_purchases",
          "card_purchase_audit",
          "card_adjustments",
          "classification_reviews",
        ])
          assert.equal((await q(`select * from ${table}`)).length, 0);
        assert.deepEqual(
          (
            await q(
              "select amount_cents from card_invoices where card_id=$1 order by due_month",
              [c],
            )
          ).map((r) => r.amount_cents),
          [0, 0],
        );
        await db.exec("reset role");
        for (const month of ["2026-10", "2026-11", "2026-12"])
          assert.equal(
            Number(
              (await q("select invoice_total($1,$2,$3) n", [c, month, user]))[0]
                .n,
            ),
            0,
          );
        await as(user);
      },
    );
    await t.test(
      "compra paga e ajuste em fatura paga bloqueiam; falha não modifica nada",
      async () => {
        const c = await card(),
          p = await purchase(c, 10000, 1);
        await q(
          "select pay_card_invoice($1,$2,'2026-10',$3,1000,'2026-10-05')",
          [randomUUID(), c, account],
        );
        await rejectsUnchanged(
          "select delete_card_purchase($1)",
          [p],
          /pagamento/,
        );
        const c2 = await card(),
          p2 = await purchase(c2, 2000, 1);
        await q(
          "select adjust_card_purchase($1,$2,'2026-11-12',500,'Correção')",
          [randomUUID(), p2],
        );
        await q(
          "select pay_card_invoice($1,$2,'2026-11',$3,100,'2026-10-05')",
          [randomUUID(), c2, account],
        );
        await rejectsUnchanged(
          "select delete_card_purchase($1)",
          [p2],
          /pagamento/,
        );
      },
    );
    await t.test(
      "compra cancelada e compra não coberta podem desaparecer sem subtrair duas vezes",
      async () => {
        const c = await card(),
          p = await purchase(c, 2000, 1);
        await q("select correct_card_purchase($1,'{}',true)", [p]);
        await q("select delete_card_purchase($1)", [p]);
        const p2 = await purchase(c, 3000, 1);
        await q("select delete_card_purchase($1)", [p2]);
        assert.equal(
          (await q("select * from card_purchases where card_id=$1", [c]))
            .length,
          0,
        );
      },
    );
    await t.test(
      "fatura insuficiente desfaz inclusive a alteração da parcela anterior",
      async () => {
        const c = await card(),
          p = await purchase(c, 10000, 2);
        await q("select set_card_invoice($1,$2,5000,'2026-10-12','')", [
          randomUUID(),
          c,
        ]);
        await q("select set_card_invoice($1,$2,1000,'2026-11-12','')", [
          randomUUID(),
          c,
        ]);
        await rejectsUnchanged(
          "select delete_card_purchase($1)",
          [p],
          /não comporta/,
        );
      },
    );
    await t.test(
      "meta vazia e reserva com aportes/links: preserva contas e transações",
      async () => {
        const empty = (
          await q(
            "insert into goals(name,target_amount_cents) values('Meta',10000) returning id",
          )
        )[0].id;
        await q("select delete_goal($1)", [empty]);
        const g = randomUUID();
        const reserve = (
          await q(
            "insert into accounts(name,type) values('Reserva','savings') returning id",
          )
        )[0].id;
        await q("select save_emergency_reserve($1,1000,6,$2::uuid[])", [
          g,
          [reserve],
        ]);
        await q(
          "insert into goal_contributions(goal_id,amount_cents,contribution_date) values($1,100,'2026-10-05')",
          [g],
        );
        const accounts = await q("select * from accounts"),
          transactions = await q("select * from transactions"),
          investments = await q("select * from investments");
        await q("select delete_goal($1)", [g]);
        for (const table of [
          "goals",
          "goal_contributions",
          "reserve_account_links",
        ])
          assert.equal((await q(`select * from ${table}`)).length, 0);
        assert.deepEqual(await q("select * from accounts"), accounts);
        assert.deepEqual(await q("select * from transactions"), transactions);
        assert.deepEqual(await q("select * from investments"), investments);
      },
    );
    for (const scenario of [
      "empty",
      "adjustment",
      "contribution",
      "withdrawal",
    ])
      await t.test(
        `investimento manual ${scenario}: remove apenas movimentos e transações vinculadas`,
        async () => {
          const before = await q("select * from transactions order by id"),
            i = await investment();
          if (scenario === "adjustment") await movement(i, "adjustment", 2000);
          if (["contribution", "withdrawal"].includes(scenario))
            await movement(i, "contribution", 2000);
          if (scenario === "withdrawal") await movement(i, "withdrawal", 500);
          await q("select delete_investment($1)", [i]);
          assert.equal(
            (await q("select * from investments where id=$1", [i])).length,
            0,
          );
          assert.equal(
            (
              await q(
                "select * from investment_movements where investment_id=$1",
                [i],
              )
            ).length,
            0,
          );
          assert.deepEqual(
            await q("select * from transactions order by id"),
            before,
          );
        },
      );
    await t.test(
      "investimento migrado e vínculo inesperado bloqueados atomicamente",
      async () => {
        await db.exec("reset role");
        const migrated = (
          await q(
            "insert into investments(user_id,name,initial_date,source_account_id) values($1,'Migrado','2026-10-01',$2) returning id",
            [user, account],
          )
        )[0].id;
        await as(user);
        await rejectsUnchanged(
          "select delete_investment($1)",
          [migrated],
          /migrado/,
        );
        const i = await investment(),
          m = await movement(i, "contribution", 100);
        await db.exec("reset role");
        // An unexpected externally created link must stop deletion, never cascade.
        const rule = (
          await q(
            "insert into recurring_items(user_id,name,type,amount_cents,account_id,category_id,frequency,start_date) values($1,'Regra','expense',100,$2,$3,'monthly','2026-10-01') returning id",
            [user, account, category],
          )
        )[0].id;
        await q(
          "insert into recurring_occurrences(user_id,recurring_item_id,due_date,status,transaction_id) values($1,$2,'2026-10-01','recorded',$3)",
          [user, rule, m],
        );
        await as(user);
        await rejectsUnchanged(
          "select delete_investment($1)",
          [i],
          /outros registros/,
        );
      },
    );
    await t.test(
      "cartão/dívida/recorrência: só registros sem dependências",
      async () => {
        const c = await card();
        await q("select delete_unused_record('card',$1)", [c]);
        const d = (
          await q(
            "insert into debts(name,original_amount_cents,remaining_amount_cents) values('Dívida',1000,1000) returning id",
          )
        )[0].id;
        await q("select delete_unused_record('debt',$1)", [d]);
        const d2 = (
          await q(
            "insert into debts(name,original_amount_cents,remaining_amount_cents) values('Paga',1000,1000) returning id",
          )
        )[0].id;
        await q("select pay_debt($1,$2,$3,100,'2026-10-05')", [
          randomUUID(),
          d2,
          account,
        ]);
        await rejectsUnchanged(
          "select delete_unused_record('debt',$1)",
          [d2],
          /pagamentos/,
        );
        const r = (
          await q(
            "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Regra','expense',100,$1,$2,'monthly','2026-10-01') returning id",
            [account, category],
          )
        )[0].id;
        await q("select delete_unused_record('recurring',$1)", [r]);
        const used = (
          await q(
            "select recurring_item_id id from recurring_occurrences limit 1",
          )
        )[0].id;
        await rejectsUnchanged(
          "select delete_unused_record('recurring',$1)",
          [used],
          /ocorrências/,
        );
        const usedCard = (
          await q("select card_id id from card_payments limit 1")
        )[0].id;
        await rejectsUnchanged(
          "select delete_unused_record('card',$1)",
          [usedCard],
          /compras/,
        );
      },
    );
    await t.test("isolamento A/B, autenticação, grants e RLS", async () => {
      const i = await investment(),
        c = await card(),
        p = await purchase(c),
        g = (
          await q(
            "insert into goals(name,target_amount_cents) values('Privada',1000) returning id",
          )
        )[0].id;
      const original = await snapshot();
      await as(other);
      for (const [sql, args] of [
        ["select delete_investment($1)", [i]],
        ["select delete_card_purchase($1)", [p]],
        ["select delete_goal($1)", [g]],
        ["select delete_unused_record('card',$1)", [c]],
      ])
        await assert.rejects(q(sql, args), /não encontrad/);
      await as(user);
      assert.deepEqual(await snapshot(), original);
      await as("");
      await assert.rejects(q("select delete_goal($1)", [g]), /Autenticação/);
      await db.exec("reset role;set role anon");
      for (const sql of [
        "select delete_goal(null)",
        "select delete_card_purchase(null)",
        "select delete_investment(null)",
        "select delete_unused_record('card',null)",
      ])
        await assert.rejects(q(sql), /permission denied/);
      await db.exec("reset role");
      assert.ok(
        (
          await q("select rowsecurity from pg_tables where schemaname='public'")
        ).every((r) => r.rowsecurity),
      );
    });
  } finally {
    await db.close();
  }
});
