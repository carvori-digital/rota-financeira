import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { FinanceData, Transaction } from "../../types";
import type { PlanningData, Commitment } from "./types";
import type { CreditCard, InvoiceSummary } from "../cards/types";
import type { Debt } from "../debts/types";
import type { RecurringItem } from "../recurring/types";
import { Field, Amount, Modal, Status, cents, text } from "./ui";
import type { Money } from "./ui";
import { rpc, save } from "./queries";
import { CardsPanel } from "../cards/components";
import { DebtsPanel } from "../debts/components";
import { RecurringPanel } from "../recurring/components";
import { firstInvoiceDate, invoices } from "../cards/calculations";
import { monthDay } from "./dates";
import { balance, isReserveAccount, today } from "../../utils/finance";
import { projection } from "./calculations";
import { experienceReport } from "../experience/calculations";
import { MonthReport } from "./MonthReport";
import { ProjectionList } from "./ProjectionList";
export type PlanningAction = {
  kind:
    | "installment"
    | "occurrence"
    | "card"
    | "purchase"
    | "invoice"
    | "cardPayment"
    | "debt"
    | "debtPayment"
    | "recurring"
    | "reserve";
  due?: string;
  initialType?: "income" | "expense";
  card?: CreditCard;
  invoice?: InvoiceSummary;
  debt?: Debt;
  rule?: RecurringItem;
};
interface Props {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  visible: boolean;
  section: string;
  onSection: (section: string) => void;
  goalsContent: ReactNode;
  action: PlanningAction | null;
  setAction: (a: PlanningAction | null) => void;
  onSaved: () => Promise<void>;
  onResolve: (c: Commitment) => void;
  onSchedule: (t?: Transaction) => void;
}
export function PlanningWorkspace(props: Props) {
  const {
    data,
    plan,
    money,
    hidden,
    visible,
    section,
    onSection: setSection,
    goalsContent,
    action,
    setAction,
    onSaved,
    onResolve,
    onSchedule,
  } = props;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Não foi possível concluir.",
      );
    } finally {
      setBusy(false);
    }
  }
  const overview = experienceReport(data, plan, today());
  const { reserveGoal, cost, selected, protectedMonths } = overview;
  const months = overview.targetMonths,
    actual = overview.reserve;
  const reserveAccounts = data.accounts.filter(isReserveAccount);
  const legacy = data.transactions.filter(
    (t) =>
      t.is_recurring &&
      t.type !== "transfer" &&
      t.type !== "card_payment" &&
      !t.payment_reference &&
      !plan.recurring_occurrences.some((o) => o.transaction_id === t.id),
  );
  return (
    <>
      {visible && (
        <section className="planning-workspace">
          <h1>Planejar</h1>
          <div
            className="planning-tabs"
            role="tablist"
            aria-label="Planejamento"
          >
            {[
              ["month", "Visão do mês"],

              ["cards", "Cartões"],
              ["debts", "Dívidas e parcelas"],
              ["recurring", "Recorrentes"],
              ["scheduled", "Programadas"],
              ["reserve", "Reserva e investimentos"],
              ["goals", "Metas"],
            ].map(([key, label]) => (
              <button
                role="tab"
                id={`tab-${key}`}
                aria-controls={`panel-${key}`}
                aria-selected={section === key}
                key={key}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {error && <p role="alert">{error}</p>}
          <div
            role="tabpanel"
            id={`panel-${section}`}
            aria-labelledby={`tab-${section}`}
            className="page-content"
            key={section}
            aria-busy={busy}
          >
            {section === "month" && (
              <>
                <MonthReport
                  data={data}
                  plan={plan}
                  money={money}
                  onResolve={onResolve}
                />
              </>
            )}
            {section === "scheduled" && (
              <>
                <div className="section-heading">
                  <h2>Programadas</h2>
                  <button onClick={() => onSchedule()}>
                    Agendar receita/despesa
                  </button>
                </div>
                {data.transactions
                  .filter((t) => t.status === "pending")
                  .map((t) => (
                    <article className="panel" key={t.id}>
                      <strong>
                        {t.description || "Lançamento programado"} ·{" "}
                        {money(t.amount_cents)}
                      </strong>
                      <p>
                        {t.transaction_date.split("-").reverse().join("/")} ·{" "}
                        <Status
                          state={
                            t.transaction_date <= today()
                              ? "pending"
                              : "forecast"
                          }
                        />
                      </p>
                      <div className="actions">
                        <button
                          onClick={() =>
                            onResolve({
                              id: t.id,
                              entity: t.id,
                              source: "transaction",
                              name: t.description,
                              due: t.transaction_date,
                              amount: t.amount_cents,
                              impact: 0,
                              direction:
                                t.type === "income"
                                  ? "income"
                                  : t.type === "transfer"
                                    ? "transfer"
                                    : "expense",
                            })
                          }
                        >
                          Confirmar / cancelar
                        </button>
                        {!t.is_recurring &&
                          (t.type === "income" || t.type === "expense") && (
                            <button onClick={() => onSchedule(t)}>
                              Editar programada
                            </button>
                          )}
                      </div>
                    </article>
                  ))}
              </>
            )}
            {section === "goals" && goalsContent}
            {section === "month" && (
              <details className="panel">
                <summary>Próximos meses</summary>
                <>
                  <p className="muted">
                    PREVISTO · quatro meses a partir do saldo disponível
                    realizado. Vencidos ainda pendentes ficam no mês atual.
                    Valores em contas de investimento/reserva aparecem nos
                    compromissos, mas não alteram o disponível.
                  </p>
                  <ProjectionList
                    months={projection(data, plan, today())}
                    money={money}
                  />
                  {projection(data, plan, today()).map((m) => (
                    <details key={m.month}>
                      <summary>
                        Compromissos · {m.month.split("-").reverse().join("/")}
                      </summary>
                      {m.items.map((c) => (
                        <div className="account-line" key={c.id}>
                          <div>
                            <strong>{c.name}</strong>
                            <small>
                              {c.due.split("-").reverse().join("/")} ·{" "}
                              {c.direction === "income" ? "Entrada" : "Saída"}{" "}
                              <Status
                                state={
                                  c.due <= today() ? "pending" : "forecast"
                                }
                              />
                            </small>
                          </div>
                          <strong>{money(c.amount)}</strong>
                        </div>
                      ))}
                    </details>
                  ))}
                </>
              </details>
            )}
            {section === "cards" && (
              <CardsPanel
                plan={plan}
                money={money}
                onEdit={(card) => setAction({ kind: "card", card })}
                onPurchase={(card) => setAction({ kind: "purchase", card })}
                onInvoice={(card) => setAction({ kind: "invoice", card })}
                onPay={(card, invoice) =>
                  setAction({ kind: "cardPayment", card, invoice })
                }
                onToggle={(c) =>
                  void run(() =>
                    save("credit_cards", c.id, { active: !c.active }, true),
                  )
                }
              />
            )}
            {section === "debts" && (
              <DebtsPanel
                plan={plan}
                money={money}
                hidden={hidden}
                onInstallment={() => setAction({ kind: "installment" })}
                onEdit={(debt) => setAction({ kind: "debt", debt })}
                onPay={(debt) => setAction({ kind: "debtPayment", debt })}
                onToggle={(d) =>
                  void run(() =>
                    save("debts", d.id, { active: !d.active }, true),
                  )
                }
              />
            )}
            {section === "recurring" && (
              <>
                <RecurringPanel
                  plan={plan}
                  transactions={data.transactions}
                  money={money}
                  onEdit={(rule) => setAction({ kind: "recurring", rule })}
                  onToggle={(r) =>
                    void run(() =>
                      save(
                        "recurring_items",
                        r.id,
                        { active: !r.active },
                        true,
                      ),
                    )
                  }
                  onResolve={(r, date, skip) =>
                    void run(() =>
                      rpc("resolve_recurring", {
                        p_id: crypto.randomUUID(),
                        p_rule: r.id,
                        p_due: date,
                        p_skip: skip,
                      }),
                    )
                  }
                />
                {!!legacy.length && (
                  <article className="panel">
                    <h3>Marcações da versão anterior</h3>
                    <p>
                      A marcação antiga não criava previsões. Transforme cada
                      lançamento em regra quando desejar.
                    </p>
                    {legacy.map((t) => (
                      <div className="account-line" key={t.id}>
                        <div>
                          <strong>
                            {t.description || "Lançamento recorrente"}
                          </strong>
                          <small>{money(t.amount_cents)}</small>
                        </div>
                        <button
                          onClick={() =>
                            void run(() =>
                              rpc("repeat_transaction", {
                                p_id: t.id,
                                p_rule: crypto.randomUUID(),
                                p_existing: true,
                                p_payload: {
                                  recurrence_frequency:
                                    t.recurrence_frequency ?? "monthly",
                                },
                              }),
                            )
                          }
                        >
                          Criar regra
                        </button>
                      </div>
                    ))}
                  </article>
                )}
              </>
            )}
            {section === "reserve" && (
              <>
                <div className="section-heading">
                  <h2>Investimentos e Reserva</h2>
                  <button onClick={() => setAction({ kind: "reserve" })}>
                    Ajustar reserva
                  </button>
                </div>
                <article className="panel">
                  <h3>Reserva de emergência</h3>
                  <div className="reserve-protection">
                    <strong>
                      {hidden
                        ? "••••"
                        : protectedMonths === null
                          ? "Configure o custo mensal"
                          : protectedMonths.toFixed(1).replace(".", ",") +
                            " de " +
                            months +
                            " meses protegidos"}
                    </strong>
                    {!hidden && protectedMonths !== null && (
                      <progress
                        max={months}
                        value={Math.min(months, protectedMonths)}
                        aria-label="Proteção da reserva"
                      />
                    )}
                    {!hidden &&
                      protectedMonths !== null &&
                      protectedMonths >= months && (
                        <p className="milestone">
                          Reserva de emergência protegida.
                        </p>
                      )}
                  </div>
                  <details>
                    <summary>Composição da reserva</summary>
                    <dl className="finance-details">
                      <div>
                        <dt>
                          Custo essencial mensal{" "}
                          {reserveGoal?.essential_monthly_cents == null
                            ? "(sugerido)"
                            : "(manual)"}
                        </dt>
                        <dd>{money(cost)}</dd>
                      </div>
                      <div>
                        <dt>Meses de proteção desejados</dt>
                        <dd>{months}</dd>
                      </div>
                      <div>
                        <dt>Reserva recomendada</dt>
                        <dd>{money(cost * months)}</dd>
                      </div>
                      <div>
                        <dt>Reserva atual</dt>
                        <dd>{money(actual)}</dd>
                      </div>
                      <div>
                        <dt>Quanto falta</dt>
                        <dd>{money(Math.max(0, cost * months - actual))}</dd>
                      </div>
                    </dl>
                  </details>
                  <small>
                    A reserva atual usa somente as contas selecionadas. Por
                    padrão, poupanças. Transferências ou retiradas nessas contas
                    atualizam a proteção; metas não movimentam dinheiro.
                  </small>
                </article>
                <h3>Onde está reservado/investido</h3>
                {reserveAccounts.length ? (
                  reserveAccounts.map((a) => (
                    <div className="account-line" key={a.id}>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {a.type === "savings" ? "Poupança" : "Investimento"}
                          {selected.includes(a.id)
                            ? " · reserva de emergência"
                            : ""}
                          {!a.is_active ? " · Arquivada" : ""}
                        </small>
                      </div>
                      <strong>{money(balance(a, data.transactions))}</strong>
                    </div>
                  ))
                ) : (
                  <p className="empty">
                    Crie uma conta de poupança ou investimento em Ajustes.
                  </p>
                )}
                <div className="account-line">
                  <strong>Total em investimentos e reserva</strong>
                  <strong>
                    {money(
                      reserveAccounts.reduce(
                        (s, a) => s + balance(a, data.transactions),
                        0,
                      ),
                    )}
                  </strong>
                </div>
              </>
            )}
          </div>
        </section>
      )}
      {action && (
        <PlanningEditor
          key={`${action.kind}:${action.card?.id ?? action.debt?.id ?? action.rule?.id ?? "new"}:${action.invoice?.month ?? ""}`}
          {...props}
          action={action}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}
function PlanningEditor({
  data,
  plan,
  hidden,
  action,
  onSaved,
  onClose,
  setAction,
}: Props & { action: PlanningAction; onClose: () => void }) {
  const request = useRef(crypto.randomUUID()),
    [kind, setKind] = useState<"income" | "expense">(
      action.rule?.type ?? action.initialType ?? "expense",
    );
  const [cardId, setCardId] = useState(
    action.card?.id ?? plan.credit_cards.find((c) => c.active)?.id ?? "",
  );
  const [debtId, setDebtId] = useState(
    action.debt?.id ??
      plan.debts.find((d) => d.remaining_amount_cents > 0)?.id ??
      "",
  );
  const accounts = data.accounts.filter((a) => a.is_active),
    card = plan.credit_cards.find((c) => c.id === cardId),
    debt = plan.debts.find((d) => d.id === debtId),
    rule = action.rule;
  const debtHasPayments =
    !!action.debt &&
    plan.debt_payments.some((p) => p.debt_id === action.debt?.id);
  const reserveGoal = data.goals.find((g) => g.is_emergency_reserve),
    reserveAccounts = data.accounts.filter(isReserveAccount);
  const currentInvoice = invoices(
    plan.credit_cards,
    plan.card_purchases,
    plan.card_invoices,
    plan.card_payments,
  ).find((i) => i.card_id === cardId && i.month === today().slice(0, 7));
  const title = {
    installment: "Cadastrar parcelamento existente",
    occurrence: "Realizar ou pular ocorrência",
    card: action.card ? "Editar cartão" : "Adicionar cartão",
    purchase: "Compra no cartão",
    invoice: "Informar fatura atual",
    cardPayment: "Pagar fatura",
    debt: action.debt ? "Editar dívida" : "Adicionar dívida",
    debtPayment: "Registrar pagamento de dívida",
    recurring: rule ? "Editar regra" : "Adicionar recorrente",
    reserve: "Ajustar reserva de emergência",
  }[action.kind];
  function accountSelect(name = "account", value?: string | null) {
    return (
      <Field label={name === "account" ? "Conta de pagamento" : "Conta"}>
        <select
          name={name}
          key={value ?? "default"}
          required
          defaultValue={
            value ??
            accounts.find((a) => !isReserveAccount(a))?.id ??
            accounts[0]?.id ??
            ""
          }
        >
          <option value="" disabled>
            Selecione uma conta
          </option>
          {accounts.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  function date(name = "date", value = today(), label = "Data", max?: string) {
    return (
      <Field label={label}>
        <input
          name={name}
          type="date"
          required
          defaultValue={value}
          max={max}
        />
      </Field>
    );
  }
  function category() {
    return (
      <Field label="Categoria">
        <select
          name="category"
          key={kind}
          required
          defaultValue={rule?.type === kind ? rule.category_id : ""}
        >
          <option value="">Selecione</option>
          {data.categories
            .filter(
              (c) =>
                c.type === (action.kind === "recurring" ? kind : "expense"),
            )
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </Field>
    );
  }
  async function submit(f: FormData) {
    const amount = () => {
      const value = cents(f)!;
      if (value <= 0) throw new Error("Informe um valor maior que zero.");
      return value;
    };
    const id = request.current;
    switch (action.kind) {
      case "occurrence":
        await rpc("resolve_recurring", {
          p_id: id,
          p_rule: rule!.id,
          p_due: action.due,
          p_skip: text(f, "resolution") === "skip",
        });
        break;
      case "installment": {
        const monthly = amount(),
          current = Number(text(f, "current")),
          total = Number(text(f, "total"));
        if (current > total)
          throw new Error("Parcela atual deve ser menor ou igual ao total.");
        await save("debts", id, {
          name: text(f, "name"),
          original_amount_cents:
            monthly * (current - 1) +
            (cents(f, "remaining", true) ?? monthly * (total - current + 1)),
          remaining_amount_cents:
            cents(f, "remaining", true) ?? monthly * (total - current + 1),
          installment_amount_cents: monthly,
          installment_number: current,
          total_installments: total,
          next_due_date: text(f, "date"),
          payment_account_id: text(f, "account"),
        });
        break;
      }
      case "card":
        await save(
          "credit_cards",
          action.card?.id ?? id,
          {
            name: text(f, "name"),
            limit_cents: cents(f, "limit", true),
            closing_day: Number(text(f, "closing")),
            due_day: Number(text(f, "due")),
            payment_account_id: text(f, "account"),
          },
          !!action.card,
        );
        break;
      case "purchase":
        if (!card)
          throw new Error(
            "Adicione um cartão em Planejar antes de registrar a compra.",
          );
        await save("card_purchases", id, {
          card_id: cardId,
          category_id: text(f, "category"),
          amount_cents: amount(),
          description: text(f, "description"),
          purchase_date: text(f, "date"),
          installments: Number(text(f, "installments")),
          first_due_date: firstInvoiceDate(
            text(f, "date"),
            card!.closing_day,
            card!.due_day,
          ),
          due_anchor_day: card!.due_day,
        });
        break;
      case "invoice":
        await rpc("set_card_invoice", {
          p_id: id,
          p_card: cardId,
          p_amount: amount(),
          p_due: text(f, "date"),
          p_description: text(f, "description"),
        });
        break;
      case "cardPayment":
        await rpc("pay_card_invoice", {
          p_id: id,
          p_card: cardId,
          p_month: action.invoice!.month,
          p_account: text(f, "account"),
          p_amount: amount(),
          p_date: text(f, "date"),
        });
        break;
      case "debt": {
        const payload: Record<string, unknown> = {
          name: text(f, "name"),
          installment_amount_cents: cents(f, "installment", true),
          payment_account_id: text(f, "account") || null,
        };
        if (!action.debt)
          Object.assign(payload, {
            original_amount_cents: cents(f, "original"),
            remaining_amount_cents: cents(f, "remaining"),
            next_due_date: text(f, "date") || null,
          });
        else if (!debtHasPayments)
          payload.next_due_date = text(f, "date") || null;
        await save("debts", action.debt?.id ?? id, payload, !!action.debt);
        break;
      }
      case "debtPayment":
        await rpc("pay_debt", {
          p_id: id,
          p_debt: debtId,
          p_account: text(f, "account"),
          p_amount: amount(),
          p_date: text(f, "date"),
        });
        break;
      case "recurring":
        await save(
          "recurring_items",
          rule?.id ?? id,
          {
            name: text(f, "name"),
            type: kind,
            amount_cents: amount(),
            account_id: text(f, "source"),
            category_id: text(f, "category"),
            frequency: text(f, "frequency"),
            start_date: text(f, "date"),
            end_date: text(f, "end") || null,
            is_essential: kind === "expense" && f.get("essential") === "on",
          },
          !!rule,
        );
        break;
      case "reserve":
        await rpc("save_emergency_reserve", {
          p_id: reserveGoal?.id ?? id,
          p_cost: cents(f, "cost", true),
          p_months: Number(text(f, "months")),
          p_accounts: f.getAll("reserveAccounts"),
        });
        break;
    }
    await onSaved();
  }
  return (
    <Modal title={title} onClose={onClose} onSubmit={submit}>
      {action.kind === "purchase" &&
        !plan.credit_cards.some((c) => c.active) && (
          <p>
            Cadastre um cartão antes de registrar a compra.{" "}
            <button type="button" onClick={() => setAction({ kind: "card" })}>
              Adicionar cartão
            </button>
          </p>
        )}
      {action.kind === "debtPayment" &&
        !plan.debts.some((d) => d.remaining_amount_cents > 0) && (
          <p>
            Nenhuma dívida com saldo restante.{" "}
            <button type="button" onClick={() => setAction({ kind: "debt" })}>
              Adicionar dívida
            </button>
          </p>
        )}
      {action.kind === "occurrence" && (
        <>
          <p>
            {rule?.name} · {action.due?.split("-").reverse().join("/")}
          </p>
          <Field label="Ação">
            <select name="resolution">
              <option value="realize">Marcar como realizado hoje</option>
              <option value="skip">Pular ocorrência</option>
            </select>
          </Field>
        </>
      )}
      {action.kind === "installment" && (
        <>
          <button type="button" onClick={() => setAction({ kind: "debt" })}>
            Dívida sem parcelamento
          </button>
          <Field label="Nome">
            <input name="name" required maxLength={80} />
          </Field>
          <Amount label="Valor por parcela (R$)" hidden={hidden} />
          <div className="filters">
            <Field label="Parcela atual">
              <input
                name="current"
                type="number"
                min={1}
                max={600}
                required
                defaultValue={1}
              />
            </Field>
            <Field label="Total de parcelas">
              <input
                name="total"
                type="number"
                min={1}
                max={600}
                required
                defaultValue={12}
              />
            </Field>
          </div>
          <Amount
            name="remaining"
            label="Saldo restante conhecido (R$) · opcional"
            optional
            hidden={hidden}
          />
          {date("date", today(), "Próximo vencimento")}
          {accountSelect()}
          <p className="muted">
            As próximas parcelas são geradas automaticamente. A última fecha
            exatamente o saldo restante.
          </p>
        </>
      )}
      {(action.kind === "card" ||
        action.kind === "debt" ||
        action.kind === "recurring") && (
        <Field label="Nome">
          <input
            name="name"
            required
            maxLength={80}
            defaultValue={action.card?.name ?? action.debt?.name ?? rule?.name}
          />
        </Field>
      )}
      {action.kind === "card" && (
        <>
          <Amount
            label="Limite (R$) · opcional"
            name="limit"
            hidden={hidden}
            optional
            value={action.card?.limit_cents}
          />
          <div className="filters">
            <Field label="Dia do fechamento">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                name="closing"
                defaultValue={action.card?.closing_day ?? 20}
                required
              />
            </Field>
            <Field label="Dia do vencimento">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                name="due"
                defaultValue={action.card?.due_day ?? 28}
                required
              />
            </Field>
          </div>
          {accountSelect("account", action.card?.payment_account_id)}
        </>
      )}
      {["purchase", "invoice", "cardPayment"].includes(action.kind) && (
        <Field label="Cartão">
          <select
            value={cardId}
            required
            disabled={!!action.card}
            onChange={(e) => setCardId(e.target.value)}
          >
            <option value="">Selecione</option>
            {plan.credit_cards
              .filter((c) => c.active || c.id === cardId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
      )}
      {action.kind === "purchase" && (
        <>
          <Amount hidden={hidden} />
          {category()}
          <Field label="Descrição">
            <input name="description" maxLength={240} />
          </Field>
          {date()}
          <Field label="Número de parcelas">
            <input
              name="installments"
              type="number"
              inputMode="numeric"
              min={1}
              max={120}
              defaultValue={1}
              required
            />
          </Field>
          <p className="muted">
            Compras até o fechamento entram na fatura desse ciclo. Centavos são
            distribuídos sem arredondar o total.
          </p>
        </>
      )}
      {action.kind === "invoice" && (
        <>
          <Amount hidden={hidden} value={currentInvoice?.total} />
          {date(
            "date",
            currentInvoice?.due_date ??
              monthDay(today().slice(0, 7), card?.due_day ?? 28),
            "Vencimento",
          )}
          <Field label="Descrição · opcional">
            <input name="description" maxLength={240} />
          </Field>
          <p className="muted">
            Informe o total atual da fatura. Esse valor substitui compras já
            cadastradas nesse mês; compras registradas depois serão somadas.
            Parcelas de outros meses permanecem.
          </p>
        </>
      )}
      {action.kind === "cardPayment" && (
        <>
          {accountSelect("account", card?.payment_account_id)}
          <Amount hidden={hidden} value={action.invoice?.pending} />
          {date("date", today(), "Data do pagamento", today())}
          <p className="muted">
            Reduz conta e fatura pendente. Não conta novamente como despesa de
            consumo.
          </p>
        </>
      )}
      {action.kind === "debt" && (
        <>
          {!action.debt && (
            <>
              <Amount
                name="original"
                label="Dívida original (R$)"
                hidden={hidden}
              />
              <Amount
                name="remaining"
                label="Quanto falta pagar (R$)"
                hidden={hidden}
              />
            </>
          )}
          <Amount
            name="installment"
            label="Parcela mensal (R$) · opcional"
            hidden={hidden}
            optional
            value={action.debt?.installment_amount_cents}
          />
          {!debtHasPayments && (
            <Field label="Próximo vencimento · opcional">
              <input
                name="date"
                type="date"
                defaultValue={action.debt?.next_due_date ?? ""}
              />
            </Field>
          )}
          {accountSelect("account", action.debt?.payment_account_id)}
          {debtHasPayments && (
            <p className="muted">
              Saldo restante e próxima data são atualizados pelos pagamentos,
              preservando o histórico.
            </p>
          )}
        </>
      )}
      {action.kind === "debtPayment" && (
        <>
          <Field label="Dívida">
            <select
              value={debtId}
              required
              disabled={!!action.debt}
              onChange={(e) => setDebtId(e.target.value)}
            >
              <option value="">Selecione</option>
              {plan.debts
                .filter((d) => d.remaining_amount_cents > 0)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
          {accountSelect("account", debt?.payment_account_id)}
          <Amount
            key={debtId}
            hidden={hidden}
            value={
              debt
                ? Math.min(
                    debt.remaining_amount_cents,
                    (debt.installment_amount_cents ??
                      debt.remaining_amount_cents) -
                      debt.installment_paid_cents,
                  )
                : undefined
            }
          />
          {date("date", today(), "Data do pagamento", today())}
          <p className="muted">
            Pagamento parcial abate a parcela atual. O último pagamento fica
            limitado ao saldo restante.
          </p>
        </>
      )}
      {action.kind === "recurring" && (
        <>
          <Field label="Tipo">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "income" | "expense")}
            >
              <option value="income">Receita</option>
              <option value="expense">Despesa</option>
            </select>
          </Field>
          <Amount hidden={hidden} value={rule?.amount_cents} />
          {accountSelect("source", rule?.account_id)}
          {category()}
          <Field label="Frequência">
            <select
              name="frequency"
              defaultValue={rule?.frequency ?? "monthly"}
            >
              <option value="weekly">Semanal</option>
              <option value="monthly">Mensal</option>
              <option value="yearly">Anual</option>
            </select>
          </Field>
          {date("date", rule?.start_date ?? today(), "Primeira ocorrência")}
          <Field label="Última data · opcional">
            <input name="end" type="date" defaultValue={rule?.end_date ?? ""} />
          </Field>
          {kind === "expense" && (
            <label className="check">
              <input
                name="essential"
                type="checkbox"
                defaultChecked={rule?.is_essential}
              />
              Despesa essencial
            </label>
          )}
          <p className="muted">
            A regra gera previsões, sem movimentar contas. Ocorrências já
            realizadas ou puladas ficam preservadas.
          </p>
        </>
      )}
      {action.kind === "reserve" && (
        <>
          <Amount
            name="cost"
            label="Custo essencial mensal (R$) · deixe vazio para usar sugestão"
            hidden={hidden}
            optional
            value={reserveGoal?.essential_monthly_cents}
          />
          <Field label="Meses de proteção">
            <input
              name="months"
              type="number"
              inputMode="numeric"
              min={1}
              max={120}
              required
              defaultValue={reserveGoal?.reserve_months ?? 6}
            />
          </Field>
          <p>Selecione as contas que compõem a reserva de emergência:</p>
          {reserveAccounts.map((a) => (
            <label className="check" key={a.id}>
              <input
                type="checkbox"
                name="reserveAccounts"
                value={a.id}
                defaultChecked={
                  reserveGoal
                    ? plan.reserve_account_links.some(
                        (l) =>
                          l.goal_id === reserveGoal.id && l.account_id === a.id,
                      )
                    : a.type === "savings"
                }
              />
              {a.name}
            </label>
          ))}
          <p className="muted">
            Sugestão automática: despesas essenciais recorrentes, convertidas
            para custo mensal. Nada será transferido.
          </p>
        </>
      )}
    </Modal>
  );
}
