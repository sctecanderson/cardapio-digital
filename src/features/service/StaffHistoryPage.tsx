import { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';

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

function toLocalDateString(dateInput: Date | string): string {
    const d = new Date(dateInput);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

interface WeekDayOption {
    isoDate: string;
    dayName: string;
    formattedDay: string;
    isToday: boolean;
}

function getWeekDaysAround(centerDate: Date): WeekDayOption[] {
    const todayStr = toLocalDateString(new Date());
    const days: WeekDayOption[] = [];

    // Começa na segunda-feira da semana
    const currentDay = centerDate.getDay();
    const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;

    const monday = new Date(centerDate);
    monday.setDate(centerDate.getDate() + diffToMonday);

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);

        const iso = toLocalDateString(d);
        days.push({
            isoDate: iso,
            dayName: dayNames[d.getDay()],
            formattedDay: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
            isToday: iso === todayStr,
        });
    }

    return days;
}

export function StaffHistoryPage() {
    const access = useOutletContext<StaffAccess>();

    const [visits, setVisits] = useState<ClosedVisit[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Filtro por data
    const [selectedDate, setSelectedDate] = useState<string>('');

    // ID do atendimento expandido
    const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);
    const [detailsMap, setDetailsMap] = useState<Record<string, VisitConsumptionDetails>>({});
    const [loadingDetails, setLoadingDetails] = useState<Record<string, boolean>>({});

    // Dias da semana atual para a barra de filtros
    const weekDays = useMemo(() => {
        const base = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
        return getWeekDaysAround(base);
    }, [selectedDate]);

    useEffect(() => {
        let disposed = false;

        async function loadHistory() {
            setLoading(true);
            setError('');

            try {
                const { data, error: qErr } = await supabase
                    .from('table_visits')
                    .select(`
                        id,
                        opened_at,
                        closed_at,
                        table:restaurant_tables!inner(table_number)
                    `)
                    .eq('restaurant_id', access.restaurantId)
                    .eq('assigned_member_id', access.memberId)
                    .eq('status', 'closed')
                    .order('closed_at', { ascending: false })
                    .limit(50)
                    .overrideTypes<ClosedVisit[], { merge: false }>();

                if (qErr) throw qErr;

                if (!disposed) {
                    setVisits(data ?? []);
                }
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível carregar o histórico de atendimentos.',
                    );
                }
            } finally {
                if (!disposed) {
                    setLoading(false);
                }
            }
        }

        void loadHistory();

        return () => {
            disposed = true;
        };
    }, [access.restaurantId, access.memberId]);

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
                    .select('id, label, status, created_at, closed_at')
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

            const totalInCents = items
                .filter((item) => item.status === 'active')
                .reduce((acc, curr) => acc + curr.line_total_in_cents, 0);

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

    // Filtra visitas pela data selecionada
    const filteredVisits = useMemo(() => {
        if (!selectedDate) return visits;
        return visits.filter((v) => {
            const visitDay = toLocalDateString(v.closed_at || v.opened_at);
            return visitDay === selectedDate;
        });
    }, [visits, selectedDate]);

    // Formata o título da data selecionada
    const selectedDateDisplay = useMemo(() => {
        if (!selectedDate) return null;
        const [year, month, day] = selectedDate.split('-').map(Number);
        const dateObj = new Date(year, month - 1, day);
        return new Intl.DateTimeFormat('pt-BR', {
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            year: 'numeric',
        }).format(dateObj);
    }, [selectedDate]);

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

            {/* Status do Filtro Atual */}
            {selectedDateDisplay && (
                <div className="mb-4 flex items-center justify-between bg-[#fffaf4] border border-[#ebdccb] px-3.5 py-2.5 rounded-xl text-xs">
                    <div>
                        <span className="font-semibold text-[#7a6655]">Exibindo: </span>
                        <strong className="capitalize text-[var(--ink,#2b1d17)]">
                            {selectedDateDisplay}
                        </strong>
                    </div>
                    <span className="text-[#8c7867] font-medium">
                        {filteredVisits.length} atendimento{filteredVisits.length !== 1 ? 's' : ''}
                    </span>
                </div>
            )}

            {loading ? (
                <p role="status" className="py-6 text-sm opacity-75">
                    Carregando histórico…
                </p>
            ) : error ? (
                <p role="alert" className="p-4 rounded-xl bg-red-50 text-xs text-red-700">
                    {error}
                </p>
            ) : filteredVisits.length === 0 ? (
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
                <ul className="space-y-3">
                    {filteredVisits.map((visit) => {
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
                                            <span className="font-bold text-base text-[var(--ink,#2b1d17)]">
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
                                                    const tabSubtotal = tabItems
                                                        .filter((i) => i.status === 'active')
                                                        .reduce((acc, curr) => acc + curr.line_total_in_cents, 0);

                                                    return (
                                                        <div
                                                            key={tab.id}
                                                            className="rounded-xl border border-[#ebdccb] bg-white p-3.5 shadow-xs"
                                                        >
                                                            {/* Título da Comanda */}
                                                            <div className="flex items-center justify-between pb-2 border-b border-[#f4ede3]">
                                                                <h4 className="font-bold text-sm text-[var(--ink,#2b1d17)]">
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

                                                            {/* Subtotal da Comanda */}
                                                            <div className="mt-2.5 pt-2 border-t border-[#f4ede3] flex items-center justify-between text-xs">
                                                                <span className="font-semibold text-[#7a6655]">
                                                                    Subtotal da comanda
                                                                </span>
                                                                <strong className="font-bold text-sm text-[var(--ink,#2b1d17)]">
                                                                    {currency.format(tabSubtotal / 100)}
                                                                </strong>
                                                            </div>
                                                        </div>
                                                    );
                                                })}

                                                {/* Total Geral da Mesa */}
                                                <div className="rounded-xl bg-white border border-[#ded5c8] p-3 flex items-center justify-between">
                                                    <span className="font-bold text-sm text-[var(--ink,#2b1d17)]">
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
            )}
        </section>
    );
}
