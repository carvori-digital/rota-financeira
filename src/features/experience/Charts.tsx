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
export function Trend({
  rows,
  hidden,
  label,
}: {
  rows: { label: string; value: number }[];
  hidden: boolean;
  label: string;
}) {
  if (hidden || rows.length < 2) return null;
  const min = Math.min(0, ...rows.map((r) => r.value)),
    max = Math.max(1, ...rows.map((r) => r.value)),
    range = max - min;
  const points = rows
    .map(
      (r, i) =>
        `${20 + (i * 280) / (rows.length - 1)},${120 - ((r.value - min) / range) * 95}`,
    )
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 320 155"
      style={{ width: "100%", maxHeight: 210 }}
    >
      <polyline points={points} fill="none" stroke="#65764e" strokeWidth="3" />
      {rows.map((r, i) => (
        <text
          key={r.label}
          x={20 + (i * 280) / (rows.length - 1)}
          y="148"
          textAnchor="middle"
          fontSize="10"
          fill="currentColor"
        >
          {r.label}
        </text>
      ))}
    </svg>
  );
}
