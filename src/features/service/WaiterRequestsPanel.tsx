import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
    attendWaiterRequest,
    listPendingWaiterRequests,
} from './serviceRequests';
import type { PendingWaiterRequest } from './serviceRequests';

interface WaiterRequestsPanelProps {
    restaurantSlug: string;
    restaurantId: string;
    memberId: string;
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
                const pendingRequests =
                    await listPendingWaiterRequests(restaurantId);

                if (disposed) return;

                if (
                    acting.current ||
                    currentRevision !== revision.current
                ) {
                    requestedAgain = true;
                    return;
                }

                setRequests(pendingRequests);
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
            setRequests((current) =>
                current.filter((item) => item.id !== request.id),
            );

            setNotice(
                `Chamado da mesa ${String(
                    request.table.table_number,
                ).padStart(2, '0')} atendido.`,
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

    return (
        <section
            aria-labelledby="waiter-requests-title"
            className="mt-8 border-t border-black/10 pt-6"
        >
            <div className="flex items-center justify-between gap-3">
                <h2
                    id="waiter-requests-title"
                    className="text-lg font-semibold"
                >
                    Chamados de garçom
                </h2>

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
                        Nenhum chamado pendente.
                    </p>
                )
            ) : (
                <ul className="mt-4 space-y-3">
                    {requests.map((request) => {
                        const assignedMember =
                            request.visit?.assigned_member_id;
                        const assignedToOther =
                            !!assignedMember && assignedMember !== memberId;

                        return (
                            <li
                                key={request.id}
                                className="rounded-2xl border border-amber-700/20 bg-amber-50 p-4"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <h3 className="font-semibold">
                                        Mesa{' '}
                                        {String(
                                            request.table.table_number,
                                        ).padStart(2, '0')}
                                    </h3>

                                    <span
                                        role="timer"
                                        aria-live="off"
                                        aria-label="Tempo aguardando atendimento"
                                        className="font-mono text-lg font-semibold tabular-nums text-amber-900"
                                    >
                                        {formatElapsed(request.created_at, now)}
                                    </span>
                                </div>

                                <p className="mt-1 text-sm text-amber-900">
                                    Cliente chamando garçom
                                </p>

                                {assignedToOther ? (
                                    <p className="mt-3 text-sm font-medium">
                                        Atendimento vinculado a outro funcionário.
                                    </p>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => void handleAttend(request)}
                                        disabled={busyId !== null}
                                        className="mt-4 min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 text-sm font-medium text-white disabled:opacity-50"
                                    >
                                        {busyId === request.id
                                            ? 'Atendendo…'
                                            : 'Assumir e atender'}
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}