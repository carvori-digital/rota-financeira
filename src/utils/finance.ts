import type {
  Account,
  Transaction,
  Goal,
  Contribution,
} from "../types/index.ts";
export function parseMoney(value: string): number {
  const normalized = value.trim().replace(/\s/g, "");
  if (!/^-?\d+(?:[,.]\d{1,2})?$/.test(normalized))
    throw new Error("Use um valor como 1250,50, sem separador de milhar.");
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace("-", "").split(/[,.]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 1_000_000_000_000)
    throw new Error("Valor fora do limite permitido.");
  return negative ? -cents : cents;
}
export function inputMoney(cents: number) {
  return `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}
export const money = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const displayDate = (date: string) =>
  date.split("-").reverse().join("/");
export function balance(
  account: Account,
  transactions: Transaction[],
  cutoff = today(),
) {
  return transactions
    .filter((t) => t.transaction_date <= cutoff)
    .reduce(
      (sum, t) =>
        sum +
        (t.account_id === account.id
          ? t.type === "income"
            ? t.amount_cents
            : -t.amount_cents
          : 0) +
        (t.type === "transfer" && t.destination_account_id === account.id
          ? t.amount_cents
          : 0),
      account.initial_balance_cents,
    );
}
export function monthly(transactions: Transaction[], month: string) {
  const rows = transactions.filter((t) => t.transaction_date.startsWith(month));
  const income = rows
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount_cents, 0);
  const expense = rows
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount_cents, 0);
  return {
    income,
    expense,
    result: income - expense,
    saved: income > 0 ? ((income - expense) / income) * 100 : null,
  };
}
export function goalProgress(goal: Goal, contributions: Contribution[]) {
  const accumulated = contributions
    .filter((c) => c.goal_id === goal.id)
    .reduce((s, c) => s + c.amount_cents, goal.initial_amount_cents);
  return {
    accumulated,
    remaining: Math.max(0, goal.target_amount_cents - accumulated),
    percent: (accumulated * 100) / goal.target_amount_cents,
  };
}
