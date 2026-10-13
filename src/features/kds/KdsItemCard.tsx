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

  const actionLabelMap: Record<ProductionStatus, { label: string; icon: string }> = {
    pending: { label: 'Iniciar Preparo', icon: '🔥' },
    preparing: { label: 'Marcar Pronto', icon: '✅' },
    ready: { label: 'Entregue na Mesa', icon: '🚀' },
    delivered: { label: 'Finalizado', icon: '✓' },
  };

  const actionConfig = actionLabelMap[item.production_status];

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
          ? 'border-rose-400 bg-rose-50/50 shadow-rose-100 dark:border-rose-800 dark:bg-rose-950/20'
          : urgency === 'warning'
          ? 'border-amber-300 bg-amber-50/40 shadow-amber-50 dark:border-amber-800 dark:bg-amber-950/20'
          : 'border-black/10 bg-white dark:border-white/10 dark:bg-[#1f1a17]'
      }`}
      aria-labelledby={`kds-item-title-${item.id}`}
    >
      <div>
        {/* Cabeçalho do Card: Mesa, Estação e Cronômetro */}
        <div className="flex items-center justify-between gap-2 border-b border-black/5 pb-3 dark:border-white/5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-lg bg-[var(--ink)] px-2.5 py-1 text-sm font-black tracking-wider text-[var(--bg)] shadow-sm dark:bg-[#ffffff] dark:text-[#14110f]"
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
                ? 'animate-pulse bg-rose-600 text-white shadow-sm'
                : urgency === 'warning'
                ? 'bg-amber-500 text-white'
                : 'bg-emerald-600 text-white'
            }`}
            title={`Tempo decorrido: ${elapsedFormatted}`}
            aria-label={`Tempo decorrido: ${elapsedMinutes} minutos`}
          >
            <span aria-hidden="true" className="text-[10px]">⏱</span>
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
            className={`w-full flex items-center justify-center gap-2 rounded-xl py-3.5 px-4 text-sm font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${
              item.production_status === 'pending'
                ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-500/20'
                : item.production_status === 'preparing'
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/20'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
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
                <span aria-hidden="true" className="text-base">{actionConfig.icon}</span>
                <span>{actionConfig.label}</span>
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
