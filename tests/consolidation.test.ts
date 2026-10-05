import { test } from "node:test";
import assert from "node:assert/strict";
import {
  investmentValue,
  wealthSummary,
} from "../src/features/investments/calculations.ts";
import { digitMoney, pastedMoney } from "../src/utils/moneyInput.ts";
import { emptyPlanning } from "../src/features/planning/types.ts";
import type {
  Investment,
  InvestmentMovement,
} from "../src/features/investments/types.ts";
const investment: Investment = {
  id: "i",
  user_id: "u",
  created_at: "",
  updated_at: "",
  name: "Reserva",
  institution: "",
  type: "fixed",
  initial_date: "2025-01-01",
  yield_type: "fixed_annual",
  yield_rate: 10,
  is_emergency_reserve: true,
  active: true,
  source_account_id: null,
};
const m = (
  date: string,
  amount_cents: number,
  type: InvestmentMovement["type"] = "contribution",
): InvestmentMovement => ({
  id: date + type,
  user_id: "u",
  investment_id: "i",
  created_at: "",
  date,
  amount_cents,
  type,
  description: "",
  transaction_id: null,
  source_transaction_id: null,
  source_account_id: null,
});
test("juros compostos por aporte, retirada e sincronização sem rendimento diário persistido", () => {
  assert.equal(
    investmentValue(investment, [m("2025-01-01", 10000)], "2026-01-01").current,
    11000,
  );
  assert.equal(
    investmentValue(
      investment,
      [m("2025-01-01", 10000), m("2026-01-01", 20000)],
      "2026-01-01",
    ).current,
    31000,
  );
  const movements = [
    m("2025-01-01", 10000),
    m("2026-01-01", 1000, "withdrawal"),
    m("2026-01-01", 100, "adjustment"),
  ];
  assert.equal(
    investmentValue(investment, movements, "2026-01-01").current,
    10100,
  );
  assert.equal(
    investmentValue(investment, movements, "2027-01-01").current,
    11110,
  );
  assert.equal(
    investmentValue(
      { ...investment, yield_type: "fixed_monthly" },
      [m("2026-01-01", 10000)],
      "2026-01-31",
    ).current,
    11000,
  );
  assert.equal(
    investmentValue(
      { ...investment, yield_type: "manual" },
      movements,
      "2027-01-01",
    ).current,
    9100,
  );
});
test("disponível, reserva e patrimônio não duplicam contas migradas nem metas", () => {
  const data = {
    accounts: [
      {
        id: "a",
        user_id: "u",
        created_at: "",
        name: "Conta",
        type: "checking",
        is_active: true,
        currency: "BRL",
        initial_balance_cents: 5000,
      },
      {
        id: "old",
        user_id: "u",
        created_at: "",
        name: "Reserva antiga",
        type: "investment",
        is_active: false,
        currency: "BRL",
        initial_balance_cents: 10000,
        investment_id: "i",
      },
    ],
    transactions: [],
    categories: [],
    goals: [],
    goal_contributions: [],
  };
  const result = wealthSummary(
    data,
    {
      ...emptyPlanning,
      investments: [investment],
      investment_movements: [m("2026-01-01", 10000)],
    },
    "2026-01-01",
  );
  assert.equal(result.available, 5000);
  assert.equal(result.reserve, 10000);
  assert.equal(result.gross, 15000);
  assert.equal(result.net, 15000);
});
test("máscara bancária e colagem brasileira preservam centavos", () => {
  for (const [input, value] of [
    ["1", "0,01"],
    ["12", "0,12"],
    ["123", "1,23"],
    ["1234", "12,34"],
    ["2290", "22,90"],
    ["3650", "36,50"],
  ])
    assert.equal(digitMoney(input), value);
  for (const input of ["22,90", "R$ 22,90"])
    assert.equal(pastedMoney(input), "22,90");
  assert.equal(pastedMoney("1.234,56"), "1234,56");
  assert.equal(digitMoney("12,3"), "1,23");
  assert.equal(digitMoney("-123", true), "-1,23");
  assert.throws(() => pastedMoney("1,234.56"));
});
