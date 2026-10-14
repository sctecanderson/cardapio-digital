import { useEffect, useState, useMemo, useCallback } from 'react';
import { useOutletContext } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';
import { useStaffCommission } from './StaffCommissionContext';
import { getTimezoneUtcRange, toTimezoneDateString } from './staffDateUtils';

interface ClosedVisit {
    id: string;
    opened_at: string;
    closed_at: string | null;
    table: {
        table_number: number;
    };
}

interface TabDetail {
    id: string;
    label: string;
    status: 'open' | 'closed';
    created_at: string;
    closed_at: string | null;
    subtotal_in_cents: number | null;
    service_fee_percent: number | null;
    service_fee_in_cents: number | null;
    total_in_cents: number | null;
    service_fee_accepted: boolean | null;
}

interface ItemDetail {
    id: string;
    table_tab_id: string;
    product_name: string;
    quantity: number;
    unit_price_in_cents: number;
    line_total_in_cents: number;
    status: 'active' | 'cancelled';
}

interface VisitConsumptionDetails {
    tabs: TabDetail[];
    items: ItemDetail[];
    totalInCents: number;
}

const PAGE_SIZE = 20;

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
});

const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
});

const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

interface WeekDayOption {
    isoDate: string;
    dayName: string;
    formattedDay: string;
    isToday: boolean;
}

function getWeekDaysAround(centerDate: Date, timeZone: string): WeekDayOption[] {
    const todayStr = toTimezoneDateString(new Date(), timeZone);
    const days: WeekDayOption[] = [];

    const currentDay = centerDate.getDay();
    const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;

    const monday = new Date(centerDate);
    monday.setDate(centerDate.getDate() + diffToMonday);

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);

        const iso = toTimezoneDateString(d, timeZone);
        days.push({
            isoDate: iso,
            dayName: dayNames[d.getDay()],
            formattedDay: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
            isToday: iso === todayStr,
        });
    }

    return days;
}

interface CommissionSummary {
    totalFeeInCents: number;
    distinctVisitsCount: number;
}

export function StaffHistoryPage() {
    const access = useOutletContext<StaffAccess>();
    const { isPrivate, setHistoryCommissionInCents } = useStaffCommission();

    const [timezone, setTimezone] = useState<string>('America/Sao_Paulo');
    const [visits, setVisits] = useState<ClosedVisit[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState('');
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);

    // Filtro por data
    const [selectedDate, setSelectedDate] = useState<string>('');

    // Resumo financeiro de comissão (taxa de serviço)
    const [commissionSummary, setCommissionSummary] = useState<CommissionSummary>({
        totalFeeInCents: 0,
        distinctVisitsCount: 0,
    });
    const [loadingCommission, setLoadingCommission] = useState(true);

    // ID do atendimento expandido
    const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);
    const [detailsMap, setDetailsMap] = useState<Record<string, VisitConsumptionDetails>>({});
    const [loadingDetails, setLoadingDetails] = useState<Record<string, boolean>>({});

    // Sincroniza limpeza no unmount
    useEffect(() => {
        return () => {
            setHistoryCommissionInCents(null);
        };
    }, [setHistoryCommissionInCents]);

    // Carrega o fuso horário configurado do restaurante
    useEffect(() => {
        let disposed = false;
        async function fetchRestaurantConfig() {
            try {
                const { data } = await supabase
                    .from('restaurants')
                    .select('timezone')
                    .eq('id', access.restaurantId)
                    .maybeSingle();

                if (!disposed && data?.timezone) {
                    setTimezone(data.timezone);
                }
            } catch {
                // Mantém o padrão America/Sao_Paulo
            }
        }
        void fetchRestaurantConfig();
        return () => {
            disposed = true;
        };
    }, [access.restaurantId]);

    // Dias da semana atual para a barra de filtros
    const weekDays = useMemo(() => {
        const base = selectedDate ? new Date(selectedDate + 'T12:00:00Z') : new Date();
        return getWeekDaysAround(base, timezone);
    }, [selectedDate, timezone]);

    const fetchVisits = useCallback(
        async (targetPage: number, dateFilter: string, append: boolean) => {
            if (append) {
                setLoadingMore(true);
            } else {
                setLoading(true);
            }
            setError('');

            try {
                const from = targetPage * PAGE_SIZE;
                const to = from + PAGE_SIZE; // busca 1 a mais para detectar hasMore

                let query = supabase
                    .from('table_visits')
                    .select(`
                        id,
                        opened_at,
                        closed_at,
                        table:restaurant_tables!inner(table_number)
                    `)
                    .eq('restaurant_id', access.restaurantId)
                    .eq('status', 'closed')
                    .order('closed_at', { ascending: false })
                    .order('id', { ascending: false })
                    .range(from, to);

                if (access.role === 'waiter') {
                    query = query.eq('assigned_member_id', access.memberId);
                }

                if (dateFilter) {
                    const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(dateFilter, timezone);
                    query = query.gte('closed_at', startUtc).lt('closed_at', nextDayStartUtc);
                }

                const { data, error: qErr } = await query.overrideTypes<ClosedVisit[], { merge: false }>();

                if (qErr) throw qErr;

                const results = data ?? [];
                const moreAvailable = results.length > PAGE_SIZE;
                const pageResults = results.slice(0, PAGE_SIZE);

                setHasMore(moreAvailable);
                if (append) {
                    setVisits((prev) => [...prev, ...pageResults]);
                } else {
                    setVisits(pageResults);
                }
            } catch (cause) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível carregar o histórico de atendimentos.',
                );
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [access.restaurantId, access.memberId, access.role, timezone],
    );

    const fetchCommissionSummary = useCallback(
        async (dateFilter: string) => {
            setLoadingCommission(true);
            try {
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
                    .eq('status', 'closed');

                if (access.role === 'waiter') {
                    query = query.eq('assigned_member_id', access.memberId);
                }

                if (dateFilter) {
                    const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(dateFilter, timezone);
                    query = query.gte('closed_at', startUtc).lt('closed_at', nextDayStartUtc);
                }

                const { data, error: qErr } = await query;
                if (qErr) throw qErr;

                let totalFeeInCents = 0;
                let distinctVisitsCount = 0;

                for (const visit of (data ?? []) as Array<{
                    id: string;
                    status: string;
                    closed_at: string | null;
                    assigned_member_id: string;
                    table_tabs: Array<{
                        id: string;
                        status: 'open' | 'closed';
                        service_fee_in_cents: number | null;
                    }> | null;
                }>) {
                    const closedTabs = (visit.table_tabs ?? []).filter((tab) => tab.status === 'closed');
                    const visitFee = closedTabs.reduce((sum, tab) => sum + (tab.service_fee_in_cents || 0), 0);
                    totalFeeInCents += visitFee;
                    if (visitFee > 0) {
                        distinctVisitsCount += 1;
                    }
                }

                setCommissionSummary({
                    totalFeeInCents,
                    distinctVisitsCount,
                });
                setHistoryCommissionInCents(totalFeeInCents);
            } catch {
                setCommissionSummary({
                    totalFeeInCents: 0,
                    distinctVisitsCount: 0,
                });
                setHistoryCommissionInCents(0);
            } finally {
                setLoadingCommission(false);
            }
        },
        [access.restaurantId, access.memberId, access.role, timezone, setHistoryCommissionInCents],
    );

    // Carrega quando a data ou restaurante muda
    useEffect(() => {
        setPage(0);
        void fetchVisits(0, selectedDate, false);
        void fetchCommissionSummary(selectedDate);
    }, [selectedDate, fetchVisits, fetchCommissionSummary]);

    function handleLoadMore() {
        if (loadingMore || !hasMore) return;
        const nextPage = page + 1;
        setPage(nextPage);
        void fetchVisits(nextPage, selectedDate, true);
    }

    // Carrega detalhes de consumo e comandas de um atendimento ao clicar
    async function toggleVisitDetails(visitId: string) {
        if (expandedVisitId === visitId) {
            setExpandedVisitId(null);
            return;
        }

        setExpandedVisitId(visitId);

        if (detailsMap[visitId]) return;

        setLoadingDetails((prev) => ({ ...prev, [visitId]: true }));

        try {
            const [tabsRes, itemsRes] = await Promise.all([
                supabase
                    .from('table_tabs')
                    .select('id, label, status, created_at, closed_at, subtotal_in_cents, service_fee_percent, service_fee_in_cents, total_in_cents, service_fee_accepted')
                    .eq('table_visit_id', visitId)
                    .order('created_at', { ascending: true })
                    .overrideTypes<TabDetail[], { merge: false }>(),

                supabase
                    .from('table_tab_items')
                    .select('id, table_tab_id, product_name, quantity, unit_price_in_cents, line_total_in_cents, status')
                    .eq('table_visit_id', visitId)
                    .order('created_at', { ascending: true })
                    .overrideTypes<ItemDetail[], { merge: false }>(),
            ]);

            const tabs = tabsRes.data ?? [];
            const items = itemsRes.data ?? [];

            // Calcula o total geral da mesa respeitando os snapshots persistidos
            let totalInCents = 0;
            for (const tab of tabs) {
                if (tab.total_in_cents !== null && tab.total_in_cents !== undefined) {
                    totalInCents += tab.total_in_cents;
                } else {
                    const tabSubtotal = items
                        .filter((item) => item.table_tab_id === tab.id && item.status === 'active')
                        .reduce((acc, curr) => acc + curr.line_total_in_cents, 0);
                    totalInCents += tabSubtotal;
                }
            }

            setDetailsMap((prev) => ({
                ...prev,
                [visitId]: {
                    tabs,
                    items,
                    totalInCents,
                },
            }));
        } catch {
            // Em caso de falha, mantém vazio
        } finally {
            setLoadingDetails((prev) => ({ ...prev, [visitId]: false }));
        }
    }

    // Formata o título da data selecionada
    const selectedDateDisplay = useMemo(() => {
        if (!selectedDate) return null;
        const [year, month, day] = selectedDate.split('-').map(Number);
        const dateObj = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
        return new Intl.DateTimeFormat('pt-BR', {
            timeZone: timezone,
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            year: 'numeric',
        }).format(dateObj);
    }, [selectedDate, timezone]);

    const todayStr = useMemo(() => toTimezoneDateString(new Date(), timezone), [timezone]);
    const isPastDay = Boolean(selectedDate && selectedDate < todayStr);

    const selectedDateShort = useMemo(() => {
        if (!selectedDate) return null;
        const [year, month, day] = selectedDate.split('-').map(Number);
        const dateObj = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
        const weekday = new Intl.DateTimeFormat('pt-BR', {
            timeZone: timezone,
            weekday: 'long',
        }).format(dateObj);
        const formattedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
        const dayStr = String(day).padStart(2, '0');
        const monthStr = String(month).padStart(2, '0');
        return `${formattedWeekday}, ${dayStr}/${monthStr}`;
    }, [selectedDate, timezone]);

    return (
        <section className="mx-auto max-w-xl pb-12">
            <div className="mb-5">
                <h1 className="text-xl font-bold text-[var(--ink,#2b1d17)]">
                    Histórico de Atendimentos
                </h1>
                <p className="text-xs text-[#8c7867] mt-1">
                    Filtre por dia da semana para consultar os atendimentos e comandas.
                </p>
            </div>

            {/* =========================================================
                DIAS DA SEMANA
               ========================================================= */}
            <div className="rounded-2xl border border-[#ece4d8] bg-white p-3.5 mb-5 shadow-xs">
                <div className="flex gap-2 overflow-x-auto pb-0.5 pt-0.5" role="tablist" aria-label="Dias da semana">
                    <button
                        type="button"
                        onClick={() => setSelectedDate('')}
                        className={`flex-shrink-0 min-w-16 px-3 py-2 rounded-xl text-xs font-bold transition-all text-center cursor-pointer ${
                            !selectedDate
                                ? 'bg-[var(--brand,#b9472b)] text-white shadow-sm'
                                : 'bg-[#f4eee5] text-[#655446] hover:bg-[#ede5d8]'
                        }`}
                    >
                        <span className="block text-[10px] uppercase font-semibold opacity-85">
                            Todos
                        </span>
                        <span>Geral</span>
                    </button>

                    {weekDays.map((day) => {
                        const isSelected = selectedDate === day.isoDate;
                        return (
                            <button
                                key={day.isoDate}
                                type="button"
                                onClick={() => setSelectedDate(day.isoDate)}
                                className={`flex-shrink-0 min-w-16 px-3 py-2 rounded-xl text-xs font-bold transition-all text-center cursor-pointer ${
                                    isSelected
                                        ? 'bg-[var(--brand,#b9472b)] text-white shadow-sm'
                                        : 'bg-[#f4eee5] text-[#655446] hover:bg-[#ede5d8]'
                                }`}
                            >
                                <span className="block text-[10px] uppercase font-semibold opacity-85">
                                    {day.dayName}
                                </span>
                                <span>{day.formattedDay}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* =========================================================
                FAIXA DE RESUMO DO PERÍODO SELECIONADO
               ========================================================= */}
            <div className="mb-4 rounded-xl border border-[#ebdccb] bg-[#fffaf4] p-3.5 text-xs shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ebdccb]/70 pb-2">
                    <span className="font-bold text-sm text-[#1c1917]">
                        {selectedDate
                            ? `${selectedDateShort} • ${visits.length} atendimento${visits.length !== 1 ? 's' : ''}`
                            : `Geral / Todas as datas • ${visits.length} atendimento${visits.length !== 1 ? 's' : ''}`}
                    </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold text-[#1c1917]">
                        <span className="text-[#655446]">
                            {selectedDate ? 'Valor total do dia:' : 'Valor total do período:'}
                        </span>
                        <strong className="text-emerald-700 font-extrabold font-mono text-sm">
                            {isPrivate ? 'R$ --,--' : currency.format(commissionSummary.totalFeeInCents / 100)}
                        </strong>
                    </div>
                    {isPastDay ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            ✓ Expediente finalizado / Valor consolidado
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                            Em apuração no expediente
                        </span>
                    )}
                </div>
            </div>

            {loading ? (
                <p role="status" className="py-6 text-sm opacity-75">
                    Carregando histórico…
                </p>
            ) : error ? (
                <p role="alert" className="p-4 rounded-xl bg-red-50 text-xs text-red-700">
                    {error}
                </p>
            ) : visits.length === 0 ? (
                <div className="rounded-2xl border border-[#ece4d8] bg-white p-8 text-center">
                    <p className="text-sm font-semibold text-[#7a6655]">
                        Nenhum atendimento encontrado {selectedDateDisplay ? `em ${selectedDateDisplay}` : 'recentemente'}.
                    </p>
                    {selectedDate && (
                        <button
                            type="button"
                            onClick={() => setSelectedDate('')}
                            className="mt-3 inline-block rounded-xl bg-[var(--brand,#b9472b)] px-4 py-2 text-xs font-bold text-white"
                        >
                            Ver todos os atendimentos
                        </button>
                    )}
                </div>
            ) : (
                <div className="space-y-3">
                    <ul className="space-y-3">
                        {visits.map((visit) => {
                            const isExpanded = expandedVisitId === visit.id;
                            const details = detailsMap[visit.id];
                            const isLoadingDet = loadingDetails[visit.id];

                            return (
                                <li
                                    key={visit.id}
                                    className="rounded-2xl border border-[#ebdccb] bg-white shadow-sm overflow-hidden transition-all"
                                >
                                    {/* Cabeçalho clicável do Card */}
                                    <button
                                        type="button"
                                        onClick={() => void toggleVisitDetails(visit.id)}
                                        className="w-full text-left p-4 hover:bg-[#fffdfa] transition-colors focus:outline-none cursor-pointer"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-base text-[#1c1917]">
                                                    Mesa {String(visit.table.table_number).padStart(2, '0')}
                                                </span>
                                                <span className="text-[11px] rounded-full bg-[#f4eee5] px-2 py-0.5 font-semibold text-[#655446]">
                                                    Encerrado
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                {details && (
                                                    <span className="font-bold text-sm text-[var(--brand,#b9472b)]">
                                                        {currency.format(details.totalInCents / 100)}
                                                    </span>
                                                )}
                                                <span className="text-xs text-[#8c7867]">
                                                    {isExpanded ? '▲' : '▼'}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="mt-2 text-xs text-[#8c7867] flex flex-wrap gap-x-4 gap-y-0.5">
                                            <span>
                                                Entrada: {dateTimeFormat.format(new Date(visit.opened_at))}
                                            </span>
                                            {visit.closed_at && (
                                                <span>
                                                    Saída: {dateTimeFormat.format(new Date(visit.closed_at))}
                                                </span>
                                            )}
                                        </div>
                                    </button>

                                    {/* Conteúdo Expandido: Comandas e Itens Vendidos */}
                                    {isExpanded && (
                                        <div className="border-t border-[#f0eae0] bg-[#faf6f0] p-4">
                                            {isLoadingDet ? (
                                                <p className="text-xs text-[#8c7867] italic py-2">
                                                    Carregando comandas e consumo…
                                                </p>
                                            ) : !details || details.tabs.length === 0 ? (
                                                <p className="text-xs text-[#8c7867] italic py-2">
                                                    Nenhuma comanda registrada neste atendimento.
                                                </p>
                                            ) : (
                                                <div className="space-y-4">
                                                    {details.tabs.map((tab) => {
                                                        const tabItems = details.items.filter(
                                                            (item) => item.table_tab_id === tab.id,
                                                        );

                                                        const hasSnapshot = tab.subtotal_in_cents !== null && tab.subtotal_in_cents !== undefined;
                                                        const calculatedItemsSubtotal = tabItems
                                                            .filter((i) => i.status === 'active')
                                                            .reduce((acc, curr) => acc + curr.line_total_in_cents, 0);

                                                        const tabSubtotal = hasSnapshot
                                                            ? tab.subtotal_in_cents!
                                                            : calculatedItemsSubtotal;

                                                        const tabFeeInCents = hasSnapshot
                                                            ? (tab.service_fee_in_cents ?? 0)
                                                            : 0;

                                                        const tabTotalInCents = hasSnapshot
                                                            ? (tab.total_in_cents ?? tabSubtotal)
                                                            : tabSubtotal;

                                                        return (
                                                            <div
                                                                key={tab.id}
                                                                className="rounded-xl border border-[#ebdccb] bg-white p-3.5 shadow-xs"
                                                            >
                                                                {/* Título da Comanda */}
                                                                <div className="flex items-center justify-between pb-2 border-b border-[#f4ede3]">
                                                                    <h4 className="font-bold text-sm text-[#1c1917]">
                                                                        Comanda {tab.label}
                                                                    </h4>
                                                                    <span className="text-[11px] font-semibold text-[#7a6655]">
                                                                        {tabItems.filter(i => i.status === 'active').length} itens
                                                                    </span>
                                                                </div>

                                                                {/* Lista de Produtos Vendidos */}
                                                                {tabItems.length === 0 ? (
                                                                    <p className="text-xs text-[#8c7867] italic py-2">
                                                                        Nenhum consumo registrado.
                                                                    </p>
                                                                ) : (
                                                                    <ul className="mt-2 divide-y divide-[#f7f2ea]">
                                                                        {tabItems.map((item) => (
                                                                            <li
                                                                                key={item.id}
                                                                                className="py-1.5 flex items-center justify-between text-xs"
                                                                            >
                                                                                <div>
                                                                                    <span className="font-medium text-[#2b1d17]">
                                                                                        {item.quantity}× {item.product_name}
                                                                                    </span>
                                                                                    {item.status === 'cancelled' && (
                                                                                        <span className="ml-2 text-[10px] text-amber-800 font-semibold bg-amber-100 px-1.5 py-0.5 rounded">
                                                                                            Cancelado
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                                <span className={`font-semibold ${item.status === 'cancelled' ? 'line-through text-gray-400' : 'text-[#2b1d17]'}`}>
                                                                                    {currency.format(item.line_total_in_cents / 100)}
                                                                                </span>
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                )}

                                                                {/* Resumo Financeiro da Comanda */}
                                                                <div className="mt-2.5 pt-2 border-t border-[#f4ede3] space-y-1 text-xs">
                                                                    <div className="flex items-center justify-between">
                                                                        <span className="text-[#7a6655]">
                                                                            Subtotal dos itens
                                                                        </span>
                                                                        <span className="font-semibold text-[#2b1d17]">
                                                                            {currency.format(tabSubtotal / 100)}
                                                                        </span>
                                                                    </div>

                                                                    {hasSnapshot && tab.service_fee_percent !== null && Number(tab.service_fee_percent) > 0 && (
                                                                        <div className="flex items-center justify-between text-xs">
                                                                            <span className="text-[#7a6655] flex items-center gap-1.5">
                                                                                <span>Taxa de serviço ({tab.service_fee_percent}%)</span>
                                                                                <span className={`text-[10px] px-1.5 py-0.2 rounded font-semibold ${tab.service_fee_accepted ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                                                                                    {tab.service_fee_accepted ? 'Aceita' : 'Dispensada'}
                                                                                </span>
                                                                            </span>
                                                                            <span className={`font-semibold ${tab.service_fee_accepted ? 'text-[#2b1d17]' : 'text-gray-400'}`}>
                                                                                {currency.format(tabFeeInCents / 100)}
                                                                            </span>
                                                                        </div>
                                                                    )}

                                                                    <div className="pt-1 flex items-center justify-between border-t border-[#f4ede3]">
                                                                        <span className="font-bold text-[#7a6655]">
                                                                            Total da comanda
                                                                        </span>
                                                                        <strong className="font-bold text-sm text-[#1c1917]">
                                                                            {currency.format(tabTotalInCents / 100)}
                                                                        </strong>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}

                                                    {/* Total Geral da Mesa */}
                                                    <div className="rounded-xl bg-white border border-[#ded5c8] p-3 flex items-center justify-between">
                                                        <span className="font-bold text-sm text-[#1c1917]">
                                                            Total Geral da Mesa
                                                        </span>
                                                        <strong className="font-extrabold text-base text-[var(--brand,#b9472b)]">
                                                            {currency.format(details.totalInCents / 100)}
                                                        </strong>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>

                    {/* Botão de Paginação / Carregar Mais */}
                    {hasMore && (
                        <div className="pt-2 text-center">
                            <button
                                type="button"
                                disabled={loadingMore}
                                onClick={handleLoadMore}
                                className="w-full py-3 rounded-xl border border-[#ebdccb] bg-white font-bold text-xs text-[#1c1917] hover:bg-[#fffdfa] transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
                            >
                                {loadingMore ? 'Carregando mais atendimentos…' : 'Carregar mais atendimentos'}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
