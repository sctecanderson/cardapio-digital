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

export function AdminLayout() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant: r } = useRestaurant();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const links = [
    ["", "Visão geral", "home"],
    ["catalogo", "Cardápio", "menu"],
    ["comentarios", "Comentários", "chat"],
    ["mesas", "Mesas e comandas", "table"],
    ["identidade", "Identidade visual", "settings"],
    ["midias", "Armazenamento", "media"],
    ["equipe", "Equipe e acessos", "user"],
  ] as const;
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
    <div className="admin-app">
      <a href="#admin-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <aside className="admin-sidebar">
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
        <nav aria-label="Administração">
          {links.map(([path, label, icon]) => (
            <NavLink
              end
              key={path}
              to={`/${r.slug}/admin${path ? `/${path}` : ""}`}
            >
              <AdminIcon name={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
          <Link to={`/${r.slug}/equipe`}>
            <AdminIcon name="bell" />
            Atendimento
          </Link>
          <Link to={`/${r.slug}/acesso`}>
            <AdminIcon name="user" />
            Minha conta
          </Link>
        </nav>
        <button
          type="button"
          className="admin-exit"
          disabled={busy}
          onClick={() => void logout()}
        >
          <AdminIcon name="exit" />
          {busy ? "Saindo…" : "Sair"}
        </button>
        {error && <p role="alert">{error}</p>}
      </aside>
      <div className="admin-workspace">
        <div className="admin-topbar">
          <span>Administração do restaurante</span>
          <Link to={`/${r.slug}`} target="_blank" rel="noopener noreferrer">
            Ver cardápio ↗
          </Link>
          <span className="admin-profile">
            <AdminIcon name="user" />
            Administrador
          </span>
        </div>
        <main id="admin-content">
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
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
    media: "M3 3h18v18H3ZM3 17l6-7 5 6 3-3 4 5M16 7h1",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-3a8 8 0 0 1 16 0v3Z",
    bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4",
    exit: "M10 3H4v18h6M9 12h12M17 8l4 4-4 4",
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
