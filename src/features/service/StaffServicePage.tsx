import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import type { StaffAccess } from '../auth/staffAuth';
import {
    closeTableVisit,
    listRestaurantTables,
    listSalonOpenTableVisits,
    openTableVisit,
} from './tableVisits';
import type { RestaurantTableItem, SalonTableVisit } from './tableVisits';
import { GuestConfirmationForm } from './GuestConfirmationForm';
import { WaiterRequestsPanel } from './WaiterRequestsPanel';
import { BillRequestsPanel } from './BillRequestsPanel';
import { ConfirmedGuestCount } from './ConfirmedGuestCount';
import { TableTabsPanel } from './TableTabsPanel';
import {
    countActiveTableServiceRequests,
    dismissTableServiceRequests,
} from './serviceRequests';

export function StaffServicePage() {
    const { restaurantSlug } = useParams();
    const access = useOutletContext<StaffAccess>();

    if (!restaurantSlug) {
        return <p role="alert">Restaurante não identificado.</p>;
    }

    return (
        <StaffSalonManager
            key={`${restaurantSlug}:${access.memberId}`}
            restaurantSlug={restaurantSlug}
            restaurantId={access.restaurantId}
            memberId={access.memberId}
            role={access.role}
        />
    );
}

function StaffSalonManager({
    restaurantSlug,
    restaurantId,
    memberId,
    role,
}: {
    restaurantSlug: string;
    restaurantId: string;
    memberId: string;
    role: 'admin' | 'waiter';
}) {
    const submitting = useRef(false);
    const salonInitialLoaded = useRef(false);

    // Estado das mesas cadastradas e de todos os atendimentos abertos no salão
    const [allTables, setAllTables] = useState<RestaurantTableItem[]>([]);
    const [salonVisits, setSalonVisits] = useState<SalonTableVisit[]>([]);
    const [selectedTableNumber, setSelectedTableNumber] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);

    // Quantidade de comandas abertas na mesa selecionada
    const [openTabsCount, setOpenTabsCount] = useState<number>(0);
    const [activeRequestsOnTable, setActiveRequestsOnTable] = useState<number>(0);

    const handleOpenTabsCountChange = useCallback((count: number) => {
        setOpenTabsCount(count);
    }, []);

    // Estado da operação de assumir/encerrar mesa
    const [busyAction, setBusyAction] = useState(false);
    const [actionError, setActionError] = useState('');
    const [confirmCloseMesa, setConfirmCloseMesa] = useState(false);
    const [confirmDismissRequests, setConfirmDismissRequests] = useState(false);

    // Carregar quantidade de chamados ativos na mesa selecionada
    useEffect(() => {
        if (selectedTableNumber === null) {
            setActiveRequestsOnTable(0);
            return;
        }

        let disposed = false;
        async function fetchTableRequestsCount() {
            try {
                const count = await countActiveTableServiceRequests(
                    restaurantId,
                    selectedTableNumber!,
                );
                if (!disposed) {
                    setActiveRequestsOnTable(count);
                }
            } catch {
                // Silencia falha transitória
            }
        }

        void fetchTableRequestsCount();

        return () => {
            disposed = true;
        };
    }, [restaurantId, selectedTableNumber, refresh]);

    // Horário formatado no topo (atualiza a cada 30 segundos)
    const [currentTime, setCurrentTime] = useState(() => {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    });

    useEffect(() => {
        const interval = window.setInterval(() => {
            const now = new Date();
            setCurrentTime(
                `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
            );
        }, 30000);

        return () => window.clearInterval(interval);
    }, []);

    // 1. Carrega mesas reais do restaurante e TODOS os atendimentos abertos do salão
    useEffect(() => {
        let disposed = false;

        async function loadSalonData() {
            if (!salonInitialLoaded.current) {
                setLoading(true);
            }
            setError('');

            try {
                const [loadedTables, openVisits] = await Promise.all([
                    listRestaurantTables(restaurantId),
                    listSalonOpenTableVisits(restaurantId),
                ]);

                if (!disposed) {
                    setAllTables(loadedTables);
                    setSalonVisits(openVisits);

                    // Seleção automática da mesa:
                    // 1. Mantém a selecionada se ainda existir;
                    // 2. Senão, seleciona a primeira mesa em atendimento por mim;
                    // 3. Senão, seleciona a primeira mesa cadastrada;
                    // 4. Se não houver mesas cadastradas, null.
                    setSelectedTableNumber((curr) => {
                        if (curr && loadedTables.some((t) => t.table_number === curr)) {
                            return curr;
                        }
                        const myFirstVisit = openVisits.find((v) => v.assigned_member_id === memberId);
                        if (myFirstVisit && loadedTables.some((t) => t.table_number === myFirstVisit.table.table_number)) {
                            return myFirstVisit.table.table_number;
                        }
                        if (loadedTables.length > 0) {
                            return loadedTables[0].table_number;
                        }
                        return null;
                    });
                    salonInitialLoaded.current = true;
                }
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível carregar os dados das mesas.',
                    );
                }
            } finally {
                if (!disposed) {
                    setLoading(false);
                }
            }
        }

        void loadSalonData();

        return () => {
            disposed = true;
        };
    }, [restaurantId, memberId, refresh]);

    // 2. Realtime + Polling para sincronização de atendimentos entre múltiplos garçons
    useEffect(() => {
        function scheduleRefresh() {
            if (!document.hidden) {
                setRefresh((c) => c + 1);
            }
        }

        const pollInterval = window.setInterval(scheduleRefresh, 10000);
        document.addEventListener('visibilitychange', scheduleRefresh);
        window.addEventListener('online', scheduleRefresh);

        const channel = supabase
            .channel(`salon-realtime:${restaurantId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'table_visits',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'restaurant_tables',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            )
            .subscribe();

        return () => {
            window.clearInterval(pollInterval);
            document.removeEventListener('visibilitychange', scheduleRefresh);
            window.removeEventListener('online', scheduleRefresh);
            void supabase.removeChannel(channel);
        };
    }, [restaurantId]);

    // Identificação do atendimento da mesa selecionada
    const currentTableVisit = selectedTableNumber !== null
        ? salonVisits.find((v) => v.table.table_number === selectedTableNumber)
        : undefined;

    const isMyVisit = currentTableVisit && currentTableVisit.assigned_member_id === memberId;
    const isOtherStaffVisit = currentTableVisit && currentTableVisit.assigned_member_id !== memberId;
    const isTableFree = !currentTableVisit;

    // Filtragem de mesas pela barra de busca
    const filteredTables = allTables.filter((table) => {
        if (!searchQuery.trim()) return true;
        const query = searchQuery.trim().toLowerCase();
        const numStr = String(table.table_number);
        const numPadded = numStr.padStart(2, '0');
        const label = (table.label || '').toLowerCase();
        return (
            numStr.includes(query) ||
            numPadded.includes(query) ||
            label.includes(query)
        );
    });

    // Ação: Assumir atendimento da mesa
    async function handleAssumeTable(tableNum: number) {
        if (submitting.current || busyAction) return;

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        try {
            await openTableVisit(restaurantSlug, tableNum);
            setRefresh((c) => c + 1);
        } catch (cause) {
            setActionError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível assumir a mesa.',
            );
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Ação: Encerrar atendimento da mesa (só pode se todas as comandas estiverem fechadas)
    async function handleCloseVisit(visitId: string) {
        if (submitting.current || busyAction) return;

        if (openTabsCount > 0) {
            setActionError('Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.');
            return;
        }

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        try {
            await closeTableVisit(restaurantSlug, visitId);
            setConfirmCloseMesa(false);
            setRefresh((c) => c + 1);
        } catch (cause) {
            setActionError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível encerrar o atendimento da mesa.',
            );
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Ação excepcional: Encerrar chamados em aberto desta mesa específica
    async function handleDismissTableRequests(tableNum: number) {
        if (submitting.current || busyAction) return;

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        try {
            await dismissTableServiceRequests(restaurantSlug, tableNum);
            setConfirmDismissRequests(false);
            setRefresh((c) => c + 1);
        } catch (cause) {
            setActionError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível encerrar os chamados da mesa.',
            );
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Estado vazio: Nenhuma mesa cadastrada no restaurante
    if (!loading && allTables.length === 0) {
        return (
            <section className="mx-auto max-w-xl pb-12">
                <div className="tab-hero-card" style={{ marginTop: '24px' }}>
                    <div className="tab-hero-icon" style={{ background: '#f5efe6', color: '#8c7867' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                    </div>
                    <h2>Nenhuma mesa cadastrada</h2>
                    <p>
                        Este restaurante ainda não possui mesas ativas cadastradas no sistema. Cadastre as mesas no painel administrativo para iniciar os atendimentos do salão.
                    </p>
                    <Link
                        to={`/${restaurantSlug}/admin/mesas`}
                        className="tab-hero-primary-btn"
                        style={{ maxWidth: '280px', minHeight: '44px', fontSize: '14px', textDecoration: 'none' }}
                    >
                        Cadastrar Mesas no Painel
                    </Link>
                </div>
            </section>
        );
    }

    return (
        <section className="mx-auto max-w-xl pb-12">
            {/* =========================================================
                TOPO: MESAS NO SALÃO + CARROSSEL HORIZONTAL
               ========================================================= */}
            <div className="staff-salon-container border-t-0 pt-0 mt-0">
                <div className="staff-salon-header-row">
                    <div>
                        <h2 className="staff-salon-title m-0">MESAS NO SALÃO</h2>
                        <span className="staff-salon-subtitle">Selecione para alternar</span>
                    </div>
                    {loading && (
                        <span className="text-xs text-[var(--brand)] animate-pulse">
                            Carregando…
                        </span>
                    )}
                </div>

                {/* Barra de Busca de Mesa */}
                <input
                    type="text"
                    placeholder="Buscar mesa (ex.: 02, 14)..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="staff-table-search-bar"
                />

                {/* Carrossel de Botões de Mesas */}
                <div className="staff-tables-scroll-wrap" role="tablist" aria-label="Mesas do salão">
                    {filteredTables.map((table) => {
                        const isSelected = table.table_number === selectedTableNumber;
                        const visit = salonVisits.find(
                            (v) => v.table.table_number === table.table_number,
                        );

                        const isMine = visit && visit.assigned_member_id === memberId;
                        const isOther = visit && visit.assigned_member_id !== memberId;

                        const occupiedClass = isMine
                            ? 'occupied'
                            : isOther
                                ? 'occupied other'
                                : '';

                        return (
                            <button
                                key={table.id}
                                type="button"
                                role="tab"
                                aria-selected={isSelected}
                                onClick={() => {
                                    setSelectedTableNumber(table.table_number);
                                    setConfirmCloseMesa(false);
                                    setOpenTabsCount(0);
                                    setActionError('');
                                }}
                                className={`staff-table-btn ${isSelected ? 'active' : ''} ${occupiedClass}`}
                                title={
                                    isMine
                                        ? `Mesa ${table.table_number}: Em atendimento por você`
                                        : isOther
                                            ? `Mesa ${table.table_number}: Em atendimento por outro garçom`
                                            : `Mesa ${table.table_number}: Livre`
                                }
                            >
                                {String(table.table_number).padStart(2, '0')}
                            </button>
                        );
                    })}
                </div>
            </div>

            {error && (
                <p role="alert" className="mt-4 text-xs text-red-700 bg-red-50 p-3 rounded-xl border border-red-200">
                    {error}
                </p>
            )}

            {/* =========================================================
                CARD PRINCIPAL: GERENCIAR MESA SELECIONADA
               ========================================================= */}
            {selectedTableNumber !== null && (
                <div className="staff-manage-card">
                    {/* Cabeçalho da Mesa: Número, Horário e Status */}
                    <div className="staff-manage-header">
                        <div>
                            <h3 className="staff-manage-title">
                                Gerenciar Mesa {String(selectedTableNumber).padStart(2, '0')}
                            </h3>
                            <span className="staff-manage-time">{currentTime}</span>
                        </div>

                        <div className="text-right">
                            {isMyVisit ? (
                                <span className="staff-manage-badge">
                                    Em atendimento por você
                                </span>
                            ) : isOtherStaffVisit ? (
                                <span className="staff-manage-badge other">
                                    Em atendimento por outro garçom
                                </span>
                            ) : (
                                <span className="staff-manage-badge free">
                                    Livre
                                </span>
                            )}
                        </div>
                    </div>

                    {actionError && (
                        <p role="alert" className="mt-3 text-xs text-red-700 bg-red-50 p-2.5 rounded-xl border border-red-200">
                            {actionError}
                        </p>
                    )}

                    {/* Gerenciamento centralizado de chamados da mesa selecionada */}
                    {activeRequestsOnTable > 0 && (role === 'admin' || isMyVisit || isTableFree) && (
                        <div className="mt-4 rounded-2xl border border-amber-300/80 bg-amber-50/90 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <div>
                                    <span className="font-semibold text-amber-950">
                                        Chamados desta mesa:
                                    </span>{' '}
                                    <span className="text-amber-900 font-bold">
                                        {activeRequestsOnTable} ativo{activeRequestsOnTable > 1 ? 's' : ''}
                                    </span>
                                </div>
                                {!confirmDismissRequests && (
                                    <button
                                        type="button"
                                        disabled={busyAction}
                                        onClick={() => setConfirmDismissRequests(true)}
                                        className="rounded-lg bg-amber-700 hover:bg-amber-800 px-2.5 py-1 text-xs font-semibold text-white transition-colors disabled:opacity-50"
                                    >
                                        Encerrar chamados
                                    </button>
                                )}
                            </div>
                            {confirmDismissRequests && (
                                <div className="mt-2 pt-2 border-t border-amber-200">
                                    <p className="text-amber-900 mb-2">
                                        Encerrar {activeRequestsOnTable} chamado(s) da Mesa {String(selectedTableNumber).padStart(2, '0')}? A ação cancela chamados pendentes/em atendimento sem fechar comandas.
                                    </p>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            disabled={busyAction}
                                            onClick={() => void handleDismissTableRequests(selectedTableNumber!)}
                                            className="rounded-lg bg-amber-700 hover:bg-amber-800 px-3 py-1 font-medium text-white transition-colors disabled:opacity-50"
                                        >
                                            {busyAction ? 'Encerrando…' : 'Confirmar encerramento'}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={busyAction}
                                            onClick={() => setConfirmDismissRequests(false)}
                                            className="rounded-lg border border-amber-300 bg-white px-3 py-1 font-medium text-amber-900"
                                        >
                                            Cancelar
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Caso A: Mesa Livre */}
                    {isTableFree && (
                        <div className="mt-4 rounded-2xl bg-[#fff8ef] p-4 border border-[#e8dac8] text-center">
                            <p className="text-xs text-[#6d5b4d] font-medium mb-3">
                                Esta mesa está livre e disponível para atendimento.
                            </p>
                            <button
                                type="button"
                                disabled={busyAction}
                                onClick={() => void handleAssumeTable(selectedTableNumber)}
                                className="staff-primary-action-btn w-full max-w-xs mx-auto"
                            >
                                {busyAction ? 'Iniciando atendimento…' : 'Assumir atendimento desta mesa'}
                            </button>
                        </div>
                    )}

                    {/* Caso B: Mesa em atendimento por outro funcionário */}
                    {isOtherStaffVisit && (
                        <div className="mt-4 rounded-2xl bg-[#fffbeb] p-4 border border-[#fef3c7] text-center">
                            <div className="text-amber-800 text-xs font-semibold mb-1">
                                ⚠️ Mesa ocupada
                            </div>
                            <p className="text-xs text-amber-700 font-medium">
                                Esta mesa já está sendo atendida por outro membro da equipe. Apenas o responsável pode confirmar clientes, administrar comandas ou encerrar o atendimento.
                            </p>
                        </div>
                    )}

                    {/* Caso C: Mesa em atendimento por mim */}
                    {isMyVisit && currentTableVisit && (
                        <>
                            {/* 1. SEÇÃO: CONFIRMAR ACESSO (6 CAIXAS DE DÍGITOS) */}
                            <GuestConfirmationForm
                                restaurantSlug={restaurantSlug}
                                tableNumber={selectedTableNumber}
                                onConfirmed={() => {
                                    setRefresh((c) => c + 1);
                                }}
                            />

                            {/* 2. SEÇÃO: CRIAR COMANDA E COMANDAS ABERTAS REAIS */}
                            <TableTabsPanel
                                restaurantSlug={restaurantSlug}
                                restaurantId={restaurantId}
                                tableVisitId={currentTableVisit.id}
                                onOpenTabsCountChange={handleOpenTabsCountChange}
                            />

                            {/* 3. SEÇÃO: ACESSOS E ENCERRAMENTO DA MESA */}
                            <div className="staff-closure-section">
                                <ConfirmedGuestCount
                                    restaurantId={restaurantId}
                                    tableVisitId={currentTableVisit.id}
                                />

                                {openTabsCount > 0 ? (
                                    <div className="rounded-2xl bg-amber-50 p-3.5 border border-amber-200 text-xs text-amber-900 mb-2">
                                        <p className="font-semibold mb-1">
                                            ⚠️ {openTabsCount} comanda(s) aberta(s) nesta mesa.
                                        </p>
                                        <p className="text-amber-800">
                                            Encerre todas as comandas antes de finalizar o atendimento da mesa.
                                        </p>
                                    </div>
                                ) : null}

                                 {confirmCloseMesa ? (
                                    <div className="rounded-2xl bg-red-50 p-4 border border-red-200">
                                        <p className="text-sm font-bold text-red-900 mb-1">
                                            Encerrar o atendimento da Mesa {String(selectedTableNumber).padStart(2, '0')}?
                                        </p>
                                        <p className="text-xs text-red-800 mb-2">
                                            Todas as sessões dos clientes vinculados a esta mesa serão revogadas.
                                        </p>
                                        {activeRequestsOnTable > 0 && (
                                            <p className="text-xs font-semibold text-red-900 mb-3 bg-red-100/70 p-2 rounded-lg">
                                                ℹ️ {activeRequestsOnTable} chamado(s) ou pedido(s) em aberto desta mesa serão encerrados automaticamente.
                                            </p>
                                        )}
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                disabled={busyAction || openTabsCount > 0}
                                                onClick={() => void handleCloseVisit(currentTableVisit.id)}
                                                className="staff-primary-action-btn bg-red-700 hover:bg-red-800 flex-1 text-xs"
                                                style={{ background: '#b91c1c', border: 'none' }}
                                            >
                                                {busyAction ? 'Encerrando…' : 'Confirmar encerramento'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busyAction}
                                                onClick={() => setConfirmCloseMesa(false)}
                                                className="staff-outline-action-btn px-4 text-xs"
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (openTabsCount > 0) {
                                                    setActionError(`Existem ${openTabsCount} comanda(s) aberta(s). Encerre todas as comandas antes de finalizar o atendimento da mesa.`);
                                                    return;
                                                }
                                                setConfirmCloseMesa(true);
                                                setActionError('');
                                            }}
                                            disabled={busyAction || openTabsCount > 0}
                                            className={`staff-full-close-btn ${openTabsCount > 0 ? 'opacity-60 cursor-not-allowed' : ''}`}
                                        >
                                            {openTabsCount > 0
                                                ? `Encerre as comandas para finalizar a mesa (${openTabsCount} aberta${openTabsCount > 1 ? 's' : ''})`
                                                : 'Encerrar atendimento da mesa'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* =========================================================
                PAINÉIS DE CHAMADOS E PEDIDOS DE CONTA EM TEMPO REAL
               ========================================================= */}
            <div className="mt-6 space-y-4">
                <WaiterRequestsPanel
                    restaurantSlug={restaurantSlug}
                    restaurantId={restaurantId}
                    memberId={memberId}
                    role={role}
                    onAttended={() => {
                        setRefresh((current) => current + 1);
                    }}
                />

                <BillRequestsPanel
                    restaurantSlug={restaurantSlug}
                    restaurantId={restaurantId}
                    memberId={memberId}
                    onAttended={() => {
                        setRefresh((current) => current + 1);
                    }}
                />
            </div>
        </section>
    );
}