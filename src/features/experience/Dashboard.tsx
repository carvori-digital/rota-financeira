import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  CreditCard,
  CalendarRange,
  ChevronRight,
  Landmark,
  ShieldCheck,
  Target,
  SlidersHorizontal,
} from "lucide-react";
import type { FinanceData } from "../../types";
import type { PlanningData, Commitment } from "../planning/types";
import {
  balanceSummary,
  balance,
  goalProgress,
  today,
  displayDate,
} from "../../utils/finance";
import type { Money } from "../planning/ui";
import { Status } from "../planning/ui";
import { experienceReport } from "./calculations";
import { MonthlyProgress } from "./MonthlyProgress";
import { ReportChart } from "./ReportChart";
export type ReturnTypeReport = ReturnType<typeof experienceReport>;
export function Dashboard({
  data,
  plan,
  money,
  hidden,
  onPlan,
  onAction,
  onResolve,
  onSetup,
  onGoals,
  onReports,
  onAccount,
}: {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  onPlan: (section?: string) => void;
  onAction: (kind: string) => void;
  onResolve: (c: Commitment) => void;
  onSetup: () => void;
  onGoals: () => void;
  onReports: () => void;
  onAccount: () => void;
}) {
  const asOf = today(),
    r = experienceReport(data, plan, asOf);
  const balances = balanceSummary(data.accounts, data.transactions, asOf);
  const upcoming = r.months
    .flatMap((m) => m.items)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 3);
  const goal = data.goals.find((g) => g.is_active && !g.is_emergency_reserve);
  const percent = goal
    ? goalProgress(goal, data.goal_contributions).percent
    : null;
  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">SEU DINHEIRO, COM DIREÇÃO</p>
          <h1>Seu mês, mais leve.</h1>
        </div>
        <button
          className="icon-link"
          aria-label="Configuração rápida"
          onClick={onSetup}
        >
          <SlidersHorizontal size={20} />
        </button>
      </div>
      <section className="balance month-hero">
        <span>Livre no mês</span>
        <h2>{money(r.current.closing)}</h2>
        <small>
          <Status state="forecast" /> · fechamento do mês
        </small>
        <div className="balance-secondary">
          <div aria-label="Saldo disponível">
            <span>Saldo agora</span>
            <strong>{money(balances.available)}</strong>
          </div>
          <div>
            <span>Ainda entra</span>
            <strong>{money(r.incoming)}</strong>
          </div>
          <div>
            <span>Ainda sai</span>
            <strong>{money(r.current.commitments)}</strong>
          </div>
        </div>
        {!data.accounts.length && (
          <button onClick={onAccount}>Criar primeira conta</button>
        )}
      </section>
      <MonthlyProgress
        hidden={hidden}
        report={r}
        onPlan={() => onPlan("month")}
      />
      <section className="dashboard-actions" aria-label="Ações rápidas">
        {[
          { kind: "expense", label: "Despesa", Icon: ArrowUpRight },
          { kind: "income", label: "Receita", Icon: ArrowDownLeft },
          { kind: "transfer", label: "Pix", Icon: ArrowLeftRight },
          { kind: "purchase", label: "Cartão", Icon: CreditCard },
          { kind: "plan", label: "Planejar", Icon: CalendarRange },
        ].map(({ kind, label, Icon }) => (
          <button
            key={kind}
            aria-label={kind === "transfer" ? "Pix / Transferência" : label}
            onClick={() => (kind === "plan" ? onPlan("month") : onAction(kind))}
          >
            <span>
              <Icon size={21} strokeWidth={1.8} />
            </span>
            <small>{label}</small>
          </button>
        ))}
      </section>
      <section className="upcoming-commitments">
        <div className="section-heading">
          <h2>Próximos vencimentos</h2>
          <button className="text-link" onClick={() => onPlan("month")}>
            Ver todos <ChevronRight size={14} />
          </button>
        </div>
        <div className="panel compact-list">
          {upcoming.length ? (
            upcoming.map((c) => (
              <div className="upcoming-row" key={c.id}>
                <span className="due-date">
                  {displayDate(c.due).slice(0, 5)}
                </span>
                <div className="grow">
                  <strong>{c.name}</strong>
                  <small>
                    <Status state={c.due <= asOf ? "pending" : "forecast"} />
                  </small>
                </div>
                <div className="row-end">
                  <strong>{money(c.amount)}</strong>
                  {c.canResolve !== false && (
                    <button onClick={() => onResolve(c)}>
                      {c.direction === "income"
                        ? "Receber"
                        : c.direction === "transfer"
                          ? "Realizar"
                          : "Pagar"}
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty">
              <p>Nenhum vencimento previsto.</p>
              <button onClick={() => onPlan("month")}>Planejar meu mês</button>
            </div>
          )}
        </div>
      </section>
      <section>
        <h2>Visão rápida</h2>
        <div className="overview-grid">
          <button onClick={() => onPlan("cards")}>
            <CreditCard size={21} />
            <span>Cartões</span>
              <strong>{money(r.cardsPending)}</strong>
            <small>Faturas restantes do mês</small>
          </button>
          <button onClick={() => onPlan("debts")}>
            <Landmark size={21} />
            <span>Dívidas</span>
            <strong>
              {money(
                plan.debts.reduce((s, d) => s + d.remaining_amount_cents, 0),
              )}
            </strong>
            <small>Falta quitar</small>
          </button>
          <button onClick={() => onPlan("reserve")}>
            <ShieldCheck size={21} />
            <span>Reserva</span>
            <strong>
              {hidden
                ? "••••"
                : r.protectedMonths === null
                  ? "Configurar"
                  : `${r.protectedMonths.toFixed(1).replace(".", ",")} de ${r.targetMonths}`}
            </strong>
            <small>Meses protegidos</small>
          </button>
          <button aria-label="Metas" onClick={onGoals}>
            <Target size={21} />
            <span>Metas</span>
            <strong>
              {hidden
                ? "••••"
                : percent === null
                  ? "Começar"
                  : `${Math.round(percent)}%`}
            </strong>
            <small>{goal?.name ?? "Seu próximo objetivo"}</small>
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Resumo do mês</h2>
          <button className="text-link" onClick={onReports}>
            Detalhar <ChevronRight size={14} />
          </button>
        </div>
        <ReportChart
          rows={
            r.actual.income || r.actual.expense
              ? [
                  { label: "Receitas realizadas", value: r.actual.income },
                  {
                    label: "Despesas realizadas",
                    value: r.actual.expense,
                    tone: "outflow",
                  },
                ]
              : []
          }
          money={money}
          hidden={hidden}
          label="Resumo realizado do mês"
        />
      </section>
      <details className="panel account-disclosure">
        <summary>Onde está meu dinheiro</summary>
        <dl className="finance-details">
          <div>
            <dt>Investimentos e reserva</dt>
            <dd>{money(balances.reserve)}</dd>
          </div>
          <div>
            <dt>Patrimônio total nas contas</dt>
            <dd>{money(balances.total)}</dd>
          </div>
        </dl>
        {data.accounts.map((a) => (
          <div className="account-line" key={a.id}>
            <span>
              {a.name}
              {!a.is_active && " · Arquivada"}
            </span>
            <strong>{money(balance(a, data.transactions, asOf))}</strong>
          </div>
        ))}
        <small>Patrimônio nas contas antes das dívidas e faturas.</small>
      </details>
    </div>
  );
}
