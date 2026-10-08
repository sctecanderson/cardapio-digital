import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
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
}

const confirmationTime = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
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
}: TableTabsPanelProps) {
  const submitting = useRef(false);
  const creationId = useRef<string | null>(null);

  const [state, setState] = useState<TableTabsState>({
    tabs: [],
    guests: [],
    links: [],
  });

  const [label, setLabel] = useState('');
  const [selectedGuests, setSelectedGuests] = useState<
    Record<string, string>
  >({});
  const [closingTabId, setClosingTabId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let disposed = false;

    async function load() {
      setLoading(true);
      setLoadError('');

      try {
        const result = await getTableTabsState(
          restaurantId,
          tableVisitId,
        );

        if (!disposed) {
          setState(result);
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

  const linkedGuestIds = new Set(
    state.links.map((link) => link.guest_session_id),
  );

  // Esta filtragem melhora a apresentação.
  // A validade é conferida novamente pelo banco ao vincular.
  const availableGuests = state.guests.filter(
    (guest) =>
      !linkedGuestIds.has(guest.id) &&
      Date.parse(guest.expires_at) > Date.now(),
  );

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

    // Mantém o mesmo ID em uma repetição após falha.
    const id = creationId.current ?? crypto.randomUUID();
    creationId.current = id;

    await perform(
      () => createTableTab(restaurantSlug, tableVisitId, value, id),
      'Comanda criada.',
      () => {
        setLabel('');
        creationId.current = null;
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
      'Cliente vinculado à comanda.',
      () => {
        setSelectedGuests((current) => ({
          ...current,
          [tableTabId]: '',
        }));
      },
    );
  }

  async function handleClose(tableTabId: string) {
    await perform(
      () => closeTableTab(restaurantSlug, tableTabId),
      'Comanda encerrada. As demais continuam abertas.',
      () => setClosingTabId(null),
    );
  }

  return (
    <section
      aria-labelledby={`tabs-title-${tableVisitId}`}
      className="mt-5 border-t border-black/10 pt-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id={`tabs-title-${tableVisitId}`}
          className="text-lg font-semibold"
        >
          Comandas
        </h3>

        <button
          type="button"
          disabled={busy || loading}
          onClick={() => setRefresh((current) => current + 1)}
          className="min-h-11 px-3 text-sm font-medium text-[var(--brand)] disabled:opacity-50"
        >
          Atualizar
        </button>
      </div>

      <form onSubmit={handleCreate} className="mt-3">
        <fieldset disabled={disabled} className="space-y-3">
          <label
            htmlFor={`tab-label-${tableVisitId}`}
            className="block text-sm font-medium"
          >
            Identificação da nova comanda
          </label>

          <input
            id={`tab-label-${tableVisitId}`}
            type="text"
            required
            maxLength={80}
            autoComplete="off"
            value={label}
            placeholder="Ex.: Anderson, Casal ou Comanda 01"
            onChange={(event) => {
              setLabel(event.target.value);
              creationId.current = null;
              setActionError('');
              setNotice('');
            }}
            className="min-h-12 w-full rounded-xl border border-black/20 px-3"
          />

          <button
            type="submit"
            className="min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Processando…' : 'Criar comanda'}
          </button>
        </fieldset>
      </form>

      {actionError && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {notice && (
        <p role="status" className="mt-3 text-sm text-green-800">
          {notice}
        </p>
      )}

      {loading ? (
        <p role="status" className="mt-4 text-sm opacity-75">
          Carregando comandas…
        </p>
      ) : loadError ? (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {loadError}
        </p>
      ) : state.tabs.length === 0 ? (
        <p className="mt-4 text-sm opacity-75">
          Nenhuma comanda criada neste atendimento.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {state.tabs.map((tab) => {
            const links = state.links.filter(
              (link) => link.table_tab_id === tab.id,
            );

            const closed = tab.status === 'closed';
            const confirmingClose = closingTabId === tab.id;

            return (
              <li
                key={tab.id}
                className="rounded-2xl border border-black/10 bg-[var(--page)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="break-words font-semibold">
                    {tab.label}
                  </h4>

                  <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-medium">
                    {closed ? 'Encerrada' : 'Aberta'}
                  </span>
                </div>

                <p className="mt-2 text-sm opacity-75">
                  {links.length}{' '}
                  {links.length === 1
                    ? 'acesso vinculado'
                    : 'acessos vinculados'}
                </p>

                <TabConsumptionPanel
                  restaurantSlug={restaurantSlug}
                  restaurantId={restaurantId}
                  tab={tab}
                />

                {!closed && (
                  <>
                    <div className="mt-4 space-y-2">
                      <label
                        htmlFor={`tab-guest-${tab.id}`}
                        className="block text-sm font-medium"
                      >
                        Vincular cliente confirmado
                      </label>

                      <select
                        id={`tab-guest-${tab.id}`}
                        value={selectedGuests[tab.id] ?? ''}
                        disabled={disabled || availableGuests.length === 0}
                        onChange={(event) => {
                          setSelectedGuests((current) => ({
                            ...current,
                            [tab.id]: event.target.value,
                          }));
                        }}
                        className="min-h-12 w-full rounded-xl border border-black/20 bg-white px-3 disabled:opacity-50"
                      >
                        <option value="">
                          {availableGuests.length === 0
                            ? 'Nenhum cliente disponível'
                            : 'Selecione um acesso confirmado'}
                        </option>

                        {availableGuests.map((guest, index) => (
                          <option key={guest.id} value={guest.id}>
                            Cliente {index + 1} — confirmado às{' '}
                            {confirmationTime.format(
                              new Date(guest.confirmed_at),
                            )}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        disabled={
                          disabled ||
                          !selectedGuests[tab.id] ||
                          !availableGuests.some(
                            (guest) =>
                              guest.id === selectedGuests[tab.id],
                          )
                        }
                        onClick={() => void handleLink(tab.id)}
                        className="min-h-11 w-full rounded-xl border border-black/15 bg-white px-3 text-sm font-medium disabled:opacity-50"
                      >
                        Vincular à comanda
                      </button>
                    </div>

                    {confirmingClose ? (
                      <div className="mt-4 rounded-xl bg-white p-3">
                        <p className="text-sm">
                          Encerrar a comanda “{tab.label}”?
                        </p>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => void handleClose(tab.id)}
                            className="min-h-11 rounded-xl bg-[var(--brand)] px-4 text-sm font-medium text-white disabled:opacity-50"
                          >
                            Confirmar encerramento
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setClosingTabId(null)}
                            className="min-h-11 rounded-xl border border-black/15 px-4 text-sm"
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
                        className="mt-3 min-h-11 text-sm font-medium text-[var(--brand)] underline disabled:opacity-50"
                      >
                        Encerrar comanda
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}