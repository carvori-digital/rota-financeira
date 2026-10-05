import { inputMoney } from "./finance.ts";
export function digitMoney(raw: string, allowNegative = false) {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return allowNegative && raw.trim() === "-" ? "-" : "";
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents) || cents > 1_000_000_000_000)
    throw new Error("Valor fora do limite permitido.");
  return inputMoney(
    allowNegative && raw.trim().startsWith("-") ? -cents : cents,
  );
}
export function pastedMoney(raw: string, allowNegative = false) {
  const value = raw.trim().replace(/^R\$\s*/, "");
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(value))
    throw new Error("Cole um valor como R$ 1.234,56.");
  if (value.startsWith("-") && !allowNegative)
    throw new Error("Use um valor positivo.");
  const [whole, fraction] = value.replace(/\./g, "").split(",");
  return digitMoney(
    fraction === undefined ? whole : whole + fraction.padEnd(2, "0"),
    allowNegative,
  );
}
