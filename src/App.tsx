import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useFinance } from "./hooks/useFinance";
import { usePlanning } from './features/planning/usePlanning';
import { HomeClarity } from './features/planning/HomeClarity';
import { PlanningWorkspace } from './features/planning/PlanningWorkspace';
import type { PlanningAction } from './features/planning/PlanningWorkspace';
import { QuickActions } from './features/planning/ui';
import { realized } from './features/planning/calculations';
import { rpc } from './features/planning/queries';
import type { Account, Category, Goal, Transaction, Table } from "./types";
import {
  balance,
  balanceSummary,
  isReserveAccount,
  displayDate,
  goalProgress,
  inputMoney,
  money as formatMoney,
  monthly,
  parseMoney,
  today,
} from "./utils/finance";
type Editor =
  | { kind: "account"; row?: Account }
  | { kind: "category"; row?: Category }
  | { kind: "transaction"; row?: Transaction; initialType?: 'income'|'expense'|'transfer'; accountId?: string }
  | { kind: "goal"; row?: Goal }
  | { kind: "contribution"; goal: Goal };
const labels = {
  income: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
};
const accountTypes: Record<string, string> = {
  checking: "Conta corrente",
  wallet: "Carteira",
  savings: "Poupança",
  investment: "Investimento",
  other: "Outro",
};
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [quick, setQuick] = useState(false);
  const [planningAction,setPlanningAction] = useState<PlanningAction|null>(null);
  const lastAccount=useRef<string>('');
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState(false);
  const finance = useFinance(session?.user.id);
  const planning = usePlanning(session?.user.id);
  const { data }=finance;
  const loading=finance.loading||planning.loading;
  const error=finance.error||planning.error;
  async function refresh() { await Promise.all([finance.refresh(),planning.refresh()]); }
  const [month, setMonth] = useState(today().slice(0, 7));
  const [historyMonth, setHistoryMonth] = useState(today().slice(0, 7));
  const [filterAccount, setFilterAccount] = useState("");
  const [filterType, setFilterType] = useState("");
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
          setQuick(false);setPlanningAction(null);lastAccount.current='';
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
  const actual=realized(data.transactions,planning.data.card_purchases,month,today());
  const totals={...actual,result:actual.income-actual.expense,saved:actual.income>0?(actual.income-actual.expense)*100/actual.income:null};
  const balances = balanceSummary(data.accounts, data.transactions);
  const reserveAccounts = data.accounts.filter(isReserveAccount);
  const sorted = [...data.transactions].sort(
    (a, b) =>
      b.transaction_date.localeCompare(a.transaction_date) ||
      b.created_at.localeCompare(a.created_at),
  );
  const accountName = (id: string | null) =>
    data.accounts.find((a) => a.id === id)?.name ?? "Conta";
  const categoryName = (id: string | null) =>
    data.categories.find((c) => c.id === id)?.name ?? "";
  const spending = data.categories
    .filter((c) => c.type === "expense")
    .map((c) => ({
      name: c.name,
      cents: data.transactions
        .filter(
          (t) =>
            t.type === "expense" &&
            t.transaction_date <= today() &&
            t.category_id === c.id &&
            t.transaction_date.startsWith(month),
        )
        .reduce((sum, t) => sum + t.amount_cents, 0) + planning.data.card_purchases.filter(p=>p.category_id===c.id && p.purchase_date<=today()&&p.purchase_date.startsWith(month)).reduce((s,p)=>s+p.amount_cents,0),
    }))
    .filter((c) => c.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  const [selectedYear, selectedMonth] = (month || today().slice(0, 7))
    .split("-")
    .map(Number);
  const evolution = Array.from({ length: 6 }, (_, i) => {
    const date = new Date(selectedYear, selectedMonth - 6 + i, 1);
    const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return { period, ...monthly(data.transactions, period) };
  }).filter((m) => m.income || m.expense);
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
  function rows(transactions: Transaction[]) {
    return transactions.map((t) => (
      <div className="movement" key={t.id}>
        <span className={`movement-icon ${t.type}`}>
          {t.type === "income" ? "↙" : t.type === "expense" ? "↗" : "⇄"}
        </span>
        <div className="grow">
          <strong>
            {t.description || categoryName(t.category_id) || "Transferência"}
          </strong>
          <small>
            {displayDate(t.transaction_date)} · {accountName(t.account_id)}
            {t.type === "transfer"
              ? ` → ${accountName(t.destination_account_id)}`
              : ` · ${categoryName(t.category_id)}`}
            {t.is_recurring ? " · Recorrente" : ""} · {t.transaction_date>today()?'PREVISTO':'REALIZADO'}
          </small>
        </div>
        <div className="row-end">
          <strong className={t.type}>
            {!valuesHidden &&
              (t.type === "expense" ? "−" : t.type === "income" ? "+" : "")}
            {money(t.amount_cents)}
          </strong>
          <small>{t.type==='card_payment'?'Pagamento de fatura':labels[t.type]}</small>
          {!t.payment_reference && <div className="actions">
            <button onClick={() => setEditor({ kind: "transaction", row: t })}>
              Editar
            </button>
            <button
              disabled={operation}
              onClick={() => void remove("transactions", t.id)}
            >
              Excluir
            </button>
          </div>}
        </div>
      </div>
    ));
  }
  function goals(limit?: number) {
    return data.goals
      .filter((g) => !g.is_emergency_reserve && (page === "goals" || g.is_active))
      .slice(0, limit)
      .map((g) => {
        const p = goalProgress(g, data.goal_contributions);
        return (
          <article className="goal panel" key={g.id}>
            <div className="section-heading">
              <h3>
                {g.name}
                {!g.is_active && " · Arquivado"}
              </h3>
              <span>{valuesHidden ? "••••" : `${Math.round(p.percent)}%`}</span>
            </div>
            {!valuesHidden && (
              <progress max="100" value={Math.min(100, p.percent)} />
            )}
            <p>
              <strong>{money(p.accumulated)}</strong>
              <span className="muted"> de {money(g.target_amount_cents)}</span>
            </p>
            <small>
              Faltam {money(p.remaining)}
              {g.target_date && ` · Até ${displayDate(g.target_date)}`}
            </small>
            {page === "goals" && (
              <>
                <div className="actions">
                  <button
                    disabled={!g.is_active}
                    onClick={() => setEditor({ kind: "contribution", goal: g })}
                  >
                    + Aporte
                  </button>
                  <button onClick={() => setEditor({ kind: "goal", row: g })}>
                    Editar
                  </button>
                  <button
                    disabled={operation}
                    onClick={() => void archive("goals", g.id, g.is_active)}
                  >
                    {g.is_active ? "Arquivar" : "Reativar"}
                  </button>
                </div>
                {data.goal_contributions
                  .filter((c) => c.goal_id === g.id)
                  .map((c) => (
                    <div className="contribution" key={c.id}>
                      <small>
                        {displayDate(c.contribution_date)} ·{" "}
                        {c.description || "Aporte"} · {money(c.amount_cents)}
                      </small>
                      <button
                        disabled={operation}
                        onClick={() => void remove("goal_contributions", c.id)}
                      >
                        Excluir
                      </button>
                    </div>
                  ))}
              </>
            )}
          </article>
        );
      });
  }
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
        {!error && !loading && (
          <div className="page-content" key={page}>
            {page === "home" && (
              <>
                <div className="eyebrow">SEU DINHEIRO, COM DIREÇÃO</div>
                <h1>Um passo de cada vez.</h1>
                <HomeClarity data={data} plan={planning.data} money={money} onPlan={()=>setPage('planning')} onNew={()=>setQuick(true)}/>
                <div className="section-heading">
                  <h2>Seu mês · realizado</h2>
                  <input
                    aria-label="Mês do resumo"
                    type="month"
                    value={month}
                    onChange={(e) =>
                      setMonth(e.target.value || today().slice(0, 7))
                    }
                  />
                </div>
                <div className="metrics">
                  <div>
                    <small>Entrou</small>
                    <strong className="income">{money(totals.income)}</strong>
                  </div>
                  <div>
                    <small>Saiu</small>
                    <strong>{money(totals.expense)}</strong>
                  </div>
                  <div>
                    <small>Resultado</small>
                    <strong>{money(totals.result)}</strong>
                  </div>
                </div>
                {totals.saved !== null && (
                  <p className="muted">
                    {valuesHidden ? "••••" : `${totals.saved.toFixed(1)}%`} da
                    receita economizada no mês.
                  </p>
                )}
                {!!spending.length && (
                  <details className="summary-detail">
                    <summary>Onde gastei neste mês</summary>
                    {spending.map((c) => (
                      <div className="account-line" key={c.name}>
                        <span>{c.name}</span>
                        <strong>{money(c.cents)}</strong>
                      </div>
                    ))}
                  </details>
                )}
                {evolution.length > 1 && (
                  <details className="summary-detail">
                    <summary>Minha evolução · últimos 6 meses</summary>
                    <p className="muted">Resultado: receitas menos despesas.</p>
                    {evolution.map((m) => (
                      <div className="account-line" key={m.period}>
                        <span>{m.period.split("-").reverse().join("/")}</span>
                        <strong className={m.result < 0 ? "expense" : "income"}>
                          {money(m.result)}
                        </strong>
                      </div>
                    ))}
                  </details>
                )}
                <div className="section-heading">
                  <h2>Onde está seu dinheiro</h2>
                  <button onClick={() => setPage("settings")}>Gerenciar</button>
                </div>
                {!data.accounts.length ? (
                  <Empty
                    text="Crie sua primeira conta para começar a registrar."
                    action="Criar conta"
                    onClick={() => setEditor({ kind: "account" })}
                  />
                ) : (
                  data.accounts.map((a) => (
                    <div className="account-line" key={a.id}>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {accountTypes[a.type]}
                          {!a.is_active && " · Arquivada"}
                        </small>
                      </div>
                      <strong>{money(balance(a, data.transactions))}</strong>
                    </div>
                  ))
                )}
                <div className="section-heading">
                  <h2>Últimas movimentações</h2>
                  <button onClick={() => setPage("history")}>Ver todas</button>
                </div>
                {sorted.length ? (
                  rows(sorted.slice(0, 5))
                ) : (
                  <p className="muted">
                    Sua primeira movimentação aparecerá aqui.
                  </p>
                )}
                {data.goals.some((g) => g.is_active) && (
                  <>
                    <div className="section-heading">
                      <h2>Seus objetivos</h2>
                      <button onClick={() => setPage("goals")}>
                        Ver todos
                      </button>
                    </div>
                    {goals(3)}
                  </>
                )}
              </>
            )}
            {page === "history" && (
              <>
                <h1>Movimentações</h1>
                <div className="filters">
                  <Field label="Mês">
                    <input
                      type="month"
                      value={historyMonth}
                      onChange={(e) => setHistoryMonth(e.target.value)}
                    />
                  </Field>
                  <Field label="Conta">
                    <select
                      value={filterAccount}
                      onChange={(e) => setFilterAccount(e.target.value)}
                    >
                      <option value="">Todas</option>
                      {data.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tipo">
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                    >
                      <option value="">Todos</option>
                      {Object.entries(labels).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <button
                  className="primary"
                  onClick={() => setQuick(true)}
                >
                  + Adicionar
                </button>
                {(() => {
                  const filtered = sorted.filter(
                    (t) =>
                      (!historyMonth ||
                        t.transaction_date.startsWith(historyMonth)) &&
                      (!filterType || t.type === filterType) &&
                      (!filterAccount ||
                        t.account_id === filterAccount ||
                        t.destination_account_id === filterAccount),
                  );
                  return filtered.length ? (
                    rows(filtered)
                  ) : (
                    <p className="empty">Nenhuma movimentação neste filtro.</p>
                  );
                })()}
              </>
            )}
            {page === "investments" && (
              <>
                <h1>Investimentos e Reserva</h1>
                <section className="balance">
                  <span>Total em investimentos e reserva</span>
                  <h2>{money(balances.reserve)}</h2>
                  <small>Inclui contas arquivadas · lançamentos até hoje</small>
                </section>
                {reserveAccounts.length ? (
                  reserveAccounts.map((a) => (
                    <div className="account-line" key={a.id}>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {accountTypes[a.type]}
                          {!a.is_active && " · Arquivada"}
                        </small>
                      </div>
                      <strong>{money(balance(a, data.transactions))}</strong>
                    </div>
                  ))
                ) : (
                  <p className="empty">
                    Nenhuma conta de poupança ou investimento. Crie uma conta em
                    Ajustes.
                  </p>
                )}
              </>
            )}
            {page === "goals" && (
              <>
                <div className="section-heading">
                  <h1>Objetivos</h1>
                  <button
                    className="primary"
                    onClick={() => setEditor({ kind: "goal" })}
                  >
                    + Criar
                  </button>
                </div>
                <p className="muted">
                  Aportes acompanham sua meta; não movimentam o saldo das
                  contas.
                </p>
                {data.goals.length ? (
                  goals()
                ) : (
                  <Empty
                    text="Dê um nome ao próximo passo: reserva, viagem ou outra conquista."
                    action="Criar objetivo"
                    onClick={() => setEditor({ kind: "goal" })}
                  />
                )}
              </>
            )}
            {page === "settings" && (
              <>
                <h1>Ajustes</h1>
                <p className="muted">{session.user.email}</p>
                <div className="section-heading">
                  <h2>Contas</h2>
                  <button onClick={() => setEditor({ kind: "account" })}>
                    + Criar
                  </button>
                </div>
                {data.accounts.map((a) => (
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
                <small className="muted">Rota Financeira · v0.2</small>
              </>
            )}
          </div>
        )}
      </main>
      <nav aria-label="Navegação principal">
        {[
          ["home", "⌂", "Início"],
          ["history", "↕", "Movimentações"],
          ["add", "+", "Adicionar"],
          ["planning", "◇", "Planejar"],
          ["goals", "◎", "Objetivos"],
          ["settings", "☷", "Ajustes"],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            aria-label={label}
            aria-current={page === id ? "page" : undefined}
            disabled={id === "add" && (loading || !!error)}
            className={`${page === id ? "selected" : ""} ${id === "add" ? "add" : ""}`}
            onClick={() =>
              id === "add" ? setQuick(true) : setPage(id)
            }
          >
            <span aria-hidden="true">{icon}</span>
            <small>
              {id === "history" ? "Movimentos" : id === "add" ? "Novo" : id==='goals'?'Metas':label}
            </small>
          </button>
        ))}
      </nav>
      {editor && (
        <EditorForm
          key={`${editor.kind}:${'row' in editor?editor.row?.id??'new':'new'}`}
          editor={editor}
          valuesHidden={valuesHidden}
          data={data}
          onClose={() => setEditor(null)}
          onSaved={async (accountId?:string) => {
            if(accountId)lastAccount.current=accountId;
            setEditor(null);
            await refresh();
            setNotice(
              "Salvo com sucesso. Você já pode adicionar outra movimentação.",
            );
          }}
        />
      )}
      {!error&&!loading&&<div className={page==='planning'?'planning-container':'planning-hidden'}><PlanningWorkspace data={data} plan={planning.data} money={money} hidden={valuesHidden} visible={page==='planning'} action={planningAction} setAction={setPlanningAction} onSaved={async()=>{await refresh();setNotice('Salvo com sucesso. Planejamento atualizado.');}}/></div>}
      {quick&&<QuickActions onClose={()=>setQuick(false)} onSelect={kind=>{setQuick(false);if(['income','expense','transfer'].includes(kind))setEditor({kind:'transaction',initialType:kind as 'income'|'expense'|'transfer',accountId:lastAccount.current});else if(kind==='contribution'){setPage('goals');setNotice('Escolha + Aporte na meta desejada. Para mover dinheiro entre contas, use Transferência.');}else setPlanningAction({kind:kind as 'purchase'|'debtPayment'});}}/>}
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
function Empty({
  text,
  action,
  onClick,
}: {
  text: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="empty">
      <p>{text}</p>
      <button className="primary" onClick={onClick}>
        {action}
      </button>
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
  onSaved: () => Promise<void>;
}) {
  const row = "row" in editor ? editor.row : undefined;
  const transaction = editor.kind === "transaction" ? editor.row : undefined;
  const [type, setType] = useState(
    transaction?.type ??
      (editor.kind === "category"
        ? (editor.row?.type ?? "expense")
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
          initial_balance_cents: cents("initial"),
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
          is_recurring: recurring,
          recurrence_frequency: recurring ? str("frequency") : null,
        };
        if (
          type === "transfer" &&
          payload.account_id === payload.destination_account_id
        )
          throw new Error("Escolha duas contas diferentes.");
      }
      if ("amount_cents" in payload && Number(payload.amount_cents) <= 0)
        throw new Error("Informe um valor maior que zero.");
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
      closeWithMotion(() => void onSaved());
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
              <input
                className="amount-input"
                required
                name="amount"
                inputMode="decimal"
                type={valuesHidden ? "password" : "text"}
                autoComplete="off"
                placeholder={valuesHidden ? "••••" : "0,00"}
                defaultValue={
                  transaction ? inputMoney(transaction.amount_cents) : ""
                }
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
                  {Object.entries(accountTypes).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Saldo inicial (R$)">
                <input
                  required
                  name="initial"
                  inputMode="decimal"
                  type={valuesHidden ? "password" : "text"}
                  autoComplete="off"
                  defaultValue={inputMoney(
                    editor.row?.initial_balance_cents ?? 0,
                  )}
                />
              </Field>
              <small>
                Alterar o saldo inicial recalcula o saldo atual. Os lançamentos
                continuam preservados.
              </small>
            </>
          )}
          {editor.kind === "goal" && (
            <>
              <Field label="Meta (R$)">
                <input
                  required
                  name="target"
                  inputMode="decimal"
                  type={valuesHidden ? "password" : "text"}
                  autoComplete="off"
                  defaultValue={
                    editor.row ? inputMoney(editor.row.target_amount_cents) : ""
                  }
                />
              </Field>
              <Field label="Já acumulado (R$)">
                <input
                  required
                  name="initial"
                  inputMode="decimal"
                  type={valuesHidden ? "password" : "text"}
                  autoComplete="off"
                  defaultValue={inputMoney(
                    editor.row?.initial_amount_cents ?? 0,
                  )}
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
                    transaction?.account_id ?? accounts[0]?.id ?? ""
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
          {editor.kind === "transaction" && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
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
                    A marcação não cria lançamentos automaticamente.
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
