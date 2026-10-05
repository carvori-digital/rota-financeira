import type { Money } from "../planning/ui";
const colors = [
  "#65764e",
  "#bc8559",
  "#638c8c",
  "#a69868",
  "#887a9d",
  "#b77578",
];
export function Donut({
  rows,
  hidden,
  money,
}: {
  rows: { label: string; value: number }[];
  hidden: boolean;
  money: Money;
}) {
  const positive = rows.filter((r) => r.value > 0),
    total = positive.reduce((s, r) => s + r.value, 0);
  if (hidden || !total) return null;
  let offset = 0;
  const segments = positive.map((row, index) => {
    const percent = (row.value / total) * 100,
      start = offset;
    offset += percent;
    return {
      ...row,
      percent,
      start,
      color: colors[index] ?? `hsl(${(index * 137.508) % 360} 35% 48%)`,
    };
  });
  return (
    <div className="category-distribution">
      <svg
        viewBox="0 0 160 160"
        role="img"
        aria-label="Distribuição proporcional dos gastos"
        style={{
          width: "100%",
          maxWidth: 190,
          display: "block",
          margin: "0 auto",
        }}
      >
        {segments.map((r) => {
          return (
            <circle
              key={r.label}
              cx="80"
              cy="80"
              r="58"
              fill="none"
              stroke={r.color}
              strokeWidth="22"
              pathLength="100"
              strokeDasharray={`${r.percent} ${100 - r.percent}`}
              strokeDashoffset={-r.start}
              transform="rotate(-90 80 80)"
            >
              <title>
                {r.label}: {r.percent.toFixed(1)}%
              </title>
            </circle>
          );
        })}
      </svg>
      <ul
        className="category-legend"
        aria-label="Legenda dos gastos por categoria"
      >
        {segments.map((r) => (
          <li key={r.label}>
            <span
              className="category-marker"
              aria-hidden="true"
              style={{ backgroundColor: r.color }}
            />
            <span className="category-name">{r.label}</span>
            <span className="category-amount">
              <strong>{money(r.value)}</strong>
              <small>{r.percent.toFixed(1).replace(".", ",")}%</small>
            </span>
          </li>
        ))}
      </ul>
      {rows.some((r) => r.value < 0) && (
        <small className="muted">
          Percentuais sobre as categorias com gasto positivo.
        </small>
      )}
    </div>
  );
}
export function MonthlyColumns({
  rows,
  hidden,
  money,
  scale,
}: {
  rows: {
    period: string;
    income: number;
    expense: number;
    result: number;
  }[];
  hidden: boolean;
  money: Money;
  scale: number;
}) {
  if (hidden)
    return <p className="muted">Gráfico oculto junto com os valores.</p>;
  return (
    <div
      className="monthly-columns"
      role="group"
      aria-label="Comparação mensal em colunas"
    >
      {rows.map((month) => (
        <article
          className="monthly-column-month"
          key={month.period}
          role="group"
          aria-label={`Comparação ${month.period}`}
        >
          <h3>{month.period.split("-").reverse().join("/")}</h3>
          <div className="monthly-bars">
            {[
              { label: "Receitas", value: month.income, tone: "income" },
              { label: "Despesas", value: month.expense, tone: "outflow" },
              { label: "Resultado", value: month.result, tone: "result" },
            ].map((item) => (
              <div className="monthly-bar-item" key={item.label}>
                <strong>{money(item.value)}</strong>
                <div className="monthly-bar-axis" aria-hidden="true">
                  <span
                    className={`monthly-bar ${item.tone} ${item.value < 0 ? "negative" : ""}`}
                    style={{
                      height: `${Math.max(item.value === 0 ? 0 : 2, (Math.abs(item.value) / scale) * 50)}%`,
                    }}
                  />
                </div>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
