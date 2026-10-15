import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Investments } from "../src/features/investments/Investments";
import {
  InvestmentMovementEditor,
  QuickInvestmentFlow,
  DeleteInvestment,
} from "../src/features/investments/InvestmentOperations";
import { FinancialActions } from "../src/features/planning/FinancialActions";
import { emptyPlanning } from "../src/features/planning/types";
import { today } from "../src/utils/finance";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), save: vi.fn() }));
vi.mock("../src/features/planning/queries", () => ({
  rpc: mock.rpc,
  save: mock.save,
}));
const base = { user_id: "a", created_at: "2026-10-01T12:00:00Z" };
const investment = {
  ...base,
  id: "i",
  name: "Reserva",
  institution: "Nubank",
  type: "RDB",
  initial_date: "2026-10-01",
  yield_type: "manual" as const,
  yield_rate: 0,
  is_emergency_reserve: true,
  active: true,
  source_account_id: "legacy",
  updated_at: base.created_at,
};
const data = {
  accounts: [
    {
      ...base,
      id: "cash",
      name: "Nubank",
      type: "checking",
      initial_balance_cents: 50000,
      is_active: true,
      currency: "BRL",
    },
  ],
  transactions: [],
  categories: [],
  goals: [],
  goal_contributions: [],
};
const plan = {
  ...emptyPlanning,
  investments: [investment],
  investment_movements: [
    {
      ...base,
      id: "m",
      investment_id: "i",
      type: "adjustment" as const,
      amount_cents: 50000,
      date: "2026-10-01",
      description: "Saldo informado",
      sync_value_cents: 50000,
      accounting_kind: "initial_position" as const,
      transaction_id: null,
      source_transaction_id: null,
      source_account_id: null,
    },
  ],
};
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
beforeEach(() => {
  mock.rpc.mockReset();
  mock.save.mockReset();
});
afterEach(cleanup);
it("creates a position in one RPC without account fields or financial transactions", async () => {
  const user = userEvent.setup(),
    saved = vi.fn(async () => {});
  render(
    <Investments
      data={data}
      plan={emptyPlanning}
      money={String}
      hidden={false}
      onSaved={saved}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Adicionar investimento" }),
  );
  await user.type(screen.getByLabelText("Nome"), "Caixinha Turbo");
  await user.type(screen.getByLabelText("Instituição"), "Nubank");
  await user.selectOptions(screen.getByLabelText("Rendimento"), "percent_cdi");
  await user.clear(screen.getByLabelText(/Taxa fixa/));
  await user.type(screen.getByLabelText(/Taxa fixa/), "115");
  await user.type(
    screen.getByLabelText("Saldo inicial já existente (R$)"),
    "50000",
  );
  await user.click(screen.getByLabelText(/Conferi que este saldo/));
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc).toHaveBeenCalledWith(
    "create_simple_investment",
    expect.objectContaining({
      p_payload: expect.objectContaining({
        initial_cents: 50000,
        yield_rate: 115,
        acknowledged: true,
      }),
    }),
  );
  expect(mock.save).not.toHaveBeenCalled();
});
it("migrated deletion requires name and explicit confirmation; no automatic deletion", async () => {
  const user = userEvent.setup(),
    saved = vi.fn(async () => {});
  render(
    <DeleteInvestment
      investment={investment}
      plan={plan}
      hidden={false}
      onSaved={saved}
    />,
  );
  expect(mock.rpc).not.toHaveBeenCalled();
  await user.click(screen.getByText("Ações do registro"));
  await user.click(
    screen.getByRole("button", { name: "Excluir investimento" }),
  );
  expect(
    screen.getByText(/Todas as movimentações bancárias serão preservadas/),
  ).toBeTruthy();
  await user.type(
    screen.getByLabelText("Digite o nome do investimento"),
    "Reserva",
  );
  await user.click(screen.getByLabelText(/Confirmo a exclusão definitiva/));
  await user.click(
    screen.getByRole("button", {
      name: "Excluir definitivamente",
      exact: true,
    }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc).toHaveBeenCalledWith(
    "delete_simple_investment",
    expect.objectContaining({
      p_investment: "i",
      p_expected: 50000,
      p_confirmed: true,
    }),
  );
});
it("withdrawal reviews effects before RPC, preserves retry id and refreshes all data once", async () => {
  const user = userEvent.setup(),
    saved = vi.fn(async () => {});
  render(
    <InvestmentMovementEditor
      investment={investment}
      kind="withdrawal"
      data={data}
      plan={plan}
      hidden={false}
      onClose={() => {}}
      onSaved={saved}
    />,
  );
  await user.selectOptions(screen.getByLabelText("Conta de destino"), "cash");
  await user.click(
    screen.getByLabelText(/este movimento ainda não foi registrado/),
  );
  await user.type(screen.getByLabelText("Valor (R$)"), "15000");
  await user.click(
    screen.getByRole("button", { name: "Conferir movimentação" }),
  );
  expect(mock.rpc).not.toHaveBeenCalled();
  expect(screen.getByText("Saldo da conta após correção")).toBeTruthy();
  await user.click(
    screen.getByLabelText("Conferi os valores e confirmo esta movimentação"),
  );
  mock.rpc.mockRejectedValueOnce(new Error("Resposta perdida"));
  await user.click(
    screen.getByRole("button", { name: "Confirmar movimentação" }),
  );
  await screen.findByRole("alert");
  mock.rpc.mockResolvedValueOnce("ok");
  await user.click(
    screen.getByRole("button", { name: "Confirmar movimentação" }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc.mock.calls[0][1]).toEqual(mock.rpc.mock.calls[1][1]);
  expect(mock.rpc.mock.calls[1][1]).toMatchObject({
    p_amount: 15000,
    p_account: "cash",
    p_type: "withdrawal",
  });
});
it("zero position explains the withdrawal limit and offers bank synchronization", async () => {
  const user = userEvent.setup();
  render(
    <QuickInvestmentFlow
      kind="withdrawal"
      data={data}
      plan={{ ...plan, investment_movements: [] }}
      hidden={false}
      onClose={() => {}}
      onSaved={async () => {}}
      onCreate={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Sem saldo registrado",
  );
  await user.click(
    screen.getByRole("button", {
      name: "Sincronizar saldo real antes de movimentar",
    }),
  );
  expect(
    screen.getByRole("dialog", { name: "Sincronizar valor atual" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Conta de destino")).toBeNull();
});
it("empty investment selector guides creation without recording anything", async () => {
  const user = userEvent.setup(),
    create = vi.fn();
  render(
    <QuickInvestmentFlow
      kind="contribution"
      data={data}
      plan={emptyPlanning}
      hidden={false}
      onClose={() => {}}
      onSaved={async () => {}}
      onCreate={create}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Criar investimento" }));
  expect(create).toHaveBeenCalledOnce();
  expect(mock.rpc).not.toHaveBeenCalled();
});
it("account reconciliation previews the current balance and difference before mutation", async () => {
  const user = userEvent.setup(),
    saved = vi.fn(async () => {});
  render(
    <FinancialActions
      action={{ kind: "adjust", account: data.accounts[0] }}
      data={data}
      hidden={false}
      onClose={() => {}}
      onSaved={saved}
    />,
  );
  await user.clear(screen.getByLabelText("Saldo atual correto (R$)"));
  await user.type(screen.getByLabelText("Saldo atual correto (R$)"), "55000");
  await user.click(
    screen.getByRole("button", { name: "Conferir reconciliação" }),
  );
  expect(mock.rpc).not.toHaveBeenCalled();
  expect(screen.getByText(/Diferença e efeito da correção/)).toBeTruthy();
  await user.click(
    screen.getByLabelText(/Conferi os movimentos existentes e faltantes/),
  );
  await user.click(
    screen.getByRole("button", { name: "Confirmar ajuste de saldo" }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc).toHaveBeenCalledWith(
    "reconcile_operational_balance",
    expect.objectContaining({ p_target: 55000, p_expected: 50000 }),
  );
  expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
