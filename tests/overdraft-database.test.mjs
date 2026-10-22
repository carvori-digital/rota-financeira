import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as id } from "node:crypto";
import { readFile } from "node:fs/promises";
import { financialFixture, normalizeRows } from "./financial-fixture.mjs";
import { emptyPlanning } from "../src/features/planning/types.ts";
import { balance } from "../src/utils/finance.ts";
import {
  bankingSummary,
  overdraftPosition,
} from "../src/features/overdraft/calculations.ts";
import { validateSnapshot } from "../src/features/export/snapshot.ts";
import { buildFinancialExport } from "../src/features/export/calculations.ts";
import {
  financialCsv,
  financialJson,
  financialPdf,
} from "../src/features/export/formats.ts";
async function fixture() {
  const f = await financialFixture();
  const rawData = f.data;
  f.data = async () =>
    Object.fromEntries(
      Object.entries(await rawData()).map(([k, rows]) => [
        k,
        normalizeRows(rows),
      ]),
    );
  f.account = (
    await f.q(
      "insert into accounts(name,type,initial_balance_cents) values('Itaú sintético','checking',0) returning id",
    )
  )[0].id;
  f.terms = {
    tracking_start: "2026-10-10",
    effective_date: "2026-10-10",
    limit_cents: 100000,
    active: true,
    statement_model: "negative_balance",
    monthly_interest_rate: null,
    contract_notes: "",
    change_reason: "Extrato sintético",
  };
  f.save = (extra = {}, expected = null, request = id(), account = f.account) =>
    f.q("select save_account_overdraft($1,$2,$3,$4)", [
      request,
      account,
      expected,
      { ...f.terms, ...extra },
    ]);
  f.tx = async (
    type,
    amount,
    date = "2026-10-13",
    extra = {},
    request = id(),
  ) => {
    const payload = {
      type,
      account_id: f.account,
      category_id:
        type === "income" ? f.income : type === "expense" ? f.cat : null,
      amount_cents: amount,
      transaction_date: date,
      description: "Sintético",
      ...extra,
    };
    await f.q("select create_financial_transaction($1,$2)", [request, payload]);
    return request;
  };
  f.plan = async () => {
    const p = { ...emptyPlanning };
    for (const t of Object.keys(emptyPlanning))
      p[t] = normalizeRows(await f.q("select * from " + t));
    return p;
  };
  return f;
}
test("ledger crosses zero for Pix/debit and receipts recover without artificial income/expense", async () => {
  const f = await fixture();
  try {
    await f.tx("income", 10000);
    await f.tx("transfer", 20000, undefined, {
      destination_account_id: f.other,
    });
    await f.tx("expense", 20000);
    assert.equal(await f.bank(f.account), -30000);
    await f.save();
    let d = await f.data(),
      p = await f.plan();
    let account = d.accounts.find((a) => a.id === f.account);
    assert.equal(overdraftPosition(account, d, p, "2026-10-15").used, 30000);
    await f.tx("income", 20000);
    assert.equal(await f.bank(f.account), -10000);
    await f.tx("income", 10000);
    assert.equal(await f.bank(f.account), 0);
    await f.tx("income", 50000);
    assert.equal(await f.bank(f.account), 50000);
    assert.equal((await f.q("select * from debts")).length, 0);
    assert.equal((await f.q("select * from transactions")).length, 6);
    assert.equal(
      (
        await f.q("select initial_balance_cents from accounts where id=$1", [
          f.account,
        ])
      )[0].initial_balance_cents,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("versioned limits, optimistic concurrency, retries and deactivation preserve debt and history", async () => {
  const f = await fixture();
  try {
    await f.tx("expense", 30000);
    const request = id();
    await f.save({}, null, request);
    await f.save({}, null, request);
    assert.equal(
      (await f.q("select * from account_overdraft_versions")).length,
      1,
    );
    await assert.rejects(
      f.save({ limit_cents: 1 }, null, request),
      /outros parâmetros/,
    );
    await assert.rejects(f.save(), /Configuração mudou/);
    await assert.rejects(
      f.save({ effective_date: "2026-10-14" }, request),
      /datas passadas/,
    );
    const second = id();
    await f.save(
      { effective_date: "2026-10-15", limit_cents: 20000 },
      request,
      second,
    );
    await f.save({ effective_date: "2026-10-16", active: false }, second);
    const d = await f.data(),
      p = await f.plan(),
      a = d.accounts.find((a) => a.id === f.account);
    assert.equal(overdraftPosition(a, d, p, "2026-10-13").remaining, 70000);
    assert.equal(
      overdraftPosition(a, d, p, "2026-10-15").state,
      "Acima do limite",
    );
    assert.equal(overdraftPosition(a, d, p, "2026-10-16").remaining, 0);
    assert.equal(await f.bank(f.account), -30000);
    await assert.rejects(
      f.q("update accounts set type='wallet' where id=$1", [f.account]),
      /Preserve o tipo/,
    );
  } finally {
    await f.db.close();
  }
});
test("explicit reconciliation captures divergence and original ledger, never adjusts it; stale previews fail", async () => {
  const f = await fixture();
  try {
    await f.tx("expense", 30000);
    const req = id(),
      args = [
        req,
        f.account,
        "2026-10-14",
        -35000,
        -30000,
        "Extrato sintético de outubro; diferença ainda não explicada",
        true,
      ];
    await assert.rejects(
      f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", [
        ...args.slice(0, 6),
        false,
      ]),
      /Confirme/,
    );
    await f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", args);
    await f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", args);
    const before = (await f.q("select * from bank_reconciliations"))[0];
    assert.equal(before.difference_cents, -5000);
    assert.equal(before.ledger_snapshot.transactions.length, 1);
    assert.equal(await f.bank(f.account), -30000);
    await f.tx("expense", 5000, "2026-10-01");
    assert.equal(await f.bank(f.account), -35000);
    await assert.rejects(
      f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", [
        id(),
        ...args.slice(1),
      ]),
      /Saldo mudou/,
    );
    assert.deepEqual(
      (await f.q("select * from bank_reconciliations"))[0],
      before,
    );
    assert.equal(
      (await f.q("select * from transactions where type='adjustment'")).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("financial charges post one expense with retry and reject invalid account/type/recurrence", async () => {
  const f = await fixture();
  try {
    const req = id();
    await f.tx(
      "expense",
      1000,
      undefined,
      { financial_charge: "overdraft_interest" },
      req,
    );
    await f.tx(
      "expense",
      1000,
      undefined,
      { financial_charge: "overdraft_interest" },
      req,
    );
    await f.tx("expense", 100, undefined, {
      financial_charge: "overdraft_iof",
    });
    assert.equal(await f.bank(f.account), -1100);
    await assert.rejects(
      f.tx("income", 100, undefined, { financial_charge: "overdraft_iof" }),
      /financial_charge_expense/,
    );
    await assert.rejects(
      f.tx("expense", 100, undefined, {
        financial_charge: "overdraft_iof",
        is_recurring: true,
        recurrence_frequency: "monthly",
      }),
      /financial_charge_expense/,
    );
    const savings = (
      await f.q(
        "insert into accounts(name,type,initial_balance_cents) values('Reserva','savings',5000) returning id",
      )
    )[0].id;
    await assert.rejects(
      f.tx("expense", 100, undefined, {
        financial_charge: "overdraft_iof",
        account_id: savings,
      }),
      /conta corrente correta/,
    );
    await assert.rejects(f.save({}, null, id(), savings), /conta corrente/);
    assert.equal(
      (
        await f.q(
          "select * from financial_audit where table_name='transactions'",
        )
      ).length >= 2,
      true,
    );
  } finally {
    await f.db.close();
  }
});
test("RLS, cross-owner IDs, direct writes and anon RPCs cannot mutate or expose bank evidence", async () => {
  const f = await fixture();
  try {
    const req = id();
    await f.save({}, null, req);
    await f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", [
      id(),
      f.account,
      "2026-10-15",
      0,
      0,
      "Extrato sintético",
      true,
    ]);
    await assert.rejects(
      f.q("update account_overdraft_versions set limit_cents=1"),
      /permission denied/,
    );
    await assert.rejects(
      f.q("delete from bank_reconciliations"),
      /permission denied/,
    );
    await f.as(f.b);
    assert.equal(
      (await f.q("select * from account_overdraft_versions")).length,
      0,
    );
    assert.equal((await f.q("select * from bank_reconciliations")).length, 0);
    await assert.rejects(f.save(), /conta corrente/);
    await assert.rejects(f.save({}, null, req), /outros parâmetros/);
    await assert.rejects(
      f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", [
        id(),
        f.account,
        "2026-10-15",
        0,
        0,
        "Extrato sintético",
        true,
      ]),
      /não encontrada/,
    );
    await f.db.exec("reset role;set role anon");
    await assert.rejects(f.save(), /permission denied/);
  } finally {
    await f.db.close();
  }
});
test("014→015→016 preserves existing accounts, IDs, balances, transactions and subscriptions", async () => {
  const f = await financialFixture("202610160015");
  try {
    await f.q("select create_financial_transaction($1,$2)", [
      id(),
      {
        type: "expense",
        account_id: f.cash,
        category_id: f.cat,
        amount_cents: 1030000,
        transaction_date: "2026-10-01",
      },
    ]);
    const before = await f.data();
    await f.db.exec("reset role");
    await f.db.exec(
      await readFile(
        "supabase/migrations/202610160015_card_subscriptions.sql",
        "utf8",
      ),
    );
    await f.as(f.a);
    const card = (
      await f.q(
        "insert into credit_cards(name,closing_day,due_day) values('Sintético',20,28) returning id",
      )
    )[0].id;
    await f.q("select save_card_subscription($1,$2,$3,$4)", [
      id(),
      id(),
      null,
      {
        name: "Sintético",
        card_id: card,
        category_id: f.cat,
        amount_cents: 2000,
        start_date: "2026-10-01",
        billing_day: 13,
        status: "active",
      },
    ]);
    const snap015 = (await f.q("select export_financial_snapshot() s"))[0].s;
    await f.db.exec("reset role");
    await f.db.exec(
      await readFile(
        "supabase/migrations/202610220016_account_overdraft.sql",
        "utf8",
      ),
    );
    await f.as(f.a);
    const snap016 = (await f.q("select export_financial_snapshot() s"))[0].s;
    for (const [table, rows] of Object.entries(snap015.data))
      assert.deepEqual(
        snap016.data[table].map((row) =>
          Object.fromEntries(
            Object.keys(rows.find((r) => r.id === row.id) ?? row).map((k) => [
              k,
              row[k],
            ]),
          ),
        ),
        rows,
        table,
      );
    const after = await f.data();
    assert.deepEqual(after.accounts, before.accounts);
    assert.equal(await f.bank(), -30000);
    assert.equal(snap016.data.account_overdraft_versions.length, 0);
    assert.equal(snap016.data.bank_reconciliations.length, 0);
  } finally {
    await f.db.close();
  }
});
test("consistent exports and reports retain negative positions, charges, contract versions and reconciliation evidence", async () => {
  const f = await fixture();
  try {
    await f.save();
    await f.tx("expense", 30000);
    await f.tx("expense", 1000, undefined, {
      financial_charge: "overdraft_interest",
    });
    await f.q("select record_bank_reconciliation($1,$2,$3,$4,$5,$6,$7)", [
      id(),
      f.account,
      "2026-10-15",
      -31000,
      -31000,
      "Extrato sintético",
      true,
    ]);
    const raw = (await f.q("select export_financial_snapshot() s"))[0].s;
    raw.generated_at = "2026-10-15T12:00:00.000Z";
    const snapshot = validateSnapshot(raw, f.a);
    const r = buildFinancialExport(snapshot, {
      start: "2026-10-01",
      end: "2026-10-15",
      detailed: true,
    });
    assert.equal(r.banking.negative, -31000);
    assert.equal(r.banking.additionalCredit, 69000);
    assert.equal(
      r.bank_reconciliations[0].ledger_snapshot.transactions.length,
      2,
    );
    assert.equal(r.realized.expense_cents, 31000);
    assert.equal(r.estimated.wealth.net_cents, r.banking.net);
    const csv = financialCsv(r);
    assert.match(csv, /Posição bancária líquida/);
    assert.match(csv, /overdraft_interest/);
    assert.match(csv, /account_overdraft_versions/);
    assert.match(financialJson(r), /ledger_snapshot/);
    assert.ok((await financialPdf(r)).size > 0);
    const bad = structuredClone(raw);
    delete bad.data.bank_reconciliations;
    assert.throws(() => validateSnapshot(bad, f.a), /incompleto/);
    const old = structuredClone(raw);
    delete old.data.account_overdraft_versions;
    delete old.data.bank_reconciliations;
    assert.equal(
      validateSnapshot(old, f.a).plan.account_overdraft_versions.length,
      0,
    );
    const d = await f.data(),
      p = await f.plan();
    assert.equal(bankingSummary(d, p, "2026-10-15").net, r.banking.net);
    assert.equal(
      balance(
        d.accounts.find((a) => a.id === f.account),
        d.transactions,
        "2026-10-15",
      ),
      -31000,
    );
  } finally {
    await f.db.close();
  }
});
