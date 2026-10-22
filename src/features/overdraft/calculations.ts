import type { Account, FinanceData } from "../../types/index.ts";
import type { PlanningData } from "../planning/types.ts";
import {
  balance,
  isRealized,
  isOperationalAccount,
} from "../../utils/finance.ts";
import { projection } from "../planning/calculations.ts";
export function overdraftTerms(
  plan: PlanningData,
  accountId: string,
  date: string,
) {
  return (plan.account_overdraft_versions ?? [])
    .filter((v) => v.account_id === accountId && v.effective_date <= date)
    .sort(
      (a, b) =>
        b.effective_date.localeCompare(a.effective_date) ||
        b.revision - a.revision,
    )[0];
}
export function overdraftPosition(
  account: Account,
  data: FinanceData,
  plan: PlanningData,
  date: string,
) {
  const bankBalance = balance(account, data.transactions, date);
  const terms = overdraftTerms(plan, account.id, date);
  const negative = Math.max(0, -bankBalance);
  const verified = terms?.statement_model === "negative_balance";
  const used = verified ? negative : null;
  const remaining =
    terms && verified
      ? terms.active && account.is_active
        ? Math.max(0, terms.limit_cents - negative)
        : 0
      : null;
  return {
    bankBalance,
    terms,
    negative,
    used,
    remaining,
    percent:
      used === null || !terms
        ? null
        : terms.limit_cents > 0
          ? (used * 100) / terms.limit_cents
          : used > 0
            ? null
            : 0,
    state: !verified
      ? "A conciliar"
      : negative === 0
        ? "Sem uso"
        : negative > terms.limit_cents
          ? "Acima do limite"
          : "Em uso",
  };
}
export function bankingSummary(
  data: FinanceData,
  plan: PlanningData,
  date: string,
) {
  return data.accounts.filter(isOperationalAccount).reduce(
    (s, a) => {
      const p = overdraftPosition(a, data, plan, date);
      s.positive += Math.max(0, p.bankBalance);
      s.negative += Math.min(0, p.bankBalance);
      s.net += p.bankBalance;
      s.additionalCredit += p.remaining ?? 0;
      if (p.terms?.active && p.remaining === null) s.unreconciled++;
      return s;
    },
    { positive: 0, negative: 0, net: 0, additionalCredit: 0, unreconciled: 0 },
  );
}
// End-of-day positions: a late entry recomputes every subsequent date. No cache
// of utilization, and no claim about intra-day order absent bank evidence.
export function overdraftHistory(
  account: Account,
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  const versions = (plan.account_overdraft_versions ?? []).filter(
    (v) => v.account_id === account.id,
  );
  const dates = new Set<string>([asOf]);
  for (const v of versions) {
    dates.add(v.tracking_start);
    dates.add(v.effective_date);
  }
  for (const t of data.transactions)
    if (
      isRealized(t, asOf) &&
      (t.account_id === account.id || t.destination_account_id === account.id)
    )
      dates.add(t.transaction_date);
  return [...dates]
    .filter((d) => d <= asOf)
    .sort()
    .map((date) => ({ date, ...overdraftPosition(account, data, plan, date) }));
}
export function overdraftCharges(
  account: Account,
  data: FinanceData,
  asOf: string,
) {
  const rows = data.transactions.filter(
    (t) =>
      t.account_id === account.id &&
      t.type === "expense" &&
      t.financial_charge &&
      isRealized(t, asOf),
  );
  return {
    rows,
    interest: rows
      .filter((t) => t.financial_charge === "overdraft_interest")
      .reduce((s, t) => s + t.amount_cents, 0),
    iof: rows
      .filter((t) => t.financial_charge === "overdraft_iof")
      .reduce((s, t) => s + t.amount_cents, 0),
  };
}
export function accountRecovery(
  account: Account,
  data: FinanceData,
  plan: PlanningData,
  asOf: string,
) {
  // Only explicitly assigned flows can recover this account. Unknown payment
  // accounts must never be silently allocated here to promise a recovery date.
  const scoped = {
    ...plan,
    credit_cards: plan.credit_cards.filter(
      (c) => c.payment_account_id === account.id,
    ),
    debts: plan.debts.filter((d) => d.payment_account_id === account.id),
  };
  const months = projection({ ...data, accounts: [account] }, scoped, asOf);
  const grouped = new Map<string, number>();
  for (const item of months.flatMap((m) => m.items)) {
    const date =
      (item.cashDate ?? item.due) < asOf ? asOf : (item.cashDate ?? item.due);
    grouped.set(date, (grouped.get(date) ?? 0) + item.impact);
  }
  let projected = balance(account, data.transactions, asOf);
  let recoveryDate: string | null = null;
  for (const [date, delta] of [...grouped].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    projected += delta;
    if (projected >= 0 && recoveryDate === null && delta !== 0)
      recoveryDate = date;
  }
  return {
    months,
    projected,
    recoveryDate:
      balance(account, data.transactions, asOf) < 0 ? recoveryDate : null,
  };
}
