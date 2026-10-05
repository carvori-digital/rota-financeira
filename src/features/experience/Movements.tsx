import { useState } from "react";
import {
  Search,
  SlidersHorizontal,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  CreditCard,
  Wallet,
  MoreHorizontal,
} from "lucide-react";
import type { FinanceData, Transaction } from "../../types";
import { today, displayDate } from "../../utils/finance";
import { Field, Status } from "../planning/ui";
import type { Money } from "../planning/ui";
const labels = {
  income: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
  card_payment: "Pagamento de fatura",
  adjustment: "Ajuste de saldo",
};
export function Movements({
  data,
  money,
  hidden,
  busy,
  onEdit,
  onDelete,
  onNew,
  onPending,
}: {
  data: FinanceData;
  money: Money;
  hidden: boolean;
  busy: boolean;
  onEdit: (t: Transaction) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onPending: () => void;
}) {
  const [search, setSearch] = useState(""),
    [filters, setFilters] = useState(false),
    [month, setMonth] = useState(today().slice(0, 7)),
    [account, setAccount] = useState(""),
    [type, setType] = useState("");
  const name = (id: string | null) =>
    data.accounts.find((a) => a.id === id)?.name ?? "Conta";
  const category = (id: string | null) =>
    data.categories.find((c) => c.id === id)?.name ?? "";
  const rows = [...data.transactions]
    .filter(
      (t) =>
        t.status !== "cancelled" &&
        (!month || t.transaction_date.startsWith(month)) &&
        (!account ||
          t.account_id === account ||
          t.destination_account_id === account) &&
        (!type || t.type === type) &&
        `${t.description} ${category(t.category_id)} ${name(t.account_id)}`
          .toLocaleLowerCase("pt-BR")
          .includes(search.toLocaleLowerCase("pt-BR")),
    )
    .sort(
      (a, b) =>
        b.transaction_date.localeCompare(a.transaction_date) ||
        b.created_at.localeCompare(a.created_at),
    );
  return (
    <div className="movements-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SEU EXTRATO</p>
          <h1>Movimentos</h1>
        </div>
        <button className="primary" onClick={onNew}>
          Novo
        </button>
      </div>
      <div className="statement-tools">
        <label className="statement-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Buscar movimentos"
            type="search"
            placeholder="Buscar movimentos"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          className={filters ? "filter-toggle active" : "filter-toggle"}
          aria-label="Filtros"
          aria-expanded={filters}
          onClick={() => setFilters(!filters)}
        >
          <SlidersHorizontal size={19} />
        </button>
      </div>
      {filters && (
        <div className="filters">
          <Field label="Mês">
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </Field>
          <Field label="Conta">
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">Todas</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Todos</option>
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="statement-caption">
        <span>
          {month ? month.split("-").reverse().join("/") : "Todos os meses"}
        </span>
        <span>{rows.length} movimentos</span>
      </div>
      <div className="panel statement-list">
        {rows.length ? (
          rows.map((t) => {
            const Icon = {
              income: ArrowDownLeft,
              expense: ArrowUpRight,
              transfer: ArrowLeftRight,
              card_payment: CreditCard,
              adjustment: Wallet,
            }[t.type];
            return (
              <article className="movement" key={t.id}>
                <span className={`movement-icon ${t.type}`} aria-hidden="true">
                  <Icon size={19} />
                </span>
                <div className="grow">
                  <strong>
                    {t.description || category(t.category_id) || labels[t.type]}
                  </strong>
                  <small>
                    {category(t.category_id)}
                    {category(t.category_id) && " · "}
                    {name(t.account_id)}
                    {t.type === "transfer" &&
                      ` → ${name(t.destination_account_id)}`}
                  </small>
                  <small>
                    {displayDate(t.transaction_date)}
                    {(t.status === "pending" ||
                      t.transaction_date > today()) && (
                      <>
                        {" "}
                        ·{" "}
                        <Status
                          state={
                            t.transaction_date > today()
                              ? "forecast"
                              : "pending"
                          }
                        />
                      </>
                    )}
                  </small>
                </div>
                <div className="row-end">
                  <strong className={t.type}>
                    {!hidden &&
                      (t.type === "expense" || t.type === "card_payment"
                        ? "−"
                        : t.type === "income"
                          ? "+"
                          : "")}
                    {money(t.amount_cents)}
                  </strong>
                  {t.status === "pending" && (
                    <button
                      className="text-link"
                      onClick={onPending}
                      aria-label={`Revisar: ${t.description || labels[t.type]}`}
                    >
                      Planejar
                    </button>
                  )}
                  {t.status !== "pending" &&
                    !t.payment_reference &&
                    !data.accounts.some(
                      (a) =>
                        a.investment_id &&
                        (a.id === t.account_id ||
                          a.id === t.destination_account_id),
                    ) &&
                    t.type !== "adjustment" && (
                      <details className="movement-menu">
                        <summary
                          aria-label={`Ações: ${t.description || labels[t.type]}`}
                        >
                          <MoreHorizontal size={18} />
                        </summary>
                        <div className="actions">
                          <button onClick={() => onEdit(t)}>Editar</button>
                          <button
                            disabled={busy}
                            onClick={() => onDelete(t.id)}
                          >
                            Excluir
                          </button>
                        </div>
                      </details>
                    )}
                </div>
              </article>
            );
          })
        ) : (
          <p className="empty">Nenhuma movimentação neste filtro.</p>
        )}
      </div>
    </div>
  );
}
