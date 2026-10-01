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
import { act } from "react";
import { today } from "../src/utils/finance";

type Row = Record<string, unknown>;
const backend = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  writes: [] as Row[],
  readError: false,
  writeError: false,
  lostResponse: false,
  authCalls: [] as { kind: string; payload: unknown }[],
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
      signUp: async (payload: unknown) => {
        backend.authCalls.push({ kind: "signup", payload });
        return { data: { session: null }, error: null };
      },
      resetPasswordForEmail: async (email: string, options: unknown) => {
        backend.authCalls.push({ kind: "reset", payload: { email, options } });
        return { error: null };
      },
      updateUser: async (payload: unknown) => {
        backend.authCalls.push({ kind: "password", payload });
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
        delete: () => {
          mode = "delete";
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (mode === "write" && backend.writeError)
            return Promise.resolve({
              data: null,
              error: { message: "network" },
            }).then(resolve);
          if (mode === "delete") {
            const found = backend.rows[table].find((r) => r.id === id);
            backend.rows[table] = backend.rows[table].filter(
              (r) => r.id !== id,
            );
            return Promise.resolve({
              data: found ? [{ id }] : [],
              error: null,
            }).then(resolve);
          }
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
          const lost = backend.lostResponse;
          backend.lostResponse = false;
          return Promise.resolve({
            data: [{ id: written.id }],
            error: lost ? { message: "lost response" } : null,
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
  backend.lostResponse = false;
  backend.authCalls = [];
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
  it("cadastro informa confirmação e recuperação oferece envio de link", async () => {
    backend.session = null;
    render(<App />);
    const user = userEvent.setup();
    await screen.findByText("Bem-vindo de volta");
    await user.click(
      screen.getByRole("button", { name: "Criar uma conta", exact: true }),
    );
    await user.type(screen.getByLabelText("E-mail"), "fixture@example.com");
    await user.type(screen.getByLabelText("Senha"), "fixture-password");
    await user.click(
      screen.getByRole("button", { name: "Criar conta", exact: true }),
    );
    await screen.findByText(/Confira seu e-mail/);
    expect(backend.authCalls[0].kind).toBe("signup");
    await user.click(
      screen.getByRole("button", { name: "Esqueci minha senha", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Enviar link", exact: true }),
    );
    await screen.findByText(/receberá um link/);
    expect(backend.authCalls[1].kind).toBe("reset");
    act(() =>
      backend.listener?.("PASSWORD_RECOVERY", {
        user: { id: "user-a", email: "fixture@example.com" },
      }),
    );
    await screen.findByText("Nova senha");
    expect(screen.getByLabelText("Senha")).toBeTruthy();
    await user.type(screen.getByLabelText("Senha"), "new-fixture-password");
    await user.click(
      screen.getByRole("button", { name: "Salvar senha", exact: true }),
    );
    await screen.findByText("Saldo total hoje");
    expect(backend.authCalls[2]).toMatchObject({
      kind: "password",
      payload: { password: "new-fixture-password" },
    });
  });
  it("limpar período do histórico não transforma dashboard em total de todos os meses", async () => {
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Movimentações", exact: true }),
    );
    await user.clear(screen.getByLabelText("Mês"));
    await user.click(
      screen.getByRole("button", { name: "Início", exact: true }),
    );
    expect(
      (screen.getByLabelText("Mês do resumo") as HTMLInputElement).value,
    ).toBe(today().slice(0, 7));
  });
  it("repetir após resposta perdida não duplica lançamento já gravado", async () => {
    const user = await open();
    backend.lostResponse = true;
    await user.click(
      screen.getByRole("button", { name: "Adicionar", exact: true }),
    );
    await user.type(screen.getByLabelText("Valor (R$)"), "10");
    await user.selectOptions(screen.getByLabelText("Categoria"), "c");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByRole("alert");
    expect(backend.rows.transactions).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    expect(backend.rows.transactions).toHaveLength(1);
    expect(backend.writes[0].id).toBe(backend.writes[1].id);
  });
  it("editar e excluir movimentação atualiza histórico e saldo", async () => {
    backend.rows.transactions = [
      {
        id: "t",
        account_id: "a",
        category_id: "c",
        destination_account_id: null,
        type: "expense",
        amount_cents: 1000,
        description: "Compra fixture",
        transaction_date: today(),
        is_recurring: false,
        recurrence_frequency: null,
        created_at: new Date().toISOString(),
      },
    ];
    const user = await open();
    await user.click(
      screen.getByRole("button", { name: "Movimentações", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Editar", exact: true }),
    );
    await user.clear(screen.getByLabelText("Valor (R$)"));
    await user.type(screen.getByLabelText("Valor (R$)"), "20");
    await user.click(
      screen.getByRole("button", { name: "Salvar", exact: true }),
    );
    await screen.findByText(/Salvo com sucesso/);
    expect(backend.rows.transactions[0].amount_cents).toBe(2000);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(
      screen.getByRole("button", { name: "Excluir", exact: true }),
    );
    await screen.findByText("Registro excluído.");
    expect(backend.rows.transactions).toHaveLength(0);
    confirm.mockRestore();
  });
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
