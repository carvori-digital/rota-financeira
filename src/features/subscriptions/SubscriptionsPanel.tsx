import { useState } from "react";
import type { FinanceData } from "../../types";
import type { PlanningData } from "../planning/types";
import type { CardSubscription, SubscriptionCharge } from "./types";
import type { Money } from "../planning/ui";
import { Amount, Field, Modal, cents, text } from "../planning/ui";
import { rpc } from "../planning/queries";
import { addMonths } from "../planning/dates";
import { displayDate, today } from "../../utils/finance";
import { subscriptionCharge, subscriptionVersion } from "./calculations";

type Editor =
  | { kind: "subscription"; subscription?: CardSubscription }
  | { kind: "charge"; charge: SubscriptionCharge };
export function SubscriptionsPanel({
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [month, setMonth] = useState(today().slice(0, 7));
  return (
    <>
      <div className="section-heading">
        <h2>Assinaturas no cartão</h2>
        <button onClick={() => setEditor({ kind: "subscription" })}>
          Adicionar assinatura
        </button>
      </div>
      <p className="muted">
        Cadastre uma vez. As cobranças mensais são previstas até você confirmar
        ou vincular uma compra.
      </p>
      <Field label="Mês de cobrança">
        <input
          type="month"
          required
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </Field>
      {!plan.card_subscriptions?.length && (
        <p className="empty">Você ainda não cadastrou assinaturas.</p>
      )}
      {(plan.card_subscriptions ?? []).map((s) => {
        const latest = subscriptionVersion(plan, s.id);
        const current = subscriptionVersion(plan, s.id, month);
        const charge = subscriptionCharge(plan, s.id, month);
        if (!latest) return null;
        const manual =
          charge &&
          plan.card_invoices.some(
            (b) =>
              b.card_id === charge.card_id &&
              b.due_month === charge.due_date.slice(0, 7),
          );
        return (
          <article className="panel" key={s.id}>
            <div className="section-heading">
              <h3>{current?.name ?? latest.name}</h3>
              <button
                onClick={() =>
                  setEditor({ kind: "subscription", subscription: s })
                }
                disabled={latest.status === "cancelled"}
              >
                Alterar próximas cobranças
              </button>
            </div>
            <p>
              Mensal · dia {s.billing_day} ·{" "}
              {current?.status === "paused"
                ? "Pausada"
                : current?.status === "cancelled"
                  ? "Cancelada"
                  : "Ativa"}
            </p>
            {latest.effective_month.slice(0, 7) > month && (
              <small>
                Alteração programada para{" "}
                {latest.effective_month
                  .slice(0, 7)
                  .split("-")
                  .reverse()
                  .join("/")}
                .
              </small>
            )}
            {charge ? (
              <>
                <div className="account-line">
                  <div>
                    <strong>{money(charge.amount_cents)}</strong>
                    <small>
                      {displayDate(charge.charge_date)} ·{" "}
                      {
                        plan.credit_cards.find((c) => c.id === charge.card_id)
                          ?.name
                      }{" "}
                      · fatura{" "}
                      {charge.due_date
                        .slice(0, 7)
                        .split("-")
                        .reverse()
                        .join("/")}
                    </small>
                  </div>
                  <span className="status">
                    {charge.status === "confirmed"
                      ? "Confirmada"
                      : charge.status === "skipped"
                        ? "Dispensada"
                        : manual
                          ? "A conferir na fatura informada"
                          : "Prevista"}
                  </span>
                </div>
                {charge.status === "planned" && (
                  <button onClick={() => setEditor({ kind: "charge", charge })}>
                    Conferir cobrança
                  </button>
                )}
              </>
            ) : (
              <p className="muted">Sem cobrança prevista neste mês.</p>
            )}
            <details>
              <summary>Histórico e condições</summary>
              <p>
                Início {displayDate(s.start_date)} · frequência mensal.
                Alterações da regra valem pelo mês de cobrança, antes da
                alocação à fatura.
              </p>
              {(plan.card_subscription_occurrences ?? [])
                .filter((o) => o.subscription_id === s.id)
                .sort((a, b) => b.charge_month.localeCompare(a.charge_month))
                .map((o) => (
                  <div className="account-line" key={o.id}>
                    <span>
                      {displayDate(o.charge_date)} ·{" "}
                      {o.status === "confirmed"
                        ? "Confirmada"
                        : o.status === "skipped"
                          ? "Dispensada"
                          : "Previsão ajustada"}
                      <small>
                        {o.purchase_id
                          ? `Compra vinculada · ${o.purchase_id}`
                          : "Sem compra confirmada"}
                      </small>
                    </span>
                    <strong>{money(o.amount_cents)}</strong>
                  </div>
                ))}
              {(plan.card_subscription_versions ?? [])
                .filter((v) => v.subscription_id === s.id)
                .sort((a, b) => b.revision - a.revision)
                .map((v) => (
                  <div className="account-line" key={v.id}>
                    <span>
                      A partir de{" "}
                      {v.effective_month
                        .slice(0, 7)
                        .split("-")
                        .reverse()
                        .join("/")}{" "}
                      ·{" "}
                      {v.status === "active"
                        ? "Ativa"
                        : v.status === "paused"
                          ? "Pausada"
                          : "Cancelada"}
                      <small>
                        {
                          plan.credit_cards.find((c) => c.id === v.card_id)
                            ?.name
                        }
                        {v.end_date ? ` · até ${displayDate(v.end_date)}` : ""}
                      </small>
                    </span>
                    <strong>{money(v.amount_cents)}</strong>
                  </div>
                ))}
            </details>
          </article>
        );
      })}
      {editor && (
        <SubscriptionEditor
          key={
            editor.kind +
            (editor.kind === "subscription"
              ? (editor.subscription?.id ?? "new")
              : editor.charge.subscription_id + editor.charge.charge_month)
          }
          editor={editor}
          data={data}
          plan={plan}
          hidden={hidden}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
function SubscriptionEditor({
  editor,
  data,
  plan,
  hidden,
  onClose,
  onSaved,
}: {
  editor: Editor;
  data: FinanceData;
  plan: PlanningData;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [request] = useState(() => crypto.randomUUID());
  const [newId] = useState(() => crypto.randomUUID());
  const [action, setAction] = useState("adjust");
  const s = editor.kind === "subscription" ? editor.subscription : undefined;
  const v = s && subscriptionVersion(plan, s.id);
  const charge = editor.kind === "charge" ? editor.charge : undefined;
  const baseline =
    charge &&
    plan.card_invoices.find(
      (b) =>
        b.card_id === charge.card_id &&
        b.due_month === charge.due_date.slice(0, 7),
    );
  const candidates = charge
    ? plan.card_purchases.filter(
        (p) =>
          !p.cancelled_at &&
          p.installments === 1 &&
          p.card_id === charge.card_id &&
          p.first_due_date.slice(0, 7) === charge.due_date.slice(0, 7) &&
          p.purchase_date <= today() &&
          !plan.card_subscription_occurrences?.some(
            (o) => o.purchase_id === p.id,
          ),
      )
    : [];
  return (
    <Modal
      title={
        charge
          ? "Conferir cobrança da assinatura"
          : s
            ? "Alterar próximas cobranças"
            : "Adicionar assinatura no cartão"
      }
      onClose={onClose}
      onSubmit={async (f) => {
        if (charge) {
          await rpc("resolve_card_subscription", {
            p_request: request,
            p_subscription: charge.subscription_id,
            p_month: charge.charge_month,
            p_action: action,
            p_amount: action === "link" || action === "skip" ? null : cents(f),
            p_purchase: action === "link" ? text(f, "purchase") : null,
            p_coverage:
              action === "confirm" && baseline ? text(f, "coverage") : null,
          });
        } else {
          await rpc("save_card_subscription", {
            p_request: request,
            p_subscription: s?.id ?? newId,
            p_expected: v?.id ?? null,
            p_payload: {
              name: text(f, "name"),
              card_id: text(f, "card"),
              category_id: text(f, "category"),
              amount_cents: cents(f),
              start_date: s?.start_date ?? text(f, "start"),
              billing_day: s?.billing_day ?? Number(text(f, "day")),
              effective_month: s ? `${text(f, "effective")}-01` : null,
              end_date: text(f, "end") || null,
              status: text(f, "status"),
            },
          });
        }
        await onSaved();
      }}
    >
      {charge ? (
        <>
          <p>
            {charge.name} · {displayDate(charge.charge_date)} · fatura{" "}
            {charge.due_date.slice(0, 7).split("-").reverse().join("/")}
          </p>
          <Field label="Ação">
            <select
              name="action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="adjust">Ajustar previsão desta cobrança</option>
              <option value="confirm" disabled={charge.charge_date > today()}>
                Confirmar cobrança no cartão
              </option>
              <option value="link" disabled={charge.charge_date > today()}>
                Vincular compra já registrada
              </option>
              <option value="skip">Dispensar esta cobrança</option>
            </select>
          </Field>
          {(action === "adjust" || action === "confirm") && (
            <Amount
              label={
                action === "confirm"
                  ? "Valor confirmado (R$)"
                  : "Valor previsto (R$)"
              }
              hidden={hidden}
              value={charge.amount_cents}
            />
          )}
          {action === "link" && (
            <Field label="Compra existente">
              <select required name="purchase" defaultValue="">
                <option value="">Selecione explicitamente</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {displayDate(p.purchase_date)} · {p.description || "Compra"}{" "}
                    · {hidden ? "••••" : (p.amount_cents / 100).toFixed(2)} ·{" "}
                    {p.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {action === "confirm" && baseline && (
            <Field label="Esta cobrança está na fatura informada?">
              <select name="coverage" required defaultValue="">
                <option value="">Selecione</option>
                <option value="included">Já incluída no total informado</option>
                <option value="additional">
                  É adicional ao total informado
                </option>
              </select>
            </Field>
          )}
          <p className="muted">
            {action === "confirm"
              ? "Confirme somente após conferir a cobrança no cartão. Será registrada uma compra avulsa; o saldo bancário muda apenas no pagamento da fatura."
              : action === "link"
                ? "O vínculo preserva a compra, seu ID, valor e a composição atual da fatura. Nenhuma correspondência por descrição é automática."
                : "Esta ação afeta somente a previsão escolhida. Compras confirmadas permanecem no histórico."}
          </p>
        </>
      ) : (
        <>
          <Field label="Nome">
            <input name="name" required maxLength={80} defaultValue={v?.name} />
          </Field>
          <Field label="Cartão">
            <select name="card" required defaultValue={v?.card_id ?? ""}>
              <option value="">Selecione</option>
              {plan.credit_cards
                .filter((c) => c.active || c.id === v?.card_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {!c.active ? " · arquivado" : ""}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Categoria">
            <select
              name="category"
              required
              defaultValue={v?.category_id ?? ""}
            >
              <option value="">Selecione</option>
              {data.categories
                .filter((c) => c.type === "expense")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Amount
            label="Valor previsto (R$)"
            hidden={hidden}
            value={v?.amount_cents}
          />
          {!s && (
            <>
              <Field label="Dia habitual da cobrança">
                <input name="day" required type="number" min={1} max={31} />
              </Field>
              <Field label="Data inicial">
                <input name="start" required type="date" />
              </Field>
            </>
          )}
          {s && (
            <Field label="Aplicar a partir do mês de cobrança">
              <input
                name="effective"
                required
                type="month"
                min={[
                  addMonths(`${today().slice(0, 7)}-01`, 1).slice(0, 7),
                  v!.effective_month.slice(0, 7),
                ]
                  .sort()
                  .at(-1)}
              />
            </Field>
          )}
          <Field label="Status">
            <select name="status" defaultValue={v?.status ?? "active"}>
              <option value="active">Ativo</option>
              <option value="paused">Pausado</option>
              <option value="cancelled">Cancelado</option>
            </select>
          </Field>
          <Field label="Data final (opcional)">
            <input
              name="end"
              type="date"
              min={s?.start_date}
              defaultValue={v?.end_date ?? ""}
            />
          </Field>
          <p className="muted">
            Frequência mensal. Dias 29, 30 e 31 se ajustam ao último dia dos
            meses curtos. Mudanças futuras preservam cobranças e compras
            anteriores. Uma assinatura cancelada mantém seu histórico.
          </p>
        </>
      )}
    </Modal>
  );
}
