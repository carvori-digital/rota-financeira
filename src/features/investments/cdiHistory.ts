import { parseSgs12 } from "./cdi";
import type { CdiHistory } from "./cdi";
const key = "rota-public-cdi-sgs12-v1";
export function cachedCdi(): CdiHistory | null {
  try {
    const h = JSON.parse(
      localStorage.getItem(key) ?? "null",
    ) as CdiHistory | null;
    if (!h || h.source !== "BCB-SGS-12") return null;
    return parseSgs12(
      h.days.map((d) => ({
        data: d.date.split("-").reverse().join("/"),
        valor: String(d.daily_percent),
      })),
      h.start,
      h.end,
      h.fetched_at,
    );
  } catch {
    return null;
  }
}
export async function updateCdi(
  start: string,
  end: string,
): Promise<CdiHistory> {
  const days: CdiHistory["days"] = [];
  // BCB bounds daily-series queries to ten years; use annual windows and save
  // atomically only after every window succeeds. No financial data is sent.
  for (
    let year = Number(start.slice(0, 4));
    year <= Number(end.slice(0, 4));
    year++
  ) {
    const from = start > `${year}-01-01` ? start : `${year}-01-01`,
      to = end < `${year}-12-31` ? end : `${year}-12-31`;
    const url = new URL(
      "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados",
    );
    url.search = new URLSearchParams({
      formato: "json",
      dataInicial: from.split("-").reverse().join("/"),
      dataFinal: to.split("-").reverse().join("/"),
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error(
        "BCB indisponível. Cache anterior preservado; sincronize o saldo real.",
      );
    const h = parseSgs12(
      await response.json(),
      from,
      to,
      new Date().toISOString(),
    );
    days.push(...h.days);
  }
  const h: CdiHistory = {
    source: "BCB-SGS-12",
    fetched_at: new Date().toISOString(),
    start,
    end,
    days,
  };
  localStorage.setItem(key, JSON.stringify(h));
  return h;
}
