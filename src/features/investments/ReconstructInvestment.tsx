import { createUuid } from "../../lib/uuid";
import { useRef, useState } from "react";
import type { Investment } from "./types";
import type { PlanningData } from "../planning/types";
import { investmentValue } from "./calculations";
import { Modal, Field, Amount, text } from "../planning/ui";
import type { Money } from "../planning/ui";
import { parseMoney, today } from "../../utils/finance";
import { rpc } from "../planning/queries";
export function parseHistoricalPosition(
  raw: string,
  initial: string,
  through: string,
) {
  const rows = raw
    .split(/\r?\n/)
    .filter((r) => r.trim())
    .map((line) => {
      const [date, kind, value, ...extra] = line
        .split(";")
        .map((v) => v.trim());
      const amount_cents = parseMoney(value ?? "");
      if (
        extra.length ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
        date < initial ||
        date > through ||
        !["aporte", "resgate"].includes(kind) ||
        amount_cents <= 0
      )
        throw new Error("Use data;aporte ou resgate;valor em cada linha.");
      return {
        date,
        type:
          kind === "aporte"
            ? ("contribution" as const)
            : ("withdrawal" as const),
        amount_cents,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length || rows.length > 1000)
    throw new Error("Informe de 1 a 1000 movimentos históricos.");
  let net = 0;
  for (const r of rows) {
    net += r.type === "withdrawal" ? -r.amount_cents : r.amount_cents;
    if (net < 0)
      throw new Error(
        "Resgate supera os aportes históricos; revise o extrato.",
      );
  }
  return { rows, net };
}
export function ReconstructInvestment({
  investment: i,
  plan,
  money,
  hidden,
  onClose,
  onSaved,
}: {
  investment: Investment;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [ids] = useState(() => ({
    request: createUuid(),
    investment: createUuid(),
  }));
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [net, setNet] = useState(0),
    [target, setTarget] = useState(0);
  const old = useRef(
    investmentValue(
      i,
      plan.investment_movements ?? [],
      today(),
      plan.investment_rates,
      plan.cdi_history,
    ).current,
  );
  return (
    <Modal
      title="Reconstruir investimento"
      submitLabel={review ? "Confirmar reconstrução" : "Preparar reconciliação"}
      onClose={onClose}
      onSubmit={async (f) => {
        if (!review) {
          const initial = text(f, "date"),
            history = parseHistoricalPosition(
              text(f, "history"),
              initial,
              today(),
            ),
            real = parseMoney(text(f, "amount"));
          if (real < 0) throw new Error("Posição real não pode ser negativa.");
          setNet(history.net);
          setTarget(real);
          setReview({
            name: text(f, "name"),
            institution: text(f, "institution"),
            product: text(f, "product"),
            initial_date: initial,
            yield_type: text(f, "yield"),
            yield_rate: Number(text(f, "rate").replace(",", ".")),
            history: history.rows,
            real_value_cents: real,
            note: text(f, "note"),
            acknowledged: true,
          });
          return false;
        }
        if (f.get("confirm") !== "on")
          throw new Error(
            "Confirme as diferenças e que os movimentos históricos já foram contabilizados.",
          );
        await rpc("reconstruct_investment", {
          p_id: ids.request,
          p_old: i.id,
          p_new: ids.investment,
          p_expected: old.current,
          p_payload: review,
        });
        await onSaved();
      }}
    >
      {review ? (
        <>
          <p>
            Substituir {i.name} por {String(review.name)}. Histórico e
            transações bancárias permanecerão protegidos. O investimento antigo
            sai dos totais.
          </p>
          <dl className="finance-details reconstruction-values">
            <div>
              <dt>Posição antiga registrada</dt>
              <dd>{money(old.current)}</dd>
            </div>
            <div>
              <dt>Capital histórico líquido</dt>
              <dd>{money(net)}</dd>
            </div>
            <div>
              <dt>Valor real informado hoje</dt>
              <dd>{money(target)}</dd>
            </div>
            <div>
              <dt>Diferença de patrimônio</dt>
              <dd>{money(target - old.current)}</dd>
            </div>
            <div>
              <dt>Diferença entre saldo real e capital histórico</dt>
              <dd>{money(target - net)}</dd>
            </div>
          </dl>
          <p className="muted">
            A diferença será registrada como valorização/sincronização, sem
            crédito ou débito bancário. Rendimentos anteriores à sincronização
            não são reconstruídos com precisão. Confirme o saldo e as datas no
            extrato.
          </p>
          <label className="check reconstruction-confirm">
            <input name="confirm" type="checkbox" required />
            Revisei as diferenças e confirmo que estes aportes/resgates já foram
            contabilizados; não são dinheiro novo.
          </label>
          <button type="button" onClick={() => setReview(null)}>
            Voltar e revisar
          </button>
        </>
      ) : (
        <>
          <p>
            Recrie a posição histórica sem movimentar suas contas. Novos aportes
            reais devem ser feitos depois, pelo botão Aportar.
          </p>
          <Field label="Nome">
            <input name="name" required maxLength={80} defaultValue={i.name} />
          </Field>
          <Field label="Instituição">
            <input
              name="institution"
              required
              maxLength={120}
              defaultValue={i.institution}
            />
          </Field>
          <Field label="Produto">
            <input
              name="product"
              required
              maxLength={80}
              placeholder="RDB / Caixinha Turbo"
            />
          </Field>
          <Field label="Data inicial">
            <input
              name="date"
              type="date"
              required
              max={today()}
              defaultValue={i.initial_date}
            />
          </Field>
          <details open>
            <summary>Rendimento contratado</summary>
            <Field label="Modelo">
              <select name="yield" defaultValue="percent_cdi">
                <option value="manual">Manual</option>
                <option value="fixed_annual">Taxa fixa anual</option>
                <option value="fixed_monthly">Taxa fixa mensal</option>
                <option value="percent_cdi">Percentual do CDI</option>
              </select>
            </Field>
            <Field label="Taxa (%) ou percentual do CDI">
              <input
                name="rate"
                required
                inputMode="decimal"
                pattern="[0-9]+([.,][0-9]+)?"
                defaultValue="115"
              />
            </Field>
            <p>
              Use as condições do seu contrato; elegibilidade Turbo não é
              presumida.
            </p>
          </details>
          <Field label="Aportes e resgates históricos">
            <textarea
              name="history"
              className="reconstruction-history"
              required
              rows={6}
              placeholder={
                "2026-09-01;aporte;1000,00\n2026-09-20;aporte;500,00"
              }
            />
          </Field>
          <p className="muted">
            Uma linha por movimento: AAAA-MM-DD;aporte ou resgate;valor. Somente
            valores já contabilizados no passado.
          </p>
          <Amount label="Valor real atual no banco (R$)" hidden={hidden} />
          <Field label="Referência da reconciliação">
            <input
              name="note"
              required
              maxLength={240}
              placeholder="Extrato e motivo de eventual diferença"
            />
          </Field>
          <p>
            Salvar prepara a prévia. A substituição acontece somente na
            confirmação seguinte.
          </p>
        </>
      )}
    </Modal>
  );
}
