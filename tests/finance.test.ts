import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMoney,
  inputMoney,
  balance,
  balanceSummary,
  monthly,
  goalProgress,
} from "../src/utils/finance.ts";
import type { Account, Transaction, Goal } from "../src/types/index.ts";
test("valores monetários usam centavos exatos e rejeitam entradas ambíguas", () => {
  assert.equal(parseMoney("0,29"), 29);
  assert.equal(parseMoney("1250.5"), 125050);
  assert.equal(parseMoney("-12,34"), -1234);
  for (const v of [
    "1.000,00",
    "1e3",
    "1,234",
    "",
    "NaN",
    "Infinity",
    "10000000001",
  ])
    assert.throws(() => parseMoney(v));
  for (const n of [0, 29, -1234, 1000000000000])
    assert.equal(parseMoney(inputMoney(n)), n);
});
const base = { id: "a", user_id: "u", created_at: "" };
const a: Account = {
  ...base,
  name: "A",
  type: "checking",
  initial_balance_cents: 10000,
  currency: "BRL",
  is_active: true,
};
const b: Account = { ...a, id: "b", initial_balance_cents: 2000 };
const t: Transaction = {
  ...base,
  id: "t",
  account_id: "a",
  destination_account_id: "b",
  category_id: null,
  type: "transfer",
  amount_cents: 3000,
  description: "",
  transaction_date: "2026-10-01",
  is_recurring: false,
  recurrence_frequency: null,
};
test("transferência preserva patrimônio e não entra no resultado mensal", () => {
  assert.equal(balance(a, [t], "2026-10-01"), 7000);
  assert.equal(balance(b, [t], "2026-10-01"), 5000);
  assert.equal(
    balance(a, [t], "2026-10-01") + balance(b, [t], "2026-10-01"),
    12000,
  );
  assert.deepEqual(monthly([t], "2026-10"), {
    income: 0,
    expense: 0,
    result: 0,
    saved: null,
  });
});
test("edição, exclusão e lançamentos futuros recalculam o saldo", () => {
  assert.equal(balance(a, [{ ...t, amount_cents: 1000 }], "2026-10-01"), 9000);
  assert.equal(balance(a, []), 10000);
  assert.equal(balance(a, [t], "2026-09-30"), 10000);
});
test("resultado do mês separa entradas, saídas e períodos", () => {
  const rows = [
    { ...t, type: "income" as const, amount_cents: 10000 },
    { ...t, type: "expense" as const, amount_cents: 2500 },
    { ...t, type: "expense" as const, transaction_date: "2026-09-01" },
  ];
  assert.deepEqual(monthly(rows, "2026-10"), {
    income: 10000,
    expense: 2500,
    result: 7500,
    saved: 75,
  });
});
test("objetivo soma apenas os aportes vinculados e limita valor restante a zero", () => {
  const g: Goal = {
    ...base,
    name: "Reserva",
    target_amount_cents: 10000,
    initial_amount_cents: 2000,
    target_date: null,
    is_active: true,
  };
  assert.deepEqual(
    goalProgress(g, [
      {
        ...base,
        id: "c",
        goal_id: "a",
        amount_cents: 9000,
        contribution_date: "2026-10-01",
        description: "",
      },
      {
        ...base,
        id: "d",
        goal_id: "outro",
        amount_cents: 100,
        contribution_date: "2026-10-01",
        description: "",
      },
    ]),
    { accumulated: 11000, remaining: 0, percent: 110 },
  );
});

test("resumo separa os cinco tipos, inclui arquivadas e mantém centavos negativos", () => {
  const accounts = [
    { ...a, initial_balance_cents: -29 },
    { ...a, id: "wallet", type: "wallet", initial_balance_cents: 150 },
    { ...a, id: "other", type: "other", initial_balance_cents: 300 },
    {
      ...a,
      id: "savings",
      type: "savings",
      initial_balance_cents: 500,
      is_active: false,
    },
    { ...a, id: "investment", type: "investment", initial_balance_cents: 700 },
  ];
  assert.deepEqual(balanceSummary(accounts, []), {
    available: 421,
    reserve: 1200,
    total: 1621,
  });
  assert.deepEqual(balanceSummary([], []), {
    available: 0,
    reserve: 0,
    total: 0,
  });
});
test("transferências para reserva reduzem disponível sem mudar patrimônio, e retorno inverte", () => {
  for (const type of ["savings", "investment"]) {
    const accounts = [a, { ...b, type }];
    assert.deepEqual(balanceSummary(accounts, [t], "2026-10-01"), {
      available: 7000,
      reserve: 5000,
      total: 12000,
    });
    assert.deepEqual(balanceSummary(accounts, [t], "2026-09-30"), {
      available: 10000,
      reserve: 2000,
      total: 12000,
    });
    const back = {
      ...t,
      id: "back",
      account_id: "b",
      destination_account_id: "a",
      amount_cents: 1000,
    };
    assert.deepEqual(balanceSummary(accounts, [t, back], "2026-10-01"), {
      available: 8000,
      reserve: 4000,
      total: 12000,
    });
  }
});
test("transferências internas de cada grupo preservam ambos os subtotais", () => {
  for (const types of [
    ["checking", "wallet"],
    ["savings", "investment"],
  ]) {
    const accounts = [
      { ...a, type: types[0] },
      { ...b, type: types[1] },
    ];
    assert.deepEqual(
      balanceSummary(accounts, [t], "2026-10-01"),
      balanceSummary(accounts, [], "2026-10-01"),
    );
  }
});
