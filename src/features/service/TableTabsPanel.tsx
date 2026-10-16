import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import {
  closeTableTab,
  createTableTab,
  getTableTabsState,
  linkGuestToTableTab,
} from './tableTabs';
import type { TableTabsState } from './tableTabs';
import { TabConsumptionPanel } from './TabConsumptionPanel';

interface TableTabsPanelProps {
  restaurantSlug: string;
  restaurantId: string;
  tableVisitId: string;
  onOpenTabsCountChange?: (count: number) => void;
}

const confirmationTime = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

export function TableTabsPanel(props: TableTabsPanelProps) {
  return (
    <TableTabsContent
      key={`${props.restaurantSlug}:${props.tableVisitId}`}
      {...props}
    />
  );
}

function TableTabsContent({
  restaurantSlug,
  restaurantId,
  tableVisitId,
  onOpenTabsCountChange,
}: TableTabsPanelProps) {
  const submitting = useRef(false);

  const [state, setState] = useState<TableTabsState>({
    tabs: [],
    guests: [],
    links: [],
  });

  const [label, setLabel] = useState('');
  const [selectedGuests, setSelectedGuests] = useState<Record<string, string>>({});
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [closingFeeAccepted, setClosingFeeAccepted] = useState<boolean>(true);
  const [restaurantFeePercent, setRestaurantFeePercent] = useState<number>(10);
  const [collapsedTabs, setCollapsedTabs] = useState<Record<string, boolean>>({});

  function toggleTabCollapse(tabId: string) {
    setCollapsedTabs((prev) => ({
      ...prev,
      [tabId]: !prev[tabId],
    }));
  }

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  const initialLoaded = useRef(false);
  const onOpenTabsCountChangeRef = useRef(onOpenTabsCountChange);
  onOpenTabsCountChangeRef.current = onOpenTabsCountChange;

  useEffect(() => {
    let disposed = false;

    async function load() {
      if (!initialLoaded.current) {
        setLoading(true);
      }
      setLoadError('');

      try {
        const [result, restaurantRes] = await Promise.all([
          getTableTabsState(restaurantId, tableVisitId),
          supabase.from('restaurants').select('service_fee_percent').eq('id', restaurantId).maybeSingle(),
        ]);

        if (!disposed) {
          setState(result);
          if (restaurantRes.data?.service_fee_percent !== undefined) {
            setRestaurantFeePercent(Number(restaurantRes.data.service_fee_percent));
          }
          const openCount = result.tabs.filter((t) => t.status === 'open').length;
          onOpenTabsCountChangeRef.current?.(openCount);
          initialLoaded.current = true;
        }
      } catch (cause) {
        if (!disposed) {
          setLoadError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar as comandas.',
          );
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      disposed = true;
    };
  }, [restaurantId, tableVisitId, refresh]);

  const disabled = busy || loading || !!loadError;

  // Clientes ativos com confirmação de presença válida
  const activeGuests = state.guests.filter(
    (guest) => Date.parse(guest.expires_at) > Date.now(),
  );

  // Mapeia em qual comanda cada cliente está atualmente
  const guestTabMap = new Map<string, string>();
  for (const link of state.links) {
    const linkedTab = state.tabs.find((t) => t.id === link.table_tab_id);
    if (linkedTab) {
      guestTabMap.set(link.guest_session_id, linkedTab.label);
    }
  }

  async function perform(
    operation: () => Promise<unknown>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    if (submitting.current || disabled) return;

    submitting.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');

    try {
      await operation();
      onSuccess?.();
      setNotice(successMessage);
      setRefresh((current) => current + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível concluir a operação.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitting.current || disabled) return;

    const value = label.trim();

    if (!value || value.length > 80) {
      setActionError('Informe uma identificação entre 1 e 80 caracteres.');
      return;
    }

    const id = crypto.randomUUID();

    await perform(
      () => createTableTab(restaurantSlug, tableVisitId, value, id),
      'Comanda criada.',
      () => {
        setLabel('');
        setCollapsedTabs((prev) => ({
          ...prev,
          [id]: false,
        }));
      },
    );
  }

  async function handleLink(tableTabId: string) {
    const guestId = selectedGuests[tableTabId];

    if (!guestId) {
      setActionError('Selecione um cliente confirmado.');
      return;
    }

    await perform(
      () => linkGuestToTableTab(restaurantSlug, tableTabId, guestId),
      'Cliente vinculado à comanda com sucesso.',
      () => {
        setSelectedGuests((current) => ({
          ...current,
          [tableTabId]: '',
        }));
      },
    );
  }

  async function handleClose(tableTabId: string) {
    const feeAccepted = restaurantFeePercent > 0 ? closingFeeAccepted : false;
    await perform(
      () => closeTableTab(restaurantSlug, tableTabId, feeAccepted),
      'Comanda encerrada com sucesso.',
      () => setClosingTabId(null),
    );
  }

  return (
    <div className="staff-tab-block">
      {/* Seção: Criar Comanda */}
      <div className="staff-sub-block border-t-0 pt-0 mt-0">
        <h4 className="staff-sub-title">Criar Comanda</h4>
        <form onSubmit={handleCreate}>
          <fieldset disabled={disabled}>
            <label
              htmlFor={`tab-label-${tableVisitId}`}
              className="staff-sub-desc block mb-1"
            >
              Identificação da comanda
            </label>

            <div className="staff-create-tab-row">
              <input
                id={`tab-label-${tableVisitId}`}
                type="text"
                required
                maxLength={80}
                autoComplete="off"
                value={label}
                placeholder="Ex.: Casal, Amigos ou Comanda 01"
                onChange={(event) => {
                  setLabel(event.target.value);
                  setActionError('');
                  setNotice('');
                }}
                className="staff-create-tab-input"
              />

              <button
                type="submit"
                disabled={disabled}
                className="staff-primary-action-btn"
              >
                {busy ? 'Criando…' : 'Criar comanda'}
              </button>
            </div>
          </fieldset>
        </form>
      </div>

      {actionError && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {actionError}
        </p>
      )}

      {notice && (
        <p role="status" className="mt-2 text-xs text-green-800">
          {notice}
        </p>
      )}

      {/* Seção: Comandas Abertas Reais */}
      {loading && !initialLoaded.current ? (
        <p role="status" className="mt-3 text-xs opacity-75">
          Carregando comandas…
        </p>
      ) : loadError && !initialLoaded.current ? (
        <p role="alert" className="mt-3 text-xs text-red-700">
          {loadError}
        </p>
      ) : (
        <>
          {loadError && (
            <p role="alert" className="mt-3 text-xs text-red-700">
              {loadError}
            </p>
          )}
          {state.tabs.length > 0 && (
            <div className="mt-5 space-y-4">
          {state.tabs.map((tab) => {
            const links = state.links.filter(
              (link) => link.table_tab_id === tab.id,
            );

            const closed = tab.status === 'closed';
            const confirmingClose = closingTabId === tab.id;

            // Clientes ativos que não estão já vinculados a ESTA comanda
            const linkedSessionIdsThisTab = links.map((l) => l.guest_session_id);
            const availableForThisTab = activeGuests.filter(
              (g) => !linkedSessionIdsThisTab.includes(g.id),
            );

            const isCollapsed = Boolean(collapsedTabs[tab.id]);

            return (
              <div key={tab.id} className="staff-tab-inner-card">
                {/* Cabeçalho da comanda com alternador de encolher/expandir */}
                <button
                  type="button"
                  onClick={() => toggleTabCollapse(tab.id)}
                  aria-expanded={!isCollapsed}
                  className={`staff-tab-header-btn ${isCollapsed ? 'is-collapsed' : ''}`}
                >
                  <div className="staff-tab-label-badge">
                    <span className="staff-tab-label-name">
                      Comanda {tab.label}
                    </span>
                    <span className="staff-tab-open-pill">
                      {closed ? 'Encerrada' : 'Aberta'}
                    </span>
                  </div>

                  <div className="staff-tab-header-right">
                    <span className="staff-tab-access-count">
                      {links.length}{' '}
                      {links.length === 1
                        ? 'acesso vinculado'
                        : 'acessos vinculados'}
                    </span>
                    <span
                      className="staff-tab-toggle-indicator"
                      title={isCollapsed ? 'Expandir comanda' : 'Encolher comanda'}
                    >
                      {isCollapsed ? 'Expandir ▼' : 'Encolher ▲'}
                    </span>
                  </div>
                </button>

                {/* Conteúdo expansível da comanda */}
                <div className={isCollapsed ? 'hidden' : 'block'}>
                  {/* Bloco de consumo da comanda */}
                  <TabConsumptionPanel
                    restaurantSlug={restaurantSlug}
                    restaurantId={restaurantId}
                    tab={tab}
                  />

                  {/* Bloco de vincular cliente e encerrar comanda */}
                  {!closed && (
                    <div className="staff-link-guest-box mt-4 border-t border-[#ebdccb] pt-3">
                      <label
                        htmlFor={`tab-guest-${tab.id}`}
                        className="staff-link-guest-label block"
                      >
                        Vincular cliente confirmado
                      </label>

                      <div className="staff-link-guest-row">
                        <select
                          id={`tab-guest-${tab.id}`}
                          value={selectedGuests[tab.id] ?? ''}
                          disabled={disabled || availableForThisTab.length === 0}
                          onChange={(event) => {
                            setSelectedGuests((current) => ({
                              ...current,
                              [tab.id]: event.target.value,
                            }));
                          }}
                          className="staff-guest-select"
                        >
                          <option value="">
                            {availableForThisTab.length === 0
                              ? 'Nenhum outro cliente disponível'
                              : 'Selecione um acesso confirmado'}
                          </option>

                          {availableForThisTab.map((guest, index) => {
                            const otherTabName = guestTabMap.get(guest.id);
                            return (
                              <option key={guest.id} value={guest.id}>
                                Cliente {index + 1}
                                {otherTabName
                                  ? ` (atualmente na Comanda ${otherTabName})`
                                  : ` — confirmado às ${confirmationTime.format(
                                      new Date(guest.confirmed_at),
                                    )}`}
                              </option>
                            );
                          })}
                        </select>

                        <button
                          type="button"
                          disabled={
                            disabled ||
                            !selectedGuests[tab.id] ||
                            !availableForThisTab.some(
                              (guest) =>
                                guest.id === selectedGuests[tab.id],
                            )
                          }
                          onClick={() => void handleLink(tab.id)}
                          className="staff-link-guest-btn"
                        >
                          Confirmar acesso
                        </button>
                      </div>

                      {confirmingClose ? (
                        <div className="mt-3 rounded-xl bg-white p-3 border border-amber-200 dark:bg-stone-900 dark:border-amber-900/60 shadow-xs">
                          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                            Encerrar a comanda “{tab.label}”?
                          </p>

                          {restaurantFeePercent > 0 && (
                            <div className="mt-2 text-xs">
                              <span className="text-gray-700 dark:text-stone-300 font-medium block mb-1">
                                Taxa de serviço ({restaurantFeePercent}%):
                              </span>
                              <div className="flex gap-4">
                                <label className="flex items-center gap-1.5 cursor-pointer text-gray-800 dark:text-stone-200">
                                  <input
                                    type="radio"
                                    name={`fee-${tab.id}`}
                                    checked={closingFeeAccepted}
                                    onChange={() => setClosingFeeAccepted(true)}
                                    disabled={disabled}
                                  />
                                  <span>Aceita (incluir {restaurantFeePercent}%)</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer text-gray-800 dark:text-stone-200">
                                  <input
                                    type="radio"
                                    name={`fee-${tab.id}`}
                                    checked={!closingFeeAccepted}
                                    onChange={() => setClosingFeeAccepted(false)}
                                    disabled={disabled}
                                  />
                                  <span>Dispensada (taxa 0%)</span>
                                </label>
                              </div>
                            </div>
                          )}

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => void handleClose(tab.id)}
                              className="staff-primary-action-btn text-xs px-3 py-1.5"
                            >
                              Confirmar encerramento
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setClosingTabId(null)}
                              className="staff-outline-action-btn text-xs px-3 py-1.5"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setClosingTabId(tab.id);
                            setActionError('');
                            setNotice('');
                          }}
                          className="staff-close-tab-link"
                        >
                          Encerrar comanda
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
}