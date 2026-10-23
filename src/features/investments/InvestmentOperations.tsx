import { createUuid } from "../../lib/uuid";
import { useState } from "react";
import type { FinanceData } from "../../types";
import type { PlanningData } from "../planning/types";
import type { Investment, InvestmentMovement } from "./types";
import { Field, Amount, Modal, cents, text } from "../planning/ui";
import { rpc } from "../planning/queries";
import { balance, today, money, displayDate } from "../../utils/finance";
import { recordedInvestmentValue } from "./calculations";
type Props = {
  data: FinanceData;
  plan: PlanningData;
  hidden: boolean;
  onSaved: () => Promise<void>;
  onClose: () => void;
};
export type InvestmentOperation = "contribution" | "withdrawal" | "adjustment";
export function QuickInvestmentFlow(
  props: Props & { kind: InvestmentOperation; onCreate: () => void },
) {
  const options = (props.plan.investments ?? []).filter(
    (i) => i.active && !i.deleted_at && !i.replaced_by_id,
  );
  const [selected, setSelected] = useState(
    options.length === 1 ? options[0].id : "",
  );
  const investment = options.find((i) => i.id === selected);
  if (investment)
    return (
      <InvestmentMovementEditor
        {...props}
        key={investment.id + props.kind}
        investment={investment}
      />
    );
  return (
    <Modal
      title={
        props.kind === "contribution"
          ? "Aportar em investimento"
          : "Resgatar investimento"
      }
      onClose={props.onClose}
      onSubmit={async () => false}
      submitLabel="Selecione um investimento"
    >
      {options.length ? (
        <Field label="Investimento">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Selecione</option>
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <p>Cadastre um investimento para registrar aportes e resgates.</p>
          <button type="button" onClick={props.onCreate}>
            Criar investimento
          </button>
        </>
      )}
    </Modal>
  );
}
export function InvestmentMovementEditor({
  investment: i,
  kind,
  ...props
}: Props & { investment: Investment; kind: InvestmentOperation }) {
  const [request] = useState(createUuid);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [transfer, setTransfer] = useState("");
  const [distinct, setDistinct] = useState(false);
  const [account, setAccount] = useState("");
  const [sync, setSync] = useState(kind === "adjustment");
  const operation = sync ? "adjustment" : kind;
  const recorded = recordedInvestmentValue(
    i,
    props.plan.investment_movements ?? [],
    today(),
  );
  const accounts = props.data.accounts.filter(
    (a) =>
      a.is_active &&
      !a.investment_id &&
      !a.investment_retired &&
      ["checking", "wallet", "other"].includes(a.type),
  );
  const transfers = props.data.transactions.filter(
    (t) =>
      t.type === "transfer" &&
      t.status !== "pending" &&
      t.status !== "cancelled" &&
      (operation === "contribution"
        ? t.account_id === account
        : t.destination_account_id === account),
  );
  const selectedTransfer = transfers.find((t) => t.id === transfer);
  const related = props.data.accounts.find((a) => a.id === account);
  const showMoney = (n: number) => (props.hidden ? "••••" : money(n));
  return (
    <Modal
      title={
        operation === "adjustment"
          ? "Sincronizar valor atual"
          : operation === "contribution"
            ? "Aportar"
            : "Resgatar"
      }
      onClose={props.onClose}
      submitLabel={preview ? "Confirmar movimentação" : "Conferir movimentação"}
      onSubmit={async (f) => {
        if (!preview) {
          const value = selectedTransfer?.amount_cents ?? cents(f)!;
          if (operation !== "adjustment" && !transfer && !distinct)
            throw new Error(
              "Confirme que este movimento ainda não foi registrado.",
            );
          setPreview({
            p_id: request,
            p_investment: i.id,
            p_type: operation,
            p_amount: value,
            p_date: selectedTransfer?.transaction_date ?? text(f, "date"),
            p_account: operation === "adjustment" ? null : account,
            p_description: text(f, "description"),
            p_transfer: transfer || null,
            p_expected: recorded,
            p_confirmed: true,
          });
          return false;
        }
        if (f.get("confirmed") !== "on")
          throw new Error("Confirme os valores e o efeito da operação.");
        await rpc("simple_investment_movement", preview);
        await props.onSaved();
      }}
    >
      <p>
        {i.name} · saldo registrado: <strong>{showMoney(recorded)}</strong>
      </p>
      {preview ? (
        <>
          <dl className="finance-details">
            <div>
              <dt>Data</dt>
              <dd>{displayDate(String(preview.p_date))}</dd>
            </div>
            <div>
              <dt>Valor informado</dt>
              <dd>{showMoney(Number(preview.p_amount))}</dd>
            </div>
            <div>
              <dt>Diferença na posição</dt>
              <dd>
                {showMoney(
                  operation === "adjustment"
                    ? Number(preview.p_amount) - recorded
                    : Number(preview.p_amount) *
                        (operation === "withdrawal" ? -1 : 1),
                )}
              </dd>
            </div>
            <div>
              <dt>Efeito na conta {related?.name}</dt>
              <dd>
                {showMoney(
                  operation === "adjustment" || transfer
                    ? 0
                    : Number(preview.p_amount) *
                        (operation === "contribution" ? -1 : 1),
                )}
              </dd>
            </div>
            {related && (
              <div>
                <dt>Saldo da conta após correção</dt>
                <dd>
                  {showMoney(
                    balance(related, props.data.transactions) +
                      (transfer
                        ? 0
                        : Number(preview.p_amount) *
                          (operation === "contribution" ? -1 : 1)),
                  )}
                </dd>
              </div>
            )}
          </dl>
          <p>
            {transfer
              ? "Transferência já registrada: nenhum novo crédito ou débito bancário. A posição do investimento será reconciliada."
              : operation === "adjustment"
                ? "O saldo real passa a ser a posição registrada. Nenhuma conta bancária será movimentada."
                : "Conta e investimento serão atualizados juntos, sem receita, despesa ou compromisso."}
          </p>
          <label className="check">
            <input name="confirmed" type="checkbox" required />
            Conferi os valores e confirmo esta movimentação
          </label>
          <button type="button" onClick={() => setPreview(null)}>
            Voltar e corrigir
          </button>
        </>
      ) : (
        <>
          {operation === "withdrawal" && (
            <p className="muted">
              Resgatável registrado: {showMoney(recorded)}. Rendimentos
              estimados só ficam disponíveis após sincronizar o saldo real do
              banco.
            </p>
          )}
          {operation === "withdrawal" && recorded <= 0 && (
            <p role="status">
              Sem saldo registrado para resgate. Confira o saldo no banco e
              sincronize antes de continuar.
            </p>
          )}
          {operation !== "adjustment" && (
            <>
              <Field
                label={
                  operation === "contribution"
                    ? "Conta de origem"
                    : "Conta de destino"
                }
              >
                <select
                  required
                  value={account}
                  onChange={(e) => {
                    setAccount(e.target.value);
                    setTransfer("");
                    setDistinct(false);
                  }}
                >
                  <option value="">Selecione</option>
                  {accounts.map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!accounts.length && (
                <p role="status">
                  Cadastre ou ative uma conta operacional em Ajustes para
                  movimentar dinheiro.
                </p>
              )}
              <Field label="Esta movimentação já foi registrada?">
                <select
                  value={transfer}
                  onChange={(e) => setTransfer(e.target.value)}
                >
                  <option value="">Novo movimento, ainda não registrado</option>
                  {transfers.map((t) => (
                    <option value={t.id} key={t.id}>
                      {displayDate(t.transaction_date)} ·{" "}
                      {showMoney(t.amount_cents)} ·{" "}
                      {t.description || "Transferência"}
                    </option>
                  ))}
                </select>
              </Field>
              {!transfer && (
                <label className="check">
                  <input
                    type="checkbox"
                    required
                    checked={distinct}
                    onChange={(e) => setDistinct(e.target.checked)}
                  />
                  Conferi o extrato do Rota: este movimento ainda não foi
                  registrado
                </label>
              )}
              {transfer && (
                <p className="muted">
                  Só é possível vincular transferências com a origem contábil
                  preservada do investimento. Transferências entre contas
                  operacionais exigem revisão das contas; não serão creditadas
                  novamente.
                </p>
              )}
            </>
          )}
          {selectedTransfer ? (
            <p>
              Movimento considerado:{" "}
              {displayDate(selectedTransfer.transaction_date)} ·{" "}
              {showMoney(selectedTransfer.amount_cents)} ·{" "}
              {selectedTransfer.description}
            </p>
          ) : (
            <>
              <Amount
                hidden={props.hidden}
                label={
                  operation === "adjustment"
                    ? "Valor real no banco (R$)"
                    : "Valor (R$)"
                }
                value={operation === "adjustment" ? recorded : undefined}
              />
              <Field label="Data">
                <input
                  name="date"
                  type="date"
                  required
                  min={i.initial_date}
                  max={today()}
                  defaultValue={today()}
                />
              </Field>
            </>
          )}
          <Field label="Descrição">
            <input
              name="description"
              maxLength={240}
              required={operation === "adjustment"}
              placeholder={
                operation === "adjustment"
                  ? "Referência do extrato ou motivo"
                  : "Opcional. Se houver transferência distinta semelhante, use Conferido: e o motivo"
              }
            />
          </Field>
          {operation !== "adjustment" && (
            <button
              type="button"
              onClick={() => {
                setSync(true);
                setTransfer("");
              }}
            >
              Sincronizar saldo real antes de movimentar
            </button>
          )}
          {operation === "adjustment" && (
            <p className="muted">
              Confira primeiro aportes e resgates já registrados abaixo. Lance
              movimentos faltantes antes de sincronizar. Uma sincronização
              inclui o histórico até essa data.
            </p>
          )}
          <details>
            <summary>Movimentações já consideradas</summary>
            {(props.plan.investment_movements ?? [])
              .filter((m) => m.investment_id === i.id)
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((m) => (
                <p key={m.id}>
                  {displayDate(m.date)} ·{" "}
                  {m.type === "contribution"
                    ? "Aporte"
                    : m.type === "withdrawal"
                      ? "Resgate"
                      : m.accounting_kind === "initial_position"
                        ? "Saldo inicial"
                        : "Saldo/ajuste"}{" "}
                  · {showMoney(m.sync_value_cents ?? m.amount_cents)} ·{" "}
                  {m.description}
                </p>
              ))}
          </details>
        </>
      )}
    </Modal>
  );
}
export function DeleteInvestment({
  investment,
  plan,
  hidden,
  onSaved,
}: {
  investment: Investment;
  plan: PlanningData;
  hidden: boolean;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [request] = useState(createUuid);
  const expected = recordedInvestmentValue(
    investment,
    plan.investment_movements ?? [],
    today(),
  );
  return (
    <>
      <details>
        <summary>Ações do registro</summary>
        <button onClick={() => setOpen(true)}>Excluir investimento</button>
      </details>
      {open && (
        <Modal
          title="Excluir definitivamente investimento"
          onClose={() => setOpen(false)}
          submitLabel="Excluir definitivamente"
          onSubmit={async (f) => {
            if (
              f.get("confirm") !== "on" ||
              text(f, "name") !== investment.name
            )
              throw new Error(
                "Confirme a exclusão e digite o nome do investimento.",
              );
            await rpc("delete_simple_investment", {
              p_request: request,
              p_investment: investment.id,
              p_expected: expected,
              p_confirmed: true,
            });
            await onSaved();
          }}
        >
          <p>
            {investment.name} · posição registrada:{" "}
            {hidden ? "••••" : money(expected)}
          </p>
          <p>
            O investimento sairá dos totais e da reserva. Todas as movimentações
            bancárias serão preservadas, sem devolver aportes nem debitar
            resgates nas contas.
          </p>
          <p>
            A conta antiga permanecerá apenas como origem contábil, fora dos
            totais. Se houver reconstrução anterior, o vínculo mínimo de
            auditoria será preservado e ocultado. Esta exclusão não pode ser
            desfeita.
          </p>
          <Field label="Digite o nome do investimento">
            <input name="name" required autoComplete="off" />
          </Field>
          <label className="check">
            <input type="checkbox" name="confirm" required />
            Confirmo a exclusão definitiva e a preservação das movimentações
            bancárias
          </label>
        </Modal>
      )}
    </>
  );
}
export function ReverseInvestmentMovement({
  movement,
  onSaved,
}: {
  movement: InvestmentMovement;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [request] = useState(createUuid);
  if (movement.reversed_by)
    return <small>Estornado · histórico preservado</small>;
  if (
    !["real_cash", "valuation"].includes(movement.accounting_kind ?? "") ||
    movement.description.startsWith("Estorno rastreável")
  )
    return null;
  return (
    <>
      <button
        disabled={busy}
        onClick={async () => {
          if (
            !window.confirm(
              "Estornar este movimento? A operação inversa ficará no histórico e os saldos serão conferidos. Se houver dependências, o estorno será bloqueado.",
            )
          )
            return;
          setBusy(true);
          setError("");
          try {
            await rpc("reverse_simple_investment_movement", {
              p_request: request,
              p_movement: movement.id,
            });
            await onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Estornando…" : "Estornar"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
