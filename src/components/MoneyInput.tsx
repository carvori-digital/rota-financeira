import { useState } from "react";
import type { InputHTMLAttributes } from "react";
import { digitMoney, pastedMoney } from "../utils/moneyInput";
import { inputMoney } from "../utils/finance";
type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type"
> & {
  cents?: number | null;
  hidden?: boolean;
  allowNegative?: boolean;
};
export function MoneyInput({
  cents,
  hidden = false,
  allowNegative = false,
  ...props
}: Props) {
  const [value, setValue] = useState(cents == null ? "" : inputMoney(cents));
  return (
    <input
      {...props}
      type={hidden ? "password" : "text"}
      inputMode="numeric"
      autoComplete="off"
      placeholder={hidden ? "••••" : "0,00"}
      value={value}
      onChange={(e) => {
        try {
          setValue(digitMoney(e.target.value, allowNegative));
          e.target.setCustomValidity("");
        } catch (error) {
          e.target.setCustomValidity((error as Error).message);
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        try {
          setValue(pastedMoney(e.clipboardData.getData("text"), allowNegative));
          e.currentTarget.setCustomValidity("");
        } catch (error) {
          e.currentTarget.setCustomValidity((error as Error).message);
          e.currentTarget.reportValidity();
        }
      }}
    />
  );
}
