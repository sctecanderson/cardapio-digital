import { useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
} from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { signOutStaff, type StaffAccess } from "../auth/staffAuth";
import { ThemeToggleButton } from "../theme/ThemeToggleButton";
import { AdminTopbar } from "./AdminTopbar";

export function AdminLayout() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant: r } = useRestaurant();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const links = [
    ["", "Visão geral", "home"],
    ["catalogo", "Cardápio", "menu"],
    ["kds", "KDS Cozinha/Bar", "kds"],
    ["estoque", "Estoque & Insumos", "package"],
    ["comentarios", "Comentários", "chat"],
    ["mesas", "Mesas e comandas", "table"],
    ["identidade", "Identidade visual", "settings"],
    ["midias", "Armazenamento", "media"],
    ["equipe", "Equipe e acessos", "user"],
  ] as const;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('elozi_admin_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('elozi_admin_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  async function logout() {
    setBusy(true);
    setError("");
    try {
      await signOutStaff();
      navigate(`/${r.slug}/acesso`, { replace: true });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Não foi possível sair.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`admin-app ${sidebarCollapsed ? 'sidebar-collapsed' : ''} print:block print:p-0 print:m-0 print:bg-white print:overflow-visible`}>
      <a href="#admin-content" className="skip-link print:hidden">
        Pular para o conteúdo
      </a>
      <aside className={`admin-sidebar ${sidebarCollapsed ? 'collapsed' : ''} print:hidden`}>
        <div className="admin-sidebar-header">
          <Link to={`/${r.slug}/admin`} className="admin-logo">
            {r.logo ? (
              <img src={r.logo.url} alt={r.name} />
            ) : (
              <>
                {r.name}
                <small>{r.subtitle}</small>
              </>
            )}
          </Link>
          <button
            type="button"
            onClick={toggleSidebar}
            className="admin-sidebar-toggle"
            aria-label={sidebarCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
            title={sidebarCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          >
            {sidebarCollapsed ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                <path d="m13 15 3-3-3-3" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                <path d="m14 9-3 3 3 3" />
              </svg>
            )}
          </button>
        </div>
        <nav aria-label="Administração">
          {links.map(([path, label, icon]) => (
            <NavLink
              end
              key={path}
              to={`/${r.slug}/admin${path ? `/${path}` : ""}`}
              title={label}
            >
              <AdminIcon name={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
          <Link to={`/${r.slug}/equipe`} title="Atendimento">
            <AdminIcon name="bell" />
            <span>Atendimento</span>
          </Link>
          <Link to={`/${r.slug}/acesso`} title="Minha conta">
            <AdminIcon name="user" />
            <span>Minha conta</span>
          </Link>
        </nav>
        <button
          type="button"
          className="admin-exit"
          disabled={busy}
          onClick={() => void logout()}
          title="Sair"
        >
          <AdminIcon name="exit" />
          <span>{busy ? "Saindo…" : "Sair"}</span>
        </button>
        {error && <p role="alert">{error}</p>}
      </aside>
      <div className="admin-workspace print:p-0 print:m-0 print:w-full print:block print:bg-white">
        <AdminTopbar restaurant={r} />
        {r.billingStatus === 'grace_period' && (
          <div
            role="alert"
            className="print:hidden"
            style={{
              padding: "12px 20px",
              background: "rgba(245, 158, 11, 0.12)",
              borderBottom: "1px solid rgba(245, 158, 11, 0.35)",
              color: "#b45309",
              fontSize: "13px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              <strong>Atenção:</strong> A assinatura deste estabelecimento expirou. Regularize o pagamento para evitar o bloqueio automático dos pedidos.
            </span>
          </div>
        )}
        {r.billingStatus === 'expired' && (
          <div
            role="alert"
            className="print:hidden"
            style={{
              padding: "12px 20px",
              background: "rgba(239, 68, 68, 0.12)",
              borderBottom: "1px solid rgba(239, 68, 68, 0.35)",
              color: "#b91c1c",
              fontSize: "13px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span>
              <strong>Atenção:</strong> A assinatura deste estabelecimento está suspensa por expiração do ciclo. Novos atendimentos estão bloqueados.
            </span>
          </div>
        )}
        <main id="admin-content" className="print:p-0 print:m-0 print:w-full print:block">
          <Outlet context={access} />
        </main>
      </div>
    </div>
  );
}
export function AdminIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
    menu: "M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5",
    chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    table: "M3 9h18v4H3ZM5 13l-2 8M19 13l2 8M5 9V5h14v4",
    kds: "M12 2c1.5 3 4 5 4 8a6 6 0 1 1-12 0c0-3 2.5-5 4-8 1 2 2 3 4 0z",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
    media: "M3 3h18v18H3ZM3 17l6-7 5 6 3-3 4 5M16 7h1",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-3a8 8 0 0 1 16 0v3Z",
    bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4",
    package: "M16.5 9.4 7.55 4.24M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
    exit: "M10 3H4v18h6M9 12h12M17 8l4 4-4 4",
    lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4",
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.menu} />
    </svg>
  );
}
