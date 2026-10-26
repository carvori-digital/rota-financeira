import { createUuid } from "../../lib/uuid";
import { useState } from "react";
import type { Account, FinanceData, Transaction } from "../../types";
import { balance, today, money, displayDate } from "../../utils/finance";
import { Amount, Field, Modal, cents, text } from "./ui";
import { rpc, save } from "./queries";
export type FinancialAction =
  | { kind: "schedule"; transaction?: Transaction }
  | { kind: "resolve"; transaction: Transaction }
  | { kind: "adjust"; account: Account };
export function FinancialActions({
  action,
  data,
  hidden,
  onClose,
  onSaved,
}: {
  action: FinancialAction;
  data: FinanceData;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(createUuid);
  const t = action.kind !== "adjust" ? action.transaction : undefined;
  const [type, setType] = useState<"income" | "expense">(
    t?.type === "income" ? "income" : "expense",
  );
  const [resolution, setResolution] = useState("realize");
  const [target, setTarget] = useState<number | null>(null);
  const recorded =
    action.kind === "adjust" ? balance(action.account, data.transactions) : 0;
  const showMoney = (n: number) => (hidden ? "••••" : money(n));
  return (
    <Modal
      title={
        action.kind === "adjust"
          ? "Ajustar saldo atual"
          : action.kind === "resolve"
            ? "Confirmar lançamento"
            : t
              ? "Editar programada"
              : "Agendar receita/despesa"
      }
      onClose={onClose}
      submitLabel={
        action.kind === "adjust"
          ? target === null
            ? "Conferir reconciliação"
            : "Confirmar ajuste de saldo"
          : "Salvar"
      }
      onSubmit={async (f) => {
        if (action.kind === "adjust") {
          if (target === null) {
            setTarget(cents(f)!);
            return false;
          }
          if (f.get("confirmed") !== "on")
            throw new Error(
              "Confirme a revisão dos movimentos antes do ajuste.",
            );
          await rpc("reconcile_operational_balance", {
            p_id: id,
            p_account: action.account.id,
            p_target: target,
            p_expected: recorded,
          });
        } else if (action.kind === "resolve")
          await rpc("resolve_transaction", {
            p_id: action.transaction.id,
            p_cancel: resolution === "cancel",
            p_date: text(f, "date") || today(),
          });
        else {
          const amount = cents(f)!;
          if (amount <= 0) throw new Error("Informe um valor maior que zero.");
          await save(
            "transactions",
            t?.id ?? id,
            {
              type,
              amount_cents: amount,
              description: text(f, "description"),
              account_id: text(f, "account"),
              category_id: text(f, "category"),
              destination_account_id: null,
              transaction_date: text(f, "date"),
              ...(t ? {} : { status: "pending" }),
              planning_group: text(f, "group"),
              financial_commitment: type === "expense",
              commitment_due_date: text(f, "date"),
            },
            !!t,
          );
        }
        await onSaved();
      }}
    >
      {action.kind === "adjust" ? (
        <>
          <p>
            {action.account.name}: saldo calculado a partir do histórico. O
            ajuste fica no extrato, sem contar como receita ou despesa.
          </p>
          <p>
            Saldo registrado: <strong>{showMoney(recorded)}</strong>
          </p>
          <details open>
            <summary>Movimentações já consideradas</summary>
            {data.transactions
              .filter(
                (t) =>
                  (t.account_id === action.account.id ||
                    t.destination_account_id === action.account.id) &&
                  t.status !== "pending" &&
                  t.status !== "cancelled" &&
                  t.transaction_date <= today(),
              )
              .sort((a, b) =>
                b.transaction_date.localeCompare(a.transaction_date),
              )
              .map((t) => (
                <p key={t.id}>
                  {displayDate(t.transaction_date)} ·{" "}
                  {t.type === "transfer"
                    ? "Transferência"
                    : t.type === "adjustment"
                      ? "Ajuste / investimento"
                      : t.type === "income"
                        ? "Receita"
                        : "Despesa"}{" "}
                  · {showMoney(t.amount_cents)} · {t.description}
                </p>
              ))}
          </details>
          <p className="muted">
            Lance receitas e despesas faltantes em Novo. Para aportes ou
            resgates, use as ações de investimento; uma transferência já
            existente deve ser reconciliada sem novo débito ou crédito. Ajuste
            somente diferenças não explicadas após conferir o histórico.
          </p>
          {target === null ? (
            <Amount
              label="Saldo atual correto (R$)"
              allowNegative
              hidden={hidden}
              value={balance(action.account, data.transactions)}
            />
          ) : (
            <>
              <p>Saldo real informado: {showMoney(target)}</p>
              <p>
                Diferença e efeito da correção: {showMoney(target - recorded)}
              </p>
              <p>
                Será registrado um ajuste rastreável, sem receita, despesa ou
                compromisso.
              </p>
              <label className="check">
                <input name="confirmed" type="checkbox" required />
                Conferi os movimentos existentes e faltantes; confirmo o ajuste
              </label>
              <button type="button" onClick={() => setTarget(null)}>
                Voltar e corrigir
              </button>
            </>
          )}
        </>
      ) : action.kind === "resolve" ? (
        <>
          <p>{action.transaction.description || "Lançamento programado"}</p>
          <Field label="Ação">
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="realize">Marcar como realizado</option>
              <option value="cancel">Cancelar compromisso</option>
            </select>
          </Field>
          {resolution === "realize" && (
            <Field label="Data da realização">
              <input
                name="date"
                type="date"
                required
                max={today()}
                defaultValue={today()}
              />
            </Field>
          )}
          <p className="muted">
            Confirmar atualiza o saldo uma única vez e retira o item dos
            pendentes.
          </p>
        </>
      ) : (
        <>
          <Field label="Tipo">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "income" | "expense")}
            >
              <option value="income">Receita</option>
              <option value="expense">Despesa</option>
            </select>
          </Field>
          <Field label="Descrição">
            <input
              name="description"
              required
              maxLength={240}
              defaultValue={t?.description}
            />
          </Field>
          <Amount hidden={hidden} value={t?.amount_cents} />
          <Field label="Conta">
            <select
              name="account"
              required
              defaultValue={
                t?.account_id ??
                data.accounts.find((a) => a.is_active)?.id ??
                ""
              }
            >
              {data.accounts
                .filter((a) => a.is_active || a.id === t?.account_id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Categoria">
            <select
              key={type}
              name="category"
              required
              defaultValue={t?.type === type ? (t.category_id ?? "") : ""}
            >
              <option value="">Selecione</option>
              {data.categories
                .filter((c) => c.type === type)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Data prevista">
            <input
              name="date"
              type="date"
              required
              defaultValue={t?.transaction_date ?? today()}
            />
          </Field>
          <Field label="Grupo">
            <select
              name="group"
              defaultValue={t?.planning_group ?? "scheduled"}
            >
              <option value="scheduled">Programadas</option>
              <option value="other">Outros · juros, IOF, tarifa</option>
            </select>
          </Field>
          <p className="muted">
            Pendente: entra na projeção e só muda o saldo quando você confirmar.
          </p>
        </>
      )}
    </Modal>
  );
}
