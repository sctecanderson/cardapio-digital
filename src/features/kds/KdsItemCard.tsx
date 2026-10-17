import { useState, useEffect } from 'react';
import type { KdsItem, ProductionStatus } from './kdsService';

interface KdsItemCardProps {
  item: KdsItem;
  onAdvance: (item: KdsItem, nextStatus: ProductionStatus) => Promise<void>;
  isMutating?: boolean;
}

export function KdsItemCard({ item, onAdvance, isMutating = false }: KdsItemCardProps) {
  const [elapsedMinutes, setElapsedMinutes] = useState(() => calculateElapsedMinutes(item.created_at));
  const [elapsedFormatted, setElapsedFormatted] = useState(() => formatElapsed(item.created_at));

  useEffect(() => {
    const updateTime = () => {
      setElapsedMinutes(calculateElapsedMinutes(item.created_at));
      setElapsedFormatted(formatElapsed(item.created_at));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [item.created_at]);

  const urgency = getUrgencyTier(elapsedMinutes);

  const nextStatusMap: Record<ProductionStatus, ProductionStatus | null> = {
    pending: 'preparing',
    preparing: 'ready',
    ready: 'delivered',
    delivered: null,
  };

  const nextStatus = nextStatusMap[item.production_status];

  const handleAction = async () => {
    if (!nextStatus || isMutating) return;
    await onAdvance(item, nextStatus);
  };

  const stationLabelMap = {
    kitchen: { label: 'Cozinha', color: 'bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300 border-orange-200 dark:border-orange-800/60' },
    bar: { label: 'Bar', color: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200 dark:border-blue-800/60' },
    none: { label: 'Balcão', color: 'bg-stone-100 text-stone-800 dark:bg-stone-800 dark:text-stone-300 border-stone-200 dark:border-stone-700' },
  };

  const stationConfig = stationLabelMap[item.preparation_station] || stationLabelMap.kitchen;

  return (
    <article
      className={`relative flex flex-col justify-between rounded-xl border p-4 shadow-sm transition-all duration-200 ${
        urgency === 'urgent'
          ? 'border-rose-400 bg-rose-50/70 shadow-rose-100 dark:border-rose-900/60 dark:bg-rose-950/30'
          : urgency === 'warning'
          ? 'border-amber-300 bg-amber-50/70 shadow-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
          : 'border-slate-200 bg-white dark:border-zinc-800 dark:bg-[#18181b]'
      }`}
      aria-labelledby={`kds-item-title-${item.id}`}
    >
      <div>
        {/* Cabeçalho do Card: Mesa, Estação e Cronômetro */}
        <div className="flex items-center justify-between gap-2 border-b border-black/5 pb-3 dark:border-white/5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-lg bg-slate-900 px-2.5 py-1 text-sm font-black tracking-wider text-white shadow-xs dark:bg-white dark:text-slate-950"
              aria-label={`Mesa do pedido: ${item.table_name}`}
            >
              {item.table_name.toUpperCase()}
            </span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${stationConfig.color}`}
            >
              {stationConfig.label}
            </span>
          </div>

          {/* Cronômetro decorrido com indicador de urgência */}
          <div
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs font-bold ${
              urgency === 'urgent'
                ? 'animate-pulse bg-rose-700 text-white shadow-xs'
                : urgency === 'warning'
                ? 'bg-amber-700 text-white shadow-xs'
                : 'bg-emerald-700 text-white shadow-xs'
            }`}
            title={`Tempo decorrido: ${elapsedFormatted}`}
            aria-label={`Tempo decorrido: ${elapsedMinutes} minutos`}
          >
            <svg
              className="h-3 w-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{elapsedFormatted}</span>
          </div>
        </div>

        {/* Detalhes do Produto: Quantidade e Nome */}
        <div className="py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-[var(--ink)] dark:text-white">
              {item.quantity}x
            </span>
            <h4
              id={`kds-item-title-${item.id}`}
              className="text-lg font-bold leading-tight text-[var(--ink)] dark:text-white"
            >
              {item.product_name}
            </h4>
          </div>

          {/* Linha do tempo resumida */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--ink)]/60 dark:text-stone-400">
            <span>
              Entrada: <strong>{formatTimeOnly(item.created_at)}</strong>
            </span>
            {item.prep_started_at && (
              <span>
                Início: <strong>{formatTimeOnly(item.prep_started_at)}</strong>
              </span>
            )}
            {item.prep_ready_at && (
              <span>
                Pronto: <strong>{formatTimeOnly(item.prep_ready_at)}</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Botão de Ação Rápida (Alvo de toque mínimo de 48px para tablets de cozinha) */}
      <div className="pt-2">
        {nextStatus && (
          <button
            type="button"
            disabled={isMutating}
            onClick={() => void handleAction()}
            className={`w-full flex items-center justify-center gap-2 rounded-xl py-3.5 px-4 text-sm font-bold shadow-xs transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${
              item.production_status === 'pending'
                ? 'bg-amber-600 hover:bg-amber-700 text-white'
                : item.production_status === 'preparing'
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-emerald-700 hover:bg-emerald-800 text-white'
            }`}
            aria-live="polite"
          >
            {isMutating ? (
              <>
                <svg
                  className="h-4 w-4 animate-spin text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Processando…</span>
              </>
            ) : (
              <>
                {item.production_status === 'pending' ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z" />
                  </svg>
                ) : item.production_status === 'preparing' ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                )}
                <span>
                  {item.production_status === 'pending'
                    ? 'Iniciar Preparo'
                    : item.production_status === 'preparing'
                    ? 'Marcar Pronto'
                    : 'Entregue na Mesa'}
                </span>
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}

function calculateElapsedMinutes(isoString: string): number {
  const diffMs = Math.max(0, Date.now() - new Date(isoString).getTime());
  return Math.floor(diffMs / 60000);
}

function formatElapsed(isoString: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  const m = Math.floor(diffSec / 60);
  const s = diffSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${String(remM).padStart(2, '0')}m`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimeOnly(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

type UrgencyTier = 'normal' | 'warning' | 'urgent';

function getUrgencyTier(minutes: number): UrgencyTier {
  if (minutes >= 20) return 'urgent';
  if (minutes >= 10) return 'warning';
  return 'normal';
}
