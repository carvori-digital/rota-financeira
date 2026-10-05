import { useEffect, useRef, useState } from "react";
import { MoneyInput } from "./components/MoneyInput";
import { ClassificationReviews } from "./features/investments/ClassificationReviews";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useFinance } from "./hooks/useFinance";
import { usePlanning } from "./features/planning/usePlanning";
import { Dashboard } from "./features/experience/Dashboard";
import { Goals } from "./features/experience/Goals";
import { Reports } from "./features/experience/Reports";
import { Movements } from "./features/experience/Movements";
import { BottomNavigation } from "./features/experience/BottomNavigation";
import { PlanningWorkspace } from "./features/planning/PlanningWorkspace";
import type { PlanningAction } from "./features/planning/PlanningWorkspace";
import { QuickActions, Field } from "./features/planning/ui";
import { FinancialActions } from "./features/planning/FinancialActions";
import type { FinancialAction } from "./features/planning/FinancialActions";
import type { Commitment } from "./features/planning/types";
import { QuickSetup } from "./features/planning/QuickSetup";
import { invoices } from "./features/cards/calculations";
import { rpc } from "./features/planning/queries";
import type { Account, Category, Goal, Transaction, Table } from "./types";
import { money as formatMoney, parseMoney, today } from "./utils/finance";
type Editor =
  | { kind: "account"; row?: Account }
  | { kind: "category"; row?: Category }
  | {
      kind: "transaction";
      row?: Transaction;
      initialType?: "income" | "expense" | "transfer";
      accountId?: string;
    }
  | { kind: "goal"; row?: Goal }
  | { kind: "contribution"; goal: Goal };
const labels = {
  income: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
  adjustment: "Ajuste de saldo",
};
const accountTypes: Record<string, string> = {
  checking: "Conta corrente",
  wallet: "Carteira",
  savings: "Poupança",
  investment: "Investimento",
  other: "Outro",
};
function explain(error: unknown) {
  const value = error as { code?: string; message?: string };
  if (value.code === "23503")
    return "Este registro está vinculado ao histórico. Mantenha o tipo original ou arquive a conta/objetivo.";
  if (value.code === "23505")
    return "Já existe uma categoria com esse nome e tipo.";
  if (value.code === "23514")
    return "Verifique os valores e os campos obrigatórios.";
  if (error instanceof Error && !value.code) return error.message;
  return "Não foi possível salvar. Verifique a conexão e tente novamente.";
}
export default function App() {
  const [valuesHidden, setValuesHidden] = useState(() => {
    try {
      return (
        window.localStorage.getItem("rota-financeira:values-hidden") === "true"
      );
    } catch {
      return false;
    }
  });
  function toggleValues() {
    const next = !valuesHidden;
    setValuesHidden(next);
    try {
      window.localStorage.setItem(
        "rota-financeira:values-hidden",
        String(next),
      );
    } catch {
      // The toggle still works when browser storage is unavailable.
    }
  }
  const money = (cents: number) => (
    <span className="financial-value" key={valuesHidden ? "hidden" : "visible"}>
      {valuesHidden ? "••••" : formatMoney(cents)}
    </span>
  );
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [page, setPage] = useState("home");
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [page]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [financialAction, setFinancialAction] =
    useState<FinancialAction | null>(null);
  const [setup, setSetup] = useState(false);
  const [quick, setQuick] = useState(false);
  const [planningAction, setPlanningAction] = useState<PlanningAction | null>(
    null,
  );
  const lastAccount = useRef<string>("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState(false);
  const finance = useFinance(session?.user.id);
  const planning = usePlanning(session?.user.id);
  const { data } = finance;
  const loading = finance.loading || planning.loading;
  const error = finance.error || planning.error;
  async function refresh() {
    await Promise.all([finance.refresh(), planning.refresh()]);
  }
  const [planningSection, setPlanningSection] = useState("month");
  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, next) => {
        setSession(next);
        setAuthLoading(false);
        if (event === "PASSWORD_RECOVERY") setRecovery(true);
        if (!next) {
          setEditor(null);
          setQuick(false);
          setPlanningAction(null);
          lastAccount.current = "";
          setPage("home");
          setNotice("");
        }
      },
    );
    return () => listener.subscription.unsubscribe();
  }, []);
  if (!supabase)
    return (
      <main className="auth">
        <Brand />
        <h1>Sua rota começa aqui.</h1>
        <p>O aplicativo está pronto para conectar ao seu Supabase.</p>
        <div className="panel">
          <p>
            Configure <code>.env.local</code> com a URL e a chave pública do
            projeto existente e execute a migration indicada no README.
          </p>
          <p>Nenhum dado financeiro será salvo antes dessa conexão.</p>
        </div>
      </main>
    );
  if (authLoading)
    return (
      <main className="auth">
        <Brand />
        <p role="status">Carregando sessão…</p>
      </main>
    );
  if (!session || recovery)
    return (
      <Auth
        key={recovery ? "recovery" : "signin"}
        recovery={recovery}
        onRecovered={() => setRecovery(false)}
      />
    );
  async function remove(table: Table, id: string) {
    if (
      operation ||
      !window.confirm(
        "Excluir este registro? Essa ação altera os totais e não pode ser desfeita.",
      )
    )
      return;
    setOperation(true);
    setNotice("");
    try {
      const result = await supabase!
        .from(table)
        .delete()
        .eq("id", id)
        .select("id");
      if (result.error) throw result.error;
      if (!result.data.length)
        throw new Error("Registro não encontrado. Atualize os dados.");
      await refresh();
      setNotice("Registro excluído.");
    } catch (e) {
      setNotice(explain(e));
    } finally {
      setOperation(false);
    }
  }
  async function archive(
    table: "accounts" | "goals",
    id: string,
    active: boolean,
  ) {
    if (operation) return;
    setOperation(true);
    try {
      const result = await supabase!
        .from(table)
        .update({ is_active: !active })
        .eq("id", id)
        .select("id");
      if (result.error) throw result.error;
      if (!result.data.length) throw new Error("Registro não encontrado.");
      await refresh();
      setNotice(
        active ? "Arquivado. O histórico foi preservado." : "Reativado.",
      );
    } catch (e) {
      setNotice(explain(e));
    } finally {
      setOperation(false);
    }
  }
  function resolveCommitment(c: Commitment) {
    const transaction = data.transactions.find(
      (t) => t.id === c.entity && t.status === "pending",
    );
    if (transaction) {
      setFinancialAction({ kind: "resolve", transaction });
      return;
    }
    if (c.source === "card") {
      const card = planning.data.credit_cards.find((x) => x.id === c.entity);
      const invoice = invoices(
        planning.data.credit_cards,
        planning.data.card_purchases,
        planning.data.card_invoices,
        planning.data.card_payments,
        planning.data.card_adjustments,
      ).find((i) => i.card_id === c.entity && i.month === c.due.slice(0, 7));
      if (card && invoice)
        setPlanningAction({ kind: "cardPayment", card, invoice });
    } else if (c.source === "debt")
      setPlanningAction({
        kind: "debtPayment",
        debt: planning.data.debts.find((d) => d.id === c.entity),
      });
    else if (c.source === "recurring")
      setPlanningAction({
        kind: "occurrence",
        rule: planning.data.recurring_items.find((r) => r.id === c.entity),
        due: c.due,
      });
  }
  function selectQuickAction(kind: string) {
    setQuick(false);
    if (["income", "expense", "transfer"].includes(kind))
      setEditor({
        kind: "transaction",
        initialType: kind as "income" | "expense" | "transfer",
        accountId: lastAccount.current,
      });
    else if (kind === "schedule") setFinancialAction({ kind: "schedule" });
    else if (kind.startsWith("contribution:")) {
      const goal = data.goals.find((g) => g.id === kind.slice(13));
      if (goal) setEditor({ kind: "contribution", goal });
    } else if (kind.startsWith("cardPayment:")) {
      const [cardId, invoiceMonth] = kind.slice(12).split(":");
      const card = planning.data.credit_cards.find((c) => c.id === cardId);
      const invoice = invoices(
        planning.data.credit_cards,
        planning.data.card_purchases,
        planning.data.card_invoices,
        planning.data.card_payments,
        planning.data.card_adjustments,
      ).find((i) => i.card_id === cardId && i.month === invoiceMonth);
      if (card && invoice)
        setPlanningAction({ kind: "cardPayment", card, invoice });
    } else
      setPlanningAction({
        kind: kind as "purchase" | "debtPayment" | "installment",
      });
  }
  const goalsContent = (
    <Goals
      data={data}
      money={money}
      hidden={valuesHidden}
      busy={operation}
      onCreate={() => setEditor({ kind: "goal" })}
      onEdit={(row) => setEditor({ kind: "goal", row })}
      onContribution={(goal) => setEditor({ kind: "contribution", goal })}
      onArchive={(g) => void archive("goals", g.id, g.is_active)}
      onRemove={(id) => void remove("goal_contributions", id)}
    />
  );
  return (
    <div className="shell">
      <header>
        <Brand />
        <div className="header-actions">
          <button
            className="values-toggle"
            onClick={toggleValues}
            aria-label={valuesHidden ? "Exibir valores" : "Ocultar valores"}
            aria-pressed={valuesHidden}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
              {valuesHidden && <path d="m3 3 18 18" />}
            </svg>
          </button>
          <button
            className="avatar"
            onClick={() => setPage("settings")}
            aria-label="Abrir ajustes"
          >
            {session.user.email?.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>
      <main>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="Fechar mensagem" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {loading && <p role="status">Atualizando dados…</p>}
        {error && (
          <div role="alert" className="notice">
            {error}
            <button onClick={() => void refresh()}>Tentar novamente</button>
            <button
              onClick={async () => {
                const result = await supabase!.auth.signOut();
                if (result.error)
                  setNotice("Não foi possível sair. Tente novamente.");
              }}
            >
              Sair da conta
            </button>
          </div>
        )}
        {!error && (!loading || (finance.ready && planning.ready)) && (
          <div className="page-content" key={page}>
            {page === "home" && (
              <Dashboard
                data={data}
                plan={planning.data}
                money={money}
                hidden={valuesHidden}
                onPlan={(section) => {
                  setPlanningSection(section ?? "month");
                  setPage("planning");
                }}
                onAction={selectQuickAction}
                onResolve={resolveCommitment}
                onSetup={() => setSetup(true)}
                onGoals={() => setPage("goals")}
                onReports={() => setPage("reports")}
                onAccount={() => setEditor({ kind: "account" })}
              />
            )}
            {page === "history" && (
              <Movements
                data={data}
                money={money}
                hidden={valuesHidden}
                busy={operation}
                onEdit={(row) => setEditor({ kind: "transaction", row })}
                onDelete={(id) => void remove("transactions", id)}
                onNew={() => setQuick(true)}
                onPending={() => {
                  setPlanningSection("scheduled");
                  setPage("planning");
                }}
              />
            )}
            {page === "reports" && (
              <Reports
                data={data}
                plan={planning.data}
                money={money}
                hidden={valuesHidden}
              />
            )}
            {page === "goals" && (
              <>
                <h1>Metas</h1>
                {goalsContent}
              </>
            )}
            {page === "settings" && (
              <>
                <h1>Ajustes</h1>
                <ClassificationReviews
                  data={data}
                  plan={planning.data}
                  onSaved={refresh}
                />
                <button onClick={() => setSetup(true)}>
                  Configuração rápida
                </button>
                <p className="muted">{session.user.email}</p>
                <div className="section-heading">
                  <h2>Contas</h2>
                  <button onClick={() => setEditor({ kind: "account" })}>
                    + Criar
                  </button>
                </div>
                {data.accounts
                  .filter((a) => !a.investment_id)
                  .map((a) => (
                    <div className="settings-row" key={a.id}>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {accountTypes[a.type]} ·{" "}
                          {a.is_active ? "Ativa" : "Arquivada"}
                        </small>
                      </div>
                      <div className="actions">
                        <button
                          onClick={() => setEditor({ kind: "account", row: a })}
                        >
                          Editar
                        </button>
                        <button
                          onClick={() =>
                            setFinancialAction({ kind: "adjust", account: a })
                          }
                        >
                          Ajustar saldo atual
                        </button>
                        <button
                          disabled={operation}
                          onClick={() =>
                            void archive("accounts", a.id, a.is_active)
                          }
                        >
                          {a.is_active ? "Arquivar" : "Reativar"}
                        </button>
                      </div>
                    </div>
                  ))}
                <div className="section-heading">
                  <h2>Categorias</h2>
                  <button onClick={() => setEditor({ kind: "category" })}>
                    + Criar
                  </button>
                </div>
                {data.categories.map((c) => (
                  <div className="settings-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>{labels[c.type]}</small>
                    </div>
                    <button
                      onClick={() => setEditor({ kind: "category", row: c })}
                    >
                      Editar
                    </button>
                  </div>
                ))}
                <div className="panel">
                  <h3>No iPhone</h3>
                  <p>
                    Abra no Safari, toque em Compartilhar e escolha “Adicionar à
                    Tela de Início”. É necessária conexão para consultar e
                    salvar.
                  </p>
                  <small>
                    Termos de Uso e Política de Privacidade: espaço reservado
                    para a futura distribuição pública.
                  </small>
                </div>
                <button
                  className="logout"
                  disabled={operation}
                  onClick={async () => {
                    setOperation(true);
                    const result = await supabase!.auth.signOut();
                    if (result.error)
                      setNotice("Não foi possível sair. Tente novamente.");
                    setOperation(false);
                  }}
                >
                  Sair da conta
                </button>
                <small className="muted">
                  Rota Financeira · v0.2 ·{" "}
                  {typeof __RELEASE_COMMIT__ !== "undefined"
                    ? __RELEASE_COMMIT__.slice(0, 7)
                    : "local"}
                </small>
              </>
            )}
          </div>
        )}
        {!error && (
          <PlanningWorkspace
            data={data}
            plan={planning.data}
            money={money}
            hidden={valuesHidden}
            visible={page === "planning"}
            section={planningSection}
            onSection={setPlanningSection}
            goalsContent={goalsContent}
            action={planningAction}
            setAction={setPlanningAction}
            onResolve={resolveCommitment}
            onSchedule={(transaction) =>
              setFinancialAction({ kind: "schedule", transaction })
            }
            onSaved={async () => {
              await refresh();
              setNotice(
                planningAction?.kind === "debtPayment"
                  ? "Pagamento registrado. Dívida reduzida."
                  : planningAction?.kind === "cardPayment"
                    ? "Pagamento registrado. Fatura atualizada."
                    : "Salvo com sucesso. Planejamento atualizado.",
              );
            }}
          />
        )}
      </main>
      <BottomNavigation
        page={page}
        onNavigate={setPage}
        onNew={() => setQuick(true)}
        disabled={loading || !!error}
      />
      {editor && (
        <EditorForm
          key={`${editor.kind}:${"row" in editor ? (editor.row?.id ?? "new") : "new"}`}
          editor={editor}
          valuesHidden={valuesHidden}
          data={data}
          onClose={() => setEditor(null)}
          onSaved={async (accountId?: string) => {
            if (accountId) lastAccount.current = accountId;
            setEditor(null);
            await refresh();
            setNotice(
              "Salvo com sucesso. Você já pode adicionar outra movimentação.",
            );
          }}
        />
      )}
      {financialAction && (
        <FinancialActions
          key={
            financialAction.kind +
            ("transaction" in financialAction
              ? (financialAction.transaction?.id ?? "")
              : "")
          }
          action={financialAction}
          data={data}
          hidden={valuesHidden}
          onClose={() => setFinancialAction(null)}
          onSaved={refresh}
        />
      )}
      {setup && (
        <QuickSetup
          data={data}
          plan={planning.data}
          paused={!!editor || !!planningAction || !!financialAction}
          onClose={() => {
            setSetup(false);
            setPage("home");
          }}
          onAction={(kind) => {
            if (kind === "investments") {
              setSetup(false);
              setPlanningSection("reserve");
              setPage("planning");
            } else if (kind === "account") setEditor({ kind: "account" });
            else if (kind === "schedule")
              setFinancialAction({ kind: "schedule" });
            else if (kind.startsWith("adjust:")) {
              const account = data.accounts.find((a) => a.id === kind.slice(7));
              if (account) setFinancialAction({ kind: "adjust", account });
            } else if (kind.startsWith("invoice:")) {
              const card = planning.data.credit_cards.find(
                (c) => c.id === kind.slice(8),
              );
              if (card) setPlanningAction({ kind: "invoice", card });
            } else
              setPlanningAction({
                kind:
                  kind === "salary"
                    ? "recurring"
                    : (kind as PlanningAction["kind"]),
                initialType: kind === "salary" ? "income" : "expense",
              });
          }}
        />
      )}
      {quick && (
        <QuickActions
          goals={data.goals.filter(
            (g) => g.is_active && !g.is_emergency_reserve,
          )}
          onClose={() => setQuick(false)}
          invoices={invoices(
            planning.data.credit_cards,
            planning.data.card_purchases,
            planning.data.card_invoices,
            planning.data.card_payments,
            planning.data.card_adjustments,
          )
            .filter((i) => i.pending > 0)
            .map((i) => ({
              id: i.card_id + ":" + i.month,
              name:
                (planning.data.credit_cards.find((c) => c.id === i.card_id)
                  ?.name ?? "Cartão") +
                " · " +
                i.month.split("-").reverse().join("/"),
            }))}
          onSelect={selectQuickAction}
        />
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span>↗</span> rota<span className="brand-light">financeira</span>
    </div>
  );
}
function Auth({
  recovery,
  onRecovered,
}: {
  recovery: boolean;
  onRecovered: () => void;
}) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    try {
      if (recovery) {
        const r = await supabase!.auth.updateUser({ password });
        if (r.error) throw r.error;
        onRecovered();
      } else if (mode === "reset") {
        const r = await supabase!.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (r.error) throw r.error;
        setMessage(
          "Se houver uma conta, você receberá um link para redefinir a senha.",
        );
      } else if (mode === "signup") {
        const r = await supabase!.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (r.error) throw r.error;
        if (!r.data.session)
          setMessage(
            "Confira seu e-mail para confirmar o cadastro e depois entre.",
          );
      } else {
        const r = await supabase!.auth.signInWithPassword({ email, password });
        if (r.error) throw r.error;
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(
        code === "email_not_confirmed"
          ? "Confirme seu e-mail pelo link recebido antes de entrar."
          : code === "invalid_credentials"
            ? "E-mail ou senha incorretos. Confira seus dados."
            : code === "over_email_send_rate_limit" ||
                code === "over_request_rate_limit"
              ? "Muitas tentativas. Aguarde alguns minutos e tente novamente."
              : "Não foi possível concluir. Confira seus dados e a conexão. No cadastro, use uma senha com pelo menos 8 caracteres.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth">
      <Brand />
      <div className="eyebrow">UM CAMINHO MAIS TRANQUILO</div>
      <h1>
        Seu dinheiro.
        <br />
        Sua direção.
      </h1>
      <p className="muted">Contas, movimentações e objetivos em um só lugar.</p>
      <form onSubmit={submit}>
        <h2>
          {recovery
            ? "Nova senha"
            : mode === "signup"
              ? "Crie sua conta"
              : mode === "reset"
                ? "Recupere o acesso"
                : "Bem-vindo de volta"}
        </h2>
        {!recovery && (
          <Field label="E-mail">
            <input required name="email" type="email" autoComplete="email" />
          </Field>
        )}
        {(recovery || mode !== "reset") && (
          <Field label="Senha">
            <input
              required
              name="password"
              type="password"
              minLength={recovery || mode === "signup" ? 8 : 1}
              autoComplete={
                mode === "signup" || recovery
                  ? "new-password"
                  : "current-password"
              }
            />
          </Field>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy
            ? "Aguarde…"
            : recovery
              ? "Salvar senha"
              : mode === "signup"
                ? "Criar conta"
                : mode === "reset"
                  ? "Enviar link"
                  : "Entrar"}
        </button>
      </form>
      {!recovery && (
        <div className="auth-actions">
          <button
            disabled={busy}
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setMessage("");
            }}
          >
            {mode === "signup" ? "Já tenho conta" : "Criar uma conta"}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setMode(mode === "reset" ? "login" : "reset");
              setMessage("");
            }}
          >
            {mode === "reset" ? "Voltar ao login" : "Esqueci minha senha"}
          </button>
        </div>
      )}
    </main>
  );
}
function EditorForm({
  editor,
  valuesHidden,
  data,
  onClose,
  onSaved,
}: {
  editor: Editor;
  valuesHidden: boolean;
  data: ReturnType<typeof useFinance>["data"];
  onClose: () => void;
  onSaved: (accountId?: string) => Promise<void>;
}) {
  const row = "row" in editor ? editor.row : undefined;
  const transaction = editor.kind === "transaction" ? editor.row : undefined;
  const [type, setType] = useState(
    transaction?.type ??
      (editor.kind === "category"
        ? (editor.row?.type ?? "expense")
        : editor.kind === "transaction"
          ? (editor.initialType ?? "expense")
          : "expense"),
  );
  const [recurring, setRecurring] = useState(
    transaction?.is_recurring ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draftId] = useState(() => crypto.randomUUID());
  const [ruleId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const d = dialogRef.current;
    d?.showModal();
    return () => {
      d?.close();
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);
  function closeWithMotion(action: () => void) {
    if (closing) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      action();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(action, 140);
  }
  const accounts = data.accounts.filter(
    (a) =>
      a.is_active ||
      a.id === transaction?.account_id ||
      a.id === transaction?.destination_account_id,
  );
  const titles = {
    account: "Conta financeira",
    category: "Categoria",
    transaction: "Movimentação",
    goal: "Objetivo",
    contribution: "Registrar aporte",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const cents = (k: string) => parseMoney(str(k));
    try {
      let payload: Record<string, unknown>;
      let table: Table;
      if (editor.kind === "account") {
        table = "accounts";
        payload = {
          name: str("name"),
          type: str("account_type"),
          ...(!editor.row ? { initial_balance_cents: cents("initial") } : {}),
        };
      } else if (editor.kind === "category") {
        table = "categories";
        payload = { name: str("name"), type };
      } else if (editor.kind === "goal") {
        table = "goals";
        payload = {
          name: str("name"),
          target_amount_cents: cents("target"),
          initial_amount_cents: cents("initial"),
          target_date: str("date") || null,
        };
        if (
          Number(payload.target_amount_cents) <= 0 ||
          Number(payload.initial_amount_cents) < 0
        )
          throw new Error(
            "A meta deve ser positiva e o valor inicial não pode ser negativo.",
          );
      } else if (editor.kind === "contribution") {
        table = "goal_contributions";
        payload = {
          goal_id: editor.goal.id,
          amount_cents: cents("amount"),
          contribution_date: str("date"),
          description: str("description"),
        };
      } else {
        table = "transactions";
        payload = {
          type,
          amount_cents: cents("amount"),
          account_id: str("account"),
          destination_account_id:
            type === "transfer" ? str("destination") : null,
          category_id: type === "transfer" ? null : str("category"),
          description: str("description"),
          transaction_date: str("date"),
          ...(!transaction
            ? { status: str("date") > today() ? "pending" : "realized" }
            : {}),
          is_recurring: type !== "transfer" && recurring,
          recurrence_frequency:
            type !== "transfer" && recurring
              ? (transaction?.recurrence_frequency ?? str("frequency"))
              : null,
        };
        if (
          type === "transfer" &&
          payload.account_id === payload.destination_account_id
        )
          throw new Error("Escolha duas contas diferentes.");
      }
      if ("amount_cents" in payload && Number(payload.amount_cents) <= 0)
        throw new Error("Informe um valor maior que zero.");
      if (
        editor.kind === "transaction" &&
        type !== "transfer" &&
        recurring &&
        !row
      ) {
        await rpc("repeat_transaction", {
          p_id: draftId,
          p_rule: ruleId,
          p_payload: payload,
          p_existing: false,
        });
        closeWithMotion(() => void onSaved(String(payload.account_id)));
        return;
      }
      // A stable UUID makes retrying after a lost network response idempotent.
      const result = row
        ? await supabase!
            .from(table)
            .update(payload)
            .eq("id", row.id)
            .select("id")
        : await supabase!
            .from(table)
            .upsert({ ...payload, id: draftId }, { onConflict: "id" })
            .select("id");
      if (result.error) throw result.error;
      if (!result.data.length)
        throw new Error("Registro não encontrado. Atualize os dados.");
      closeWithMotion(
        () =>
          void onSaved(
            editor.kind === "transaction"
              ? String(payload.account_id)
              : undefined,
          ),
      );
    } catch (e) {
      setError(explain(e));
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialogRef}
      className={closing ? "is-closing" : undefined}
      aria-labelledby="editor-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) closeWithMotion(onClose);
      }}
    >
      <form onSubmit={submit}>
        <div className="section-heading">
          <h2 id="editor-title">
            {row ? "Editar " : ""}
            {titles[editor.kind]}
          </h2>
          <button
            type="button"
            disabled={busy || closing}
            onClick={() => closeWithMotion(onClose)}
            aria-label="Fechar"
          >
            ×
          </button>
        </div>
        <fieldset disabled={busy || closing}>
          {(editor.kind === "transaction" || editor.kind === "category") && (
            <div className="segments">
              {Object.entries(labels)
                .filter(
                  ([k]) => editor.kind === "transaction" || k !== "transfer",
                )
                .map(([k, v]) => (
                  <button
                    type="button"
                    key={k}
                    className={type === k ? "active" : ""}
                    onClick={() => setType(k as typeof type)}
                  >
                    {v}
                  </button>
                ))}
            </div>
          )}
          {(editor.kind === "transaction" ||
            editor.kind === "contribution") && (
            <Field label="Valor (R$)">
              <MoneyInput
                className="amount-input"
                required
                name="amount"
                hidden={valuesHidden}
                autoComplete="off"
                placeholder={valuesHidden ? "••••" : "0,00"}
                cents={transaction?.amount_cents}
              />
            </Field>
          )}
          {(editor.kind === "account" ||
            editor.kind === "category" ||
            editor.kind === "goal") && (
            <Field label="Nome">
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={editor.row?.name}
              />
            </Field>
          )}
          {editor.kind === "account" && (
            <>
              <Field label="Tipo de conta">
                <select
                  name="account_type"
                  defaultValue={editor.row?.type ?? "checking"}
                >
                  {Object.entries(accountTypes)
                    .filter(([k]) =>
                      [
                        "checking",
                        "wallet",
                        "other",
                        editor.row?.type,
                      ].includes(k),
                    )
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </Field>
              {!editor.row && (
                <Field label="Saldo atual (R$)">
                  <MoneyInput
                    required
                    name="initial"
                    hidden={valuesHidden}
                    allowNegative
                    autoComplete="off"
                    cents={0}
                  />
                </Field>
              )}
              <small>
                Para sincronizar uma conta existente, use Ajustar saldo atual. O
                histórico fica preservado.
              </small>
            </>
          )}
          {editor.kind === "goal" && (
            <>
              <Field label="Meta (R$)">
                <MoneyInput
                  required
                  name="target"
                  hidden={valuesHidden}
                  autoComplete="off"
                  cents={editor.row?.target_amount_cents}
                />
              </Field>
              <Field label="Já acumulado (R$)">
                <MoneyInput
                  required
                  name="initial"
                  hidden={valuesHidden}
                  autoComplete="off"
                  cents={editor.row?.initial_amount_cents ?? 0}
                />
              </Field>
              <Field label="Data desejada (opcional)">
                <input
                  type="date"
                  name="date"
                  defaultValue={editor.row?.target_date ?? ""}
                />
              </Field>
            </>
          )}
          {editor.kind === "transaction" && (
            <>
              <Field label={type === "transfer" ? "Conta de origem" : "Conta"}>
                <select
                  required
                  name="account"
                  defaultValue={
                    transaction?.account_id ??
                    (editor.kind === "transaction" &&
                    accounts.some((a) => a.id === editor.accountId)
                      ? editor.accountId
                      : accounts[0]?.id) ??
                    ""
                  }
                >
                  {!accounts.length && (
                    <option value="">Crie uma conta em Ajustes</option>
                  )}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {!a.is_active ? " (arquivada)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {type === "transfer" ? (
                <Field label="Conta de destino">
                  <select
                    required
                    name="destination"
                    defaultValue={transaction?.destination_account_id ?? ""}
                  >
                    <option value="">Selecione</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label="Categoria">
                  <select
                    key={type}
                    required
                    name="category"
                    defaultValue={
                      transaction?.type === type
                        ? (transaction.category_id ?? "")
                        : ""
                    }
                  >
                    <option value="">Selecione</option>
                    {data.categories
                      .filter((c) => c.type === type)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </>
          )}
          {(editor.kind === "transaction" ||
            editor.kind === "contribution") && (
            <>
              <Field label="Descrição (opcional)">
                <input
                  name="description"
                  maxLength={240}
                  defaultValue={transaction?.description}
                />
              </Field>
              <Field label="Data">
                <input
                  required
                  type="date"
                  name="date"
                  defaultValue={transaction?.transaction_date ?? today()}
                />
              </Field>
            </>
          )}
          {editor.kind === "transaction" && type !== "transfer" && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={!!transaction}
                  checked={recurring}
                  onChange={(e) => setRecurring(e.target.checked)}
                />{" "}
                Recorrente
              </label>
              {recurring && (
                <>
                  <Field label="Frequência">
                    <select
                      name="frequency"
                      disabled={!!transaction}
                      defaultValue={
                        transaction?.recurrence_frequency ?? "monthly"
                      }
                    >
                      <option value="weekly">Semanal</option>
                      <option value="monthly">Mensal</option>
                      <option value="yearly">Anual</option>
                    </select>
                  </Field>
                  <small>
                    {transaction
                      ? "Gerencie a regra em Planejar → Recorrentes."
                      : "Cria uma regra de previsão. Esta primeira ocorrência já fica registrada, sem duplicar o lançamento."}
                  </small>
                </>
              )}
            </>
          )}
          {editor.kind === "contribution" && (
            <p className="muted">
              Para {editor.goal.name}. Este registro não retira dinheiro de uma
              conta.
            </p>
          )}
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </button>
        </fieldset>
      </form>
    </dialog>
  );
}
