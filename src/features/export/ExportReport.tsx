import { useEffect, useRef, useState } from "react";
import { rpc } from "../planning/queries";
import { cachedCdi } from "../investments/cdiHistory";
import { validateSnapshot } from "./snapshot";
import type { ExportSnapshot } from "./snapshot";
import { buildFinancialExport } from "./calculations";
import type { FinancialExport } from "./calculations";
import {
  financialCsv,
  financialJson,
  financialPdf,
  downloadFile,
} from "./formats";
import { Field } from "../planning/ui";
import type { Money } from "../planning/ui";
import { today } from "../../utils/finance";
export function ExportReport({
  owner,
  money,
  hidden,
}: {
  owner: string;
  money: Money;
  hidden: boolean;
}) {
  const [start, setStart] = useState(today().slice(0, 7) + "-01"),
    [end, setEnd] = useState(today()),
    [detailed, setDetailed] = useState(false),
    [report, setReport] = useState<FinancialExport | null>(null),
    [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    currentOwner = useRef(owner);
  currentOwner.current = owner;
  const active = useRef(true),
    visible = useRef(!hidden);
  visible.current = !hidden;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const clear = () => {
    generation.current++;
    setReport(null);
    setSnapshot(null);
    setError("");
  };
  const prepare = async () => {
    const run = ++generation.current;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const s = validateSnapshot(
        await rpc("export_financial_snapshot", {}),
        owner,
        cachedCdi(),
      );
      const result = buildFinancialExport(s, { start, end, detailed });
      if (run === generation.current && currentOwner.current === owner) {
        setSnapshot(s);
        setReport(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (format: "pdf" | "csv" | "json") => {
    if (!report) return;
    setBusy(true);
    try {
      const blob =
        format === "pdf"
          ? await financialPdf(report)
          : new Blob(
              [format === "csv" ? financialCsv(report) : financialJson(report)],
              {
                type:
                  format === "csv"
                    ? "text/csv;charset=utf-8"
                    : "application/json;charset=utf-8",
              },
            );
      if (!active.current || !visible.current || currentOwner.current !== owner)
        throw new Error("Sessão alterada; prepare novamente.");
      downloadFile(blob, `rota-financeira-${start}-${end}.${format}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="panel export-report">
      <summary>Exportar relatório</summary>
      <p className="muted">
        O arquivo contém dados financeiros privados. Downloads gerados neste
        dispositivo.
      </p>
      <div className="export-period">
        <Field label="Início">
          <input
            type="date"
            value={start}
            max={end}
            onChange={(e) => {
              setStart(e.target.value);
              clear();
            }}
          />
        </Field>
        <Field label="Fim">
          <input
            type="date"
            value={end}
            min={start}
            max={today()}
            onChange={(e) => {
              setEnd(e.target.value);
              clear();
            }}
          />
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={detailed}
          onChange={(e) => {
            setDetailed(e.target.checked);
            clear();
          }}
        />
        Incluir movimentações detalhadas
      </label>
      <p className="muted">
        No modo detalhado, o JSON também inclui histórico anterior para
        reconciliar saldos atuais.
      </p>
      <button disabled={busy || !owner || hidden} onClick={prepare}>
        {busy ? "Preparando…" : "Visualizar resumo antes de exportar"}
      </button>
      {hidden && <p>Exiba os valores para revisar e exportar.</p>}
      {error && <p role="alert">{error}</p>}
      {report && snapshot && (
        <>
          <h3>Prévia do relatório</h3>
          <dl className="finance-details">
            <div>
              <dt>Receitas realizadas</dt>
              <dd>{money(report.realized.income_cents)}</dd>
            </div>
            <div>
              <dt>Despesas realizadas</dt>
              <dd>{money(report.realized.expense_cents)}</dd>
            </div>
            <div>
              <dt>Resultado</dt>
              <dd>{money(report.realized.result_cents)}</dd>
            </div>
          </dl>
          <p>
            {report.mode === "detailed" ? "Detalhado" : "Resumido"} · leitura
            consistente concluída · {snapshot.counts.transactions} transações
            carregadas.
          </p>
          <details>
            <summary>Completude dos meses</summary>
            {report.realized.months.map((m) => (
              <div className="account-line" key={m.month}>
                <span>
                  {m.month} ·{" "}
                  {m.complete
                    ? "Completo confirmado"
                    : "Completude não confirmada"}
                </span>
                {m.month < today().slice(0, 7) && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await rpc("confirm_report_month", {
                          p_month: m.month + "-01",
                          p_complete: !m.complete,
                        });
                        await prepare();
                      } catch (e) {
                        setError((e as Error).message);
                        setBusy(false);
                      }
                    }}
                  >
                    {m.complete
                      ? "Marcar como parcial"
                      : "Confirmar mês completo"}
                  </button>
                )}
              </div>
            ))}
          </details>
          {report.warnings.map((w, i) => (
            <p key={i} className="muted">
              {w}
            </p>
          ))}
          <div className="actions">
            <button disabled={busy || hidden} onClick={() => download("pdf")}>
              Baixar PDF
            </button>
            <button disabled={busy || hidden} onClick={() => download("csv")}>
              Baixar CSV
            </button>
            <button disabled={busy || hidden} onClick={() => download("json")}>
              Baixar JSON
            </button>
          </div>
        </>
      )}
    </details>
  );
}
