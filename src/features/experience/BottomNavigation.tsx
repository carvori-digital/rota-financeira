import {
  House,
  ArrowLeftRight,
  CirclePlus,
  CalendarRange,
  ChartNoAxesCombined,
  Settings,
} from "lucide-react";
export function BottomNavigation({
  page,
  onNavigate,
  onNew,
  disabled,
}: {
  page: string;
  onNavigate: (page: string) => void;
  onNew: () => void;
  disabled: boolean;
}) {
  return (
    <nav aria-label="Navegação principal" className="bottom-navigation">
      {[
        { id: "home", label: "Início", Icon: House },
        { id: "history", label: "Movimentos", Icon: ArrowLeftRight },
        { id: "add", label: "Novo", Icon: CirclePlus },
        { id: "planning", label: "Planejar", Icon: CalendarRange },
        { id: "reports", label: "Relatórios", Icon: ChartNoAxesCombined },
        { id: "settings", label: "Ajustes", Icon: Settings },
      ].map(({ id, label, Icon }) => (
        <button
          key={id}
          aria-label={label}
          aria-current={page === id ? "page" : undefined}
          disabled={id === "add" && disabled}
          className={`${page === id ? "selected" : ""} ${id === "add" ? "add" : ""}`}
          onClick={() => (id === "add" ? onNew() : onNavigate(id))}
        >
          <span aria-hidden="true">
            <Icon size={22} strokeWidth={1.8} />
          </span>
          <small>{label}</small>
        </button>
      ))}
    </nav>
  );
}
