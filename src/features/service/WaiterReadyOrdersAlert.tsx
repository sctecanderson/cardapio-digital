import { useEffect, useRef, useState } from 'react';
import { advanceKdsItemStatus, fetchActiveKdsItems, subscribeToKdsItems } from '../kds/kdsService';
import type { KdsItem } from '../kds/kdsService';

interface WaiterReadyOrdersAlertProps {
  restaurantSlug: string;
  restaurantId: string;
  onDelivered?: () => void;
}

function formatStopwatch(prepReadyAt: string | null, now: number): string {
  if (!prepReadyAt) return '00:00';
  const readyTs = new Date(prepReadyAt).getTime();
  if (Number.isNaN(readyTs)) return '00:00';
  const elapsedSeconds = Math.max(0, Math.floor((now - readyTs) / 1000));
  const mins = Math.floor(elapsedSeconds / 60);
  const secs = elapsedSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function WaiterReadyOrdersAlert({
  restaurantSlug,
  restaurantId,
  onDelivered,
}: WaiterReadyOrdersAlertProps) {
  const [readyItems, setReadyItems] = useState<KdsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState<number>(() => Date.now());
  const mounted = useRef(false);

  // Carrega itens com status 'ready'
  const loadReadyItems = async () => {
    try {
      const active = await fetchActiveKdsItems(restaurantSlug);
      if (mounted.current) {
        setReadyItems(active.filter((i) => i.production_status === 'ready'));
        setError('');
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Falha ao buscar pedidos prontos.');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void loadReadyItems();

    // Cronômetro atualiza a cada 1 segundo
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    // Escuta mudanças em tempo real em table_tab_items
    const unsubscribe = subscribeToKdsItems(restaurantId, () => {
      void loadReadyItems();
    });

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [restaurantSlug, restaurantId]);

  async function handleConfirmDelivery(item: KdsItem) {
    if (busyItemId) return;
    setBusyItemId(item.id);
    setError('');

    try {
      const result = await advanceKdsItemStatus(restaurantSlug, item.id, 'delivered');
      if (!result.success) {
        setError(result.error || 'Não foi possível confirmar a entrega.');
      } else {
        if (mounted.current) {
          setReadyItems((prev) => prev.filter((i) => i.id !== item.id));
        }
        onDelivered?.();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Falha ao confirmar entrega.');
      }
    } finally {
      if (mounted.current) setBusyItemId(null);
    }
  }

  if (loading && readyItems.length === 0) {
    return null;
  }

  if (readyItems.length === 0) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Pedidos prontos para entrega"
      className="mb-6 rounded-2xl border-2 border-emerald-500/30 bg-emerald-50/60 p-4 shadow-sm"
    >
      <div className="flex items-center justify-between pb-3 border-b border-emerald-200/60">
        <div className="flex items-center gap-2">
          <span className="flex h-3 w-3 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-600" />
          </span>
          <h3 className="text-sm font-bold tracking-tight text-emerald-950 uppercase m-0">
            🔔 Pedidos Prontos para Retirar ({readyItems.length})
          </h3>
        </div>
        <span className="text-xs font-semibold text-emerald-800 bg-emerald-100/80 px-2.5 py-0.5 rounded-full border border-emerald-200">
          Ação do Garçom
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 bg-red-50 p-2 rounded-lg border border-red-200">
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-2.5">
        {readyItems.map((item) => {
          const isBusy = busyItemId === item.id;
          const isBar = item.preparation_station === 'bar';
          const stationLabel = isBar ? 'Retirar no Bar' : 'Retirar na Cozinha';
          const stationBg = isBar
            ? 'bg-orange-100 text-orange-900 border-orange-200 dark:bg-orange-950/60 dark:text-orange-200 dark:border-orange-900/60'
            : 'bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-950/60 dark:text-blue-200 dark:border-blue-900/60';
          const timeElapsed = formatStopwatch(item.prep_ready_at, now);

          return (
            <li
              key={item.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white dark:border-emerald-900/50 dark:bg-stone-900 p-3.5 shadow-xs"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center rounded-lg bg-emerald-800 px-2.5 py-1 text-xs font-extrabold text-white">
                    Mesa {String(item.table_number).padStart(2, '0')}
                  </span>
                  <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-md border ${stationBg}`}>
                    {stationLabel}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-800 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-100 dark:border-emerald-900/50">
                    ⏱️ Pronto há {timeElapsed}
                  </span>
                </div>
                <p className="text-sm font-bold text-gray-900 dark:text-stone-100 m-0">
                  {item.quantity}x {item.product_name}
                </p>
              </div>

              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleConfirmDelivery(item)}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 active:scale-98 transition-all disabled:opacity-50"
              >
                {isBusy ? (
                  <span>Confirmando…</span>
                ) : (
                  <>
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    <span>Confirmar Entrega na Mesa</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
