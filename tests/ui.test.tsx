import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { today } from "../src/utils/finance";

type Row = Record<string, unknown>;
const backend = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  writes: [] as Row[],
  readError: false,
  writeError: false,
  session: { user: { id: "user-a", email: "teste@example.com" } } as {
    user: { id: string; email: string };
  } | null,
  listener: undefined as
    undefined | ((event: string, session: unknown) => void),
}));
vi.mock("../src/lib/supabase", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (
        callback: (event: string, session: unknown) => void,
      ) => {
        backend.listener = callback;
        queueMicrotask(() => callback("INITIAL_SESSION", backend.session));
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                backend.listener = undefined;
              },
            },
          },
        };
      },
      signOut: async () => {
        backend.session = null;
        backend.listener?.("SIGNED_OUT", null);
        return { error: null };
      },
      signInWithPassword: async () => {
        backend.session = {
          user: { id: "user-a", email: "teste@example.com" },
        };
        backend.listener?.("SIGNED_IN", backend.session);
        return { error: null };
      },
    },
    from: (table: string) => {
      let mode = "read";
      let payload: Row = {};
      let id: unknown;
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          if (key === "id") id = value;
          return query;
        },
        order: () => query,
        range: async (start: number, end: number) => ({
          data: backend.rows[table].slice(start, end + 1),
          error: backend.readError ? { message: "network" } : null,
        }),
        upsert: (row: Row) => {
          mode = "write";
          payload = row;
          return query;
        },
        update: (row: Row) => {
          mode = "write";
          payload = row;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (mode === "write" && backend.writeError)
            return Promise.resolve({
              data: null,
              error: { message: "network" },
            }).then(resolve);
          const written = {
            user_id: "user-a",
            created_at: new Date().toISOString(),
            is_active: true,
            ...payload,
            id: id ?? payload.id,
          };
          backend.writes.push(written);
          const previous = backend.rows[table].findIndex(
            (r) => r.id === written.id,
          );
          if (previous < 0) backend.rows[table].push(written);
          else
            backend.rows[table][previous] = {
              ...backend.rows[table][previous],
              ...written,
            };
          return Promise.resolve({
            data: [{ id: written.id }],
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  backend.session = { user: { id: "user-a", email: "teste@example.com" } };
  backend.readError = false;
  backend.writeError = false;
  backend.writes = [];
  backend.rows = {
    accounts: [
      {
        id: "a",
        name: "Principal",
        type: "checking",
        initial_balance_cents: 10000,
        is_active: true,
      },
      {
        id: "b",
        name: "Carteira",
        type: "wallet",
        initial_balance_cents: 0,
        is_active: true,
      },
    ],
    categories: [
      { id: "c", name: "Alimentação", type: "expense" },
      { id: "d", name: "Salário", type: "income" },
    ],
    transactions: [],
    goals: [],
    goal_contributions: [],
  };
});
afterEach(cleanup);
async function open() {
  render(<App />);
  await screen.findByText("Saldo total hoje");
  return userEvent.setup();
}
describe("fluxos reais da interface com Supabase isolado de teste", () => {
  it("reconstitui sessão e permite cadastrar despesa em centavos", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Adicionar", exact: true }),
    );
    await user.type(screen.getByLabelText("Valor (R$)"), "12,34");
    await user.selectOptions(screen.getByLabelText("Categoria"), "c");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    expect(backend.writes[0]).toMatchObject({
      type: "expense",
      amount_cents: 1234,
      account_id: "a",
      category_id: "c",
      destination_account_id: null,
      transaction_date: today(),
    });
    expect(backend.writes[0]).not.toHaveProperty("user_id", "user-b");
  });
  it("transferência grava uma linha e mantém o total", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Adicionar", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Transferência", exact: true }),
    );
    await user.type(screen.getByLabelText("Valor (R$)"), "25,00");
    await user.selectOptions(screen.getByLabelText("Conta de destino"), "b");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    expect(backend.rows.transactions).toHaveLength(1);
    expect(backend.rows.transactions[0]).toMatchObject({
      type: "transfer",
      category_id: null,
      amount_cents: 2500,
      destination_account_id: "b",
    });
    expect(screen.getAllByText(/R\$\s*100,00/).length).toBeGreaterThan(0);
  });
  it("erro de gravação preserva formulário e UUID ao repetir", async () => {
    const user = await open();
    backend.writeError = true;
    await user.click(
      screen.getByRole("button", { name: "Adicionar", exact: true }),
    );
    await user.type(screen.getByLabelText("Valor (R$)"), "10");
    await user.selectOptions(screen.getByLabelText("Categoria"), "c");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByRole("alert");
    expect(
      (screen.getByLabelText("Valor (R$)") as HTMLInputElement).value,
    ).toBe("10");
    backend.writeError = false;
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    expect(backend.rows.transactions).toHaveLength(1);
  });
  it("falha na consulta não apresenta saldo zero como informação válida", async () => {
    backend.readError = true;
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Saldo total hoje")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Adicionar", exact: true })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("arquiva conta sem excluir seus dados", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Ajustes", exact: true }),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Arquivar", exact: true })[0],
    );
    await screen.findByText(/O histórico foi preservado/);
    expect(backend.rows.accounts).toHaveLength(2);
    expect(backend.rows.accounts[0].is_active).toBe(false);
  });
  it("cria objetivo e registra aporte separado do saldo", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Objetivos", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "+ Criar", exact: true }),
    );
    await user.type(screen.getByLabelText("Nome"), "Reserva");
    await user.type(screen.getByLabelText("Meta (R$)"), "1000");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    await user.click(
      screen.getByRole("button", { name: "+ Aporte", exact: true }),
    );
    await user.type(screen.getByLabelText("Valor (R$)"), "50");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await waitFor(() =>
      expect(backend.rows.goal_contributions).toHaveLength(1),
    );
    expect(backend.rows.transactions).toHaveLength(0);
    expect(backend.rows.goal_contributions[0].amount_cents).toBe(5000);
  });
  it("logout remove a área financeira e o login a restaura", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Ajustes", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Sair da conta", exact: true }),
    );
    await screen.findByText("Bem-vindo de volta");
    expect(screen.queryByText("Principal")).toBeNull();
    await user.type(screen.getByLabelText("E-mail"), "teste@example.com");
    await user.type(screen.getByLabelText("Senha"), "test-password");
    await user.click(
      screen.getByRole("button", { name: "Entrar", exact: true }),
    );
    await screen.findByText("Saldo total hoje");
  });
});
