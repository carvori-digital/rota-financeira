import { Check, ChevronRight } from "lucide-react";
import type { ReturnTypeReport } from "./Dashboard";
export function MonthlyProgress({
  report: r,
  onPlan,
  hidden,
}: {
  report: ReturnTypeReport;
  onPlan: () => void;
  hidden: boolean;
}) {
  return (
    <section className="panel monthly-progress">
      <div className="section-heading">
        <h2>Progresso do mês</h2>
        <button
          className="icon-link"
          onClick={onPlan}
          aria-label="Revisar compromissos"
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="progress-caption">
        <strong>
          {r.completed} de {r.total}
        </strong>
        <span>compromissos concluídos</span>
      </div>
      {!hidden && (
        <progress
          value={r.percent}
          max={100}
          aria-label="Compromissos concluídos"
        />
      )}
      {r.total > 0 && r.completed === r.total && (
        <p className="milestone">
          <Check size={16} /> Compromissos do mês em dia.
        </p>
      )}
      {r.total === 0 && (
        <p className="muted">
          Seu próximo passo: planejar o primeiro compromisso.
        </p>
      )}
      <details className="progress-details">
        <summary>Como está meu mês?</summary>
        <p className="muted">
          Contamos saídas do disponível concluídas e ainda previstas no mês.
          Pagamentos parciais não concluem faturas ou parcelas. Receitas e
          transferências entre contas disponíveis não entram nesta barra.
        </p>
        <ul className="month-checklist">
          <li>
            <Check
              size={16}
              className={
                r.pending.length === 0 && r.completed > 0
                  ? "checked"
                  : "unchecked"
              }
            />
            {r.pending.length
              ? `${r.pending.length} compromissos para concluir`
              : r.completed
                ? "Compromissos concluídos"
                : "Cadastre seus compromissos"}
          </li>
          {(r.incoming > 0 || r.actual.income > 0) && (
            <li>
              <Check
                size={16}
                className={r.incoming === 0 ? "checked" : "unchecked"}
              />
              {r.incoming > 0
                ? "Receitas previstas para confirmar"
                : "Renda do mês registrada"}
            </li>
          )}
          {r.groups.find((g) => g.key === "cards")!.items.length > 0 && (
            <li>
              <Check size={16} className="unchecked" />
              Faturas aguardando pagamento
            </li>
          )}
          {r.paidItems.some((t) => t.type === "transfer") && (
            <li>
              <Check size={16} className="checked" />
              Transferência para reserva registrada
            </li>
          )}
        </ul>
        <button onClick={onPlan}>Revisar mês</button>
      </details>
    </section>
  );
}
