import type { FinancialExport } from "./calculations.ts";
const decimal = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
export function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/u.test(s) || /^[\t\r\n]/u.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function financialCsv(r: FinancialExport): string {
  const rows: unknown[][] = [
    [
      "data",
      "descricao",
      "tipo",
      "categoria",
      "valor_brl",
      "status",
      "origem",
      "referencia",
      "efeito_resultado_brl",
    ],
  ];
  const add = (
    date: unknown,
    description: unknown,
    type: unknown,
    category: unknown,
    amount: unknown,
    status: unknown,
    origin: string,
    reference: unknown,
    effect: unknown = 0,
  ) =>
    rows.push([
      date,
      description,
      type,
      category,
      decimal(Number(amount ?? 0)),
      status,
      origin,
      reference,
      decimal(Number(effect ?? 0)),
    ]);
  const x = r.realized;
  add(
    r.period.end,
    "Receitas do período",
    "resumo",
    "",
    x.income_cents,
    "REALIZADO",
    "resumo",
    "",
    x.income_cents,
  );
  add(
    r.period.end,
    "Despesas do período",
    "resumo",
    "",
    x.expense_cents,
    "REALIZADO",
    "resumo",
    "",
    -x.expense_cents,
  );
  add(
    r.period.end,
    "Resultado do período",
    "resumo",
    "",
    x.result_cents,
    "REALIZADO",
    "resumo",
    "",
  );
  for (const [name, amount] of Object.entries({
    "Despesas fixas": x.fixed_expenses_cents,
    "Despesas variáveis": x.variable_expenses_cents,
    "Despesas programadas": x.scheduled_expenses_cents,
    "Obrigações pendentes": r.scheduled.remaining_cents,
    "Reserva atual": r.estimated.reserve_cents,
    "Patrimônio bruto": r.estimated.wealth.gross_cents,
    "Patrimônio líquido": r.estimated.wealth.net_cents,
  }))
    add(
      r.period.end,
      name,
      "resumo",
      "",
      amount,
      name.includes("Patrimônio")
        ? "ESTIMADO"
        : name === "Obrigações pendentes"
          ? "PROGRAMADO"
          : "REGISTRADO",
      "resumo",
      "",
    );
  for (const m of r.projected.months)
    add(
      m.month,
      "Saldo projetado",
      "projecao",
      "",
      m.closing,
      "PROJETADO",
      "projecao",
      m.month,
    );
  for (const c of r.scheduled.commitments)
    add(
      c.due,
      c.name,
      c.source,
      c.group,
      c.amount,
      c.status === "completed" ? "CONCLUIDO" : "PROGRAMADO",
      "compromisso",
      c.references.join("|") || c.id,
    );
  for (const warning of r.warnings)
    rows.push(["", warning, "observacao", "", "", "", "observacao", "", ""]);
  if (r.details) {
    for (const t of r.details.transactions) {
      const realized =
        t.status !== "pending" &&
        t.status !== "cancelled" &&
        String(t.transaction_date) <= r.estimated.as_of;
      const effect = realized
        ? t.type === "income"
          ? Number(t.amount_cents)
          : t.type === "expense"
            ? -Number(t.amount_cents)
            : 0
        : 0;
      add(
        t.transaction_date,
        t.description,
        t.type,
        r.categories.find((c) => c.id === t.category_id)?.name ??
          "Sem categoria",
        t.amount_cents,
        realized
          ? "REALIZADO"
          : t.status === "cancelled"
            ? "CANCELADO"
            : "PROGRAMADO",
        "transactions",
        `${t.id}|conta:${t.account_id}`,
        effect,
      );
    }
    for (const p of r.details.card_purchases)
      add(
        p.purchase_date,
        p.description,
        "compra_cartao",
        r.categories.find((c) => c.id === p.category_id)?.name,
        p.amount_cents,
        p.cancelled_at ? "CANCELADO" : "REALIZADO",
        "card_purchases",
        `${p.id}|cartao:${p.card_id}`,
        p.cancelled_at ? 0 : -Number(p.amount_cents),
      );
    for (const a of r.details.card_adjustments)
      add(
        a.due_date,
        a.description,
        "ajuste_fatura",
        "",
        a.amount_cents,
        String(a.due_date) <= r.estimated.as_of ? "REALIZADO" : "PROGRAMADO",
        "card_adjustments",
        `${a.id}|compra:${a.purchase_id}`,
        String(a.due_date) <= r.estimated.as_of ? -Number(a.amount_cents) : 0,
      );
    for (const m of r.details.investment_movements)
      add(
        m.date,
        m.description,
        m.type,
        "",
        m.amount_cents,
        m.accounting_kind === "historical_position"
          ? "HISTORICO_SEM_CAIXA"
          : m.type === "adjustment"
            ? "VALORIZACAO"
            : "REALIZADO",
        "investment_movements",
        `${m.id}|investimento:${m.investment_id}|transacao:${m.transaction_id ?? ""}`,
      );
  }
  // Summary rows and audit rows are different sources, never sum the whole file.
  rows.push([
    "",
    "Filtre origem=transactions/card_purchases/card_adjustments antes de somar efeito_resultado. Resumos e compromissos não são lançamentos adicionais.",
    "observacao",
    "",
    "",
    "",
    "observacao",
    "",
    "",
  ]);
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(";")).join("\r\n") +
    "\r\n"
  );
}
export function financialJson(r: FinancialExport) {
  return JSON.stringify(r, null, 2);
}
export async function financialPdf(r: FinancialExport): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = 32;
  const money = (n: number) =>
    new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(n / 100);
  const header = () => {
    doc.setFillColor(36, 62, 50);
    doc.rect(0, 0, 210, 23, "F");
    doc.setTextColor(255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("ROTA FINANCEIRA", 16, 15);
    doc.setTextColor(35);
  };
  header();
  const line = (s: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    const lines = doc.splitTextToSize(s, 177) as string[];
    for (const l of lines) {
      if (y > 273) {
        doc.addPage();
        header();
        y = 32;
      }
      doc.text(l, 16, y);
      y += bold ? 7 : 5;
    }
    y += 2;
  };
  const pair = (label: string, n: number) => line(`${label}: ${money(n)}`);
  line(`Relatório ${r.mode === "detailed" ? "detalhado" : "resumido"}`, true);
  line(
    `Período: ${r.period.start.split("-").reverse().join("/")} a ${r.period.end.split("-").reverse().join("/")}`,
  );
  line(
    `Gerado: ${new Date(r.generated_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (Brasília)`,
  );
  line("Fluxo REALIZADO", true);
  pair("Receitas", r.realized.income_cents);
  pair("Despesas", r.realized.expense_cents);
  pair("Resultado", r.realized.result_cents);
  pair("Despesas fixas", r.realized.fixed_expenses_cents);
  pair("Despesas variáveis", r.realized.variable_expenses_cents);
  pair("Despesas programadas realizadas", r.realized.scheduled_expenses_cents);
  line("Compromissos PROGRAMADOS", true);
  pair("Obrigações ainda pendentes", r.scheduled.remaining_cents);
  for (const c of r.scheduled.commitments)
    line(
      `${c.due} | ${c.name} | ${c.status === "completed" ? "Concluído" : "Pendente"} | ${money(c.amount)} | Pago: ${money(c.paid)}`,
    );
  line("Posição atual / ESTIMADA", true);
  pair("Dívidas e parcelas restantes", r.estimated.wealth.debts_cents);
  pair("Cartões / faturas pendentes", r.estimated.wealth.cards_cents);
  pair("Disponível", r.estimated.wealth.available_cents);
  pair("Investimentos (inclui reserva)", r.estimated.wealth.invested_cents);
  pair("Reserva de emergência", r.estimated.reserve_cents);
  pair("Patrimônio bruto", r.estimated.wealth.gross_cents);
  pair("Patrimônio líquido", r.estimated.wealth.net_cents);
  for (const i of r.investments) {
    const pos = r.estimated.positions.find((p) => p.investment_id === i.id);
    if (pos)
      line(
        `${i.name} | ${i.institution} | ${money(pos.current_cents)} | Aportado: ${money(pos.contributed_cents)} | Rendimento: ${pos.estimated_yield_cents === null ? "indisponível" : money(pos.estimated_yield_cents)}`,
      );
  }
  line("Indicadores para autonomia financeira", true);
  pair("Gastos fixos mensais cadastrados", r.indicators.fixed_monthly_cents);
  line(
    `Meses completos considerados: ${r.indicators.complete_months.join(", ") || "nenhum confirmado"}`,
  );
  line(
    `Média de despesas em meses completos: ${r.indicators.average_expenses_complete_months_cents === null ? "indisponível" : money(r.indicators.average_expenses_complete_months_cents)}`,
  );
  line(
    `Meses de proteção: ${r.indicators.protection_months === null ? "indisponível" : r.indicators.protection_months.toFixed(2)}`,
  );
  line(
    `Poupança média observada em meses completos: ${r.indicators.observed_savings_cents === null ? "indisponível" : money(r.indicators.observed_savings_cents)}`,
  );
  line("Projeção futura (PROJETADO)", true);
  for (const m of r.projected.months)
    line(
      `${m.month} | Entradas: ${money(m.income)} | Saídas: ${money(m.commitments)} | Saldo: ${money(m.closing)}`,
    );
  if (r.details) {
    line("Movimentações detalhadas", true);
    for (const t of r.details.transactions)
      line(
        `${t.transaction_date} | ${t.description} | ${t.type} | ${t.status ?? "realized"} | ${money(Number(t.amount_cents))} | Ref.: ${t.id}`,
      );
    for (const t of r.details.card_purchases)
      line(
        `${t.purchase_date} | ${t.description} | Compra cartão | ${t.cancelled_at ? "Cancelada" : "Realizada"} | ${money(Number(t.amount_cents))} | Ref.: ${t.id}`,
      );
    for (const t of r.details.card_adjustments)
      line(
        `${t.due_date} | ${t.description} | Ajuste fatura | ${money(Number(t.amount_cents))} | Ref.: ${t.id}`,
      );
    for (const t of r.details.investment_movements)
      line(
        `${t.date} | ${t.description} | ${t.type} | ${t.accounting_kind ?? "histórico legado"} | ${money(Number(t.amount_cents))} | Ref.: ${t.id}`,
      );
  }
  line("Completude, premissas e privacidade", true);
  for (const w of r.warnings) line(w);
  line(r.privacy);
  const pages = doc.getNumberOfPages();
  for (let n = 1; n <= pages; n++) {
    doc.setPage(n);
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Privado - Rota Financeira | ${n}/${pages}`, 16, 288);
  }
  doc.setProperties({
    title: "Rota Financeira - Relatório financeiro",
    subject: r.period.start + " a " + r.period.end,
  });
  return doc.output("blob");
}
export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
