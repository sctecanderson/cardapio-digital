import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { getBillRequestState, requestBill, cancelBillRequest } from './billRequests';
import type { BillRequest } from './billRequests';

interface Props {
  restaurantSlug: string;
  tableTabId: string;
  tabLabel: string;
  tabStatus: 'open' | 'closed';
}

function elapsed(createdAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function BillRequestPanel(props: Props) {
  return <BillRequestContent key={`${props.restaurantSlug}:${props.tableTabId}`} {...props} />;
}

function BillRequestContent({ restaurantSlug, tableTabId, tabLabel, tabStatus }: Props) {
  const mounted = useRef(false);
  const acting = useRef(false);
  const revision = useRef(0);
  const reload = useRef<() => void>(() => {});
  const [request, setRequest] = useState<BillRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    let requestedAgain = false;
    let timer: number | undefined;
    function scheduleLoad() {
      if (disposed || timer !== undefined || document.hidden) return;
      timer = window.setTimeout(() => { timer = undefined; void load(); }, 250);
    }
    async function load() {
      if (disposed) return;
      if (acting.current) { scheduleLoad(); return; }
      if (fetching) { requestedAgain = true; return; }
      fetching = true;
      const version = revision.current;
      setLoading(true);
      try {
        const next = await getBillRequestState(tableTabId);
        if (disposed) return;
        if (acting.current || version !== revision.current) { requestedAgain = true; return; }
        setRequest(next);
        setLoadError('');
        setNow(Date.now());
        if (next?.status === 'pending') setConfirming(false);
      } catch (cause) {
        if (!disposed && version === revision.current) {
          setLoadError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a solicitação.');
        }
      } finally {
        fetching = false;
        if (!disposed) {
          setLoading(false);
          if (requestedAgain) { requestedAgain = false; scheduleLoad(); }
        }
      }
    }
    reload.current = () => { void load(); };
    const channel = supabase.channel(`bill-request:${restaurantSlug}:${tableTabId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'service_requests', filter: `table_tab_id=eq.${tableTabId}` }, scheduleLoad)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'service_requests', filter: `table_tab_id=eq.${tableTabId}` }, scheduleLoad)
      .subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') { setSyncNotice(''); scheduleLoad(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setSyncNotice('Atualização ao vivo indisponível. Conferimos a solicitação periodicamente; você também pode atualizar abaixo.');
        }
      });
    function refreshIfVisible() { if (!document.hidden) scheduleLoad(); }
    const fallback = window.setInterval(refreshIfVisible, 30000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('online', refreshIfVisible);
    void load();
    return () => {
      disposed = true;
      reload.current = () => {};
      if (timer !== undefined) window.clearTimeout(timer);
      window.clearInterval(fallback);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('online', refreshIfVisible);
      void supabase.removeChannel(channel);
    };
  }, [restaurantSlug, tableTabId]);

  useEffect(() => {
    if (tabStatus === 'closed') setConfirming(false);
    reload.current();
  }, [tabStatus]);

  useEffect(() => {
    function tick() {
      if (document.hidden) return;
      const timestamp = Date.now();
      setNow(timestamp);
      if (retryUntil > 0 && timestamp >= retryUntil) setRetryUntil(0);
    }
    if (request?.status !== 'pending' && retryUntil <= Date.now()) return;
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [request?.status, retryUntil]);

  const pending = request?.status === 'pending';
  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000));
  const disabled = busy || loading || !!loadError || pending || tabStatus === 'closed' || retrySeconds > 0;

  const [confirmingCancel, setConfirmingCancel] = useState(false);

  async function handleCancelBill() {
    if (acting.current || busy || !pending) return;
    acting.current = true;
    revision.current += 1;
    setBusy(true);
    setActionError('');
    try {
      await cancelBillRequest(restaurantSlug, tableTabId);
      if (!mounted.current) return;
      revision.current += 1;
      setRequest(null);
      setConfirmingCancel(false);
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Não foi possível cancelar o pedido de conta.');
    } finally {
      acting.current = false;
      if (mounted.current) { setBusy(false); reload.current(); }
    }
  }

  async function handleConfirm() {
    if (acting.current || disabled) return;
    acting.current = true;
    revision.current += 1;
    setBusy(true);
    setActionError('');
    try {
      const result = await requestBill(restaurantSlug, tableTabId);
      if (!mounted.current) return;
      revision.current += 1;
      setNow(Date.now());
      if (result.status === 'rate_limited') {
        setRetryUntil(Date.now() + result.retryAfterSeconds * 1000);
        setActionError('Aguarde um pouco antes de fazer outra solicitação.');
      } else {
        setRequest(result.request);
        setRetryUntil(0);
        setLoadError('');
      }
      setConfirming(false);
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Não foi possível pedir a conta.');
    } finally {
      acting.current = false;
      if (mounted.current) { setBusy(false); reload.current(); }
    }
  }

  return <section aria-label="Solicitação de conta" className="border-t border-black/10 pt-4">
    {pending && request && tabStatus === 'open' && <div className="rounded-xl bg-amber-50 p-4 text-amber-900">
      <p role="status" className="font-semibold">Conta solicitada</p>
      <p className="mt-1 text-sm">Aguardando a equipe para esta comanda.</p>
      <p role="timer" aria-live="off" aria-label="Tempo aguardando a conta" className="mt-2 font-mono text-lg tabular-nums">
        {elapsed(request.created_at, now)}
      </p>

      {confirmingCancel ? (
        <div className="mt-3 p-3 bg-white/80 rounded-lg border border-amber-200">
          <p className="text-xs text-amber-950 font-medium">
            Atenção: cancelar este pedido de conta afeta todos os clientes vinculados a esta comanda. Deseja cancelar mesmo assim?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCancelBill()}
              className="px-3 py-1.5 text-xs bg-red-600 text-white font-medium rounded-lg disabled:opacity-50"
            >
              {busy ? 'Cancelando…' : 'Sim, cancelar conta'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingCancel(false)}
              className="px-3 py-1.5 text-xs bg-white border border-black/20 rounded-lg"
            >
              Voltar
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingCancel(true)}
            className="text-xs text-red-700 underline font-medium hover:text-red-900"
          >
            Cancelar pedido de conta
          </button>
        </div>
      )}
    </div>}
    {request?.status === 'attended' && tabStatus === 'open' && <p role="status" className="text-sm text-green-800">
      A equipe marcou sua solicitação como atendida.
    </p>}
    {request?.status === 'cancelled' && tabStatus === 'open' && <p role="status" className="text-sm opacity-75">
      A solicitação anterior foi cancelada.
    </p>}
    {tabStatus === 'open' && !pending && (confirming ? <div className="rounded-xl bg-[var(--page)] p-4">
      <p className="font-medium">Pedir a conta da comanda “{tabLabel}”?</p>
      <p className="mt-1 text-sm opacity-75">A solicitação vale para a comanda inteira.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={disabled} onClick={() => void handleConfirm()}
          className="min-h-12 flex-1 rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50">
          {busy ? 'Solicitando…' : 'Sim, pedir conta'}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}
          className="min-h-12 rounded-xl border border-black/20 px-4">Cancelar</button>
      </div>
    </div> : <button type="button" disabled={disabled} onClick={() => { setConfirming(true); setActionError(''); }}
      className="mt-2 min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50">
      {loading ? 'Verificando solicitação…' : retrySeconds > 0 ? `Aguarde ${retrySeconds}s` : 'Pedir conta'}
    </button>)}
    {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
    {actionError && <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p>}
    {syncNotice && <p role="status" className="mt-3 text-xs opacity-75">{syncNotice}</p>}
    <button type="button" disabled={loading || busy} onClick={() => reload.current()}
      className="mt-2 min-h-11 px-2 text-sm text-[var(--brand)] underline disabled:opacity-50">
      {loading ? 'Atualizando…' : 'Atualizar solicitação'}
    </button>
  </section>;
}
