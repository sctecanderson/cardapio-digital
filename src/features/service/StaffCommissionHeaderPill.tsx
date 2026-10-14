import { useEffect, useState, useMemo } from 'react';
import { useLocation, useParams } from 'react-router';
import { useStaffCommission } from './StaffCommissionContext';
import { supabase } from '../../lib/supabase';
import { getStaffAccess } from '../auth/staffAuth';
import { getTimezoneUtcRange, toTimezoneDateString } from './staffDateUtils';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function StaffCommissionHeaderPill() {
  const location = useLocation();
  const { restaurantSlug = '' } = useParams();
  const { isPrivate, togglePrivacy, historyCommissionInCents } = useStaffCommission();

  const isHistoryTab = location.pathname.endsWith('/historico');

  const [todayCommissionInCents, setTodayCommissionInCents] = useState<number | null>(null);
  const [loadingToday, setLoadingToday] = useState(false);

  // Busca o acumulado de hoje quando não estiver na tela de histórico ou como fallback
  useEffect(() => {
    let disposed = false;

    async function fetchTodayCommission() {
      if (!restaurantSlug) return;
      setLoadingToday(true);

      try {
        const access = await getStaffAccess(restaurantSlug);
        if (!access || disposed) return;

        // Fuso horário do restaurante
        const { data: restData } = await supabase
          .from('restaurants')
          .select('timezone')
          .eq('id', access.restaurantId)
          .maybeSingle();

        const timezone = restData?.timezone || 'America/Sao_Paulo';
        const todayStr = toTimezoneDateString(new Date(), timezone);
        const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(todayStr, timezone);

        let query = supabase
          .from('table_visits')
          .select(`
            id,
            status,
            closed_at,
            assigned_member_id,
            table_tabs (
              id,
              status,
              service_fee_in_cents
            )
          `)
          .eq('restaurant_id', access.restaurantId)
          .eq('status', 'closed')
          .gte('closed_at', startUtc)
          .lt('closed_at', nextDayStartUtc);

        if (access.role === 'waiter') {
          query = query.eq('assigned_member_id', access.memberId);
        }

        const { data, error } = await query;
        if (error || disposed) return;

        let totalFee = 0;
        for (const visit of (data ?? []) as Array<{
          table_tabs: Array<{ status: string; service_fee_in_cents: number | null }> | null;
        }>) {
          const closedTabs = (visit.table_tabs ?? []).filter((t) => t.status === 'closed');
          totalFee += closedTabs.reduce((acc, curr) => acc + (curr.service_fee_in_cents || 0), 0);
        }

        if (!disposed) {
          setTodayCommissionInCents(totalFee);
        }
      } catch {
        // Silêncio em caso de erro transitório de rede
      } finally {
        if (!disposed) setLoadingToday(false);
      }
    }

    void fetchTodayCommission();

    return () => {
      disposed = true;
    };
  }, [restaurantSlug, location.pathname]);

  const displayValueInCents = useMemo(() => {
    if (isHistoryTab && historyCommissionInCents !== null) {
      return historyCommissionInCents;
    }
    return todayCommissionInCents ?? 0;
  }, [isHistoryTab, historyCommissionInCents, todayCommissionInCents]);

  const formattedValue = useMemo(() => {
    if (isPrivate) return 'R$ --,--';
    if (loadingToday && !isHistoryTab && todayCommissionInCents === null) return 'R$ ...';
    return currency.format(displayValueInCents / 100);
  }, [isPrivate, loadingToday, isHistoryTab, todayCommissionInCents, displayValueInCents]);

  return (
    <button
      type="button"
      onClick={togglePrivacy}
      title={isPrivate ? 'Clique para ver o valor da comissão' : 'Clique para ocultar o valor da comissão'}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 transition-all cursor-pointer text-xs font-bold text-emerald-600 dark:text-emerald-400 select-none shadow-xs"
      aria-label={isPrivate ? 'Comissão oculta. Clique para exibir.' : `Comissão: ${formattedValue}. Clique para ocultar.`}
    >
      <span className="font-mono tracking-tight font-extrabold text-[13px] text-emerald-700 dark:text-emerald-400">
        {formattedValue}
      </span>
      {isPrivate ? (
        /* Ícone Olho Fechado (EyeOff) */
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 opacity-75 hover:opacity-100 transition-opacity"
          aria-hidden="true"
        >
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      ) : (
        /* Ícone Olho Aberto (Eye) */
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 opacity-75 hover:opacity-100 transition-opacity"
          aria-hidden="true"
        >
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}
