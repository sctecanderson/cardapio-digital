import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
    attendWaiterRequest,
    completeWaiterRequest,
    listActiveWaiterRequests,
} from './serviceRequests';
import type { PendingWaiterRequest } from './serviceRequests';

interface WaiterRequestsPanelProps {
    restaurantSlug: string;
    restaurantId: string;
    memberId: string;
    role?: 'admin' | 'waiter';
    onAttended: () => void;
}

function formatElapsed(createdAt: string, now: number) {
    const seconds = Math.max(
        0,
        Math.floor((now - Date.parse(createdAt)) / 1000),
    );
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;

    return `${String(minutes).padStart(2, '0')}:${String(
        remainder,
    ).padStart(2, '0')}`;
}

export function WaiterRequestsPanel({
    restaurantSlug,
    restaurantId,
    memberId,
    role = 'waiter',
    onAttended,
}: WaiterRequestsPanelProps) {
    const mounted = useRef(false);
    const acting = useRef(false);
    const revision = useRef(0);
    const reload = useRef<() => void>(() => {});
    const onAttendedRef = useRef(onAttended);

    const [requests, setRequests] = useState<PendingWaiterRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [loadError, setLoadError] = useState('');
    const [actionError, setActionError] = useState('');
    const [notice, setNotice] = useState('');
    const [syncNotice, setSyncNotice] = useState('');
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        onAttendedRef.current = onAttended;
    }, [onAttended]);

    useEffect(() => {
        let disposed = false;
        let fetching = false;
        let requestedAgain = false;
        let connected = false;
        let timer: number | undefined;

        function scheduleLoad() {
            if (disposed || timer !== undefined) return;

            timer = window.setTimeout(() => {
                timer = undefined;
                void loadRequests();
            }, 250);
        }

        async function loadRequests() {
            if (disposed) return;

            if (acting.current) {
                scheduleLoad();
                return;
            }

            if (fetching) {
                requestedAgain = true;
                return;
            }

            fetching = true;
            const currentRevision = revision.current;

            setLoading(true);
            setLoadError('');

            try {
                const activeRequests =
                    await listActiveWaiterRequests(restaurantId);

                if (disposed) return;

                if (
                    acting.current ||
                    currentRevision !== revision.current
                ) {
                    requestedAgain = true;
                    return;
                }

                setRequests(activeRequests);
                setNow(Date.now());

                if (connected) {
                    setSyncNotice('');
                }
            } catch (cause) {
                if (!disposed) {
                    setLoadError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível carregar os chamados.',
                    );
                }
            } finally {
                fetching = false;

                if (!disposed) {
                    setLoading(false);

                    if (requestedAgain) {
                        requestedAgain = false;
                        scheduleLoad();
                    }
                }
            }
        }

        reload.current = () => {
            void loadRequests();
        };

        const channel = supabase
            .channel(`waiter-requests:${restaurantId}:${memberId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'service_requests',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                () => {
                    void loadRequests();
                },
            )
            .subscribe((status) => {
                if (disposed) return;

                if (status === 'SUBSCRIBED') {
                    connected = true;
                    setSyncNotice('');
                    void loadRequests();
                } else if (
                    status === 'CHANNEL_ERROR' ||
                    status === 'TIMED_OUT' ||
                    status === 'CLOSED'
                ) {
                    connected = false;
                    setSyncNotice(
                        'Atualização automática indisponível. Use Atualizar fila.',
                    );
                }
            });

        function handleVisibility() {
            if (!document.hidden) {
                void loadRequests();
            }
        }

        function handleOnline() {
            void loadRequests();
        }

        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleOnline);

        void loadRequests();

        return () => {
            disposed = true;
            reload.current = () => {};

            if (timer !== undefined) {
                window.clearTimeout(timer);
            }

            document.removeEventListener(
                'visibilitychange',
                handleVisibility,
            );
            window.removeEventListener('online', handleOnline);

            void supabase.removeChannel(channel);
        };
    }, [restaurantId, memberId]);

    // Um único relógio atende todos os cards da fila.
    useEffect(() => {
        if (requests.length === 0) return;

        function updateClock() {
            if (!document.hidden) {
                setNow(Date.now());
            }
        }

        updateClock();

        const timer = window.setInterval(updateClock, 1000);
        document.addEventListener('visibilitychange', updateClock);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', updateClock);
        };
    }, [requests.length]);

    async function handleAttend(request: PendingWaiterRequest) {
        if (acting.current) return;

        acting.current = true;
        revision.current += 1;
        setBusyId(request.id);
        setActionError('');
        setNotice('');

        try {
            await attendWaiterRequest(restaurantSlug, request.id);

            if (!mounted.current) return;

            revision.current += 1;
            setNotice(
                `Chamado da mesa ${String(
                    request.table.table_number,
                ).padStart(2, '0')} assumido com sucesso.`,
            );

            onAttendedRef.current();
        } catch (cause) {
            if (mounted.current) {
                setActionError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível atender o chamado.',
                );
            }
        } finally {
            acting.current = false;

            if (mounted.current) {
                setBusyId(null);
                reload.current();
            }
        }
    }

    async function handleComplete(request: PendingWaiterRequest) {
        if (acting.current) return;

        acting.current = true;
        revision.current += 1;
        setBusyId(request.id);
        setActionError('');
        setNotice('');

        try {
            await completeWaiterRequest(restaurantSlug, request.id);

            if (!mounted.current) return;

            revision.current += 1;
            setRequests((current) =>
                current.filter((item) => item.id !== request.id),
            );

            setNotice(
                `Atendimento da mesa ${String(
                    request.table.table_number,
                ).padStart(2, '0')} concluído.`,
            );

            onAttendedRef.current();
        } catch (cause) {
            if (mounted.current) {
                setActionError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível concluir o atendimento.',
                );
            }
        } finally {
            acting.current = false;

            if (mounted.current) {
                setBusyId(null);
                reload.current();
            }
        }
    }

    // Separação em categorias lógicas:
    // 1. Chamados aguardando atendimento: status === 'pending'
    const pendingRequests = requests.filter((r) => r.status === 'pending');

    // 2. Meus atendimentos: status === 'attended' assumidos por mim (resolved_by_member_id === memberId)
    const myAttendedRequests = requests.filter(
        (r) => r.status === 'attended' && r.resolved_by_member_id === memberId,
    );

    // 3. Atendimentos de outros garçons (visíveis para admins ou como acompanhamento)
    const otherAttendedRequests = requests.filter(
        (r) => r.status === 'attended' && r.resolved_by_member_id !== memberId,
    );

    const isAdmin = role === 'admin';

    return (
        <section
            aria-labelledby="waiter-requests-title"
            className="mt-8 border-t border-black/10 pt-6"
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <h2
                        id="waiter-requests-title"
                        className="text-lg font-semibold"
                    >
                        Chamados de garçom
                    </h2>
                    {requests.length > 0 && (
                        <span className="rounded-full bg-[var(--brand)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--brand)]">
                            {requests.length} ativo{requests.length > 1 ? 's' : ''}
                        </span>
                    )}
                </div>

                <button
                    type="button"
                    onClick={() => reload.current()}
                    disabled={loading || busyId !== null}
                    className="min-h-11 rounded-xl px-3 text-sm font-medium text-[var(--brand)] disabled:opacity-50"
                >
                    {loading ? 'Atualizando…' : 'Atualizar fila'}
                </button>
            </div>

            {syncNotice && (
                <p
                    role="status"
                    className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
                >
                    {syncNotice}
                </p>
            )}

            {loadError && (
                <p role="alert" className="mt-3 text-sm text-red-700">
                    {loadError}
                </p>
            )}

            {actionError && (
                <p role="alert" className="mt-3 text-sm text-red-700">
                    {actionError}
                </p>
            )}

            {notice && (
                <p
                    role="status"
                    className="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-900"
                >
                    {notice}
                </p>
            )}

            {loading && requests.length === 0 ? (
                <p role="status" className="mt-4 text-sm opacity-75">
                    Carregando chamados…
                </p>
            ) : requests.length === 0 ? (
                !loadError && (
                    <p role="status" className="mt-4 text-sm opacity-75">
                        Nenhum chamado ativo no momento.
                    </p>
                )
            ) : (
                <div className="mt-4 space-y-6">
                    {/* =========================================================
                       SEÇÃO 1: MEUS ATENDIMENTOS (EM ANDAMENTO)
                       ========================================================= */}
                    {myAttendedRequests.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-600" aria-hidden="true" />
                                <h3 className="text-sm font-bold uppercase tracking-wide text-blue-900">
                                    Meus atendimentos em andamento ({myAttendedRequests.length})
                                </h3>
                            </div>
                            <ul className="space-y-3">
                                {myAttendedRequests.map((request) => (
                                    <li
                                        key={request.id}
                                        className="rounded-2xl border border-blue-700/25 bg-blue-50/80 p-4 shadow-sm"
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <h4 className="font-semibold text-blue-950">
                                                    Mesa {String(request.table.table_number).padStart(2, '0')}
                                                </h4>
                                                <span className="rounded-full bg-blue-200/80 px-2 py-0.5 text-xs font-semibold text-blue-900">
                                                    Garçom a caminho
                                                </span>
                                            </div>

                                            <span
                                                role="timer"
                                                aria-live="off"
                                                aria-label="Tempo em atendimento"
                                                className="font-mono text-base font-semibold tabular-nums text-blue-900"
                                            >
                                                {formatElapsed(request.created_at, now)}
                                            </span>
                                        </div>

                                        <p className="mt-1 text-xs text-blue-800">
                                            Você assumiu este chamado. Conclua ao chegar à mesa.
                                        </p>

                                        <button
                                            type="button"
                                            onClick={() => void handleComplete(request)}
                                            disabled={busyId !== null}
                                            className="mt-3 min-h-11 w-full rounded-xl bg-emerald-700 hover:bg-emerald-800 px-4 text-sm font-semibold text-white disabled:opacity-50 transition-colors shadow-sm"
                                        >
                                            {busyId === request.id
                                                ? 'Concluindo…'
                                                : 'Concluir atendimento (cheguei à mesa)'}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* =========================================================
                       SEÇÃO 2: AGUARDANDO ATENDIMENTO (FILA COMPARTILHADA)
                       ========================================================= */}
                    <div>
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-600" aria-hidden="true" />
                            <h3 className="text-sm font-bold uppercase tracking-wide text-amber-950">
                                Aguardando atendimento ({pendingRequests.length})
                            </h3>
                        </div>

                        {pendingRequests.length === 0 ? (
                            <p className="rounded-xl bg-black/5 p-3 text-xs opacity-75">
                                Nenhum cliente aguardando na fila.
                            </p>
                        ) : (
                            <ul className="space-y-3">
                                {pendingRequests.map((request) => {
                                    const assignedMember =
                                        request.visit?.assigned_member_id;
                                    const assignedToOther =
                                        !!assignedMember && assignedMember !== memberId;

                                    return (
                                        <li
                                            key={request.id}
                                            className="rounded-2xl border border-amber-700/25 bg-amber-50 p-4 shadow-sm"
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-semibold text-amber-950">
                                                        Mesa {String(request.table.table_number).padStart(2, '0')}
                                                    </h4>
                                                    <span className="rounded-full bg-amber-200/80 px-2 py-0.5 text-xs font-semibold text-amber-900">
                                                        Aguardando
                                                    </span>
                                                </div>

                                                <span
                                                    role="timer"
                                                    aria-live="off"
                                                    aria-label="Tempo aguardando atendimento"
                                                    className="font-mono text-base font-semibold tabular-nums text-amber-900"
                                                >
                                                    {formatElapsed(request.created_at, now)}
                                                </span>
                                            </div>

                                            <p className="mt-1 text-xs text-amber-900">
                                                Cliente solicitando presença do garçom
                                            </p>

                                            {assignedToOther ? (
                                                <p className="mt-2 text-xs font-medium text-amber-900">
                                                    Atendimento da mesa vinculado a outro funcionário.
                                                </p>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleAttend(request)}
                                                    disabled={busyId !== null}
                                                    className="mt-3 min-h-11 w-full rounded-xl bg-[var(--brand)] hover:opacity-90 px-4 text-sm font-semibold text-white disabled:opacity-50 transition-opacity shadow-sm"
                                                >
                                                    {busyId === request.id
                                                        ? 'Assumindo…'
                                                        : 'Assumir e atender'}
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>

                    {/* =========================================================
                       SEÇÃO 3: OUTROS ATENDIMENTOS (VISÃO ADMINISTRATIVA / COLEGAS)
                       ========================================================= */}
                    {otherAttendedRequests.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-500" aria-hidden="true" />
                                <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                                    {isAdmin ? 'Outros garçons em atendimento' : 'Em atendimento por colegas'} ({otherAttendedRequests.length})
                                </h3>
                            </div>

                            <ul className="space-y-3">
                                {otherAttendedRequests.map((request) => (
                                    <li
                                        key={request.id}
                                        className="rounded-2xl border border-slate-300 bg-slate-50 p-4"
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <h4 className="font-semibold text-slate-900">
                                                    Mesa {String(request.table.table_number).padStart(2, '0')}
                                                </h4>
                                                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
                                                    Em atendimento
                                                </span>
                                            </div>

                                            <span
                                                role="timer"
                                                aria-live="off"
                                                className="font-mono text-sm font-semibold tabular-nums text-slate-700"
                                            >
                                                {formatElapsed(request.created_at, now)}
                                            </span>
                                        </div>

                                        <p className="mt-1 text-xs text-slate-600">
                                            Assumido por outro membro da equipe.
                                        </p>

                                        {isAdmin && (
                                            <button
                                                type="button"
                                                onClick={() => void handleComplete(request)}
                                                disabled={busyId !== null}
                                                className="mt-3 min-h-10 w-full rounded-xl border border-slate-300 bg-white hover:bg-slate-100 px-3 text-xs font-semibold text-slate-800 disabled:opacity-50 transition-colors"
                                            >
                                                {busyId === request.id
                                                    ? 'Encerrando…'
                                                    : 'Encerrar administrativamente'}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}