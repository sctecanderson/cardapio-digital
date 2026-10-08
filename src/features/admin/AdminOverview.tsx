import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { getAdminTables, type AdminTable } from "./restaurantAdmin";
export function AdminOverview() {
  const { restaurant: r } = useRestaurant();
  const [tables, setTables] = useState<AdminTable[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let disposed = false;
    void getAdminTables(r.slug)
      .then((t) => {
        if (!disposed) {
          setTables(t);
          setError("");
        }
      })
      .catch(() => {
        if (!disposed) setError("Não foi possível atualizar a visão geral.");
      });
    function refresh() {
      if (!document.hidden) setTick((v) => v + 1);
    }
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [r.slug, tick]);
  return (
    <div className="admin-stack">
      <header className="admin-page-heading">
        <div>
          <p className="admin-breadcrumb">Administração</p>
          <h1>Visão geral</h1>
          <p>Organize o restaurante em um só lugar.</p>
        </div>
        <Link className="admin-button primary" to={`/${r.slug}/equipe`}>
          Abrir atendimento
        </Link>
      </header>
      {error && (
        <p role="alert" className="admin-alert error">
          {error}
        </p>
      )}
      <div className="admin-table-grid">
        {[
          ["Mesas ativas", tables?.filter((t) => t.active).length],
          ["Comandas abertas", tables?.reduce((s, t) => s + t.tabCount, 0)],
          [
            "Mesas com conta solicitada",
            tables?.filter((t) => t.billPending).length,
          ],
        ].map(([label, value]) => (
          <section className="admin-card admin-stat" key={label}>
            <span>{label}</span>
            <strong>{value ?? "—"}</strong>
          </section>
        ))}
      </div>
      <div className="admin-grid-2">
        {[
          ["catalogo", "Cardápio", "Categorias, produtos, fotos e vídeos."],
          [
            "mesas",
            "Mesas e comandas",
            "Atendimentos e configuração das mesas.",
          ],
          [
            "identidade",
            "Identidade visual",
            "Logo, cores, capa e informações.",
          ],
          ["midias", "Armazenamento", "Limpeza segura de arquivos sem uso."],
        ].map(([path, title, description]) => (
          <Link
            key={path}
            className="admin-card overview-link"
            to={`/${r.slug}/admin/${path}`}
          >
            <h2>
              {title} <span>↗</span>
            </h2>
            <p className="admin-help">{description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
