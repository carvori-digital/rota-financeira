import type { Debt } from "./types";
import type { PlanningData } from "../planning/types";
import type { Money } from "../planning/ui";
import { debtProgress, debtInstallments, debtSchedule } from "./calculations";
import { addMonths } from "../planning/dates";
import { displayDate, today } from "../../utils/finance";
export function DebtsPanel({
  plan,
  money,
  hidden,
  onEdit,
  onInstallment,
  onPay,
  onToggle,
}: {
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  onInstallment: () => void;
  onEdit: (d?: Debt) => void;
  onPay: (d?: Debt) => void;
  onToggle: (d: Debt) => void;
}) {
  return (
    <>
      <div className="section-heading">
        <h2>Dívidas</h2>
        <div className="actions">
          <button onClick={onInstallment}>Adicionar parcelamento</button>
          <button onClick={() => onEdit()}>Adicionar dívida</button>
        </div>
      </div>
      {!plan.debts.length && (
        <div className="empty">
          <p>
            Cadastre o saldo que ainda falta pagar, sem precisar reconstruir o
            passado.
          </p>
          <button className="primary" onClick={() => onEdit()}>
            Adicionar dívida
          </button>
        </div>
      )}
      {plan.debts.map((d) => {
        const progress = debtProgress(d),
          next = debtInstallments(d, addMonths(today(), 3))[0];
        return (
          <article className="panel" key={d.id}>
            <div className="section-heading">
              <h3>
                {d.name}
                {!d.active ? " · Pausada" : ""}
              </h3>
              <span>
                {hidden ? "••••" : `${Math.round(progress.percent)}% quitado`}
              </span>
            </div>
            {!hidden && <progress max={100} value={progress.percent} />}
            <p>
              Quanto falta: <strong>{money(d.remaining_amount_cents)}</strong>
            </p>
            <small>
              Pago {money(progress.paid)} · dívida original{" "}
              {money(d.original_amount_cents)}
            </small>
            {d.total_installments && d.remaining_amount_cents > 0 && (
              <p>
                Parcela {d.installment_number}/{d.total_installments} ·{" "}
                {debtSchedule(d).count} restantes · mensal{" "}
                {money(d.installment_amount_cents ?? 0)}
              </p>
            )}
            {debtSchedule(d).end && (
              <p>Previsão de quitação: {displayDate(debtSchedule(d).end!)}</p>
            )}
            {next && (
              <p>
                Próxima parcela {money(next.amount)} · {displayDate(next.date)}
              </p>
            )}
            <div className="actions">
              <button
                disabled={!d.remaining_amount_cents}
                className="primary"
                onClick={() => onPay(d)}
              >
                Registrar pagamento
              </button>
              <button onClick={() => onEdit(d)}>Editar dívida</button>
              <button onClick={() => onToggle(d)}>
                {d.active ? "Pausar previsão" : "Reativar previsão"}
              </button>
            </div>
            {debtSchedule(d).end && (
              <details>
                <summary>
                  Próximas parcelas · {debtSchedule(d).count} restantes
                </summary>
                {debtInstallments(d, debtSchedule(d).end!).map((i) => (
                  <div className="account-line" key={i.date}>
                    <span>
                      {i.number
                        ? i.number + "/" + d.total_installments + " · "
                        : ""}
                      {displayDate(i.date)}
                    </span>
                    <strong>{money(i.amount)}</strong>
                  </div>
                ))}
              </details>
            )}
            <details>
              <summary>Histórico de pagamentos</summary>
              {plan.debt_payments
                .filter((p) => p.debt_id === d.id)
                .map((p) => (
                  <div className="account-line" key={p.id}>
                    <small>{displayDate(p.payment_date)} · REALIZADO</small>
                    <strong>{money(p.amount_cents)}</strong>
                  </div>
                ))}
            </details>
          </article>
        );
      })}
    </>
  );
}
