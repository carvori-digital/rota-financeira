import { useEffect, useRef, useState } from "react";
import type { FinanceData } from "../../types";
import type { PlanningData } from "./types";
export function QuickSetup({
  data,
  plan,
  paused,
  onAction,
  onClose,
}: {
  data: FinanceData;
  plan: PlanningData;
  paused: boolean;
  onAction: (kind: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [step, setStep] = useState(0);
  useEffect(() => {
    if (paused) ref.current?.close();
    else ref.current?.showModal();
  }, [paused]);
  const steps = [
    ["Contas e saldo atual", "account", "Adicionar conta"],
    ["Renda / salário", "salary", "Cadastrar renda recorrente"],
    ["Contas fixas", "recurring", "Cadastrar conta fixa"],
    ["Despesas programadas", "schedule", "Agendar compromisso"],
    ["Cartões e fatura atual", "card", "Adicionar cartão"],
    ["Parcelas / dívidas existentes", "installment", "Cadastrar parcelamento"],
    ["Reserva / investimentos", "reserve", "Configurar reserva"],
  ];
  const current = steps[step];
  return (
    <dialog
      ref={ref}
      aria-label="Configuração rápida"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="section-heading">
        <h2>Configuração rápida · {step + 1}/7</h2>
        <button aria-label="Fechar" onClick={onClose}>
          ×
        </button>
      </div>
      <h3>{current[0]}</h3>
      <p>
        Comece com os valores atuais. Você pode incluir mais de um item e
        complementar depois.
      </p>
      <button className="primary" onClick={() => onAction(current[1])}>
        {current[2]}
      </button>
      {step === 0 &&
        data.accounts
          .filter((a) => a.is_active)
          .map((a) => (
            <button key={a.id} onClick={() => onAction("adjust:" + a.id)}>
              Sincronizar {a.name}
            </button>
          ))}
      {step === 4 &&
        plan.credit_cards
          .filter((c) => c.active)
          .map((c) => (
            <button key={c.id} onClick={() => onAction("invoice:" + c.id)}>
              Informar fatura de {c.name}
            </button>
          ))}
      {step === 6 && (
        <button onClick={() => onAction("investments")}>
          Abrir investimentos
        </button>
      )}
      <div className="actions">
        {step > 0 && (
          <button onClick={() => setStep(step - 1)}>Anterior</button>
        )}
        <button
          className="primary"
          onClick={() => (step === 6 ? onClose() : setStep(step + 1))}
        >
          {step === 6 ? "Ver minha Home" : "Continuar / pular etapa"}
        </button>
      </div>
      <small>
        Registre cada informação uma vez. Home e projeção serão calculadas
        automaticamente.
      </small>
    </dialog>
  );
}
