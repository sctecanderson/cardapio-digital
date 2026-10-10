import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import {
    closeTableVisit,
    listMyOpenTableVisits,
    listRestaurantTables,
    openTableVisit,
} from './tableVisits';
import type { OpenTableVisit, RestaurantTableItem } from './tableVisits';
import { GuestConfirmationForm } from './GuestConfirmationForm';
import { WaiterRequestsPanel } from './WaiterRequestsPanel';
import { BillRequestsPanel } from './BillRequestsPanel';
import { ConfirmedGuestCount } from './ConfirmedGuestCount';
import { TableTabsPanel } from './TableTabsPanel';

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
        />
    );
}

function StaffSalonManager({
    restaurantSlug,
    restaurantId,
    memberId,
}: {
    restaurantSlug: string;
    restaurantId: string;
    memberId: string;
}) {
    const submitting = useRef(false);

    // Estado das mesas e atendimentos
    const [allTables, setAllTables] = useState<RestaurantTableItem[]>([]);
    const [visits, setVisits] = useState<OpenTableVisit[]>([]);
    const [selectedTableNumber, setSelectedTableNumber] = useState<number>(1);
    const [searchQuery, setSearchQuery] = useState('');

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);

    // Quantidade de comandas abertas na mesa selecionada
    const [openTabsCount, setOpenTabsCount] = useState<number>(0);

    // Estado da operação de assumir/encerrar mesa
    const [busyAction, setBusyAction] = useState(false);
    const [actionError, setActionError] = useState('');
    const [confirmCloseMesa, setConfirmCloseMesa] = useState(false);

    // Horário formatado no topo (atualiza a cada minuto)
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

    // Carrega mesas cadastradas no Supabase e atendimentos abertos do garçom
    useEffect(() => {
        let disposed = false;

        async function loadSalonData() {
            setLoading(true);
            setError('');

            try {
                const [loadedTables, openVisits] = await Promise.all([
                    listRestaurantTables(restaurantId),
                    listMyOpenTableVisits(restaurantId, memberId),
                ]);

                if (!disposed) {
                    // Garante que todas as mesas cadastradas (ou 1 a 20) estejam na lista
                    const tableMap = new Map<number, RestaurantTableItem>();

                    // Adiciona mesas retornadas do banco
                    for (const table of loadedTables) {
                        tableMap.set(table.table_number, table);
                    }

                    // Se por algum motivo o banco tiver poucas mesas, assegura mesas 1 a 20
                    for (let n = 1; n <= 20; n++) {
                        if (!tableMap.has(n)) {
                            tableMap.set(n, {
                                id: `placeholder-${n}`,
                                table_number: n,
                                label: `Mesa ${String(n).padStart(2, '0')}`,
                                active: true,
                            });
                        }
                    }

                    const sortedTables = Array.from(tableMap.values()).sort(
                        (a, b) => a.table_number - b.table_number,
                    );

                    setAllTables(sortedTables);
                    setVisits(openVisits);

                    // Se não tiver mesa selecionada ou for a primeira carga, seleciona a primeira mesa com visita ou a mesa 1
                    setSelectedTableNumber((curr) => {
                        if (curr && tableMap.has(curr)) return curr;
                        if (openVisits.length > 0) return openVisits[0].table.table_number;
                        return 1;
                    });
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

    // Visita ativa da mesa selecionada
    const currentVisit = visits.find(
        (v) => v.table.table_number === selectedTableNumber,
    );

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

    return (
        <section className="mx-auto max-w-xl pb-12">
            {/* =========================================================
                TOPO: MESAS NO SALÃO + CARROSSEL HORIZONTAL (IMAGEM 1)
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

                {/* Barra de Busca de Mesa (para casos de 20 mesas) */}
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
                        const isOccupied = visits.some(
                            (v) => v.table.table_number === table.table_number,
                        );

                        return (
                            <button
                                key={table.table_number}
                                type="button"
                                role="tab"
                                aria-selected={isSelected}
                                onClick={() => {
                                    setSelectedTableNumber(table.table_number);
                                    setConfirmCloseMesa(false);
                                    setOpenTabsCount(0);
                                    setActionError('');
                                }}
                                className={`staff-table-btn ${isSelected ? 'active' : ''} ${isOccupied ? 'occupied' : ''}`}
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
                CARD PRINCIPAL: GERENCIAR MESA SELECIONADA (IMAGEM 2)
               ========================================================= */}
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
                        {currentVisit ? (
                            <span className="staff-manage-badge">
                                Em atendimento por você
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

                {/* Se a mesa ainda não estiver em atendimento por este garçom */}
                {!currentVisit && (
                    <div className="mt-4 rounded-2xl bg-[#fff8ef] p-4 border border-[#e8dac8] text-center">
                        <p className="text-xs text-[#6d5b4d] font-medium mb-3">
                            Esta mesa ainda não possui atendimento ativo sob sua responsabilidade.
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

                {/* 1. SEÇÃO: CONFIRMAR ACESSO (6 CAIXAS DE DÍGITOS) */}
                <GuestConfirmationForm
                    restaurantSlug={restaurantSlug}
                    tableNumber={selectedTableNumber}
                    onConfirmed={() => {
                        setRefresh((c) => c + 1);
                    }}
                />

                {/* 2. SEÇÃO: CRIAR COMANDA E COMANDAS ABERTAS REAIS */}
                {currentVisit ? (
                    <TableTabsPanel
                        restaurantSlug={restaurantSlug}
                        restaurantId={restaurantId}
                        tableVisitId={currentVisit.id}
                        onOpenTabsCountChange={(count) => setOpenTabsCount(count)}
                    />
                ) : null}

                {/* 3. SEÇÃO: ACESSOS E ENCERRAMENTO DA MESA */}
                {currentVisit && (
                    <div className="staff-closure-section">
                        <ConfirmedGuestCount
                            restaurantId={restaurantId}
                            tableVisitId={currentVisit.id}
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
                                <p className="text-xs text-red-800 mb-4">
                                    Todas as sessões dos clientes vinculados a esta mesa serão revogadas.
                                </p>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={busyAction || openTabsCount > 0}
                                        onClick={() => void handleCloseVisit(currentVisit.id)}
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
                        )}
                    </div>
                )}
            </div>

            {/* =========================================================
                PAINÉIS DE CHAMADOS E PEDIDOS DE CONTA EM TEMPO REAL
               ========================================================= */}
            <div className="mt-6 space-y-4">
                <WaiterRequestsPanel
                    restaurantSlug={restaurantSlug}
                    restaurantId={restaurantId}
                    memberId={memberId}
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