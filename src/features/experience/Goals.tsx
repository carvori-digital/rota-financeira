import { Check, Target } from "lucide-react";
import type { FinanceData, Goal } from "../../types";
import { goalProgress, displayDate } from "../../utils/finance";
import type { Money } from "../planning/ui";
export function Goals({
  data,
  money,
  hidden,
  busy,
  onCreate,
  onEdit,
  onContribution,
  onArchive,
  onRemove,
}: {
  data: FinanceData;
  money: Money;
  hidden: boolean;
  busy: boolean;
  onCreate: () => void;
  onEdit: (g: Goal) => void;
  onContribution: (g: Goal) => void;
  onArchive: (g: Goal) => void;
  onRemove: (id: string) => void;
}) {
  const goals = data.goals.filter((g) => !g.is_emergency_reserve);
  return (
    <section className="goals-workspace">
      <div className="section-heading">
        <h2>Seus objetivos</h2>
        <button className="primary" onClick={onCreate}>
          + Criar
        </button>
      </div>
      {!goals.length && (
        <div className="panel empty">
          <Target size={26} />
          <p>Dê um nome ao seu próximo passo.</p>
          <button onClick={onCreate}>Criar objetivo</button>
        </div>
      )}
      {goals.map((g) => {
        const p = goalProgress(g, data.goal_contributions);
        return (
          <article className="goal panel" key={g.id}>
            <div className="section-heading">
              <h3>
                {g.name}
                {!g.is_active && " · Arquivado"}
              </h3>
              <span>{hidden ? "••••" : `${Math.round(p.percent)}%`}</span>
            </div>
            {!hidden && (
              <progress
                max={100}
                value={Math.min(100, p.percent)}
                aria-label={`Progresso: ${g.name}`}
              />
            )}
            <p>
              <strong>{money(p.accumulated)}</strong>
              <span className="muted"> de {money(g.target_amount_cents)}</span>
            </p>
            <small>
              Faltam {money(p.remaining)}
              {g.target_date && ` · Até ${displayDate(g.target_date)}`}
            </small>
            {p.percent >= 100 && !hidden && (
              <p className="milestone">
                <Check size={16} />
                Meta atingida.
              </p>
            )}
            <div className="actions">
              <button disabled={!g.is_active} onClick={() => onContribution(g)}>
                + Aporte
              </button>
              <button onClick={() => onEdit(g)}>Editar</button>
              <button disabled={busy} onClick={() => onArchive(g)}>
                {g.is_active ? "Arquivar" : "Reativar"}
              </button>
            </div>
            <details>
              <summary>Histórico de aportes</summary>
              {data.goal_contributions
                .filter((c) => c.goal_id === g.id)
                .map((c) => (
                  <div className="contribution" key={c.id}>
                    <small>
                      {displayDate(c.contribution_date)} ·{" "}
                      {c.description || "Aporte"} · {money(c.amount_cents)}
                    </small>
                    <button disabled={busy} onClick={() => onRemove(c.id)}>
                      Excluir
                    </button>
                  </div>
                ))}
              <p className="muted">
                Aportes em metas registram progresso; não movimentam contas.
              </p>
            </details>
          </article>
        );
      })}
    </section>
  );
}
