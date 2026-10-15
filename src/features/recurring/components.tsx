import type { Transaction } from "../../types";
import { DeleteRecord } from "../planning/DeleteRecord";
import type { PlanningData } from "../planning/types";
import type { Money } from "../planning/ui";
import { Status } from "../planning/ui";
import type { RecurringItem } from "./types";
import {
  recurringDates,
  occurrenceAmount,
  occurrencePayments,
} from "./calculations";
import { addMonths } from "../planning/dates";
import { displayDate, today } from "../../utils/finance";
export function RecurringPanel({
  plan,
  transactions,
  money,
  onEdit,
  onResolve,
  onToggle,
  onAmount,
  onSaved,
}: {
  plan: PlanningData;
  transactions: Transaction[];
  money: Money;
  onEdit: (r?: RecurringItem) => void;
  onAmount?: (r: RecurringItem, due: string, amount: number) => void;
  onResolve: (r: RecurringItem, date: string, skip: boolean) => void;
  onToggle: (r: RecurringItem) => void;
  onSaved: () => Promise<void>;
}) {
  const now = today();
  return (
    <>
      <div className="section-heading">
        <h2>Recorrentes</h2>
        <button onClick={() => onEdit()}>Adicionar recorrente</button>
      </div>
      {!plan.recurring_items.length && (
        <div className="empty">
          <p>
            Adicione uma receita ou conta recorrente para prever os próximos
            meses.
          </p>
          <button className="primary" onClick={() => onEdit()}>
            Adicionar receita ou conta recorrente
          </button>
        </div>
      )}
      {plan.recurring_items.map((r) => (
        <article className="panel" key={r.id}>
          <div className="section-heading">
            <h3>{r.name}</h3>
            <strong>{money(r.amount_cents)}</strong>
          </div>
          <p>
            {r.type === "income" ? "Receita" : "Despesa"} ·{" "}
            {
              { weekly: "Semanal", monthly: "Mensal", yearly: "Anual" }[
                r.frequency
              ]
            }
            {r.is_essential ? " · Essencial" : ""}
            {!r.active ? " · Pausada" : ""}
          </p>
          <div className="actions">
            <button onClick={() => onEdit(r)}>Editar regra</button>
            <button onClick={() => onToggle(r)}>
              {r.active ? "Pausar" : "Reativar"}
            </button>
          </div>
          {recurringDates(r, addMonths(now, 1), plan.recurring_occurrences)
            .slice(0, 6)
            .map((date) => (
              <div className="account-line" key={date}>
                <small>
                  {displayDate(date)} ·{" "}
                  {money(
                    occurrenceAmount(
                      r,
                      date,
                      plan.recurring_occurrences,
                      transactions,
                    ),
                  )}{" "}
                  · <Status state={date <= now ? "pending" : "forecast"} />
                </small>
                <div className="actions">
                  {onAmount && (
                    <button
                      onClick={() =>
                        onAmount(
                          r,
                          date,
                          occurrenceAmount(
                            r,
                            date,
                            plan.recurring_occurrences,
                            transactions,
                          ),
                        )
                      }
                    >
                      Ajustar previsão
                    </button>
                  )}
                  <button
                    disabled={date > now}
                    onClick={() => onResolve(r, date, false)}
                  >
                    Realizar
                  </button>
                  <button onClick={() => onResolve(r, date, true)}>
                    Pular
                  </button>
                </div>
              </div>
            ))}
          <details>
            <summary>Ocorrências realizadas e puladas</summary>
            {plan.recurring_occurrences
              .filter(
                (o) => o.recurring_item_id === r.id && o.status !== "planned",
              )
              .sort((a, b) => b.due_date.localeCompare(a.due_date))
              .map((o) => {
                const paid = occurrencePayments(
                  o,
                  r.type,
                  transactions,
                  plan.recurring_payments ?? [],
                  now,
                ).reduce((sum, t) => sum + t.amount_cents, 0);
                const expected = occurrenceAmount(
                  r,
                  o.due_date,
                  plan.recurring_occurrences,
                  transactions,
                );
                return (
                  <div className="account-line" key={o.id}>
                    <small>
                      {displayDate(o.due_date)}
                      {o.status === "recorded" ? (
                        <>
                          {" "}
                          · Pago {money(paid)} de {money(expected)}
                        </>
                      ) : null}
                    </small>
                    <Status
                      state={
                        o.status === "skipped"
                          ? "skipped"
                          : expected > 0 && paid >= expected
                            ? "realized"
                            : o.due_date > now
                              ? "forecast"
                              : "pending"
                      }
                    />
                  </div>
                );
              })}
          </details>
          <DeleteRecord
            kind="recurring"
            id={r.id}
            onSaved={onSaved}
            blocked={
              plan.recurring_occurrences.some(
                (o) => o.recurring_item_id === r.id,
              )
                ? "Esta recorrência possui ocorrências. Pause para preservar o histórico."
                : undefined
            }
          />
        </article>
      ))}
    </>
  );
}
