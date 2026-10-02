import type { FinanceData } from "../../types";
import type { PlanningData, MonthProjection, Commitment } from "./types";
import { balanceSummary, balance, today } from "../../utils/finance";
import { monthReport } from "./reportCalculations";
import { MonthReport, CommitmentRow } from "./MonthReport";
import type { Money } from "./ui";
import { Status } from "./ui";
export function ProjectionList({
  months,
  money,
}: {
  months: MonthProjection[];
  money: Money;
}) {
  return (
    <div className="projection-list">
      {months.map((m) => (
        <article className="panel" key={m.month}>
          <h3>{m.month.split("-").reverse().join("/")}</h3>
          <dl className="finance-details">
            <div>
              <dt>Abertura {m === months[0] ? "realizada" : "prevista"}</dt>
              <dd>{money(m.opening)}</dd>
            </div>
            <div>
              <dt>Entradas previstas</dt>
              <dd>{money(m.income)}</dd>
            </div>
            <div>
              <dt>Recorrentes</dt>
              <dd>{money(m.recurring)}</dd>
            </div>
            <div>
              <dt>Cartões</dt>
              <dd>{money(m.cards)}</dd>
            </div>
            <div>
              <dt>Dívidas</dt>
              <dd>{money(m.debts)}</dd>
            </div>
            <div>
              <dt>Outras despesas previstas</dt>
              <dd>{money(m.other)}</dd>
            </div>
            <div>
              <dt>Transferências (efeito no disponível)</dt>
              <dd>{money(m.transfers)}</dd>
            </div>
            <div>
              <dt>Compromissos totais</dt>
              <dd>{money(m.commitments)}</dd>
            </div>
            <div className="finance-total">
              <dt>Saldo projetado final</dt>
              <dd>{money(m.closing)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
export function HomeClarity({
  data,
  plan,
  money,
  onPlan,
  onNew,
  onResolve,
  onSetup,
}: {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  onPlan: () => void;
  onNew: () => void;
  onResolve: (c: Commitment) => void;
  onSetup: () => void;
}) {
  const asOf = today(),
    report = monthReport(data, plan, asOf),
    current = report.current,
    balances = balanceSummary(data.accounts, data.transactions, asOf);
  const upcoming = report.months
    .flatMap((m) => m.items)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 8);
  const negative = data.accounts.filter(
    (a) => balance(a, data.transactions, asOf) < 0,
  );
  return (
    <>
      <section className="balance">
        <span>Livre depois dos compromissos · mês atual</span>
        <h2>{money(current.closing)}</h2>
        <small>
          <Status state="forecast" /> · saldo projetado no fechamento
        </small>
        <div className="balance-secondary">
          <div>
            Saldo disponível <strong>{money(balances.available)}</strong>
            <small>
              <Status state="realized" /> · agora
            </small>
          </div>
          <div>
            Ainda entra <strong>{money(report.incoming)}</strong>
          </div>
          <div>
            Ainda sai <strong>{money(current.commitments)}</strong>
          </div>
        </div>
        <button onClick={onNew}>+ Nova movimentação</button>
      </section>
      <button onClick={onSetup}>Configuração rápida</button>
      {negative.length > 0 && (
        <article className="panel">
          <h3>Contas negativas · obrigação atual</h3>
          {negative.map((a) => (
            <p key={a.id}>
              {a.name} · {money(balance(a, data.transactions, asOf))}
            </p>
          ))}
          <small>
            Esses saldos já reduzem o disponível. Encargos conhecidos podem ser
            agendados no grupo Outros.
          </small>
        </article>
      )}
      <MonthReport
        data={data}
        plan={plan}
        money={money}
        onResolve={onResolve}
      />
      <div className="section-heading">
        <h2>Próximos vencimentos</h2>
        <button onClick={onPlan}>Planejar</button>
      </div>
      {upcoming.length ? (
        upcoming.map((c) => (
          <CommitmentRow
            key={c.id}
            item={c}
            money={money}
            onResolve={onResolve}
          />
        ))
      ) : (
        <p className="empty">
          Cadastre seus compromissos em Planejar ou na configuração rápida.
        </p>
      )}
      <div className="section-heading">
        <h2>Projeção · próximos meses</h2>
        <button onClick={onPlan}>Detalhar</button>
      </div>
      <ProjectionList months={report.months} money={money} />
      <article className="panel">
        <h2>Reserva, investimentos e patrimônio</h2>
        <dl className="finance-details">
          <div>
            <dt>Investimentos e reserva</dt>
            <dd>{money(balances.reserve)}</dd>
          </div>
          <div>
            <dt>Patrimônio total nas contas</dt>
            <dd>{money(balances.total)}</dd>
          </div>
          <div>
            <dt>Quanto falta pagar em dívidas</dt>
            <dd>
              {money(
                plan.debts.reduce((s, d) => s + d.remaining_amount_cents, 0),
              )}
            </dd>
          </div>
        </dl>
        <small>
          Patrimônio soma as contas antes das dívidas e faturas. Metas registram
          progresso e não movimentam dinheiro.
        </small>
      </article>
    </>
  );
}
