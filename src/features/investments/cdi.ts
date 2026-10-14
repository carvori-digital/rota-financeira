import type { InvestmentMovement, InvestmentRate } from "./types.ts";
export interface CdiDay {
  date: string;
  daily_percent: number;
}
export interface CdiHistory {
  source: "BCB-SGS-12";
  fetched_at: string;
  start: string;
  end: string;
  days: CdiDay[];
}
const validDate = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export function parseSgs12(
  input: unknown,
  start: string,
  end: string,
  fetchedAt: string,
): CdiHistory {
  if (
    !validDate(start) ||
    !validDate(end) ||
    start > end ||
    !Array.isArray(input)
  )
    throw new Error("Histórico CDI inválido");
  const days = input
    .map((row: unknown) => {
      if (
        !row ||
        typeof row !== "object" ||
        !("data" in row) ||
        !("valor" in row) ||
        typeof row.data !== "string" ||
        !/^\d{2}\/\d{2}\/\d{4}$/.test(row.data)
      )
        throw new Error("Resposta SGS 12 inválida");
      const date = row.data.split("/").reverse().join("-"),
        daily_percent = Number(String(row.valor).replace(",", "."));
      if (
        !validDate(date) ||
        date < start ||
        date > end ||
        !Number.isFinite(daily_percent) ||
        daily_percent < 0 ||
        daily_percent > 1
      )
        throw new Error("Taxa diária SGS 12 inválida");
      return { date, daily_percent };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length || new Set(days.map((d) => d.date)).size !== days.length)
    throw new Error("Histórico CDI vazio ou duplicado");
  return { source: "BCB-SGS-12", fetched_at: fetchedAt, start, end, days };
}
export function cdiPosition(
  movements: InvestmentMovement[],
  asOf: string,
  initialPercent: number,
  rates: InvestmentRate[],
  history?: CdiHistory | null,
) {
  const rows = [...movements]
    .filter((m) => m.date <= asOf)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.ledger_order != null && b.ledger_order != null
          ? a.ledger_order - b.ledger_order
          : a.created_at.localeCompare(b.created_at)) ||
        a.id.localeCompare(b.id),
    );
  const latestSync = rows.filter((m) => m.sync_value_cents != null).at(-1);
  const start = latestSync?.date ?? rows[0]?.date ?? asOf;
  const covered =
    start === asOf ||
    !!(
      history &&
      history.source === "BCB-SGS-12" &&
      history.start <= start &&
      history.end >= asOf &&
      history.days.length
    );
  let value = 0,
    contributed = 0,
    withdrawn = 0,
    adjustments = 0;
  for (const m of rows) {
    if (m.type === "contribution") contributed += m.amount_cents;
    else if (m.type === "withdrawal") withdrawn += m.amount_cents;
    else adjustments += m.amount_cents;
  }
  const timeline = new Set([
    ...rows.map((m) => m.date),
    ...(covered
      ? (history?.days
          .filter((d) => d.date >= start && d.date < asOf)
          .map((d) => d.date) ?? [])
      : []),
  ]);
  const changes = [...rates].sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date),
  );
  for (const date of [...timeline].sort()) {
    for (const m of rows.filter((m) => m.date === date)) {
      if (m.sync_value_cents != null) value = m.sync_value_cents;
      else value += m.type === "withdrawal" ? -m.amount_cents : m.amount_cents;
    }
    // SGS 12 is already % per DAY, so no 252nd root here. Initial inclusive,
    // final exclusive; same-day cash movements occur before the daily factor.
    const day =
      covered && date >= start
        ? history?.days.find((d) => d.date === date)
        : undefined;
    if (day) {
      const percent =
        changes.filter((r) => r.effective_date <= date).at(-1)?.percent ??
        initialPercent;
      value *= 1 + (day.daily_percent / 100) * (percent / 100);
    }
  }
  const current = Math.round(value),
    principal = contributed - withdrawn + adjustments;
  return {
    current,
    principal,
    contributed,
    withdrawn,
    adjustments,
    estimatedYield: covered ? current - principal : null,
    profitability:
      covered && principal > 0
        ? ((current - principal) / principal) * 100
        : null,
    lastUpdate: latestSync?.date ?? rows.at(-1)?.date ?? asOf,
    complete: covered,
    limitation: covered
      ? null
      : "Histórico CDI insuficiente. Valor registrado sem rendimento adicional; sincronize com o banco.",
    source: history?.source ?? null,
    fetchedAt: history?.fetched_at ?? null,
    estimated: covered && start < asOf,
  };
}
