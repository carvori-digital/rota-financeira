import { useState } from "react";
import type { FinanceData } from "../../types";
import type { PlanningData } from "../planning/types";
import type { Money } from "../planning/ui";
import {
  experienceReport,
  periodReport,
  monthlyEvolution,
} from "./calculations";
import { today, displayDate } from "../../utils/finance";
import { ReportChart } from "./ReportChart";
import { Donut, Trend } from "./Charts";
export function Reports({
  data,
  plan,
  money,
  hidden,
}: {
  data: FinanceData;
  plan: PlanningData;
  money: Money;
  hidden: boolean;
}) {
  const asOf = today(),
    [period, setPeriod] = useState(asOf.slice(0, 7));
  const r = experienceReport(data, plan, asOf),
    actual = periodReport(data, plan, period, asOf);
  const evolution = monthlyEvolution(data, plan, period, asOf);
  const evolutionScale = Math.max(
    1,
    ...evolution.flatMap((m) => [m.income, m.expense, Math.abs(m.result)]),
  );
  const paidByMonth = new Map<string, number>();
  for (const payment of plan.debt_payments.filter(
    (p) => p.payment_date <= asOf,
  )) {
    const key = payment.payment_date.slice(0, 7);
    paidByMonth.set(key, (paidByMonth.get(key) ?? 0) + payment.amount_cents);
  }
  const remaining = plan.debts.reduce(
    (s, d) => s + d.remaining_amount_cents,
    0,
  );
  const original = plan.debts.reduce((s, d) => s + d.original_amount_cents, 0);
  return (
    <div className="reports">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ENTENDA SUA ROTA</p>
          <h1>Relatórios</h1>
        </div>
        <input
          type="month"
          aria-label="Mês do resumo"
          value={period}
          max={asOf.slice(0, 7)}
          onChange={(e) => setPeriod(e.target.value || asOf.slice(0, 7))}
        />
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Fluxo do mês</h2>
          <span className="report-badge">Realizado</span>
        </div>
        <ReportChart
          label="Receitas, despesas e resultado"
          hidden={hidden}
          money={money}
          rows={
            actual.income || actual.expense
              ? [
                  { label: "Receitas", value: actual.income },
                  { label: "Despesas", value: actual.expense, tone: "outflow" },
                  { label: "Resultado", value: actual.result, tone: "result" },
                ]
              : []
          }
        />
        <details>
          <summary>O que entra neste resultado?</summary>
          <p className="muted">
            Receitas menos consumo realizado. Compras no cartão entram uma vez,
            na data da compra. Pagar fatura e transferir entre contas não são um
            novo consumo. Ajustes de fatura entram no mês do vencimento
            escolhido.
          </p>
        </details>
      </section>
      <section className="panel">
        <h2>Gastos por categoria</h2>
        <Donut rows={actual.categories} hidden={hidden} />
        <ReportChart
          label="Despesas por categoria"
          hidden={hidden}
          money={money}
          rows={actual.categories}
        />
      </section>
      <section className="panel">
        <h2>Evolução mensal</h2>
        <Trend
          rows={evolution.map((m) => ({
            label: m.period.slice(5) + "/" + m.period.slice(2, 4),
            value: m.result,
          }))}
          hidden={hidden}
          label="Evolução do resultado mensal"
        />
        {evolution.length > 1 ? (
          <>
            <div className="chart-legend">
              <span>Receitas</span>
              <span>Despesas</span>
              <span>Resultado</span>
            </div>
            <div className="evolution-chart">
              {evolution.map((m) => (
                <div key={m.period} className="evolution-period">
                  <h3>{m.period.split("-").reverse().join("/")}</h3>
                  <ReportChart
                    label={`Evolução ${m.period}`}
                    scale={evolutionScale}
                    money={money}
                    hidden={hidden}
                    rows={[
                      { label: "Receitas", value: m.income },
                      { label: "Despesas", value: m.expense, tone: "outflow" },
                      { label: "Resultado", value: m.result, tone: "result" },
                    ]}
                  />
                </div>
              ))}
            </div>
            <small>Mesma escala em todos os meses com movimentos.</small>
          </>
        ) : (
          <p className="empty">
            Com movimentos em dois meses, sua evolução aparece aqui. O mês atual
            já está no fluxo acima.
          </p>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Compromissos</h2>
          <span className="report-badge">Mês atual</span>
        </div>
        <ReportChart
          label="Compromissos restantes por grupo"
          hidden={hidden}
          money={money}
          rows={r.groups.map((g) => ({ label: g.label, value: g.total }))}
        />
        <div className="report-total">
          <span>Ainda sai do disponível</span>
          <strong>{money(r.current.commitments)}</strong>
        </div>
        <details>
          <summary>Ver registros previstos</summary>
          {r.groups.map((g) => (
            <div key={g.key}>
              <h3>{g.label}</h3>
              {g.items.length ? (
                g.items.map((c) => (
                  <div className="account-line" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {displayDate(c.due)}
                        {c.impact === 0 && " · sem efeito no disponível"}
                      </small>
                    </div>
                    <strong>{money(c.amount)}</strong>
                  </div>
                ))
              ) : (
                <p className="muted">Nenhum compromisso.</p>
              )}
            </div>
          ))}
        </details>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Projeção</h2>
          <span className="report-badge">Previsto</span>
        </div>
        <ReportChart
          label="Saldo projetado nos próximos quatro meses"
          hidden={hidden}
          money={money}
          rows={r.months.map((m) => ({
            label: m.month.split("-").reverse().join("/"),
            value: m.closing,
            tone: "result",
          }))}
        />
        <details>
          <summary>Como chegamos ao saldo?</summary>
          <p className="muted">
            Disponível realizado, mais entradas previstas, menos compromissos.
            Reserva e investimentos ficam separados do dinheiro livre.
          </p>
          {r.months.map((m) => (
            <div key={m.month} className="projection-detail">
              <h3>{m.month.split("-").reverse().join("/")}</h3>
              <dl className="finance-details">
                <div>
                  <dt>Abertura</dt>
                  <dd>{money(m.opening)}</dd>
                </div>
                <div>
                  <dt>Ainda entra</dt>
                  <dd>{money(m.income)}</dd>
                </div>
                <div>
                  <dt>Ainda sai</dt>
                  <dd>{money(m.commitments)}</dd>
                </div>
                <div>
                  <dt>Saldo projetado final</dt>
                  <dd>{money(m.closing)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </details>
      </section>
      <section className="panel">
        <h2>Dívidas</h2>
        <div className="report-total">
          <span>Saldo restante</span>
          <strong>{money(remaining)}</strong>
        </div>
        {original > 0 && (
          <div className="debt-progress">
            <span>
              {hidden
                ? "••••"
                : `${Math.round((Math.max(0, original - remaining) / original) * 100)}% quitado`}
            </span>
            {!hidden && (
              <progress
                max={original}
                value={Math.max(0, original - remaining)}
                aria-label="Total das dívidas quitado"
              />
            )}
          </div>
        )}
        <ReportChart
          label="Saldo restante por dívida"
          hidden={hidden}
          money={money}
          rows={plan.debts.map((d) => ({
            label: d.name,
            value: d.remaining_amount_cents,
          }))}
        />
        {paidByMonth.size > 0 && (
          <>
            <h3>Evolução da quitação</h3>
            <ReportChart
              label="Pagamentos de dívidas por mês"
              hidden={hidden}
              money={money}
              rows={[...paidByMonth]
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(-6)
                .map(([key, value]) => ({
                  label: key.split("-").reverse().join("/"),
                  value,
                }))}
            />
          </>
        )}
        <details>
          <summary>Evolução da quitação</summary>
          {plan.debt_payments.length ? (
            [...plan.debt_payments]
              .sort((a, b) => b.payment_date.localeCompare(a.payment_date))
              .map((p) => (
                <div className="account-line" key={p.id}>
                  <div>
                    <strong>
                      {plan.debts.find((d) => d.id === p.debt_id)?.name ??
                        "Dívida"}
                    </strong>
                    <small>
                      {displayDate(p.payment_date)} · pagamento realizado
                    </small>
                  </div>
                  <strong>{money(p.amount_cents)}</strong>
                </div>
              ))
          ) : (
            <p className="empty">
              Os pagamentos registrados aparecerão aqui. O saldo informado da
              dívida já está preservado acima.
            </p>
          )}
        </details>
      </section>
      <section className="panel savings-report">
        <h2>Patrimônio e investimentos</h2>
        <dl className="finance-details">
          <div>
            <dt>Disponível</dt>
            <dd>{money(r.wealth.available)}</dd>
          </div>
          <div>
            <dt>Investimentos estimados · inclui reserva</dt>
            <dd>{money(r.wealth.invested)}</dd>
          </div>
          <div>
            <dt>Reserva de emergência</dt>
            <dd>{money(r.reserve)}</dd>
          </div>
          <div>
            <dt>Patrimônio bruto estimado</dt>
            <dd>{money(r.wealth.gross)}</dd>
          </div>
          <div>
            <dt>Patrimônio líquido estimado</dt>
            <dd>{money(r.wealth.net)}</dd>
          </div>
        </dl>
      </section>
      <section className="panel savings-report">
        <h2>Taxa de economia</h2>
        <strong className="savings-number">
          {hidden
            ? "••••"
            : actual.saved === null
              ? "—"
              : `${actual.saved.toFixed(1).replace(".", ",")}%`}
        </strong>
        <p className="muted">
          {actual.saved === null
            ? "Registre uma receita realizada neste mês para calcular a taxa."
            : "Resultado do consumo ÷ receitas realizadas. Pode ser negativo quando o consumo supera a renda."}
        </p>
        {actual.saved !== null && !hidden && (
          <div className="chart-track" aria-hidden="true">
            <div
              className={`chart-fill ${actual.saved < 0 ? "outflow" : ""}`}
              style={{ width: `${Math.min(100, Math.abs(actual.saved))}%` }}
            />
          </div>
        )}
        <div className="report-total">
          <span>Resultado no mês</span>
          <strong>{money(actual.result)}</strong>
        </div>
      </section>
    </div>
  );
}
