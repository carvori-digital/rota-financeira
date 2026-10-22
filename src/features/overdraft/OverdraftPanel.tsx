import { useRef, useState } from "react";
import type { Account, FinanceData } from "../../types";
import type { PlanningData } from "../planning/types";
import { Amount, Field, Modal, cents, text } from "../planning/ui";
import type { Money } from "../planning/ui";
import { rpc } from "../planning/queries";
import { balance, displayDate, today } from "../../utils/finance";
import {
  accountRecovery,
  overdraftCharges,
  overdraftHistory,
  overdraftPosition,
} from "./calculations";
export function OverdraftPanel({
  account,
  data,
  plan,
  money,
  hidden,
  onSaved,
}: {
  account: Account;
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  onSaved: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<"config" | "reconcile" | null>(null);
  const asOf = today(),
    p = overdraftPosition(account, data, plan, asOf);
  const charges = overdraftCharges(account, data, asOf);
  const recovery =
    p.bankBalance < 0 ? accountRecovery(account, data, plan, asOf) : null;
  const versions = (plan.account_overdraft_versions ?? [])
    .filter((v) => v.account_id === account.id)
    .sort((a, b) => b.revision - a.revision);
  return (
    <section
      className="overdraft-panel"
      aria-label={`Cheque especial · ${account.name}`}
    >
      <div className="section-heading">
        <h3>Cheque especial</h3>
        <button onClick={() => setEditor("config")}>
          {versions.length ? "Configurar limite" : "Habilitar cheque especial"}
        </button>
      </div>
      {versions.length > 0 && (
        <>
          <p>
            <strong>
              {p.terms?.active
                ? p.state
                : p.terms
                  ? `Inativo · ${p.state}`
                  : "Acompanhamento ainda não iniciado"}
            </strong>
            {p.terms && !p.terms.active && p.negative > 0
              ? " · saldo devedor preservado"
              : ""}
          </p>
          <dl className="finance-details">
            <div>
              <dt>Saldo bancário atual</dt>
              <dd>{money(p.bankBalance)}</dd>
            </div>
            <div>
              <dt>Limite contratado</dt>
              <dd>{p.terms ? money(p.terms.limit_cents) : "Sem vigência"}</dd>
            </div>
            <div>
              <dt>Cheque especial utilizado¹</dt>
              <dd>{p.used === null ? "A conciliar" : money(p.used)}</dd>
            </div>
            <div>
              <dt>Limite restante de crédito</dt>
              <dd>
                {p.remaining === null ? "A conciliar" : money(p.remaining)}
              </dd>
            </div>
          </dl>
          {p.percent !== null && (
            <div className="overdraft-meter">
              <progress
                aria-label="Utilização do limite"
                max={100}
                value={hidden ? 0 : Math.min(100, p.percent)}
              />
              <small>
                {hidden
                  ? "••••"
                  : `${Math.round(p.percent)}% do limite contratado`}
              </small>
            </div>
          )}
          <p className="muted">
            Crédito não é dinheiro próprio. ¹Uso derivado do saldo negativo;
            inclui encargos já debitados, sem nova soma ao passivo.
          </p>
          {p.used === null && (
            <p role="status">
              Confirme como o banco representa o crédito no extrato. Nenhum
              limite disponível será presumido até a conferência.
            </p>
          )}
          {recovery && (
            <details>
              <summary>Projeção da conta</summary>
              <p>
                Saldo ao final do horizonte previsto:{" "}
                {money(recovery.projected)}.
              </p>
              <p>
                {recovery.recoveryDate
                  ? `Primeiro saldo não negativo previsto em ${displayDate(recovery.recoveryDate)}.`
                  : "Sem dados suficientes para prever recuperação do saldo."}
              </p>
              <small>
                Somente fluxos vinculados a esta conta, no horizonte de quatro
                meses. Pendências vencidas são consideradas hoje. Previsão
                sujeita a novos gastos; não é recebimento ou garantia de
                quitação.
              </small>
            </details>
          )}
          <details>
            <summary>Histórico de utilização por data</summary>
            <small>
              Saldo ao fim de cada data com movimento ou alteração contratual.
              Antes do acompanhamento, o limite é desconhecido. Lançamentos
              retroativos recalculam a evolução.
            </small>
            <div className="overdraft-history">
              {overdraftHistory(account, data, plan, asOf).map((h) => (
                <div key={h.date}>
                  <strong>{displayDate(h.date)}</strong>
                  <span>Saldo {money(h.bankBalance)}</span>
                  <span>
                    {h.terms ? (
                      <>
                        {h.terms.active ? h.state : `Inativo · ${h.state}`} ·
                        limite {money(h.terms.limit_cents)}
                      </>
                    ) : (
                      "Limite sem evidência nesta data"
                    )}
                  </span>
                  <span>
                    Uso {h.used === null ? "a conciliar" : money(h.used)} ·
                    restante{" "}
                    {h.remaining === null ? "a conciliar" : money(h.remaining)}
                  </span>
                </div>
              ))}
            </div>
          </details>
          <details>
            <summary>Juros e IOF registrados</summary>
            <p>
              Juros: {money(charges.interest)} · IOF: {money(charges.iof)}
            </p>
            <p>
              Registre cobranças efetivas em Novo → Despesa, escolhendo esta
              conta, categoria e identificação do encargo.
            </p>
            <small>
              Principal contratual segregado: depende da composição informada
              pelo banco. O saldo negativo já inclui esses débitos. O Rota não
              estima cobranças nem separa principal contratual sem evidência do
              banco.
            </small>
            {charges.rows.map((t) => (
              <p key={t.id}>
                {displayDate(t.transaction_date)} ·{" "}
                {t.financial_charge === "overdraft_iof" ? "IOF" : "Juros"} ·{" "}
                {money(t.amount_cents)}
              </p>
            ))}
          </details>
          <details>
            <summary>Versões do contrato</summary>
            {versions.map((v) => (
              <p key={v.id}>
                {displayDate(v.effective_date)} · {money(v.limit_cents)} ·{" "}
                {v.active ? "Ativo" : "Inativo"} · {v.change_reason}
                {v.monthly_interest_rate !== null
                  ? ` · taxa mensal ${hidden ? "••••" : v.monthly_interest_rate}%`
                  : ""}
                {v.contract_notes ? ` · ${v.contract_notes}` : ""}
              </p>
            ))}
          </details>
        </>
      )}
      <button onClick={() => setEditor("reconcile")}>
        Conferir extrato bancário
      </button>
      <details>
        <summary>Conferências registradas</summary>
        {(plan.bank_reconciliations ?? [])
          .filter((r) => r.account_id === account.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((r) => (
            <div className="reconciliation-record" key={r.id}>
              <p>
                {displayDate(r.statement_date)} · extrato{" "}
                {money(r.statement_balance_cents)} · calculado na conferência{" "}
                {money(r.calculated_balance_cents)} · diferença{" "}
                {money(r.difference_cents)}
              </p>
              <p>{r.evidence}</p>
              <small>
                Registro {r.id}. Saldo recalculado hoje para a mesma data:{" "}
                {money(balance(account, data.transactions, r.statement_date))}.
                Evidência original preservada na exportação JSON.
              </small>
            </div>
          ))}
      </details>
      {editor === "config" && (
        <OverdraftConfig
          account={account}
          plan={plan}
          hidden={hidden}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      )}
      {editor === "reconcile" && (
        <ReconciliationEditor
          account={account}
          data={data}
          money={money}
          hidden={hidden}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}
function OverdraftConfig({
  account,
  plan,
  hidden,
  onClose,
  onSaved,
}: {
  account: Account;
  plan: PlanningData;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const id = useRef(crypto.randomUUID());
  const latest = (plan.account_overdraft_versions ?? [])
    .filter((v) => v.account_id === account.id)
    .sort((a, b) => b.revision - a.revision)[0];
  return (
    <Modal
      title="Configurar cheque especial"
      onClose={onClose}
      onSubmit={async (f) => {
        await rpc("save_account_overdraft", {
          p_id: id.current,
          p_account: account.id,
          p_expected: latest?.id ?? null,
          p_payload: {
            tracking_start: latest?.tracking_start ?? text(f, "start"),
            effective_date: text(f, "effective") || text(f, "start"),
            limit_cents: cents(f),
            active: text(f, "active") === "true",
            statement_model: text(f, "model"),
            monthly_interest_rate: text(f, "rate")
              ? Number(text(f, "rate"))
              : null,
            contract_notes: text(f, "notes"),
            change_reason: text(f, "reason"),
          },
        });
        await onSaved();
      }}
    >
      <p>
        {account.name}. Configuração opcional; mantém conta, saldo inicial e
        histórico.
      </p>
      <Amount
        label="Limite contratado (R$)"
        value={latest?.limit_cents}
        hidden={hidden}
      />
      {!latest && (
        <Field label="Início do acompanhamento">
          <input type="date" required name="start" max={today()} />
        </Field>
      )}
      {latest && (
        <Field label="Vigência da alteração">
          <input
            type="date"
            required
            name="effective"
            min={
              latest.effective_date > today() ? latest.effective_date : today()
            }
            defaultValue={
              latest.effective_date > today() ? latest.effective_date : today()
            }
          />
        </Field>
      )}
      <Field label="Situação">
        <select name="active" defaultValue={String(latest?.active ?? true)}>
          <option value="true">Ativo</option>
          <option value="false">Inativo</option>
        </select>
      </Field>
      <Field label="Representação no extrato">
        <select
          name="model"
          required
          defaultValue={latest?.statement_model ?? "needs_reconciliation"}
        >
          <option value="needs_reconciliation">
            Ainda preciso conciliar com o banco
          </option>
          <option value="negative_balance">
            Confirmei: uso incluído no saldo negativo
          </option>
        </select>
      </Field>
      <Field label="Taxa contratual mensal (%) — opcional">
        <input
          name="rate"
          type="number"
          min="0"
          max="1000"
          step="0.0001"
          defaultValue={latest?.monthly_interest_rate ?? ""}
        />
      </Field>
      <Field label="Informações contratuais — opcional">
        <textarea
          name="notes"
          maxLength={2000}
          defaultValue={latest?.contract_notes}
        />
      </Field>
      <Field label="Referência ou motivo da configuração">
        <textarea name="reason" required maxLength={2000} />
      </Field>
      <p className="muted">
        Mudanças criam versões a partir de hoje ou de uma data futura. Desativar
        preserva o saldo devedor. A taxa é informativa; não gera cobranças.
      </p>
    </Modal>
  );
}
function ReconciliationEditor({
  account,
  data,
  money,
  hidden,
  onClose,
  onSaved,
}: {
  account: Account;
  data: FinanceData;
  money: Money;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const id = useRef(crypto.randomUUID());
  const [date, setDate] = useState(today());
  const [review, setReview] = useState<{
    date: string;
    statement: number;
    calculated: number;
    evidence: string;
  } | null>(null);
  const calculated = balance(account, data.transactions, date);
  return (
    <Modal
      title="Conferir extrato bancário"
      onClose={onClose}
      submitLabel={review ? "Confirmar conferência" : "Conferir diferença"}
      onSubmit={async (f) => {
        if (!review) {
          setReview({
            date,
            statement: cents(f)!,
            calculated,
            evidence: text(f, "evidence"),
          });
          return false;
        }
        await rpc("record_bank_reconciliation", {
          p_id: id.current,
          p_account: account.id,
          p_date: review.date,
          p_statement: review.statement,
          p_expected: review.calculated,
          p_evidence: review.evidence,
          p_confirmed: f.get("confirmed") === "on",
        });
        await onSaved();
      }}
    >
      {!review ? (
        <>
          <Field label="Data do extrato">
            <input
              type="date"
              required
              name="date"
              value={date}
              max={today()}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <p>Saldo calculado: {money(calculated)}</p>
          <Amount
            label="Saldo bancário no extrato (R$)"
            allowNegative
            hidden={hidden}
          />
          <Field label="Referência do extrato e explicação">
            <textarea name="evidence" required maxLength={2000} />
          </Field>
        </>
      ) : (
        <>
          <p>Data: {displayDate(review.date)}</p>
          <p>
            Calculado: {money(review.calculated)} · extrato:{" "}
            {money(review.statement)}
          </p>
          <p>
            Diferença:{" "}
            <strong>{money(review.statement - review.calculated)}</strong>
          </p>
          <p>{review.evidence}</p>
          <p>
            Esta conferência guarda a evidência e não altera o saldo. Registre
            operações faltantes em Novo, usando as datas reais. Se o crédito não
            estiver no saldo negativo, mantenha “a conciliar”.
          </p>
          <label className="check">
            <input type="checkbox" name="confirmed" required />
            Conferi o extrato e confirmo o registro desta diferença
          </label>
          <button
            type="button"
            onClick={() => {
              id.current = crypto.randomUUID();
              setReview(null);
            }}
          >
            Voltar à conferência
          </button>
        </>
      )}
    </Modal>
  );
}
