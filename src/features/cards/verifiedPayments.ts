import type { Transaction } from "../../types/index.ts";
import type { CardPayment } from "./types.ts";
import { isRealized } from "../../utils/finance.ts";
export function verifiedCardPayments(
  transactions: Transaction[],
  payments: CardPayment[],
  asOf: string,
) {
  return payments.filter(
    (p) =>
      p.payment_date <= asOf &&
      transactions.some(
        (t) =>
          t.id === p.transaction_id &&
          t.type === "card_payment" &&
          t.amount_cents === p.amount_cents &&
          isRealized(t, asOf),
      ),
  );
}
