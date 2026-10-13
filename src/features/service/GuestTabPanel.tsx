import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useTableContext } from '../tables/useTableContext';
import { getGuestTabState } from './guestTab';
import { BillRequestPanel } from './BillRequestPanel';
import type { GuestTabState } from './guestTab';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function GuestTabPanel() {
  const { restaurantSlug } = useParams();
  const table = useTableContext();
  if (!restaurantSlug || table.status !== 'unverified') return null;
  return <GuestTabContent key={`${restaurantSlug}:${table.tableNumber}`}
    restaurantSlug={restaurantSlug} tableNumber={Number(table.tableNumber)} />;
}

function GuestTabContent({ restaurantSlug, tableNumber }: {
  restaurantSlug: string; tableNumber: number;
}) {
  const [state, setState] = useState<GuestTabState | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  const refresh = useCallback(() => {
    requestVersion.current += 1;
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    const version = requestVersion.current;
    function isCurrent() { return !disposed && version === requestVersion.current; }
    async function load() {
      setChecking(true);
      try {
        const next = await getGuestTabState(restaurantSlug, tableNumber);
        if (isCurrent()) { setState(next); setError(''); }
      } catch (cause) {
        if (isCurrent()) {
          // Não exibir consumo anterior se o acesso não puder ser confirmado.
          setState(null);
          setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar sua comanda.');
        }
      } finally {
        if (isCurrent()) setChecking(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [restaurantSlug, tableNumber, revision]);

  useEffect(() => {
    function refreshIfVisible() { if (!document.hidden) refresh(); }
    const timer = window.setInterval(refreshIfVisible, 30000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('online', refreshIfVisible);
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') setState(null);
      refresh();
    });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('online', refreshIfVisible);
      data.subscription.unsubscribe();
    };
  }, [refresh]);

  const userId = state?.userId;
  const guestId = state?.guestSessionId;
  const tabId = state?.tabId;

  useEffect(() => {
    if (!userId) { setSyncNotice(''); return; }
    let disposed = false;
    let timer: number | undefined;
    function scheduleRefresh() {
      if (disposed || document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = undefined; if (!disposed) refresh(); }, 200);
    }
    let channel = supabase.channel(`guest-tab:${restaurantSlug}:${tableNumber}:${userId}:${guestId ?? 'none'}:${tabId ?? 'none'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'guest_sessions', filter: `user_id=eq.${userId}` }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'guest_sessions', filter: `user_id=eq.${userId}` }, scheduleRefresh);

    if (guestId) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_tab_guests', filter: `guest_session_id=eq.${guestId}` }, scheduleRefresh)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_tab_guests', filter: `guest_session_id=eq.${guestId}` }, scheduleRefresh);
    }
    if (tabId) {
      channel = channel
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_tabs', filter: `id=eq.${tabId}` }, scheduleRefresh)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_tab_items', filter: `table_tab_id=eq.${tabId}` }, scheduleRefresh)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_tab_items', filter: `table_tab_id=eq.${tabId}` }, scheduleRefresh);
    }
    channel.subscribe((status) => {
      if (disposed) return;
      if (status === 'SUBSCRIBED') { setSyncNotice(''); scheduleRefresh(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setSyncNotice('A atualização ao vivo está indisponível. Conferimos sua comanda a cada 30 segundos enquanto esta tela estiver aberta.');
      }
    });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [userId, guestId, tabId, restaurantSlug, tableNumber, refresh]);

  if (!error && (!state || state.status === 'hidden')) return null;

  return (
    <section aria-labelledby="guest-tab-title" className="overflow-hidden rounded-2xl border border-black/10 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-black/5 px-4 py-3">
        <h2 id="guest-tab-title" className="font-semibold">Minha comanda</h2>
        <button type="button" disabled={checking} onClick={refresh}
          className="min-h-11 px-3 text-sm font-medium text-[var(--brand)] disabled:opacity-50">
          {checking ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>
      <div className="space-y-4 p-4">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {state?.status === 'waiting' && <p className="text-sm opacity-75">
          Sua presença está confirmada. A equipe ainda precisa vincular você a uma comanda.
        </p>}
        {state?.status === 'ready' && <>
          <div className="flex items-start justify-between gap-3">
            <h3 className="break-words text-lg font-semibold">{state.tab.label}</h3>
            <span className="shrink-0 rounded-full bg-[var(--page)] px-3 py-1 text-xs">
              {state.tab.status === 'closed' ? 'Encerrada' : 'Aberta'}
            </span>
          </div>
          {state.items.length === 0 ? <p className="text-sm opacity-75">Ainda não há consumo registrado nesta comanda.</p>
            : <ul className="space-y-3">
              {state.items.map((item) => {
                const isCancelled = item.status === 'cancelled';
                return (
                  <li
                    key={item.id}
                    className={`rounded-xl p-3 transition-opacity ${
                      isCancelled ? 'opacity-60 bg-gray-50' : 'bg-[var(--page)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={`min-w-0 break-words font-medium ${
                          isCancelled ? 'line-through text-gray-500' : ''
                        }`}
                      >
                        {item.quantity} × {item.product_name}
                      </span>
                      <span
                        className={`shrink-0 ${
                          isCancelled ? 'line-through text-gray-400 font-normal' : ''
                        }`}
                      >
                        {currency.format(item.line_total_in_cents / 100)}
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-xs ${
                        isCancelled ? 'line-through text-gray-400' : 'opacity-75'
                      }`}
                    >
                      {currency.format(item.unit_price_in_cents / 100)} por unidade
                    </p>
                    {isCancelled && (
                      <div className="mt-2">
                        <span className="inline-block px-2 py-0.5 text-[11px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200">
                          Cancelado · não incluído no total
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>}
          <div className="flex items-center justify-between gap-3 border-t border-black/10 pt-4">
            <span className="font-semibold">Total da comanda</span>
            <strong className="text-xl text-[var(--brand)]">{currency.format(state.totalInCents / 100)}</strong>
          </div>
          <p className="text-xs opacity-75">Este total corresponde à comanda inteira, incluindo os acessos que compartilham a mesma comanda.</p>
          <BillRequestPanel
            restaurantSlug={restaurantSlug}
            tableTabId={state.tab.id}
            tabLabel={state.tab.label}
            tabStatus={state.tab.status}
          />
        </>}
        {syncNotice && <p role="status" className="text-xs opacity-75">{syncNotice}</p>}
      </div>
    </section>
  );
}
