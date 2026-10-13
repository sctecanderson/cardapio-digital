import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { getAdminTables, saveTable, type AdminTable } from "./restaurantAdmin";
import { AdminIcon } from "./AdminLayout";
import {
  getTableServiceRequestsSummary,
  dismissTableServiceRequests,
  type TableServiceRequestsSummary,
} from "../service/serviceRequests";
const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
export function TablesPage() {
  const { restaurant: r } = useRestaurant();
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState<AdminTable | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  // Gerenciamento de chamados por mesa no Admin
  const [tableRequestsSummary, setTableRequestsSummary] =
    useState<TableServiceRequestsSummary | null>(null);
  const [loadingRequestsSummary, setLoadingRequestsSummary] = useState(false);
  const [confirmDismissRequests, setConfirmDismissRequests] = useState(false);
  const [dismissingRequests, setDismissingRequests] = useState(false);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    void getAdminTables(r.slug)
      .then((data) => {
        if (!disposed) setTables(data);
      })
      .catch((cause) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível carregar.",
          );
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [r.slug, revision]);
  useEffect(() => {
    function refresh() {
      if (!document.hidden && !draft && !submitting.current)
        setRevision((v) => v + 1);
    }
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, [draft]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveTable(r.slug, draft);
      setDraft(null);
      setNotice("Mesa salva.");
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Não foi possível salvar.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const filtered = tables.filter(
    (t) =>
      `${t.tableNumber} ${String(t.tableNumber).padStart(2, "0")} ${t.label}`
        .toLocaleLowerCase("pt-BR")
        .includes(query.toLocaleLowerCase("pt-BR")) &&
      (filter === "all" ||
        (filter === "open" && !!t.visitId) ||
        (filter === "empty" && t.active && !t.visitId) ||
        (filter === "bill" && t.billPending) ||
        (filter === "inactive" && !t.active)),
  );
  function edit(t: AdminTable) {
    setDraft({ ...t });
    setError("");
    setNotice("");
    setConfirmDismissRequests(false);
    setTableRequestsSummary(null);

    // Carrega chamados da mesa se for uma mesa já existente
    if (t.revision > 0) {
      setLoadingRequestsSummary(true);
      void getTableServiceRequestsSummary(r.id, t.tableNumber)
        .then((summary) => {
          setTableRequestsSummary(summary);
        })
        .catch(() => {
          setTableRequestsSummary(null);
        })
        .finally(() => {
          setLoadingRequestsSummary(false);
        });
    }
  }

  async function handleDismissTableRequests() {
    if (!draft || dismissingRequests) return;
    setDismissingRequests(true);
    setError("");
    setNotice("");

    try {
      const dismissed = await dismissTableServiceRequests(r.slug, draft.tableNumber);
      setConfirmDismissRequests(false);
      setNotice(
        `Chamados da Mesa ${String(draft.tableNumber).padStart(2, "0")} encerrados com sucesso (${dismissed} encerrado${dismissed > 1 ? "s" : ""}).`,
      );
      // Atualiza o resumo de chamados imediatamente
      const updated = await getTableServiceRequestsSummary(r.id, draft.tableNumber);
      setTableRequestsSummary(updated);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível encerrar os chamados da mesa.",
      );
    } finally {
      setDismissingRequests(false);
    }
  }
  return (
    <div className="admin-stack">
      <header className="admin-page-heading">
        <div>
          <p className="admin-breadcrumb">Administração / Mesas</p>
          <h1>Mesas e comandas</h1>
          <p>Acompanhe os atendimentos e configure as mesas.</p>
        </div>
        <div className="admin-actions">
          <button
            className="admin-button"
            disabled={loading || !!draft}
            onClick={() => setRevision((v) => v + 1)}
          >
            Atualizar
          </button>
          <button
            className="admin-button primary"
            disabled={!!draft}
            onClick={() =>
              edit({
                id: crypto.randomUUID(),
                tableNumber: 1,
                label: "",
                active: true,
                revision: 0,
                visitId: null,
                tabCount: 0,
                totalInCents: 0,
                billPending: false,
              })
            }
          >
            + Nova mesa
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="admin-alert error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-alert success">
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="admin-card admin-form"
          onSubmit={(e) => void submit(e)}
        >
          <h2>{draft.revision ? "Configurar mesa" : "Cadastrar mesa"}</h2>
          <fieldset disabled={busy}>
            <div className="admin-grid-2">
              <label>
                Número da mesa
                <input
                  type="number"
                  min={1}
                  max={999}
                  required
                  value={draft.tableNumber || ""}
                  onChange={(e) =>
                    setDraft({ ...draft, tableNumber: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Identificação (opcional)
                <input
                  maxLength={80}
                  value={draft.label}
                  placeholder="Ex.: Varanda"
                  onChange={(e) =>
                    setDraft({ ...draft, label: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) =>
                  setDraft({ ...draft, active: e.target.checked })
                }
              />
              Mesa ativa para atendimento digital
            </label>
            <p className="admin-help">
              Desativar preserva o histórico. Mesas com histórico mantêm o
              número para proteger os QR Codes existentes.
            </p>

            {/* Gerenciamento de chamados da mesa */}
            {draft.revision > 0 && (
              <div className="admin-card" style={{ marginTop: "16px", marginBottom: "16px", padding: "16px", background: "var(--surface-raised, rgba(0,0,0,0.03))", border: "1px solid var(--line, rgba(0,0,0,0.1))", borderRadius: "12px" }}>
                <h3 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "8px" }}>
                  Gerenciamento de chamados da mesa
                </h3>
                {loadingRequestsSummary ? (
                  <p role="status" className="admin-help">
                    Consultando chamados da Mesa {String(draft.tableNumber).padStart(2, "0")}…
                  </p>
                ) : (
                  <div>
                    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "12px", fontSize: "13px" }}>
                      <div>
                        <span className="admin-help">Pendentes: </span>
                        <strong>{tableRequestsSummary?.pendingCount ?? 0}</strong>
                      </div>
                      <div>
                        <span className="admin-help">Em atendimento: </span>
                        <strong>{tableRequestsSummary?.attendedCount ?? 0}</strong>
                      </div>
                      <div>
                        <span className="admin-help">Total ativos: </span>
                        <strong>{tableRequestsSummary?.totalCount ?? 0}</strong>
                      </div>
                    </div>

                    {(tableRequestsSummary?.totalCount ?? 0) > 0 ? (
                      confirmDismissRequests ? (
                        <div style={{ padding: "12px", borderRadius: "8px", background: "rgba(245, 158, 11, 0.12)", border: "1px solid rgba(245, 158, 11, 0.35)" }}>
                          <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--ink, #1f2937)", marginBottom: "6px" }}>
                            Confirmar encerramento de {tableRequestsSummary?.totalCount} chamado(s) da Mesa {String(draft.tableNumber).padStart(2, "0")}?
                          </p>
                          <p style={{ fontSize: "12px", color: "var(--ink-secondary, #4b5563)", marginBottom: "10px" }}>
                            Esta ação cancela chamados pendentes e em atendimento desta mesa sem fechar comandas nem apagar histórico.
                          </p>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button
                              type="button"
                              className="admin-button primary"
                              disabled={dismissingRequests}
                              onClick={() => void handleDismissTableRequests()}
                            >
                              {dismissingRequests ? "Encerrando…" : "Confirmar encerramento"}
                            </button>
                            <button
                              type="button"
                              className="admin-button"
                              disabled={dismissingRequests}
                              onClick={() => setConfirmDismissRequests(false)}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="admin-button"
                          style={{ borderColor: "rgba(245, 158, 11, 0.5)", color: "var(--ink, #1f2937)" }}
                          disabled={dismissingRequests}
                          onClick={() => setConfirmDismissRequests(true)}
                        >
                          Encerrar {tableRequestsSummary?.totalCount} chamado(s) em aberto desta mesa
                        </button>
                      )
                    ) : (
                      <p className="admin-help" style={{ margin: 0 }}>
                        Nenhum chamado de garçom ativo para esta mesa no momento.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="admin-actions">
              <button
                type="button"
                className="admin-button"
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                Cancelar
              </button>
              <button className="admin-button primary">
                {busy ? "Salvando…" : "Salvar mesa"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <div className="tables-toolbar admin-form">
        <label className="sr-only" htmlFor="table-search">
          Buscar mesa
        </label>
        <input
          id="table-search"
          type="search"
          placeholder="Buscar mesa ou identificação"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="admin-actions" role="group" aria-label="Filtrar mesas">
          {[
            ["all", "Todas"],
            ["empty", "Sem atendimento"],
            ["open", "Em atendimento"],
            ["bill", "Conta solicitada"],
            ["inactive", "Desativadas"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`admin-button ${filter === key ? "primary" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <p role="status">Carregando mesas…</p>
      ) : (
        <div className="admin-table-grid">
          {filtered.map((t) => (
            <article className="admin-card table-card" key={t.id}>
              <div className="table-card-heading">
                <div className="table-symbol">
                  <AdminIcon name="table" />
                </div>
                <div>
                  <h2>Mesa {String(t.tableNumber).padStart(2, "0")}</h2>
                  {t.label && <p className="admin-help">{t.label}</p>}
                  <span
                    className={`table-status ${t.billPending ? "bill" : t.visitId ? "open" : ""}`}
                  >
                    {!t.active
                      ? "Mesa desativada"
                      : t.billPending
                        ? "Conta solicitada"
                        : t.visitId
                          ? "Em atendimento"
                          : "Sem atendimento aberto"}
                  </span>
                </div>
              </div>
              {t.visitId ? (
                <div>
                  <p>
                    {t.tabCount}{" "}
                    {t.tabCount === 1 ? "comanda aberta" : "comandas abertas"}
                  </p>
                  <p className="admin-help">Subtotal registrado</p>
                  <strong className="table-total">
                    {money.format(t.totalInCents / 100)}
                  </strong>
                </div>
              ) : (
                <p className="admin-help">
                  {t.active
                    ? "Disponível para novo registro"
                    : "Acesso digital desativado"}
                </p>
              )}
              <div className="admin-actions">
                {t.active && (
                  <Link
                    className="admin-button primary"
                    to={`/${r.slug}/equipe`}
                  >
                    {t.visitId ? "Ver atendimento" : "Abrir atendimento"}
                  </Link>
                )}
                <button
                  className="admin-button"
                  disabled={!!draft}
                  onClick={() => edit(t)}
                >
                  Configurar
                </button>
              </div>
              <Link
                className="admin-text-button"
                to={`/${r.slug}?mesa=${t.tableNumber}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Ver endereço da mesa ↗
              </Link>
            </article>
          ))}
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <p role="status" className="admin-card">
          Nenhuma mesa encontrada.
        </p>
      )}
      <p className="admin-help">
        Sem atendimento aberto não confirma que a mesa está desocupada. Os
        subtotais representam itens registrados, sem confirmação de pagamento.
        Atualização automática a cada 30 segundos.
      </p>
    </div>
  );
}
