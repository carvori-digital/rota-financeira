import type { MonthProjection } from "./types";
import type { Money } from "./ui";
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
