import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("V0.2 incremental em PostgreSQL local com dados V0.1 preservados", async (t) => {
  const db = new PGlite();
  const users = [randomUUID(), randomUUID()];
  const fixtures = [];
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const asUser = async (id) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  };
  const migrate = async (name) =>
    db.exec(
      await readFile(
        new URL(`../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    await migrate("202610010001_initial.sql");
    for (const user of users) {
      await db.query("insert into auth.users(id) values($1)", [user]);
      await asUser(user);
      const account = (
        await rows(
          "insert into accounts(name,type,initial_balance_cents) values('Conta','checking',10000) returning *",
        )
      )[0];
      const reserve = (
        await rows(
          "insert into accounts(name,type,initial_balance_cents) values('Reserva','savings',5000) returning *",
        )
      )[0];
      const category = (
        await rows("select * from categories where type='expense' limit 1")
      )[0];
      const tx = (
        await rows(
          "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',100,'2026-10-01') returning *",
          [account.id, category.id],
        )
      )[0];
      const goal = (
        await rows(
          "insert into goals(name,target_amount_cents) values('Meta histórica',1000) returning *",
        )
      )[0];
      const contribution = (
        await rows(
          "insert into goal_contributions(goal_id,amount_cents,contribution_date) values($1,100,'2026-10-01') returning *",
          [goal.id],
        )
      )[0];
      fixtures.push({ account, reserve, category, tx, goal, contribution });
      await db.exec("reset role");
    }
    const before = {};
    for (const table of [
      "accounts",
      "categories",
      "transactions",
      "goals",
      "goal_contributions",
    ])
      before[table] = await rows(`select * from ${table} order by id`);
    await migrate("202610010002_planning.sql");
    await migrate("202610010003_planning_integrity.sql");
    await migrate("202610020004_financial_clarity.sql");
    await t.test(
      "preserva cada campo dos registros anteriores sem reset",
      async () => {
        for (const [table, old] of Object.entries(before))
          for (const original of old) {
            const current = (
              await rows(`select * from ${table} where id=$1`, [original.id])
            )[0];
            for (const key of Object.keys(original))
              assert.deepEqual(current[key], original[key], `${table}.${key}`);
          }
        assert.equal(
          (
            await rows(
              "select count(*)::int n from categories where name='Dívidas'",
            )
          ).at(0).n,
          2,
        );
      },
    );
    for (let i = 0; i < users.length; i++) {
      await asUser(users[i]);
      const f = fixtures[i];
      f.card = (
        await rows(
          "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cartão',20,28,$1) returning *",
          [f.account.id],
        )
      )[0];
      f.purchase = (
        await rows(
          "insert into card_purchases(card_id,category_id,amount_cents,purchase_date,installments,first_due_date,due_anchor_day) values($1,$2,10001,'2026-10-01',3,'2000-01-01',1) returning *",
          [f.card.id, f.category.id],
        )
      )[0];
      f.debt = (
        await rows(
          "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents,next_due_date,payment_account_id) values('Dívida',2500,2500,1000,'2026-10-31',$1) returning *",
          [f.account.id],
        )
      )[0];
      f.rule = (
        await rows(
          "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Conta recorrente','expense',300,$1,$2,'monthly','2026-10-01') returning *",
          [f.account.id, f.category.id],
        )
      )[0];
      await rows(
        "select set_card_invoice($1,$2,5000,'2026-10-28','Fatura atual')",
        [randomUUID(), f.card.id],
      );
      await rows(
        "select pay_card_invoice($1,$2,'2026-10',$3,500,'2026-10-01')",
        [randomUUID(), f.card.id, f.account.id],
      );
      await rows("select pay_debt($1,$2,$3,300,'2026-10-01')", [
        randomUUID(),
        f.debt.id,
        f.account.id,
      ]);
      await rows("select resolve_recurring($1,$2,'2026-10-01',false)", [
        randomUUID(),
        f.rule.id,
      ]);
      await rows("select save_emergency_reserve($1,1000,6,$2::uuid[])", [
        randomUUID(),
        [f.reserve.id],
      ]);
    }
    await t.test(
      "RLS nas nove tabelas A↔B e bloqueio de vínculos cruzados",
      async () => {
        const tables = [
          "recurring_items",
          "recurring_occurrences",
          "credit_cards",
          "card_purchases",
          "card_invoices",
          "card_payments",
          "debts",
          "debt_payments",
          "reserve_account_links",
        ];
        for (let actor = 0; actor < 2; actor++) {
          await asUser(users[actor]);
          const f = fixtures[actor],
            victim = fixtures[1 - actor];
          for (const table of tables) {
            assert.ok(
              (await rows(`select * from ${table}`)).every(
                (r) => r.user_id === users[actor],
              ),
            );
            assert.equal(
              (
                await rows(`select * from ${table} where user_id=$1`, [
                  users[1 - actor],
                ])
              ).length,
              0,
            );
            if (
              [
                "credit_cards",
                "debts",
                "recurring_items",
                "card_purchases",
              ].includes(table)
            ) {
              assert.equal(
                (
                  await rows(
                    `update ${table} set user_id=user_id where user_id=$1 returning id`,
                    [users[1 - actor]],
                  )
                ).length,
                0,
              );
              if (table !== "card_purchases")
                assert.equal(
                  (
                    await rows(
                      `delete from ${table} where user_id=$1 returning id`,
                      [users[1 - actor]],
                    )
                  ).length,
                  0,
                );
            } else
              await assert.rejects(() =>
                rows(`delete from ${table} where user_id=$1`, [
                  users[1 - actor],
                ]),
              );
          }
          await assert.rejects(() =>
            rows(
              "insert into credit_cards(user_id,name,closing_day,due_day,payment_account_id) values($1,'Forjado',20,28,$2)",
              [users[1 - actor], f.account.id],
            ),
          );
          await assert.rejects(() =>
            rows(
              "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cruzado',20,28,$1)",
              [victim.account.id],
            ),
          );
          await assert.rejects(() =>
            rows(
              "insert into recurring_items(name,type,amount_cents,account_id,category_id,frequency,start_date) values('Cruzado','expense',100,$1,$2,'monthly','2026-10-01')",
              [f.account.id, victim.category.id],
            ),
          );
          await assert.rejects(() =>
            rows("select pay_card_invoice($1,$2,'2026-10',$3,1,'2026-10-01')", [
              randomUUID(),
              victim.card.id,
              f.account.id,
            ]),
          );
          await assert.rejects(() =>
            rows("select pay_debt($1,$2,$3,1,'2026-10-01')", [
              randomUUID(),
              victim.debt.id,
              f.account.id,
            ]),
          );
          await assert.rejects(() =>
            rows("select resolve_recurring($1,$2,'2026-11-01',true)", [
              randomUUID(),
              victim.rule.id,
            ]),
          );
          await assert.rejects(() =>
            rows("select save_emergency_reserve($1,1000,6,$2::uuid[])", [
              randomUUID(),
              [victim.reserve.id],
            ]),
          );
          await assert.rejects(() =>
            rows("select set_card_invoice($1,$2,5000,'2026-10-28','Forjada')", [
              randomUUID(),
              victim.card.id,
            ]),
          );
          await assert.rejects(() =>
            rows(
              "insert into card_payments(id,card_id,due_month,transaction_id,amount_cents,payment_date) values($1,$2,'2026-10',$3,1,'2026-10-01')",
              [randomUUID(), f.card.id, f.tx.id],
            ),
          );
          await assert.rejects(() =>
            rows(
              "insert into card_purchases(card_id,category_id,amount_cents,purchase_date,installments,first_due_date,due_anchor_day) values($1,$2,100,'2026-10-01',1,'2026-10-28',28)",
              [victim.card.id, f.category.id],
            ),
          );
          await assert.rejects(() =>
            rows("delete from card_purchases where id=$1", [f.purchase.id]),
          );
        }
      },
    );
    await asUser(users[0]);
    const f = fixtures[0];
    await t.test(
      "fatura manual, parcelas, pagamento atômico e repetição idempotente",
      async () => {
        assert.equal(
          f.purchase.first_due_date.toISOString().slice(0, 10),
          "2026-10-28",
        );
        assert.equal(f.purchase.due_anchor_day, 28);
        const before = Number(
          (await rows("select count(*) n from transactions"))[0].n,
        );
        const id = randomUUID();
        await rows(
          "select pay_card_invoice($1,$2,'2026-10',$3,500,'2026-10-01')",
          [id, f.card.id, f.account.id],
        );
        await rows(
          "select pay_card_invoice($1,$2,'2026-10',$3,500,'2026-10-01')",
          [id, f.card.id, f.account.id],
        );
        assert.equal(
          Number((await rows("select count(*) n from transactions"))[0].n),
          before + 1,
        );
        assert.equal(
          (
            await rows(
              "select type,category_id,payment_reference from transactions where id=$1",
              [id],
            )
          )[0].type,
          "card_payment",
        );
        await assert.rejects(() =>
          rows("update transactions set amount_cents=1 where id=$1", [id]),
        );
        await assert.rejects(() =>
          rows("delete from transactions where id=$1", [id]),
        );
        await assert.rejects(() =>
          rows(
            "select pay_card_invoice($1,$2,'2026-10',$3,10000,'2026-10-01')",
            [randomUUID(), f.card.id, f.account.id],
          ),
        );
        await assert.rejects(() =>
          rows(
            "select pay_card_invoice($1,$2,'2026-10',$3,1,(financial_date()+1))",
            [randomUUID(), f.card.id, f.account.id],
          ),
        );
        assert.equal(
          Number((await rows("select count(*) n from transactions"))[0].n),
          before + 1,
        );
        const request = randomUUID();
        await rows(
          "select set_card_invoice($1,$2,6000,'2026-10-28','Atualizada')",
          [request, f.card.id],
        );
        await rows(
          "insert into card_purchases(card_id,category_id,amount_cents,purchase_date,installments,first_due_date,due_anchor_day) values($1,$2,1000,'2026-10-01',1,'2026-10-28',28)",
          [f.card.id, f.category.id],
        );
        await rows(
          "select set_card_invoice($1,$2,6000,'2026-10-28','Atualizada')",
          [request, f.card.id],
        );
        await db.exec("reset role");
        assert.equal(
          Number(
            (
              await rows("select invoice_total($1,'2026-10',$2) n", [
                f.card.id,
                users[0],
              ])
            )[0].n,
          ),
          7000,
        );
        assert.equal(
          Number(
            (
              await rows("select invoice_total($1,'2026-11',$2) n", [
                f.card.id,
                users[0],
              ])
            )[0].n,
          ),
          3334,
        );
        await asUser(users[0]);
      },
    );
    await t.test(
      "dívida parcial, avanço de calendário, limite final e integridade de edição",
      async () => {
        const unscheduled = (
          await rows(
            "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents) values('Importada',1000,1000,100) returning id",
          )
        )[0];
        const scheduled = (
          await rows(
            "update debts set next_due_date='2026-10-31' where id=$1 returning *",
            [unscheduled.id],
          )
        )[0];
        assert.equal(scheduled.due_anchor_day, 31);
        await assert.rejects(() =>
          rows("update debts set next_due_date='2026-12-31' where id=$1", [
            f.debt.id,
          ]),
        );
        const id = randomUUID();
        await rows("select pay_debt($1,$2,$3,700,'2026-10-01')", [
          id,
          f.debt.id,
          f.account.id,
        ]);
        await rows("select pay_debt($1,$2,$3,700,'2026-10-01')", [
          id,
          f.debt.id,
          f.account.id,
        ]);
        let d = (await rows("select * from debts where id=$1", [f.debt.id]))[0];
        assert.equal(Number(d.remaining_amount_cents), 1500);
        assert.equal(Number(d.installment_paid_cents), 0);
        assert.equal(d.next_due_date.toISOString().slice(0, 10), "2026-11-30");
        await assert.rejects(() =>
          rows("update debts set remaining_amount_cents=0 where id=$1", [
            f.debt.id,
          ]),
        );
        await rows("select pay_debt($1,$2,$3,300,'2026-10-01')", [
          randomUUID(),
          f.debt.id,
          f.account.id,
        ]);
        await assert.rejects(() =>
          rows("update debts set installment_amount_cents=200 where id=$1", [
            f.debt.id,
          ]),
        );
        await assert.rejects(() =>
          rows("select pay_debt($1,$2,$3,1201,'2026-10-01')", [
            randomUUID(),
            f.debt.id,
            f.account.id,
          ]),
        );
        await rows("select pay_debt($1,$2,$3,1200,'2026-10-01')", [
          randomUUID(),
          f.debt.id,
          f.account.id,
        ]);
        d = (await rows("select * from debts where id=$1", [f.debt.id]))[0];
        assert.equal(Number(d.remaining_amount_cents), 0);
        assert.equal(d.next_due_date, null);
      },
    );
    await t.test(
      "realizar/pular não duplica e criação recorrente inclui primeira ocorrência",
      async () => {
        const count = Number(
          (await rows("select count(*) n from transactions"))[0].n,
        );
        await rows("select resolve_recurring($1,$2,'2026-10-01',false)", [
          randomUUID(),
          f.rule.id,
        ]);
        assert.equal(
          Number((await rows("select count(*) n from transactions"))[0].n),
          count,
        );
        await rows("select resolve_recurring($1,$2,'2026-11-01',true)", [
          randomUUID(),
          f.rule.id,
        ]);
        await rows("select resolve_recurring($1,$2,'2026-11-01',true)", [
          randomUUID(),
          f.rule.id,
        ]);
        assert.equal(
          Number(
            (
              await rows(
                "select count(*) n from recurring_occurrences where recurring_item_id=$1",
                [f.rule.id],
              )
            )[0].n,
          ),
          2,
        );
        await assert.rejects(() =>
          rows("select resolve_recurring($1,$2,'2026-12-01',false)", [
            randomUUID(),
            f.rule.id,
          ]),
        );
        await assert.rejects(() =>
          rows("select resolve_recurring($1,$2,'2026-10-02',true)", [
            randomUUID(),
            f.rule.id,
          ]),
        );
        const id = randomUUID(),
          rule = randomUUID(),
          payload = {
            account_id: f.account.id,
            category_id: f.category.id,
            type: "expense",
            amount_cents: 500,
            description: "Assinatura",
            transaction_date: "2026-10-01",
            recurrence_frequency: "monthly",
          };
        await rows("select repeat_transaction($1,$2,$3::jsonb,false)", [
          id,
          rule,
          JSON.stringify(payload),
        ]);
        await rows("select repeat_transaction($1,$2,$3::jsonb,false)", [
          id,
          rule,
          JSON.stringify(payload),
        ]);
        assert.equal(
          (
            await rows(
              "select * from recurring_occurrences where transaction_id=$1",
              [id],
            )
          ).length,
          1,
        );
        assert.equal(
          (await rows("select * from recurring_items where id=$1", [rule]))
            .length,
          1,
        );
      },
    );
    await t.test(
      "reserva selecionada preserva metas e bloqueia contas e acesso anônimo inválidos",
      async () => {
        const id = randomUUID();
        await rows("select save_emergency_reserve($1,null,6,$2::uuid[])", [
          id,
          [f.reserve.id],
        ]);
        assert.equal(
          (await rows("select * from goals where is_emergency_reserve")).length,
          1,
        );
        assert.equal(
          (await rows("select * from goals where id=$1", [f.goal.id])).length,
          1,
        );
        await assert.rejects(() =>
          rows("select save_emergency_reserve($1,1000,6,$2::uuid[])", [
            randomUUID(),
            [f.account.id],
          ]),
        );
        await db.exec("reset role;set role anon");
        await assert.rejects(() => rows("select * from credit_cards"));
        await assert.rejects(() =>
          rows("select save_emergency_reserve($1,1000,6,$2::uuid[])", [
            randomUUID(),
            [],
          ]),
        );
      },
    );
    await t.test(
      "programadas confirmam/cancelam atomicamente e ajustes não reescrevem saldo inicial",
      async () => {
        await asUser(users[0]);
        const f = fixtures[0];
        const id = randomUUID();
        await rows(
          "insert into transactions(id,account_id,category_id,type,amount_cents,transaction_date,status) values($1,$2,$3,'expense',321,'2020-01-01','pending')",
          [id, f.account.id, f.category.id],
        );
        await asUser(users[1]);
        await assert.rejects(() =>
          rows("select resolve_transaction($1,false,financial_date())", [id]),
        );
        await asUser(users[0]);
        await assert.rejects(() =>
          rows("update transactions set status='realized' where id=$1", [id]),
        );
        await assert.rejects(() =>
          rows("select resolve_transaction($1,false,financial_date()+1)", [id]),
        );
        await rows("select resolve_transaction($1,false,financial_date())", [
          id,
        ]);
        await rows("select resolve_transaction($1,false,financial_date())", [
          id,
        ]);
        assert.equal(
          (await rows("select * from transactions where id=$1", [id]))[0]
            .status,
          "realized",
        );
        const cancel = randomUUID();
        await rows(
          "insert into transactions(id,account_id,category_id,type,amount_cents,transaction_date,status) values($1,$2,$3,'expense',123,'2020-01-01','pending')",
          [cancel, f.account.id, f.category.id],
        );
        await rows("select resolve_transaction($1,true,null)", [cancel]);
        assert.equal(
          (await rows("select * from transactions where id=$1", [cancel]))[0]
            .status,
          "cancelled",
        );
        const future = (
          await rows(
            "insert into transactions(account_id,category_id,type,amount_cents,transaction_date) values($1,$2,'expense',111,financial_date()+1) returning *",
            [f.account.id, f.category.id],
          )
        )[0];
        assert.equal(future.status, "pending");
        const adjust = randomUUID();
        await rows("select adjust_account_balance($1,$2,-500)", [
          adjust,
          f.account.id,
        ]);
        await rows("select adjust_account_balance($1,$2,-500)", [
          adjust,
          f.account.id,
        ]);
        const tx = (
          await rows("select * from transactions where id=$1", [adjust])
        )[0];
        assert.equal(tx.type, "adjustment");
        assert.ok(tx.adjustment_delta_cents < 0);
        const current = (
          await rows("select * from accounts where id=$1", [f.account.id])
        )[0];
        assert.equal(
          current.initial_balance_cents,
          f.account.initial_balance_cents,
        );
        await assert.rejects(() =>
          rows("delete from transactions where id=$1", [adjust]),
        );
        await assert.rejects(() =>
          rows(
            "insert into transactions(account_id,type,amount_cents,adjustment_delta_cents,transaction_date) values($1,'adjustment',10,10,financial_date())",
            [f.account.id],
          ),
        );
        await asUser(users[1]);
        await assert.rejects(() =>
          rows("select adjust_account_balance($1,$2,0)", [
            randomUUID(),
            f.account.id,
          ]),
        );
      },
    );
    await t.test(
      "numeração e último pagamento de parcela preservam limite e quitação",
      async () => {
        await asUser(users[0]);
        const f = fixtures[0];
        const d = (
          await rows(
            "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents,installment_number,total_installments,next_due_date,payment_account_id) values('8 de 14',14000,6500,1000,8,14,'2026-10-31',$1) returning *",
            [f.account.id],
          )
        )[0];
        await rows("select pay_debt($1,$2,$3,1500,financial_date())", [
          randomUUID(),
          d.id,
          f.account.id,
        ]);
        let current = (
          await rows("select * from debts where id=$1", [d.id])
        )[0];
        assert.equal(current.installment_number, 9);
        assert.equal(current.installment_paid_cents, 500);
        await assert.rejects(() =>
          rows("update debts set total_installments=15 where id=$1", [d.id]),
        );
        await assert.rejects(() =>
          rows("select pay_debt($1,$2,$3,5001,financial_date())", [
            randomUUID(),
            d.id,
            f.account.id,
          ]),
        );
        await rows("select pay_debt($1,$2,$3,5000,financial_date())", [
          randomUUID(),
          d.id,
          f.account.id,
        ]);
        current = (await rows("select * from debts where id=$1", [d.id]))[0];
        assert.equal(current.remaining_amount_cents, 0);
        assert.equal(current.installment_number, 15);
        assert.equal(current.next_due_date, null);
      },
    );
    await t.test(
      "recorrência futura pendente confirma sem duplicar regra ou transação",
      async () => {
        await asUser(users[0]);
        const f = fixtures[0],
          id = randomUUID(),
          rule = randomUUID();
        await rows("select repeat_transaction($1,$2,$3::jsonb,false)", [
          id,
          rule,
          JSON.stringify({
            account_id: f.account.id,
            category_id: f.category.id,
            type: "expense",
            amount_cents: 200,
            description: "Recorrência futura",
            transaction_date: "2099-01-01",
            recurrence_frequency: "monthly",
          }),
        ]);
        assert.equal(
          (await rows("select status from transactions where id=$1", [id]))[0]
            .status,
          "pending",
        );
        await rows("select resolve_recurring($1,$2,'2099-01-01',false)", [
          randomUUID(),
          rule,
        ]);
        assert.equal(
          (await rows("select status from transactions where id=$1", [id]))[0]
            .status,
          "realized",
        );
        assert.equal(
          (
            await rows(
              "select * from recurring_occurrences where recurring_item_id=$1",
              [rule],
            )
          ).length,
          1,
        );
        assert.equal(
          (await rows("select * from transactions where id=$1", [id])).length,
          1,
        );
      },
    );
  } finally {
    await db.close();
  }
});
