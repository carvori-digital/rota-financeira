import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  isValidElement,
} from "react";
import {
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  CalendarPlus,
  CreditCard,
  Wallet,
  Landmark,
  Target,
} from "lucide-react";
function QuickActionIcon({ kind }: { kind: string }) {
  const Icon =
    (
      {
        expense: ArrowUpRight,
        income: ArrowDownLeft,
        transfer: ArrowLeftRight,
        schedule: CalendarPlus,
        purchase: CreditCard,
        payment: Wallet,
        installment: Landmark,
        contribution: Target,
      } as Record<string, typeof Wallet>
    )[kind] ?? Wallet;
  return <Icon size={24} strokeWidth={1.8} aria-hidden="true" />;
}
import type { ReactNode, ReactElement, FormEvent } from "react";
import { inputMoney, parseMoney } from "../../utils/finance";
export type Money = (cents: number) => ReactNode;
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <label className="field">
      <span id={labelId}>{label}</span>
      {isValidElement(children)
        ? cloneElement(
            children as ReactElement<{ "aria-labelledby"?: string }>,
            { "aria-labelledby": labelId },
          )
        : children}
    </label>
  );
}
export function Amount({
  label = "Valor (R$)",
  name = "amount",
  value,
  hidden,
  optional = false,
}: {
  label?: string;
  name?: string;
  value?: number | null;
  hidden: boolean;
  optional?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        type={hidden ? "password" : "text"}
        inputMode="decimal"
        required={!optional}
        defaultValue={value == null ? "" : inputMoney(value)}
        placeholder="0,00"
        autoComplete="off"
      />
    </Field>
  );
}
export function cents(form: FormData, name = "amount", optional = false) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw && optional) return null;
  return parseMoney(raw);
}
export function text(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}
export function Modal({
  title,
  children,
  onClose,
  onSubmit,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: (form: FormData) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false),
    [closing, setClosing] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  function close(action = onClose) {
    if (closing) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      action();
      return;
    }
    setClosing(true);
    timer.current = setTimeout(action, 140);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || closing) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(new FormData(e.currentTarget));
      close();
    } catch (err) {
      setError(
        (err as { message?: string }).message ??
          "Não foi possível salvar. Tente novamente.",
      );
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className={closing ? "is-closing" : ""}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <div className="section-heading">
          <h2>{title}</h2>
          <button
            type="button"
            disabled={busy || closing}
            aria-label="Fechar"
            onClick={() => close()}
          >
            ×
          </button>
        </div>
        <fieldset disabled={busy || closing}>
          {children}
          {error && <p role="alert">{error}</p>}
          <button type="submit" className="primary">
            {busy ? "Salvando…" : "Salvar"}
          </button>
        </fieldset>
      </form>
    </dialog>
  );
}
export function Status({
  state,
}: {
  state: "realized" | "forecast" | "pending" | "skipped";
}) {
  return (
    <span className={`status status-${state}`}>
      {
        {
          realized: "Realizado",
          forecast: "Previsto",
          pending: "Pendente",
          skipped: "Pulada",
        }[state]
      }
    </span>
  );
}
export function QuickActions({
  onSelect,
  onClose,
  goals = [],
  invoices = [],
}: {
  onSelect: (kind: string) => void;
  onClose: () => void;
  goals?: { id: string; name: string }[];
  invoices?: { id: string; name: string }[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [contribution, setContribution] = useState(false);
  const [payment, setPayment] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label="Nova movimentação"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="section-heading">
        <h2>
          {contribution
            ? "Aporte ou transferência"
            : payment
              ? "Pagamento"
              : "Novo movimento"}
        </h2>
        <button aria-label="Fechar" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="quick-actions">
        {(payment
          ? [
              ["debtPayment", "Pagamento de dívida"],
              ...invoices.map((i) => [
                `cardPayment:${i.id}`,
                `Pagar ${i.name}`,
              ]),
            ]
          : contribution
            ? [
                ["transfer", "Transferir entre contas"],
                ...goals.map((g) => [
                  `contribution:${g.id}`,
                  `Aportar em ${g.name}`,
                ]),
              ]
            : [
                ["expense", "Despesa"],
                ["income", "Receita"],
                ["transfer", "Transferência"],
                ["schedule", "Programar"],
                ["purchase", "Compra no cartão"],
                ["payment", "Pagamento"],
                ["installment", "Dívida / parcelamento"],
                ["contribution", "Aporte/transferência"],
              ]
        ).map(([kind, label]) => (
          <button
            key={kind}
            onClick={() =>
              kind === "contribution"
                ? setContribution(true)
                : kind === "payment"
                  ? setPayment(true)
                  : onSelect(kind)
            }
          >
            <QuickActionIcon kind={kind} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {(contribution || payment) && (
        <>
          {contribution && (
            <p className="muted">
              Transferências movimentam dinheiro. Aportes em metas registram
              progresso.
            </p>
          )}
          {payment && !invoices.length && (
            <p className="muted">
              Sem faturas pendentes. Cartões ficam em Planejar.
            </p>
          )}
          <button
            onClick={() => {
              setContribution(false);
              setPayment(false);
            }}
          >
            Voltar
          </button>
        </>
      )}
    </dialog>
  );
}
