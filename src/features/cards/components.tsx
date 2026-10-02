import type { PlanningData } from "../planning/types";
import type { Money } from "../planning/ui";
import { Status } from "../planning/ui";
import type { CreditCard, InvoiceSummary } from "./types";
import { addMonths } from "../planning/dates";
import { invoices, purchaseInstallments } from "./calculations";
import { displayDate, today } from "../../utils/finance";
export function CardsPanel({
  plan,
  money,
  onEdit,
  onPurchase,
  onInvoice,
  onPay,
  onToggle,
}: {
  plan: PlanningData;
  money: Money;
  onEdit: (c?: CreditCard) => void;
  onPurchase: (c: CreditCard) => void;
  onInvoice: (c: CreditCard) => void;
  onPay: (c: CreditCard, i: InvoiceSummary) => void;
  onToggle: (c: CreditCard) => void;
}) {
  const bills = invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    plan.card_payments,
  );
  return (
    <>
      <div className="section-heading">
        <h2>Cartões</h2>
        <button onClick={() => onEdit()}>Adicionar cartão</button>
      </div>
      {!plan.credit_cards.length && (
        <div className="empty">
          <p>Você ainda não cadastrou cartões.</p>
          <button className="primary" onClick={() => onEdit()}>
            Adicionar cartão
          </button>
        </div>
      )}
      {plan.credit_cards.map((c) => (
        <article className="panel" key={c.id}>
          <h3>
            {c.name}
            {!c.active ? " · Arquivado" : ""}
          </h3>
          <p>
            Fecha dia {c.closing_day} · vence dia {c.due_day}
            {c.limit_cents != null && <> · limite {money(c.limit_cents)}</>}
          </p>
          <dl className="finance-details">
            <div>
              <dt>Fatura atual pendente</dt>
              <dd>
                {money(
                  bills
                    .filter(
                      (i) =>
                        i.card_id === c.id && i.month <= today().slice(0, 7),
                    )
                    .reduce((s, i) => s + i.pending, 0),
                )}
              </dd>
            </div>
            <div>
              <dt>Próxima fatura</dt>
              <dd>
                {money(
                  bills.find(
                    (i) =>
                      i.card_id === c.id &&
                      i.month === addMonths(today(), 1).slice(0, 7),
                  )?.pending ?? 0,
                )}
              </dd>
            </div>
            <div>
              <dt>Futuro já contratado</dt>
              <dd>
                {money(
                  bills
                    .filter(
                      (i) =>
                        i.card_id === c.id && i.month > today().slice(0, 7),
                    )
                    .reduce((s, i) => s + i.pending, 0),
                )}
              </dd>
            </div>
          </dl>
          <div className="actions">
            <button disabled={!c.active} onClick={() => onPurchase(c)}>
              Compra no cartão
            </button>
            <button disabled={!c.active} onClick={() => onInvoice(c)}>
              Informar fatura atual
            </button>
            <button onClick={() => onEdit(c)}>Editar cartão</button>
            <button onClick={() => onToggle(c)}>
              {c.active ? "Arquivar" : "Reativar"}
            </button>
          </div>
          {bills
            .filter((i) => i.card_id === c.id)
            .map((i) => (
              <div className="invoice-block" key={i.month}>
                <div className="account-line">
                  <div>
                    <strong>
                      Fatura {i.month.split("-").reverse().join("/")}
                    </strong>
                    <small>
                      Vence {displayDate(i.due_date)} ·{" "}
                      <Status
                        state={
                          !i.pending
                            ? "realized"
                            : i.due_date <= today()
                              ? "pending"
                              : "forecast"
                        }
                      />
                      {!i.pending && " · paga"}
                    </small>
                  </div>
                  <strong>{money(i.pending)}</strong>
                </div>
                <small>
                  Total {money(i.total)} · pago {money(i.paid)}
                </small>
                {i.pending > 0 && (
                  <button className="primary" onClick={() => onPay(c, i)}>
                    Pagar fatura
                  </button>
                )}
              </div>
            ))}
          <details>
            <summary>Compras e parcelas</summary>
            {plan.card_purchases
              .filter((p) => p.card_id === c.id)
              .map((p) => (
                <div className="invoice-block" key={p.id}>
                  <strong>
                    {p.description || "Compra"} · {money(p.amount_cents)}
                  </strong>
                  <small>
                    {displayDate(p.purchase_date)} · {p.installments} parcela(s)
                    · término{" "}
                    {displayDate(purchaseInstallments(p).at(-1)!.date)} ·{" "}
                    {
                      purchaseInstallments(p).filter(
                        (i) =>
                          (bills.find(
                            (b) =>
                              b.card_id === c.id &&
                              b.month === i.date.slice(0, 7),
                          )?.pending ?? 0) > 0,
                      ).length
                    }{" "}
                    parcelas em faturas pendentes
                  </small>
                  {purchaseInstallments(p).map((i) => (
                    <div className="account-line" key={i.number}>
                      <small>
                        {i.number}/{p.installments} · {displayDate(i.date)}
                      </small>
                      <span>{money(i.amount)}</span>
                    </div>
                  ))}
                </div>
              ))}
          </details>
          <details>
            <summary>Histórico de pagamentos</summary>
            {plan.card_payments
              .filter((p) => p.card_id === c.id)
              .map((p) => (
                <div className="account-line" key={p.id}>
                  <small>
                    {displayDate(p.payment_date)} · fatura {p.due_month}
                  </small>
                  <strong>{money(p.amount_cents)}</strong>
                </div>
              ))}
          </details>
        </article>
      ))}
    </>
  );
}
