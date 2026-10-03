import type { Money } from "../planning/ui";
export function ReportChart({
  rows,
  money,
  hidden,
  label,
  scale,
}: {
  rows: { label: string; value: number; tone?: string }[];
  money: Money;
  hidden: boolean;
  label: string;
  scale?: number;
}) {
  const max = Math.max(1, scale ?? 0, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="report-chart" role="group" aria-label={label}>
      {rows.length ? (
        rows.map((r, i) => (
          <div className="chart-row" key={`${r.label}-${i}`}>
            <div className="chart-label">
              <span>{r.label}</span>
              <strong>{money(r.value)}</strong>
            </div>
            {!hidden && (
              <div className="chart-track" aria-hidden="true">
                <div
                  className={`chart-fill ${r.tone ?? (r.value < 0 ? "outflow" : "")}`}
                  style={{ width: `${(Math.abs(r.value) / max) * 100}%` }}
                />
              </div>
            )}
          </div>
        ))
      ) : (
        <p className="empty">
          Registre movimentos para acompanhar este período.
        </p>
      )}
      {hidden && <p className="muted">Gráfico oculto junto com os valores.</p>}
    </div>
  );
}
