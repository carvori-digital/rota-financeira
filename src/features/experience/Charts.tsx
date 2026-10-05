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
}: {
  rows: { label: string; value: number }[];
  hidden: boolean;
}) {
  const positive = rows.filter((r) => r.value > 0),
    total = positive.reduce((s, r) => s + r.value, 0);
  if (hidden || !total) return null;
  let offset = 0;
  return (
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
      {positive.map((r, index) => {
        const size = (r.value / total) * 100,
          start = offset;
        offset += size;
        return (
          <circle
            key={r.label}
            cx="80"
            cy="80"
            r="58"
            fill="none"
            stroke={colors[index % colors.length]}
            strokeWidth="22"
            pathLength="100"
            strokeDasharray={`${size} ${100 - size}`}
            strokeDashoffset={-start}
            transform="rotate(-90 80 80)"
          >
            <title>
              {r.label}: {size.toFixed(1)}%
            </title>
          </circle>
        );
      })}
    </svg>
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
