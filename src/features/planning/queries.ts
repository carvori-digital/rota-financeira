import { supabase } from "../../lib/supabase";
import { emptyPlanning } from "./types";
import type { PlanningData } from "./types";
export async function loadPlanning(user: string): Promise<PlanningData> {
  const entries = await Promise.all(
    Object.keys(emptyPlanning).map(async (table) => {
      const rows: unknown[] = [];
      for (let offset = 0; ; offset += 500) {
        const r = await supabase!
          .from(table)
          .select("*")
          .eq("user_id", user)
          .order("id")
          .range(offset, offset + 499);
        if (r.error) throw r.error;
        rows.push(...r.data);
        if (r.data.length < 500) break;
      }
      return [table, rows];
    }),
  );
  return Object.fromEntries(entries) as unknown as PlanningData;
}
export async function rpc(name: string, args: Record<string, unknown>) {
  const r = await supabase!.rpc(name, args);
  if (r.error) throw r.error;
  return r.data;
}
export async function save(
  table: string,
  id: string,
  payload: Record<string, unknown>,
  existing = false,
) {
  if (table === "card_purchases") {
    if (existing) throw new Error("Use a correção auditável de compras");
    return rpc("create_card_purchase", { p_id: id, p_payload: payload });
  }
  const query = supabase!.from(table);
  const r = await (
    existing
      ? query.update(payload).eq("id", id)
      : query.upsert({ ...payload, id }, { onConflict: "id" })
  ).select("id");
  if (r.error) throw r.error;
  if (!r.data?.length) throw new Error("Registro não salvo");
}
