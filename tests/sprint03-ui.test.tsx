import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReconstructInvestment } from "../src/features/investments/ReconstructInvestment";
import { ExportReport } from "../src/features/export/ExportReport";
import { emptyPlanning } from "../src/features/planning/types";
import { today } from "../src/utils/finance";
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  download: vi.fn(),
  pdf: vi.fn(),
}));
vi.mock("../src/features/planning/queries", () => ({ rpc: mock.rpc }));
vi.mock("../src/features/export/formats", () => ({
  financialPdf: mock.pdf,
  financialCsv: () => "",
  financialJson: () => "",
  downloadFile: mock.download,
}));
const base = { user_id: "user", created_at: new Date().toISOString() };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  mock.rpc.mockReset();
  mock.download.mockReset();
  mock.pdf.mockReset();
});
afterEach(cleanup);
it("reconstruction requires preview and explicit confirmation before one transactional RPC", async () => {
  const user = userEvent.setup(),
    saved = vi.fn(async () => {});
  const investment = {
    ...base,
    id: "old",
    name: "Reserva",
    institution: "",
    type: "legacy",
    initial_date: today(),
    yield_type: "manual" as const,
    yield_rate: 0,
    is_emergency_reserve: true,
    active: true,
    source_account_id: "legacy-account",
    updated_at: base.created_at,
  };
  const plan = {
    ...structuredClone(emptyPlanning),
    investments: [investment],
    investment_movements: [
      {
        ...base,
        id: "legacy",
        investment_id: "old",
        type: "adjustment" as const,
        amount_cents: 100000,
        date: today(),
        description: "Synthetic",
        transaction_id: null,
        source_transaction_id: null,
        source_account_id: "legacy-account",
      },
    ],
  };
  render(
    <ReconstructInvestment
      investment={investment}
      plan={plan}
      money={(n) => (n / 100).toFixed(2)}
      hidden={false}
      onClose={() => {}}
      onSaved={saved}
    />,
  );
  await user.type(screen.getByLabelText("Instituição"), "Nubank");
  await user.type(screen.getByLabelText("Produto"), "RDB");
  await user.type(
    screen.getByLabelText("Aportes e resgates históricos"),
    `${today()};aporte;1000,00`,
  );
  await user.type(
    screen.getByLabelText("Valor real atual no banco (R$)"),
    "105000",
  );
  await user.type(
    screen.getByLabelText("Referência da reconciliação"),
    "Extrato sintético",
  );
  await user.click(
    screen.getByRole("button", { name: "Preparar reconciliação" }),
  );
  expect(mock.rpc).not.toHaveBeenCalled();
  expect(screen.getByText("Diferença de patrimônio")).toBeTruthy();
  expect(screen.getAllByText("50.00")).toHaveLength(2);
  await user.click(screen.getByRole("checkbox"));
  mock.rpc.mockResolvedValue("new");
  await user.click(
    screen.getByRole("button", { name: "Confirmar reconstrução" }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(mock.rpc.mock.calls[0][0]).toBe("reconstruct_investment");
  const payload = mock.rpc.mock.calls[0][1];
  expect(payload.p_expected).toBe(100000);
  expect(payload.p_payload.real_value_cents).toBe(105000);
  expect(payload.p_payload.history[0].amount_cents).toBe(100000);
  expect(payload.p_payload.acknowledged).toBe(true);
});
function snapshot() {
  const data = {
    accounts: [],
    categories: [],
    transactions: [],
    goals: [],
    goal_contributions: [],
    ...structuredClone(emptyPlanning),
    report_month_confirmations: [],
  };
  return {
    schema_version: 1,
    owner: "user",
    generated_at: new Date().toISOString(),
    data,
    counts: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.length : 0,
      ]),
    ),
  };
}
it("export refuses incomplete read; preview required and details default off", async () => {
  const user = userEvent.setup();
  render(<ExportReport owner="user" money={(n) => String(n)} hidden={false} />);
  await user.click(screen.getByText("Exportar relatório"));
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect(screen.queryByRole("button", { name: "Baixar PDF" })).toBeNull();
  mock.rpc.mockResolvedValue({
    ...snapshot(),
    counts: { ...snapshot().counts, transactions: 1 },
  });
  await user.click(
    screen.getByRole("button", { name: "Visualizar resumo antes de exportar" }),
  );
  await screen.findByRole("alert");
  expect(mock.download).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Baixar JSON" })).toBeNull();
});
it("hide/logout during PDF generation cancels the private download", async () => {
  const user = userEvent.setup();
  const view = render(
    <ExportReport owner="user" money={(n) => String(n)} hidden={false} />,
  );
  await user.click(screen.getByText("Exportar relatório"));
  mock.rpc.mockResolvedValue(snapshot());
  await user.click(
    screen.getByRole("button", { name: "Visualizar resumo antes de exportar" }),
  );
  await screen.findByText("Prévia do relatório");
  let finish: (blob: Blob) => void = () => {};
  mock.pdf.mockImplementation(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Baixar PDF" }));
  view.unmount();
  finish(new Blob(["pdf"]));
  await waitFor(() => expect(mock.pdf).toHaveBeenCalledTimes(1));
  expect(mock.download).not.toHaveBeenCalled();
});
