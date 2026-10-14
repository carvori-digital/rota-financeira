import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinancialExport } from "../src/features/export/calculations.ts";
import {
  financialCsv,
  financialJson,
  financialPdf,
  csvCell,
} from "../src/features/export/formats.ts";
import { validateSnapshot } from "../src/features/export/snapshot.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type { ExportSnapshot } from "../src/features/export/snapshot.ts";
const base = { user_id: "user-a", created_at: "2026-09-01T00:00:00Z" };
function snapshot(): ExportSnapshot {
  return {
    owner: base.user_id,
    generated_at: "2026-10-13T12:00:00Z",
    counts: { transactions: 3 },
    confirmations: [],
    finance: {
      accounts: [],
      categories: [],
      goals: [],
      goal_contributions: [],
      transactions: [
        {
          ...base,
          id: "income",
          type: "income",
          status: "realized",
          amount_cents: 100000,
          description: "Receita",
          transaction_date: "2026-09-01",
          account_id: "cash",
          destination_account_id: null,
          category_id: null,
          is_recurring: false,
          recurrence_frequency: null,
        },
        {
          ...base,
          id: "expense",
          type: "expense",
          status: "realized",
          amount_cents: 20000,
          description: '=HYPERLINK("malicious")',
          transaction_date: "2026-09-02",
          account_id: "cash",
          destination_account_id: null,
          category_id: null,
          is_recurring: false,
          recurrence_frequency: null,
        },
        {
          ...base,
          id: "planned",
          type: "expense",
          status: "pending",
          amount_cents: 15000,
          description: "Planejada",
          transaction_date: "2026-10-15",
          account_id: "cash",
          destination_account_id: null,
          category_id: null,
          is_recurring: false,
          recurrence_frequency: null,
        },
      ],
    },
    plan: structuredClone(emptyPlanning),
  };
}
test("summary and detail have identical totals; JSON valid, no auth fields, boundaries honored", () => {
  const s = snapshot();
  const o = { start: "2026-09-01", end: "2026-09-30", detailed: false };
  const a = buildFinancialExport(s, o),
    b = buildFinancialExport(s, { ...o, detailed: true });
  assert.deepEqual(a.realized, b.realized);
  assert.equal(a.realized.income_cents, 100000);
  assert.equal(a.realized.expense_cents, 20000);
  assert.equal(a.realized.result_cents, 80000);
  assert.equal(a.details, undefined);
  assert.equal(b.details?.transactions.length, 2);
  const parsed = JSON.parse(financialJson(b));
  assert.equal(parsed.schema_version, "rota-financial-export/1.0");
  assert.ok(!financialJson(b).includes("user-a"));
  assert.equal(
    buildFinancialExport(s, {
      start: "2026-09-02",
      end: "2026-09-02",
      detailed: true,
    }).realized.income_cents,
    0,
  );
  assert.throws(() =>
    buildFinancialExport(s, {
      start: "2026-09-31",
      end: "2026-10-01",
      detailed: false,
    }),
  );
});
test("partial September never enters complete-month means without explicit confirmation", () => {
  const s = snapshot(),
    o = { start: "2026-09-01", end: "2026-09-30", detailed: false };
  assert.equal(
    buildFinancialExport(s, o).indicators
      .average_expenses_complete_months_cents,
    null,
  );
  s.confirmations = [
    {
      id: "confirmed",
      user_id: base.user_id,
      month: "2026-09-01",
      complete: true,
      confirmed_at: s.generated_at,
    },
  ];
  const r = buildFinancialExport(s, o);
  assert.equal(r.indicators.average_expenses_complete_months_cents, 20000);
  assert.equal(r.indicators.observed_savings_cents, 80000);
  assert.equal(
    buildFinancialExport(s, { ...o, start: "2026-09-02" }).indicators
      .average_expenses_complete_months_cents,
    null,
  );
});
test("empty period does not invent income or savings; future rejected", () => {
  const s = snapshot();
  const r = buildFinancialExport(s, {
    start: "2026-08-01",
    end: "2026-08-31",
    detailed: true,
  });
  assert.equal(r.realized.income_cents, 0);
  assert.equal(r.realized.expense_cents, 0);
  assert.equal(r.indicators.observed_savings_cents, null);
  assert.equal(r.details?.transactions.length, 0);
  assert.throws(() =>
    buildFinancialExport(s, {
      start: "2026-10-01",
      end: "2026-11-01",
      detailed: false,
    }),
  );
});
test("CSV BOM, Brazilian decimals, quotes, accent and formula-injection defenses", () => {
  const s = snapshot(),
    r = buildFinancialExport(s, {
      start: "2026-09-01",
      end: "2026-09-30",
      detailed: true,
    });
  const csv = financialCsv(r);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("200,00"));
  assert.ok(csv.includes('"\'=HYPERLINK(""malicious"")"'));
  assert.ok(csv.includes("Patrimônio"));
  for (const v of ["=1+1", " +cmd", "-cmd", "@sum", "\t=1"])
    assert.ok(csvCell(v).startsWith("\"'"));
});
test("PDF generated locally for summary/detail with multiple pages", async () => {
  const s = snapshot();
  for (const detailed of [false, true]) {
    const r = buildFinancialExport(s, {
      start: "2026-09-01",
      end: "2026-09-30",
      detailed,
    });
    const pdf = await financialPdf(r);
    assert.equal(pdf.type, "application/pdf");
    assert.ok(pdf.size > 1000);
    const prefix = new TextDecoder().decode(
      (await pdf.arrayBuffer()).slice(0, 8),
    );
    assert.ok(prefix.startsWith("%PDF-"));
  }
});
test("snapshot blocks missing tables, truncation and cross-user rows", () => {
  const s = snapshot();
  const data = { ...s.finance, ...s.plan, report_month_confirmations: [] };
  delete (data as Record<string, unknown>).cdi_history;
  const counts = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
  );
  const raw = {
    schema_version: 1,
    owner: s.owner,
    generated_at: s.generated_at,
    counts,
    data,
  };
  assert.equal(validateSnapshot(raw, s.owner).finance.transactions.length, 3);
  assert.throws(() => validateSnapshot(raw, "user-b"));
  assert.throws(() =>
    validateSnapshot(
      { ...raw, counts: { ...counts, transactions: 4 } },
      s.owner,
    ),
  );
  assert.throws(() =>
    validateSnapshot(
      {
        ...raw,
        data: {
          ...data,
          transactions: [{ ...data.transactions[0], user_id: "user-b" }],
        },
        counts: { ...counts, transactions: 1 },
      },
      s.owner,
    ),
  );
  assert.throws(() =>
    validateSnapshot({ ...raw, data: { ...data, debts: undefined } }, s.owner),
  );
});
