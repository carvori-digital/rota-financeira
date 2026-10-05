import { useState } from "react";
import type { PlanningData } from "../planning/types";
import type { FinanceData } from "../../types";
import { rpc } from "../planning/queries";
export function ClassificationReviews({
  data,
  plan,
  onSaved,
}: {
  data: FinanceData;
  plan: PlanningData;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const reviews = plan.classification_reviews ?? [];
  return (
    <details className="panel">
      <summary>
        Revisar classificação ·{" "}
        {reviews.filter((r) => r.status === "pending").length} pendentes
      </summary>
      <p className="muted">
        Os valores foram preservados. Confira os registros na área
        correspondente antes de confirmar a classificação.
      </p>
      {error && <p role="alert">{error}</p>}
      {reviews.map((r) => {
        const row = (
          [
            ...data.accounts,
            ...data.transactions,
            ...plan.card_purchases,
            ...plan.debts,
          ] as { id: string; name?: string; description?: string }[]
        ).find((x) => x.id === r.source_id);
        return (
          <article className="invoice-block" key={r.id}>
            <strong>
              {row?.name || row?.description || "Registro para revisão"}
            </strong>
            <p>{r.reason}</p>
            {r.status === "pending" ? (
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Confirma que este registro deve manter a classificação atual?",
                    )
                  )
                    return;
                  setBusy(true);
                  setError("");
                  try {
                    await rpc("keep_classification", {
                      p_id: r.id,
                      p_resolution:
                        "Usuário conferiu e confirmou a classificação atual.",
                    });
                    await onSaved();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Manter classificação atual
              </button>
            ) : (
              <small>Classificação conferida · {r.resolution}</small>
            )}
          </article>
        );
      })}
      {!reviews.length && <p>Nenhuma classificação pendente.</p>}
    </details>
  );
}
