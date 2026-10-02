import type { FinanceData } from "../../types";
import type { PlanningData, Commitment } from "./types";
import { today, displayDate } from "../../utils/finance";
import { monthReport } from "./reportCalculations";
import { Status } from "./ui";
import type { Money } from "./ui";
export function CommitmentRow({
  item: c,
  money,
  onResolve,
}: {
  item: Commitment;
  money: Money;
  onResolve?: (c: Commitment) => void;
}) {
  return (
    <div className="account-line commitment-row">
      <div>
        <strong>{c.name}</strong>
        <small>
          {displayDate(c.due)} ·{" "}
          <Status state={c.due <= today() ? "pending" : "forecast"} />
          {c.due < today() ? " · vencido" : ""}
          {c.impact === 0 ? " · conta de reserva / transferência interna" : ""}
        </small>
      </div>
      <div className="row-end">
        <strong>{money(c.amount)}</strong>
        {onResolve && c.canResolve !== false && (
          <button onClick={() => onResolve(c)}>
            {c.direction === "income"
              ? "Receber"
              : c.direction === "transfer"
                ? "Realizar"
                : "Marcar pago"}
          </button>
        )}
      </div>
    </div>
  );
}
export function MonthReport({
  data,
  plan,
  money,
  onResolve,
}: {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  onResolve?: (c: Commitment) => void;
}) {
  const r = monthReport(data, plan, today());
  return (
    <section className="month-report">
      <h2>Relatório financeiro do mês</h2>
      <dl className="finance-details panel">
        <div>
          <dt>Receitas realizadas</dt>
          <dd>{money(r.actual.income)}</dd>
        </div>
        <div>
          <dt>Ainda entra</dt>
          <dd>{money(r.incoming)}</dd>
        </div>
        <div>
          <dt>Já pago no mês</dt>
          <dd>{money(r.paid)}</dd>
        </div>
        <div>
          <dt>Ainda pendente no disponível</dt>
          <dd>{money(r.current.commitments)}</dd>
        </div>
        <div className="finance-total">
          <dt>Total comprometido (pago + pendente)</dt>
          <dd>{money(r.totalCommitted)}</dd>
        </div>
      </dl>
      <details className="panel">
        <summary>
          Ver composição do total comprometido · {money(r.totalCommitted)}
        </summary>
        <h3>Já pago · {money(r.paid)}</h3>
        {r.paidItems.map((t) => (
          <div className="account-line" key={t.id}>
            <span>
              {t.description || "Pagamento"} · {displayDate(t.transaction_date)}{" "}
              · <Status state="realized" />
            </span>
            <strong>{money(t.amount_cents)}</strong>
          </div>
        ))}
        <p>
          Pendentes que ainda saem do disponível: {money(r.current.commitments)}
        </p>
        {r.groups.map((g) => (
          <p key={g.key}>
            {g.label} · {money(g.total)}
          </p>
        ))}
      </details>
      <h3>Compromissos do mês</h3>
      {r.groups.map((g) => (
        <details className="panel" key={g.key}>
          <summary>
            {g.label} <strong>{money(g.total)}</strong>
          </summary>
          {g.items.length ? (
            g.items.map((c) => (
              <CommitmentRow
                key={c.id}
                item={c}
                money={money}
                onResolve={onResolve}
              />
            ))
          ) : (
            <p className="muted">Sem compromissos neste grupo.</p>
          )}
        </details>
      ))}
      <details className="panel">
        <summary>Receitas previstas · {money(r.incoming)}</summary>
        {r.current.items
          .filter((c) => c.impact > 0)
          .map((c) => (
            <CommitmentRow
              key={c.id}
              item={c}
              money={money}
              onResolve={onResolve}
            />
          ))}
      </details>
      <p className="muted">
        Os subtotais medem o efeito no disponível. Itens em reserva e
        transferências internas aparecem na composição com seu valor, sem
        consumir dinheiro livre.
      </p>
    </section>
  );
}
