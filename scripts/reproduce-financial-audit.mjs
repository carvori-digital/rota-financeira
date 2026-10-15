// Reproduce the unsafe 001–013 schema in a new in-memory database only.
// Never reads connection strings and never contacts a remote service.
import { financialFixture } from "../tests/financial-fixture.mjs";
import { randomUUID as id } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const f = await financialFixture("202610150014"),
  { db, q, rule, bank, cash, cat, other } = f;
const results = { schema: "001–013", synthetic: true, remote_database: false };
try {
  const r = await rule(),
    first = id();
  await q(
    "select record_recurring_payment($1,$2,'2026-10-13',4000,'2026-10-13')",
    [first, r],
  );
  let before = await bank();
  await q("update transactions set amount_cents=1000 where id=$1", [first]);
  results.linkedPostedEdit = { bankBefore: before, bankAfter: await bank() };
  assert.equal(results.linkedPostedEdit.bankAfter - before, 3000);
  await q("update transactions set amount_cents=4000 where id=$1", [first]);
  await q("update recurring_items set account_id=$2 where id=$1", [r, other]);
  const second = id();
  await q(
    "select record_recurring_payment($1,$2,'2026-10-13',6000,'2026-10-15')",
    [second, r],
  );
  const accounts = await q(
    "select account_id from transactions where id in ($1,$2) order by id",
    [first, second],
  );
  assert.equal(new Set(accounts.map((t) => t.account_id)).size, 2);
  results.partialPaidFromChangedRuleAccount = true;
  const investment = id();
  await q("select create_simple_investment($1,$2)", [
    investment,
    {
      name: "Posição sintética",
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
    "select simple_investment_movement($1,$2,'contribution',1000,'2026-10-15',$3,'Conferido: sintético',null,10000,true)",
    [id(), investment, cash],
  );
  before = await bank();
  await q("select delete_investment($1)", [investment]);
  results.oldDelete = { bankBefore: before, bankAfter: await bank() };
  assert.equal(results.oldDelete.bankAfter - before, 1000);
  const ordinary = id();
  await q(
    "insert into transactions(id,account_id,category_id,type,amount_cents,description,transaction_date) values($1,$2,$3,'expense',1000,'Retry sintético','2026-10-15')",
    [ordinary, cash, cat],
  );
  before = await bank();
  await q(
    "insert into transactions(id,account_id,category_id,type,amount_cents,description,transaction_date) values($1,$2,$3,'expense',2000,'Retry sintético','2026-10-15') on conflict(id) do update set amount_cents=excluded.amount_cents",
    [ordinary, cash, cat],
  );
  results.changedCreationRetry = {
    bankBefore: before,
    bankAfter: await bank(),
  };
  assert.equal(results.changedCreationRetry.bankAfter - before, -1000);
  const debt = (
    await q(
      "insert into debts(name,original_amount_cents,remaining_amount_cents,installment_amount_cents,next_due_date,payment_account_id) values('Parcelas sintéticas',30000,30000,10000,'2026-10-13',$1) returning id",
      [cash],
    )
  )[0].id;
  await q("select pay_debt($1,$2,$3,25000,'2026-10-15')", [id(), debt, cash]);
  results.prepayment = await q(
    "select amount_cents,scheduled_date,obligation_amount_cents from debt_payments where debt_id=$1",
    [debt],
  );
  assert.equal(results.prepayment.length, 1);
  assert.equal(Number(results.prepayment[0].obligation_amount_cents), 10000);
  const future = await rule({ start: "2026-11-13" });
  await assert.rejects(
    q(
      "select record_recurring_payment($1,$2,'2026-11-13',10000,'2026-10-15')",
      [id(), future],
    ),
    /futura/,
  );
  results.advancePaymentRejected = true;
  const card = (
    await q(
      "insert into credit_cards(name,closing_day,due_day,payment_account_id) values('Cartão sintético',1,13,$1) returning id",
      [cash],
    )
  )[0].id;
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
  await q("select adjust_card_purchase($1,$2,'2026-11-13',-100,'Crédito')", [
    adjustment,
    purchase,
  ]);
  await q("select adjust_card_purchase($1,$2,'2026-11-13',-200,'Crédito')", [
    adjustment,
    purchase,
  ]);
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
  results.changedCardAdjustmentReplayAcceptedWithoutApplyingNewValue = true;
  const changedTypeRule = await rule(),
    typeComplement = id();
  await q("select set_recurring_occurrence_amount($1,'2026-10-13',10000)", [
    changedTypeRule,
  ]);
  await q(
    "update recurring_items set type='income',category_id=$2 where id=$1",
    [changedTypeRule, f.income],
  );
  await q(
    "select record_recurring_payment($1,$2,'2026-10-13',10000,'2026-10-15')",
    [typeComplement, changedTypeRule],
  );
  results.reclassifiedCapturedPlannedPayment = (
    await q("select type from transactions where id=$1", [typeComplement])
  )[0].type;
  assert.equal(results.reclassifiedCapturedPlannedPayment, "income");
  await mkdir("test-results/audit", { recursive: true });
  await writeFile(
    "test-results/audit/base-findings.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await db.close();
}
