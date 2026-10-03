import { useCallback, useEffect, useRef, useState } from "react";
import { emptyPlanning } from "./types";
import type { PlanningData } from "./types";
import { loadPlanning } from "./queries";
export function usePlanning(user: string | undefined) {
  const [snapshot, setSnapshot] = useState<{
    owner: string | undefined;
    ready: boolean;
    data: PlanningData;
  }>({ owner: undefined, ready: false, data: emptyPlanning });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    if (!user) {
      setSnapshot({ owner: user, ready: false, data: emptyPlanning });
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await loadPlanning(user);
      if (run === generation.current)
        setSnapshot({ owner: user, ready: true, data });
    } catch {
      if (run === generation.current) {
        setSnapshot({ owner: user, ready: false, data: emptyPlanning });
        setError(
          "Não foi possível carregar o planejamento. Confira a conexão e a migration V0.2.",
        );
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [user]);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);
  useEffect(() => {
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 60000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return {
    data: snapshot.owner === user ? snapshot.data : emptyPlanning,
    loading: loading || snapshot.owner !== user,
    error,
    ready: snapshot.owner === user && snapshot.ready,
    refresh,
  };
}
