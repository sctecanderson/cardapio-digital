import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { getAdminTables, saveTable, deleteTable, type AdminTable } from "./restaurantAdmin";
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
const PLAN_LABELS: Record<string, string> = {
  basic: "Básico",
  pro: "Pro",
  premium: "Premium",
};

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

  // Exclusão de mesa
  const [tableToDelete, setTableToDelete] = useState<AdminTable | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);

  const planLabel = PLAN_LABELS[r.subscriptionPlan ?? "basic"] ?? "Básico";
  const maxTables = r.maxTables ?? 10;
  const activeTablesCount = tables.filter((t) => t.active).length;
  const isLimitReached = activeTablesCount >= maxTables;
  const quotaPercent = Math.min(100, Math.round((activeTablesCount / maxTables) * 100));

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

  async function handleDeleteTable() {
    if (!tableToDelete || deletingTable) return;
    setDeletingTable(true);
    setError("");
    setNotice("");
    try {
      await deleteTable(r.slug, tableToDelete.tableNumber);
      setNotice(
        `Mesa ${String(tableToDelete.tableNumber).padStart(2, "0")} excluída com sucesso.`,
      );
      setTableToDelete(null);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível excluir a mesa.",
      );
    } finally {
      setDeletingTable(false);
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
            disabled={!!draft || isLimitReached}
            title={
              isLimitReached
                ? `Limite de ${maxTables} mesas ativas atingido no Plano ${planLabel}. Faça upgrade para adicionar mais mesas.`
                : undefined
            }
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

      {/* Banner Informativo de Cota de Mesas do Plano */}
      <div
        className="admin-card"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "16px 20px",
          borderRadius: "14px",
          border: isLimitReached
            ? "1px solid rgba(239, 68, 68, 0.35)"
            : "1px solid var(--line, rgba(0,0,0,0.08))",
          background: isLimitReached
            ? "rgba(239, 68, 68, 0.05)"
            : "var(--surface, #fff)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                background:
                  r.subscriptionPlan === "premium"
                    ? "rgba(139, 92, 246, 0.15)"
                    : r.subscriptionPlan === "pro"
                      ? "rgba(59, 130, 246, 0.15)"
                      : "rgba(107, 114, 128, 0.15)",
                color:
                  r.subscriptionPlan === "premium"
                    ? "#7c3aed"
                    : r.subscriptionPlan === "pro"
                      ? "#2563eb"
                      : "#4b5563",
              }}
            >
              Plano {planLabel}
            </span>
            <strong style={{ fontSize: "14px" }}>
              {activeTablesCount} de {maxTables} mesas disponíveis no plano
            </strong>
          </div>
          {isLimitReached && (
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--danger, #dc2626)",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              Limite do plano atingido
            </span>
          )}
        </div>

        <div
          style={{
            width: "100%",
            height: "6px",
            borderRadius: "999px",
            background: "var(--line, rgba(0,0,0,0.08))",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${quotaPercent}%`,
              height: "100%",
              borderRadius: "999px",
              background: isLimitReached
                ? "var(--danger, #ef4444)"
                : quotaPercent >= 80
                  ? "var(--warning, #f59e0b)"
                  : "var(--primary, #059669)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
      </div>
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
            {(() => {
              const originalTable = tables.find((t) => t.id === draft.id);
              const isCurrentlyActive = originalTable ? originalTable.active : false;
              const isActivationBlocked = !isCurrentlyActive && isLimitReached;

              return (
                <div>
                  <label
                    className="admin-check"
                    style={isActivationBlocked ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={draft.active}
                      disabled={isActivationBlocked}
                      onChange={(e) =>
                        setDraft({ ...draft, active: e.target.checked })
                      }
                    />
                    Mesa ativa para atendimento digital
                  </label>
                  {isActivationBlocked && (
                    <p
                      className="admin-help"
                      style={{
                        color: "var(--danger, #dc2626)",
                        fontWeight: 500,
                        marginTop: "4px",
                        marginBottom: "8px",
                      }}
                    >
                      O plano atual ({planLabel}) permite no máximo {maxTables} mesas ativas. Faça upgrade para ativar esta mesa.
                    </p>
                  )}
                  <p className="admin-help">
                    Desativar preserva o histórico. Mesas com histórico mantêm o
                    número para proteger os QR Codes existentes.
                  </p>
                </div>
              );
            })()}

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
          {filtered.map((t) => {
            const isLocked = t.isLockedByPlan ?? (!t.active && t.tableNumber > maxTables);
            return (
              <article
                className={`admin-card table-card ${isLocked ? "table-card-locked" : ""}`}
                key={t.id}
                style={{
                  position: "relative",
                  ...(isLocked
                    ? {
                        opacity: 0.72,
                        border: "1px dashed rgba(239, 68, 68, 0.4)",
                        background: "rgba(239, 68, 68, 0.02)",
                      }
                    : undefined),
                }}
              >
                {/* Botão de Exclusão "X" no canto superior direito */}
                <button
                  type="button"
                  disabled={!!t.visitId || loading || deletingTable}
                  title={
                    t.visitId
                      ? "Mesa com atendimento ativo. Feche a comanda antes de excluir."
                      : `Excluir Mesa ${String(t.tableNumber).padStart(2, "0")}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setTableToDelete(t);
                  }}
                  style={{
                    position: "absolute",
                    top: "10px",
                    right: "10px",
                    width: "28px",
                    height: "28px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "8px",
                    border: "none",
                    background: "transparent",
                    color: t.visitId ? "rgba(156, 163, 175, 0.35)" : "#94a3b8",
                    cursor: t.visitId ? "not-allowed" : "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!t.visitId) {
                      e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
                      e.currentTarget.style.color = "#ef4444";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!t.visitId) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "#94a3b8";
                    }
                  }}
                  aria-label={`Excluir Mesa ${t.tableNumber}`}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>

                <div className="table-card-heading">
                  <div
                    className="table-symbol"
                    style={isLocked ? { color: "var(--danger, #dc2626)" } : undefined}
                  >
                    <AdminIcon name={isLocked ? "lock" : "table"} />
                  </div>
                  <div>
                    <h2>Mesa {String(t.tableNumber).padStart(2, "0")}</h2>
                    {t.label && <p className="admin-help">{t.label}</p>}
                    {isLocked ? (
                      <span
                        className="table-status"
                        style={{
                          background: "rgba(239, 68, 68, 0.12)",
                          color: "var(--danger, #dc2626)",
                          fontWeight: 600,
                        }}
                      >
                        Bloqueada no Plano {planLabel} (Limite: {maxTables} mesas)
                      </span>
                    ) : (
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
                    )}
                  </div>
                </div>
                {isLocked ? (
                  <p className="admin-help" style={{ color: "var(--danger, #b91c1c)" }}>
                    Mesa inativa por exceder a cota de {maxTables} mesas do Plano {planLabel}.
                  </p>
                ) : t.visitId ? (
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
                  {!isLocked && t.active && (
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
                {!isLocked && (
                  <Link
                    className="admin-text-button"
                    to={`/${r.slug}?mesa=${t.tableNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    <span>Ver endereço da mesa</span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                  </Link>
                )}
              </article>
            );
          })}
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

      {/* Modal de Confirmação de Exclusão de Mesa */}
      {tableToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-table-title"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "16px",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !deletingTable) {
              setTableToDelete(null);
            }
          }}
        >
          <div
            className="admin-card"
            style={{
              maxWidth: "460px",
              width: "100%",
              padding: "24px",
              borderRadius: "16px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.3)",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              background: "var(--surface, #fff)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "10px",
                  backgroundColor: "rgba(239, 68, 68, 0.12)",
                  color: "#ef4444",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </div>
              <div>
                <h3 id="delete-table-title" style={{ fontSize: "16px", fontWeight: "700", margin: 0 }}>
                  Excluir Mesa {String(tableToDelete.tableNumber).padStart(2, "0")}?
                </h3>
                <p style={{ fontSize: "13px", color: "var(--ink-secondary, #64748b)", margin: "6px 0 0", lineHeight: "1.4" }}>
                  Essa ação removerá a mesa do salão e liberará a cota do seu plano.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
              <button
                type="button"
                className="admin-button"
                disabled={deletingTable}
                onClick={() => setTableToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="admin-button"
                disabled={deletingTable}
                onClick={() => void handleDeleteTable()}
                style={{
                  backgroundColor: "#dc2626",
                  color: "#fff",
                  borderColor: "#dc2626",
                }}
              >
                {deletingTable ? "Excluindo…" : "Confirmar Exclusão"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
