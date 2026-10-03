import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { FinanceData, Table } from "../types";
const empty: FinanceData = {
  accounts: [],
  categories: [],
  transactions: [],
  goals: [],
  goal_contributions: [],
};
export function useFinance(userId: string | undefined) {
  const [snapshot, setSnapshot] = useState<{
    owner: string | undefined;
    ready: boolean;
    data: FinanceData;
  }>({ owner: undefined, ready: false, data: empty });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    if (!userId || !supabase) {
      setSnapshot({ owner: userId, ready: false, data: empty });
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await Promise.all(
        (Object.keys(empty) as Table[]).map(async (table) => {
          const rows: unknown[] = [];
          for (let offset = 0; ; offset += 500) {
            const response = await supabase!
              .from(table)
              .select("*")
              .eq("user_id", userId)
              .order("id")
              .range(offset, offset + 499);
            if (response.error) throw response.error;
            rows.push(...response.data);
            if (response.data.length < 500) break;
          }
          return [table, rows];
        }),
      );
      if (run === generation.current)
        setSnapshot({
          owner: userId,
          ready: true,
          data: Object.fromEntries(result) as unknown as FinanceData,
        });
    } catch {
      if (run === generation.current) {
        setSnapshot({ owner: userId, ready: false, data: empty });
        setError(
          "Não foi possível carregar seus dados. Verifique a conexão e a configuração do banco.",
        );
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [userId]);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);
  useEffect(() => {
    setSnapshot({ owner: userId, ready: false, data: empty });
    void refresh();
    return invalidate;
  }, [refresh, invalidate, userId]);
  useEffect(() => {
    if (!userId) return;
    const whenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    const timer = window.setInterval(whenVisible, 60000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [userId, refresh]);
  return {
    data: snapshot.owner === userId ? snapshot.data : empty,
    loading: loading || snapshot.owner !== userId,
    error,
    ready: snapshot.owner === userId && snapshot.ready,
    refresh,
  };
}
