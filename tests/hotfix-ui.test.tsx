import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanningWorkspace } from "../src/features/planning/PlanningWorkspace";
import type { PlanningAction } from "../src/features/planning/PlanningWorkspace";
import { CommitmentRow } from "../src/features/planning/MonthReport";
import { emptyPlanning } from "../src/features/planning/types";
import { today } from "../src/utils/finance";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), save: vi.fn() }));
vi.mock("../src/features/planning/queries", () => ({
  rpc: mock.rpc,
  save: mock.save,
}));
const base = { user_id: "a", created_at: "2026-10-01T12:00:00Z" },
  rule = {
    ...base,
    id: "rule",
    name: "Cemig",
    type: "expense" as const,
    amount_cents: 39678,
    account_id: "cash",
    category_id: "cat",
    frequency: "monthly" as const,
    start_date: today(),
    end_date: null,
    active: true,
    is_essential: true,
  };
const data = {
  accounts: [
    {
      ...base,
      id: "old",
      name: "Reserva excluída",
      type: "investment",
      initial_balance_cents: 48866,
      currency: "BRL",
      is_active: false,
      investment_retired: true,
    },
  ],
  transactions: [],
  categories: [],
  goals: [],
  goal_contributions: [],
};
function view(action: PlanningAction | null = null, section = "reserve") {
  const saved = vi.fn(async () => {});
  render(
    <PlanningWorkspace
      data={data}
      plan={{
        ...emptyPlanning,
        recurring_items: [rule],
        investments: [
          {
            ...base,
            id: "turbo",
            name: "Caixinha Turbo",
            institution: "Nubank",
            type: "RDB",
            initial_date: "2026-10-01",
            yield_type: "manual",
            yield_rate: 0,
            is_emergency_reserve: true,
            active: true,
            source_account_id: null,
            updated_at: base.created_at,
          },
        ],
      }}
      money={String}
      hidden={false}
      visible
      section={section}
      onSection={vi.fn()}
      goalsContent={null}
      action={action}
      setAction={vi.fn()}
      onSaved={saved}
      onResolve={vi.fn()}
      onSchedule={vi.fn()}
    />,
  );
  return saved;
}
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
it("deleted Reserva is absent from legacy list and reserve selector; new Turbo remains", () => {
  view({ kind: "reserve" });
  expect(screen.queryByText("Reserva excluída")).toBeNull();
  expect(screen.queryByText("Contas antigas aguardando migração")).toBeNull();
  expect(screen.getByText("Caixinha Turbo")).toBeTruthy();
  expect(screen.queryByLabelText("Reserva excluída")).toBeNull();
  expect(mock.rpc).not.toHaveBeenCalled();
});
it("completed expense with zero impact is realized without transfer/reserve label or pay action", () => {
  const resolve = vi.fn();
  render(
    <CommitmentRow
      item={{
        id: "occ",
        source: "recurring",
        entity: "rule",
        name: "Cemig",
        due: today(),
        amount: 36337,
        impact: 0,
        direction: "expense",
        canResolve: false,
      }}
      money={String}
      onResolve={resolve}
    />,
  );
  expect(
    screen.queryByText(/transferência interna|conta de reserva/),
  ).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
it("transfer and reserve labels require explicit nature", () => {
  render(
    <CommitmentRow
      item={{
        id: "transfer",
        source: "transaction",
        entity: "t",
        name: "Aporte",
        due: today(),
        amount: 100,
        impact: 0,
        direction: "transfer",
      }}
      money={String}
    />,
  );
  expect(screen.getByText(/transferência interna/)).toBeTruthy();
});
it.each(["skip", "realize"])(
  "missing recurring reference gives a useful error for %s without RPC",
  async (action) => {
    const user = userEvent.setup();
    view({ kind: "occurrence", due: today(), amount: 3341 }, "recurring");
    await user.selectOptions(screen.getByLabelText("Ação"), action);
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Recorrência não encontrada/,
    );
    expect(mock.rpc).not.toHaveBeenCalled();
  },
);
it("occurrence payment carries rule id, actual date and amount; retry preserves request id", async () => {
  const user = userEvent.setup(),
    saved = view(
      { kind: "occurrence", rule, due: today(), amount: 3341 },
      "recurring",
    );
  mock.rpc.mockRejectedValueOnce(new Error("Resposta perdida"));
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await screen.findByRole("alert");
  mock.rpc.mockResolvedValueOnce("ok");
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc.mock.calls[0]).toEqual(mock.rpc.mock.calls[1]);
  expect(mock.rpc).toHaveBeenLastCalledWith(
    "record_recurring_payment",
    expect.objectContaining({
      p_rule: "rule",
      p_due: today(),
      p_date: today(),
      p_amount: 3341,
    }),
  );
});
it("skipping uses canonical rule id and does not submit any payment fields", async () => {
  const user = userEvent.setup(),
    saved = view({ kind: "occurrence", rule, due: today() }, "recurring");
  await user.selectOptions(screen.getByLabelText("Ação"), "skip");
  expect(screen.queryByLabelText("Valor pago (R$)")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc).toHaveBeenCalledWith(
    "resolve_recurring",
    expect.objectContaining({ p_rule: "rule", p_due: today(), p_skip: true }),
  );
});
it("November forecast adjusts only that occurrence without posting money", async () => {
  const user = userEvent.setup(),
    saved = view(
      { kind: "occurrenceAmount", rule, due: "2026-11-13", amount: 39678 },
      "recurring",
    );
  await user.click(screen.getByRole("button", { name: "Salvar", exact: true }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.rpc).toHaveBeenCalledWith("set_recurring_occurrence_amount", {
    p_rule: "rule",
    p_due: "2026-11-13",
    p_amount: 39678,
  });
  expect(mock.save).not.toHaveBeenCalled();
});
