import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubscriptionsPanel } from "../src/features/subscriptions/SubscriptionsPanel";
import { emptyPlanning } from "../src/features/planning/types";
import type { PlanningData } from "../src/features/planning/types";
import type { FinanceData } from "../src/types";
import { firstInvoiceDate } from "../src/features/cards/calculations";
import { today } from "../src/utils/finance";
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const month = today().slice(0, 7),
  chargeDate = `${month}-01`;
const data: FinanceData = {
  accounts: [],
  transactions: [],
  goals: [],
  goal_contributions: [],
  categories: [{ id: "expense", name: "Serviços", type: "expense" }],
} as FinanceData;
function plan(): PlanningData {
  return {
    ...emptyPlanning,
    credit_cards: [
      {
        id: "card",
        name: "Cartão de teste",
        closing_day: 20,
        due_day: 28,
        active: true,
      },
    ],
    card_subscriptions: [
      { id: "s", start_date: chargeDate, billing_day: 1, frequency: "monthly" },
    ],
    card_subscription_versions: [
      {
        id: "v",
        subscription_id: "s",
        revision: 1,
        effective_month: chargeDate,
        name: "Serviço sintético",
        card_id: "card",
        category_id: "expense",
        amount_cents: 2000,
        closing_day: 20,
        due_day: 28,
        status: "active",
        end_date: null,
      },
    ],
  } as PlanningData;
}
function view(p = plan(), hidden = false) {
  const saved = vi.fn(async () => {});
  render(
    <SubscriptionsPanel
      data={data}
      plan={p}
      money={(c) => (hidden ? "••••" : `R$ ${c / 100}`)}
      hidden={hidden}
      onSaved={saved}
    />,
  );
  return { user: userEvent.setup(), saved };
}
it("registration starts without assumed financial values and retries with the same request ID", async () => {
  const p = {
    ...plan(),
    card_subscriptions: [],
    card_subscription_versions: [],
  };
  const { user, saved } = view(p);
  const trigger = screen.getByRole("button", { name: "Adicionar assinatura" });
  await user.click(trigger);
  for (const label of [
    "Nome",
    "Cartão",
    "Categoria",
    "Dia habitual da cobrança",
    "Data inicial",
  ])
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
  await user.type(screen.getByLabelText("Nome"), "Mensal sintética");
  await user.selectOptions(screen.getByLabelText("Cartão"), "card");
  await user.selectOptions(screen.getByLabelText("Categoria"), "expense");
  await user.type(screen.getByLabelText("Valor previsto (R$)"), "2000");
  await user.type(screen.getByLabelText("Dia habitual da cobrança"), "13");
  await user.type(screen.getByLabelText("Data inicial"), chargeDate);
  mock.rpc.mockRejectedValueOnce(new Error("Resposta perdida"));
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mock.rpc.mock.calls[0]).toEqual(mock.rpc.mock.calls[1]);
  expect(mock.rpc.mock.calls[1][1].p_payload).toMatchObject({
    amount_cents: 2000,
    billing_day: 13,
    start_date: chargeDate,
    status: "active",
  });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);
});
it("manual invoice requires explicit coverage when confirming; hidden amounts stay masked", async () => {
  const p = plan();
  p.card_invoices = [
    {
      id: "bill",
      card_id: "card",
      due_month: month,
      due_date: `${month}-28`,
      amount_cents: 10000,
    },
  ] as PlanningData["card_invoices"];
  const { user } = view(p, true);
  expect(screen.getByText("A conferir na fatura informada")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Conferir cobrança" }));
  await user.selectOptions(screen.getByLabelText("Ação"), "confirm");
  expect(
    (screen.getByLabelText("Valor confirmado (R$)") as HTMLInputElement).type,
  ).toBe("password");
  const coverage = screen.getByLabelText(
    "Esta cobrança está na fatura informada?",
  ) as HTMLSelectElement;
  expect(coverage.required).toBe(true);
  expect(coverage.value).toBe("");
  await user.selectOptions(coverage, "included");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  expect(mock.rpc).toHaveBeenCalledWith(
    "resolve_card_subscription",
    expect.objectContaining({
      p_subscription: "s",
      p_action: "confirm",
      p_amount: 2000,
      p_coverage: "included",
      p_purchase: null,
    }),
  );
});
it("closing discards the draft; reopening and saving creates fresh stable IDs", async () => {
  const { user, saved } = view();
  const open = () =>
    user.click(screen.getByRole("button", { name: "Adicionar assinatura" }));
  const fill = async () => {
    await user.type(screen.getByLabelText("Nome"), "Assinatura HTTP sintética");
    await user.selectOptions(screen.getByLabelText("Cartão"), "card");
    await user.selectOptions(screen.getByLabelText("Categoria"), "expense");
    await user.type(screen.getByLabelText("Valor previsto (R$)"), "2000");
    await user.type(screen.getByLabelText("Dia habitual da cobrança"), "13");
    await user.type(screen.getByLabelText("Data inicial"), chargeDate);
  };
  await open();
  await fill();
  await user.click(screen.getByRole("button", { name: "Fechar" }));
  expect(mock.rpc).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    await open();
    expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("");
    await fill();
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  const first = mock.rpc.mock.calls[0][1],
    second = mock.rpc.mock.calls[1][1];
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(first.p_request).toMatch(uuid);
  expect(first.p_subscription).toMatch(uuid);
  expect(
    new Set([
      first.p_request,
      first.p_subscription,
      second.p_request,
      second.p_subscription,
    ]).size,
  ).toBe(4);
  expect(saved).toHaveBeenCalledTimes(2);
});
it("a render failure gives feedback while keeping the subscriptions panel available", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const source = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
    throw new Error("synthetic entropy failure");
  });
  const { user } = view();
  await user.click(
    screen.getByRole("button", { name: "Adicionar assinatura" }),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Não foi possível abrir este formulário",
  );
  expect(
    screen.getByRole("heading", { name: "Assinaturas no cartão" }),
  ).toBeTruthy();
  expect(mock.rpc).not.toHaveBeenCalled();
  source.mockRestore();
  await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
  expect(
    screen.getByRole("dialog", { name: "Adicionar assinatura no cartão" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Fechar" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("linking requires a selected purchase ID and preserves the list context", async () => {
  const p = plan();
  p.card_purchases = [
    {
      id: "existing",
      card_id: "card",
      category_id: "expense",
      amount_cents: 1850,
      description: "Outra descrição",
      purchase_date: chargeDate,
      first_due_date: firstInvoiceDate(chargeDate, 20, 28),
      installments: 1,
    },
    {
      id: "other-card",
      card_id: "other",
      purchase_date: chargeDate,
      first_due_date: `${month}-28`,
      installments: 1,
    },
  ] as PlanningData["card_purchases"];
  const before = JSON.stringify(p);
  const { user } = view(p);
  expect(mock.rpc).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Conferir cobrança" }));
  await user.selectOptions(screen.getByLabelText("Ação"), "link");
  const select = screen.getByLabelText("Compra existente");
  expect(within(select).getAllByRole("option")).toHaveLength(2);
  expect((select as HTMLSelectElement).value).toBe("");
  await user.selectOptions(select, "existing");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  expect(mock.rpc).toHaveBeenCalledWith(
    "resolve_card_subscription",
    expect.objectContaining({
      p_purchase: "existing",
      p_action: "link",
      p_amount: null,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByLabelText("Mês de cobrança")).toBeTruthy();
  expect(JSON.stringify(p)).toBe(before);
});
it("future edits keep immutable calendar fields and send the expected version", async () => {
  const { user } = view();
  await user.click(
    screen.getByRole("button", { name: "Alterar próximas cobranças" }),
  );
  expect(screen.queryByLabelText("Data inicial")).toBeNull();
  expect(screen.queryByLabelText("Dia habitual da cobrança")).toBeNull();
  const effective = screen.getByLabelText(
    "Aplicar a partir do mês de cobrança",
  ) as HTMLInputElement;
  await user.type(effective, effective.min);
  await user.selectOptions(screen.getByLabelText("Status"), "paused");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  expect(mock.rpc).toHaveBeenCalledWith(
    "save_card_subscription",
    expect.objectContaining({
      p_expected: "v",
      p_subscription: "s",
      p_payload: expect.objectContaining({
        status: "paused",
        effective_month: `${effective.min}-01`,
      }),
    }),
  );
});
