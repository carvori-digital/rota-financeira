import { useState } from "react";
import { rpc } from "./queries";

export function DeleteRecord({
  id,
  kind,
  onSaved,
  blocked,
  explanation,
}: {
  id: string;
  kind: "purchase" | "goal" | "investment" | "card" | "debt" | "recurring";
  onSaved: () => Promise<void>;
  blocked?: string;
  explanation?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <details>
      <summary>Ações do registro</summary>
      {explanation && <p className="muted">{explanation}</p>}
      {blocked && <p className="muted">{blocked}</p>}
      <button
        type="button"
        disabled={busy || !!blocked}
        onClick={async () => {
          if (
            busy ||
            !window.confirm(
              "Excluir definitivamente?\nEste registro será removido dos cálculos." +
                (explanation ? "\n" + explanation : ""),
            )
          )
            return;
          setBusy(true);
          setError("");
          try {
            const name = {
              purchase: "delete_card_purchase",
              goal: "delete_goal",
              investment: "delete_investment",
            };
            if (kind === "purchase" || kind === "goal" || kind === "investment")
              await rpc(name[kind], { p_id: id });
            else await rpc("delete_unused_record", { p_kind: kind, p_id: id });
            await onSaved();
          } catch (e) {
            setError(
              (e as { message?: string }).message ??
                "Não foi possível excluir. Atualize e tente novamente.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Excluindo…" : "Excluir"}
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
