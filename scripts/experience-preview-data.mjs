// This adapter exists only in the explicit local preview server. No real client,
// credentials, remote request or persistent data write can be made here.
const date = new Date();
const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const month = day.slice(0, 7),
  user = "local-preview";
const base = { user_id: user, created_at: `${month}-01T12:00:00Z` };
const account = (id, name, type, amount) => ({
  ...base,
  id,
  name,
  type,
  initial_balance_cents: amount,
  currency: "BRL",
  is_active: true,
});
const transaction = (
  id,
  type,
  amount,
  description,
  category_id,
  transaction_date = day,
) => ({
  ...base,
  id,
  type,
  amount_cents: amount,
  description,
  category_id,
  transaction_date,
  account_id: "cash",
  destination_account_id: null,
  status: "realized",
  is_recurring: false,
  recurrence_frequency: null,
});
const rows = {
  accounts: [
    account("cash", "Conta principal", "checking", 150000),
    account("reserve", "Reserva de emergência", "savings", 240000),
  ],
  categories: [
    { ...base, id: "salary", name: "Salário", type: "income" },
    { ...base, id: "food", name: "Alimentação", type: "expense" },
    { ...base, id: "home", name: "Moradia", type: "expense" },
    { ...base, id: "leisure", name: "Lazer", type: "expense" },
  ],
  transactions: [
    transaction("salary-now", "income", 650000, "Salário", "salary"),
    transaction("food-now", "expense", 45000, "Mercado da semana", "food"),
    transaction("home-now", "expense", 150000, "Aluguel", "home"),
    transaction("leisure-now", "expense", 25000, "Fim de semana", "leisure"),
    {
      ...transaction(
        "bill-now",
        "card_payment",
        55000,
        "Pagamento de fatura",
        null,
      ),
      payment_reference: "card",
    },
    {
      ...transaction(
        "scheduled",
        "expense",
        32000,
        "Seguro do carro",
        "home",
        `${month}-18`,
      ),
      status: "pending",
      planning_group: "scheduled",
    },
  ],
  goals: [
    {
      ...base,
      id: "travel",
      name: "Próxima viagem",
      target_amount_cents: 500000,
      initial_amount_cents: 290000,
      target_date: null,
      is_active: true,
      is_emergency_reserve: false,
    },
    {
      ...base,
      id: "reserve-goal",
      name: "Reserva de emergência",
      target_amount_cents: 600000,
      initial_amount_cents: 0,
      target_date: null,
      is_active: true,
      is_emergency_reserve: true,
      essential_monthly_cents: 100000,
      reserve_months: 6,
    },
  ],
  goal_contributions: [],
  credit_cards: [
    {
      ...base,
      id: "card",
      name: "Meu cartão",
      limit_cents: 1200000,
      closing_day: 20,
      due_day: 28,
      payment_account_id: "cash",
      active: true,
    },
  ],
  card_purchases: [
    {
      ...base,
      id: "purchase",
      card_id: "card",
      category_id: "leisure",
      amount_cents: 90000,
      description: "Notebook · 3 parcelas",
      purchase_date: day,
      installments: 3,
      first_due_date: `${month}-28`,
      due_anchor_day: 28,
    },
  ],
  card_invoices: [
    {
      ...base,
      id: "invoice",
      card_id: "card",
      due_month: month,
      due_date: `${month}-28`,
      amount_cents: 100000,
      description: "Fatura atual",
      covered_at: `${month}-01T15:00:00Z`,
    },
  ],
  card_payments: [
    {
      ...base,
      id: "payment",
      card_id: "card",
      due_month: month,
      transaction_id: "bill-now",
      amount_cents: 55000,
      payment_date: day,
    },
  ],
  debts: [
    {
      ...base,
      id: "debt",
      name: "Financiamento pessoal",
      original_amount_cents: 800000,
      remaining_amount_cents: 310000,
      installment_amount_cents: 35000,
      next_due_date: `${month}-10`,
      due_anchor_day: 10,
      installment_paid_cents: 0,
      payment_account_id: "cash",
      active: true,
      installment_number: 15,
      total_installments: 23,
    },
  ],
  debt_payments: [],
  recurring_items: [
    {
      ...base,
      id: "internet",
      name: "Internet de casa",
      type: "expense",
      amount_cents: 9900,
      account_id: "cash",
      category_id: "home",
      frequency: "monthly",
      start_date: `${month}-12`,
      end_date: null,
      active: true,
      is_essential: true,
    },
    {
      ...base,
      id: "freelance",
      name: "Projeto freelance",
      type: "income",
      amount_cents: 150000,
      account_id: "cash",
      category_id: "salary",
      frequency: "monthly",
      start_date: `${month}-20`,
      end_date: null,
      active: true,
      is_essential: false,
    },
  ],
  recurring_occurrences: [],
  reserve_account_links: [
    { ...base, id: "link", goal_id: "reserve-goal", account_id: "reserve" },
  ],
};
for (let i = 1; i <= 3; i++) {
  const d = new Date(date.getFullYear(), date.getMonth() - i, 1),
    period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  rows.transactions.push(
    transaction(`income-${i}`, "income", 500000, "Salário", "salary", period),
    transaction(
      `expense-${i}`,
      "expense",
      i === 1 ? 620000 : 500000,
      "Despesas do mês",
      "home",
      period,
    ),
  );
}
export const supabase = {
  auth: {
    onAuthStateChange(callback) {
      queueMicrotask(() =>
        callback("INITIAL_SESSION", {
          user: { id: user, email: "preview@local.invalid" },
        }),
      );
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      return { error: { message: "Prévia local." } };
    },
  },
  from(table) {
    let mutation = false;
    const result = () => ({
      data: structuredClone(rows[table] ?? []),
      error: mutation
        ? {
            message:
              "Prévia somente para revisão visual. Nenhum dado foi salvo.",
          }
        : null,
    });
    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      order() {
        return query;
      },
      range: async (start, end) => ({
        ...result(),
        data: result().data.slice(start, end + 1),
      }),
      upsert() {
        mutation = true;
        return query;
      },
      update() {
        mutation = true;
        return query;
      },
      delete() {
        mutation = true;
        return query;
      },
      then(resolve) {
        return Promise.resolve(result()).then(resolve);
      },
    };
    return query;
  },
  async rpc() {
    return {
      data: null,
      error: {
        message: "Prévia somente para revisão visual. Nenhum dado foi salvo.",
      },
    };
  },
};
