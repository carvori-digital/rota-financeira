import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverdraftPanel } from "../src/features/overdraft/OverdraftPanel";
import { emptyPlanning } from "../src/features/planning/types";
import type { PlanningData } from "../src/features/planning/types";
import type { Account, FinanceData } from "../src/types";
import { money, today } from "../src/utils/finance";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/features/planning/queries", () => ({ rpc: mock.rpc }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});
beforeEach(() => mock.rpc.mockReset().mockResolvedValue("saved"));
afterEach(cleanup);
const day = today();
const account = {
  id: "a",
  user_id: "u",
  created_at: "",
  name: "Banco sintético",
  type: "checking",
  initial_balance_cents: -30000,
  currency: "BRL",
  is_active: true,
} satisfies Account;
const data = {
  accounts: [account],
  transactions: [],
  categories: [],
  goals: [],
  goal_contributions: [],
} satisfies FinanceData;
const plan = {
  ...emptyPlanning,
  account_overdraft_versions: [
    {
      id: "v",
      user_id: "u",
      created_at: "",
      account_id: "a",
      revision: 1,
      tracking_start: day,
      effective_date: day,
      limit_cents: 100000,
      active: true,
      statement_model: "negative_balance",
      monthly_interest_rate: null,
      contract_notes: "",
      change_reason: "Contrato sintético",
    },
  ],
} satisfies PlanningData;
function view(p: PlanningData = plan, hidden = false) {
  const saved = vi.fn(async () => {});
  render(
    <OverdraftPanel
      account={account}
      data={data}
      plan={p}
      money={(n) => <span>{hidden ? "••••" : money(n)}</span>}
      hidden={hidden}
      onSaved={saved}
    />,
  );
  return { user: userEvent.setup(), saved };
}
it("shows derived usage, separate credit, state and daily history without manual percent controls", async () => {
  const { user } = view();
  expect(screen.getByText("Em uso", { exact: true })).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("30");
  expect(screen.getAllByText(/700,00/)[0]).toBeTruthy();
  expect(screen.queryByRole("slider")).toBeNull();
  await user.click(screen.getByText("Histórico de utilização por data"));
  expect(screen.getAllByText(/restante/)[0]).toBeTruthy();
  expect(document.body.textContent).not.toContain("[object Object]");
  expect(screen.getByText(/Sem dados suficientes/)).toBeTruthy();
});
it("new optional configuration assumes no limits or rates and retries the exact request", async () => {
  const { user, saved } = view({ ...emptyPlanning });
  await user.click(
    screen.getByRole("button", { name: "Habilitar cheque especial" }),
  );
  expect(
    (screen.getByLabelText("Limite contratado (R$)") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (
      screen.getByLabelText(
        "Taxa contratual mensal (%) — opcional",
      ) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Representação no extrato") as HTMLSelectElement)
      .value,
  ).toBe("needs_reconciliation");
  await user.type(screen.getByLabelText("Limite contratado (R$)"), "100000");
  await user.type(screen.getByLabelText("Início do acompanhamento"), day);
  await user.type(
    screen.getByLabelText("Referência ou motivo da configuração"),
    "Contrato sintético",
  );
  mock.rpc.mockRejectedValueOnce(new Error("Resposta perdida"));
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc.mock.calls[0]).toEqual(mock.rpc.mock.calls[1]);
  expect(mock.rpc.mock.calls[1][1].p_payload.monthly_interest_rate).toBeNull();
});
it("deactivation preserves debt and saving uses the latest version as concurrency guard", async () => {
  const { user } = view();
  await user.click(screen.getByRole("button", { name: "Configurar limite" }));
  await user.selectOptions(screen.getByLabelText("Situação"), "false");
  await user.type(
    screen.getByLabelText("Referência ou motivo da configuração"),
    "Desativação contratual",
  );
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(mock.rpc).toHaveBeenCalled());
  expect(mock.rpc.mock.calls[0][1]).toMatchObject({
    p_expected: "v",
    p_payload: { active: false, limit_cents: 100000 },
  });
});
it("reconciliation requires a review and explicit confirmation, saves evidence without a balance mutation", async () => {
  const { user } = view();
  await user.click(
    screen.getByRole("button", { name: "Conferir extrato bancário" }),
  );
  await user.type(
    screen.getByLabelText("Saldo bancário no extrato (R$)"),
    "-35000",
  );
  await user.type(
    screen.getByLabelText("Referência do extrato e explicação"),
    "Extrato sintético",
  );
  await user.click(screen.getByRole("button", { name: "Conferir diferença" }));
  expect(mock.rpc).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText(
      (_, el) =>
        el?.tagName === "STRONG" && (el.textContent ?? "").includes("50,00"),
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("checkbox"));
  await user.click(
    screen.getByRole("button", { name: "Confirmar conferência" }),
  );
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledOnce());
  expect(mock.rpc.mock.calls[0]).toMatchObject([
    "record_bank_reconciliation",
    { p_statement: -35000, p_expected: -30000, p_confirmed: true },
  ]);
});
it("unknown bank representation withholds available credit and privacy masks utilization", () => {
  view(
    {
      ...plan,
      account_overdraft_versions: [
        {
          ...plan.account_overdraft_versions[0],
          statement_model: "needs_reconciliation",
        },
      ],
    },
    true,
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(
    "Nenhum limite disponível",
  );
  expect(screen.queryByText(/300,00|1.000,00|30%/)).toBeNull();
});
