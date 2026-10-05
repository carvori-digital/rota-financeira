import { useRef, useState } from "react";
import type { FinanceData } from "../../types";
import type { PlanningData } from "../planning/types";
import type { Investment } from "./types";
import { Field, Amount, Modal, cents, text } from "../planning/ui";
import type { Money } from "../planning/ui";
import { rpc, save } from "../planning/queries";
import { today, displayDate } from "../../utils/finance";
import { investmentValue } from "./calculations";
type Action = {
  kind: "edit" | "contribution" | "withdrawal" | "adjustment";
  investment?: Investment;
};
export function Investments({
  data,
  plan,
  money,
  hidden,
  onSaved,
}: {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  onSaved: () => Promise<void>;
}) {
  const [action, setAction] = useState<Action | null>(null);
  return (
    <>
      <div className="section-heading">
        <h3>Investimentos</h3>
        <button onClick={() => setAction({ kind: "edit" })}>
          Adicionar investimento
        </button>
      </div>
      {!(plan.investments ?? []).length && (
        <p className="empty">
          Cadastre um investimento para acompanhar aportes e reserva.
        </p>
      )}
      {(plan.investments ?? []).map((i) => {
        const v = investmentValue(i, plan.investment_movements ?? [], today());
        return (
          <article className="panel" key={i.id}>
            <div className="section-heading">
              <h3>
                {i.name}
                {!i.active ? " · Arquivado" : ""}
              </h3>
              <button
                onClick={() => setAction({ kind: "edit", investment: i })}
              >
                Editar
              </button>
            </div>
            <p>
              {i.institution || "Instituição não informada"}
              {i.is_emergency_reserve ? " · Reserva de emergência" : ""}
            </p>
            <div>
              <strong>{money(v.current)}</strong>
            </div>
            <small>
              {i.yield_type === "manual"
                ? "Valor registrado"
                : "Valor atual ESTIMADO"}{" "}
              · atualização {displayDate(v.lastUpdate)}
            </small>
            <dl className="finance-details">
              <div>
                <dt>Total aportado</dt>
                <dd>{money(v.contributed)}</dd>
              </div>
              <div>
                <dt>Rendimento estimado</dt>
                <dd>{money(v.estimatedYield)}</dd>
              </div>
              <div>
                <dt>Rentabilidade estimada</dt>
                <dd>
                  {hidden
                    ? "••••"
                    : v.profitability === null
                      ? "—"
                      : v.profitability.toFixed(2).replace(".", ",") + "%"}
                </dd>
              </div>
            </dl>
            <div className="actions">
              <button
                disabled={!i.active}
                onClick={() =>
                  setAction({ kind: "contribution", investment: i })
                }
              >
                Aportar
              </button>
              <button
                disabled={!i.active || v.current <= 0}
                onClick={() => setAction({ kind: "withdrawal", investment: i })}
              >
                Resgatar
              </button>
            </div>
            <details>
              <summary>Valor real e histórico</summary>
              <button
                disabled={!i.active}
                onClick={() => setAction({ kind: "adjustment", investment: i })}
              >
                Sincronizar valor atual
              </button>
              <p className="muted">
                A sincronização registra a diferença informada. Taxas fixas usam
                dias corridos (ano de 365 dias; mês de 30 dias), sem índices ao
                vivo.
              </p>
              {i.source_account_id && (
                <p className="muted">
                  Importado de conta antiga; histórico e origem preservados.
                </p>
              )}
              {(plan.investment_movements ?? [])
                .filter((m) => m.investment_id === i.id)
                .sort((a, b) => b.date.localeCompare(a.date))
                .map((m) => (
                  <div className="account-line" key={m.id}>
                    <div>
                      <strong>
                        {
                          {
                            contribution: "Aporte",
                            withdrawal: "Resgate",
                            adjustment: "Ajuste",
                          }[m.type]
                        }
                      </strong>
                      <small>
                        {displayDate(m.date)} · {m.description}
                      </small>
                    </div>
                    <span>{money(m.amount_cents)}</span>
                  </div>
                ))}
            </details>
          </article>
        );
      })}
      {action && (
        <InvestmentEditor
          key={action.kind + action.investment?.id}
          action={action}
          data={data}
          plan={plan}
          hidden={hidden}
          onClose={() => setAction(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
function InvestmentEditor({
  action,
  data,
  plan,
  hidden,
  onClose,
  onSaved,
}: {
  action: Action;
  data: FinanceData;
  plan: PlanningData;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const id = useRef(crypto.randomUUID()),
    i = action.investment;
  const title =
    action.kind === "edit"
      ? i
        ? "Editar investimento"
        : "Adicionar investimento"
      : {
          contribution: "Aportar",
          withdrawal: "Resgatar",
          adjustment: "Sincronizar valor atual",
        }[action.kind];
  return (
    <Modal
      title={title}
      onClose={onClose}
      onSubmit={async (f) => {
        if (action.kind === "edit")
          await save(
            "investments",
            i?.id ?? id.current,
            {
              name: text(f, "name"),
              institution: text(f, "institution"),
              type: text(f, "type"),
              is_emergency_reserve: f.get("reserve") === "on",
              active: f.get("active") === "on",
              ...(!i
                ? {
                    initial_date: text(f, "date"),
                    yield_type: text(f, "yield"),
                    yield_rate: Number(text(f, "rate").replace(",", ".")),
                  }
                : {}),
            },
            !!i,
          );
        else
          await rpc("record_investment_movement", {
            p_id: id.current,
            p_investment: i!.id,
            p_type: action.kind,
            p_amount: cents(f),
            p_date: text(f, "date"),
            p_account: action.kind === "adjustment" ? null : text(f, "account"),
            p_description: text(f, "description"),
          });
        await onSaved();
      }}
    >
      {action.kind === "edit" ? (
        <>
          <Field label="Nome">
            <input name="name" required maxLength={80} defaultValue={i?.name} />
          </Field>
          <Field label="Instituição">
            <input
              name="institution"
              maxLength={120}
              defaultValue={i?.institution}
            />
          </Field>
          <Field label="Tipo">
            <input
              name="type"
              required
              maxLength={80}
              defaultValue={i?.type ?? "Renda fixa"}
            />
          </Field>
          {!i && (
            <>
              <Field label="Data inicial">
                <input
                  name="date"
                  type="date"
                  required
                  max={today()}
                  defaultValue={today()}
                />
              </Field>
              <Field label="Rendimento">
                <select name="yield" defaultValue="manual">
                  <option value="manual">Manual</option>
                  <option value="fixed_annual">Taxa fixa anual</option>
                  <option value="fixed_monthly">Taxa fixa mensal</option>
                </select>
              </Field>
              <Field label="Taxa fixa (%)">
                <input
                  name="rate"
                  inputMode="decimal"
                  required
                  pattern="[0-9]+([.,][0-9]+)?"
                  defaultValue="0"
                />
              </Field>
              <p className="muted">
                Depois de cadastrar, registre o aporte ou sincronize um saldo já
                existente.
              </p>
            </>
          )}
          {i && (
            <p className="muted">
              Regime e taxa preservados para não recalcular o passado. Use
              sincronização para atualizar o valor real.
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              name="reserve"
              defaultChecked={i?.is_emergency_reserve}
            />
            Reserva de emergência
          </label>
          <label className="check">
            <input
              type="checkbox"
              name="active"
              defaultChecked={i?.active ?? true}
            />
            Ativo
          </label>
        </>
      ) : (
        <>
          <p>{i!.name}</p>
          <Amount
            hidden={hidden}
            label={
              action.kind === "adjustment"
                ? "Valor real no banco (R$)"
                : "Valor (R$)"
            }
            value={
              action.kind === "adjustment"
                ? investmentValue(i!, plan.investment_movements ?? [], today())
                    .current
                : undefined
            }
          />
          <Field label="Data">
            <input
              name="date"
              type="date"
              required
              min={i!.initial_date}
              max={today()}
              defaultValue={today()}
            />
          </Field>
          {action.kind !== "adjustment" && (
            <Field
              label={
                action.kind === "contribution"
                  ? "Conta de origem"
                  : "Conta de destino"
              }
            >
              <select name="account" required defaultValue="">
                <option value="">Selecione</option>
                {data.accounts
                  .filter(
                    (a) =>
                      a.is_active &&
                      !a.investment_id &&
                      ["checking", "wallet", "other"].includes(a.type),
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="Descrição">
            <input
              name="description"
              maxLength={240}
              required={action.kind === "adjustment"}
              placeholder={
                action.kind === "adjustment"
                  ? "Motivo ou referência do valor informado"
                  : ""
              }
            />
          </Field>
          <p className="muted">
            {action.kind === "adjustment"
              ? "Será registrado um ajuste rastreável, sem movimentar sua conta."
              : "Conta e investimento serão atualizados juntos, sem criar receita ou despesa."}
          </p>
        </>
      )}
    </Modal>
  );
}
