import type { FinanceData } from "../../types/index.ts";
import type { PlanningData } from "../planning/types.ts";
import type { CdiHistory } from "../investments/cdi.ts";
export interface MonthConfirmation {
  id: string;
  user_id: string;
  month: string;
  complete: boolean;
  confirmed_at: string;
}
export interface ExportSnapshot {
  owner: string;
  generated_at: string;
  finance: FinanceData;
  plan: PlanningData;
  confirmations: MonthConfirmation[];
  counts: Record<string, number>;
}
const financeTables = [
  "accounts",
  "categories",
  "transactions",
  "goals",
  "goal_contributions",
] as const;
const planTables = [
  "recurring_items",
  "recurring_occurrences",
  "recurring_payments",
  "credit_cards",
  "card_purchases",
  "card_invoices",
  "card_payments",
  "card_adjustments",
  "debts",
  "debt_payments",
  "reserve_account_links",
  "investments",
  "investment_movements",
  "investment_rates",
  "investment_reconstructions",
] as const;
export function validateSnapshot(
  raw: unknown,
  owner: string,
  cdi: CdiHistory | null = null,
): ExportSnapshot {
  if (!raw || typeof raw !== "object")
    throw new Error("Relatório não carregado");
  const r = raw as {
    schema_version?: number;
    owner?: string;
    generated_at?: string;
    counts?: Record<string, number>;
    data?: Record<string, unknown>;
  };
  if (
    r.schema_version !== 1 ||
    !owner ||
    r.owner !== owner ||
    !r.generated_at ||
    !Number.isFinite(Date.parse(r.generated_at)) ||
    !r.counts ||
    !r.data
  )
    throw new Error("Origem do relatório inválida");
  for (const table of [
    ...financeTables,
    ...planTables,
    "report_month_confirmations",
  ]) {
    const rows = r.data[table];
    if (
      !Array.isArray(rows) ||
      r.counts[table] !== rows.length ||
      rows.some(
        (row) => !row || typeof row.id !== "string" || row.user_id !== owner,
      ) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw new Error(
        "Dados incompletos ou de outro usuário; exportação bloqueada",
      );
  }
  return {
    owner,
    generated_at: r.generated_at,
    counts: r.counts,
    finance: Object.fromEntries(
      financeTables.map((t) => [t, r.data![t]]),
    ) as unknown as FinanceData,
    plan: {
      ...Object.fromEntries(planTables.map((t) => [t, r.data![t]])),
      cdi_history: cdi,
    } as unknown as PlanningData,
    confirmations: r.data.report_month_confirmations as MonthConfirmation[],
  };
}
