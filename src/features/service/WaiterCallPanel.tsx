import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTableContext } from '../tables/useTableContext';
import { supabase } from '../../lib/supabase';
import {
    getWaiterRequestState,
    requestWaiter,
    cancelWaiterRequest,
} from './serviceRequests';
import type { WaiterRequestState } from './serviceRequests';

function formatElapsed(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;

    return `${String(minutes).padStart(2, '0')}:${String(
        remainder,
    ).padStart(2, '0')}`;
}

export function WaiterCallPanel() {
    const { restaurantSlug } = useParams();
    const table = useTableContext();

    if (!restaurantSlug || table.status !== 'unverified') {
        return null;
    }

    return (
        <WaiterCallContent
            key={`${restaurantSlug}:${table.tableNumber}`}
            restaurantSlug={restaurantSlug}
            tableNumber={Number(table.tableNumber)}
        />
    );
}

function WaiterCallContent({
    restaurantSlug,
    tableNumber,
}: {
    restaurantSlug: string;
    tableNumber: number;
}) {
    const mounted = useRef(false);
    const submitting = useRef(false);
    const stateRevision = useRef(0);

    const [state, setState] = useState<WaiterRequestState>({
        guestSessionId: null,
        request: null,
    });
    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState('');
    const [now, setNow] = useState(Date.now());
    const [retryUntil, setRetryUntil] = useState<number | null>(null);
    const [syncNotice, setSyncNotice] = useState('');
    const request = state.request;
    const guestSessionId = state.guestSessionId;
    const requestId = request?.id;
    const pending = request?.status === 'pending';

    const elapsed = pending && request
        ? Math.max(
            0,
            Math.floor((now - Date.parse(request.created_at)) / 1000),
        )
        : 0;

    const retrySeconds = retryUntil === null
        ? 0
        : Math.max(0, Math.ceil((retryUntil - now) / 1000));

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    // Recuperar um chamado não cria sessão nem nova solicitação.
    useEffect(() => {
        let disposed = false;

        async function restoreRequest() {
            try {
                const restored = await getWaiterRequestState(
                    restaurantSlug,
                    tableNumber,
                );

                if (!disposed) {
                    stateRevision.current += 1;
                    setState(restored);
                    setNow(Date.now());
                }
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível recuperar seu chamado.',
                    );
                }
            } finally {
                if (!disposed) {
                    setChecking(false);
                }
            }
        }

        void restoreRequest();

        return () => {
            disposed = true;
        };
    }, [restaurantSlug, tableNumber]);

    // Usar os horários reais para evitar atraso acumulado no contador.
    useEffect(() => {
        if (!pending && retryUntil === null) return;

        function updateClock() {
            const currentTime = Date.now();
            setNow(currentTime);

            if (
                retryUntil !== null &&
                currentTime >= retryUntil
            ) {
                setRetryUntil(null);
            }
        }

        updateClock();

        const timer = window.setInterval(updateClock, 1000);
        document.addEventListener('visibilitychange', updateClock);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener(
                'visibilitychange',
                updateClock,
            );
        };
    }, [pending, retryUntil]);

    useEffect(() => {
        if (!guestSessionId) {
            setSyncNotice('');
            return;
        }

        let disposed = false;
        let refreshing = false;
        let refreshRequested = false;
        let connected = false;
        let refreshTimer: number | undefined;

        function scheduleRefresh() {
            if (disposed || refreshTimer !== undefined) return;

            refreshTimer = window.setTimeout(() => {
                refreshTimer = undefined;
                void refreshRequest();
            }, 250);
        }

        async function refreshRequest() {
            if (disposed) return;

            if (submitting.current) {
                scheduleRefresh();
                return;
            }

            if (refreshing) {
                refreshRequested = true;
                return;
            }

            refreshing = true;
            const revision = stateRevision.current;

            try {
                const restored = await getWaiterRequestState(
                    restaurantSlug,
                    tableNumber,
                );

                if (disposed) return;

                if (
                    submitting.current ||
                    revision !== stateRevision.current
                ) {
                    refreshRequested = true;
                    return;
                }

                stateRevision.current += 1;
                setState(restored);
                setNow(Date.now());

                if (connected) {
                    setSyncNotice('');
                }
            } catch {
                if (!disposed) {
                    setSyncNotice(
                        'Não foi possível atualizar automaticamente. Use Atualizar chamado ou recarregue a página.',
                    );
                }
            } finally {
                refreshing = false;

                if (!disposed && refreshRequested) {
                    refreshRequested = false;
                    scheduleRefresh();
                }
            }
        }

        const channel = supabase
            .channel(
                `waiter-call:${guestSessionId}:${requestId ?? 'none'}`,
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'guest_sessions',
                    filter: `id=eq.${guestSessionId}`,
                },
                () => {
                    void refreshRequest();
                },
            );

        if (requestId) {
            channel.on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'service_requests',
                    filter: `id=eq.${requestId}`,
                },
                () => {
                    void refreshRequest();
                },
            );
        }

        channel.subscribe((status) => {
            if (disposed) return;

            if (status === 'SUBSCRIBED') {
                connected = true;
                setSyncNotice('');

                // Recuperar também mudanças ocorridas antes
                // da assinatura ou durante uma desconexão.
                void refreshRequest();
            } else if (
                status === 'CHANNEL_ERROR' ||
                status === 'TIMED_OUT' ||
                status === 'CLOSED'
            ) {
                connected = false;
                setSyncNotice(
                    'Atualização automática indisponível. Use Atualizar chamado ou recarregue a página.',
                );
            }
        });

        function handleVisibility() {
            if (!document.hidden) {
                void refreshRequest();
            }
        }

        function handleOnline() {
            void refreshRequest();
        }

        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleOnline);

        return () => {
            disposed = true;

            if (refreshTimer !== undefined) {
                window.clearTimeout(refreshTimer);
            }

            document.removeEventListener(
                'visibilitychange',
                handleVisibility,
            );
            window.removeEventListener('online', handleOnline);

            void supabase.removeChannel(channel);
        };
    }, [
        guestSessionId,
        requestId,
        restaurantSlug,
        tableNumber,
    ]);

    async function handleCall() {
        if (
            submitting.current ||
            checking ||
            pending ||
            (retryUntil !== null && retryUntil > Date.now())
        ) {
            return;
        }

        submitting.current = true;
        setBusy(true);
        setError('');

        try {
            const result = await requestWaiter(
                restaurantSlug,
                tableNumber,
            );

            if (!mounted.current) return;

            setNow(Date.now());

            if (result.status === 'rate_limited') {
                setRetryUntil(
                    Date.now() + result.retryAfterSeconds * 1000,
                );
                setConfirming(false);
                return;
            }

            stateRevision.current += 1;

            setState({
                guestSessionId: result.guestSessionId,
                request: result.request,
            });
            setRetryUntil(null);
            setConfirming(false);
        } catch (cause) {
            if (mounted.current) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível chamar o garçom.',
                );
            }
        } finally {
            submitting.current = false;

            if (mounted.current) {
                setBusy(false);
            }
        }
    }

    async function handleRefresh() {
        if (submitting.current || checking) return;

        submitting.current = true;
        setBusy(true);
        setError('');

        try {
            const restored = await getWaiterRequestState(
                restaurantSlug,
                tableNumber,
            );

            if (mounted.current) {
                stateRevision.current += 1;
                setState(restored);
                setNow(Date.now());
                setConfirming(false);
            }
        } catch (cause) {
            if (mounted.current) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível atualizar seu chamado.',
                );
            }
        } finally {
            submitting.current = false;

            if (mounted.current) {
                setBusy(false);
            }
        }
    }

    async function handleCancel() {
        if (submitting.current || checking) return;

        submitting.current = true;
        setBusy(true);
        setError('');

        try {
            await cancelWaiterRequest(restaurantSlug, tableNumber);

            if (mounted.current) {
                stateRevision.current += 1;
                setState({
                    guestSessionId: null,
                    request: null,
                });
                setNow(Date.now());
                setConfirming(false);
            }
        } catch (cause) {
            if (mounted.current) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível cancelar seu chamado.',
                );
            }
        } finally {
            submitting.current = false;

            if (mounted.current) {
                setBusy(false);
            }
        }
    }

    return (
        <section className="overflow-hidden rounded-2xl border border-black/10 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-black/5 px-4 py-3">
                <h2 className="font-semibold">Precisa de ajuda?</h2>

                <span className="rounded-full bg-[var(--page)] px-3 py-1 text-sm font-medium">
                    Mesa {String(tableNumber).padStart(2, '0')}
                </span>
            </div>

            <div className="space-y-4 p-4">
                {checking ? (
                    <p role="status" className="text-sm opacity-75">
                        Verificando solicitações…
                    </p>
                ) : pending ? (
                    <div className="rounded-xl bg-amber-50 p-4 text-amber-900">
                        <p role="status" className="font-semibold">
                            Aguardando atendimento
                        </p>

                        <p className="mt-1 text-sm">
                            Sua solicitação está na fila da equipe.
                        </p>

                        <p
                            role="timer"
                            aria-live="off"
                            aria-label="Tempo aguardando atendimento"
                            className="mt-3 font-mono text-2xl font-semibold tabular-nums"
                        >
                            {formatElapsed(elapsed)}
                        </p>
                    </div>
                ) : request?.status === 'attended' ? (
                    <p
                        role="status"
                        className="rounded-xl bg-green-50 p-4 text-sm text-green-900"
                    >
                        Sua chamada foi marcada como atendida pela equipe.
                    </p>
                ) : request?.status === 'cancelled' ? (
                    <p
                        role="status"
                        className="rounded-xl bg-[var(--page)] p-4 text-sm"
                    >
                        Sua chamada foi cancelada.
                    </p>
                ) : (
                    <p className="text-sm opacity-75">
                        Chame nossa equipe para fazer seu pedido ou
                        solicitar ajuda.
                    </p>
                )}

                {retrySeconds > 0 && (
                    <p
                        role="status"
                        className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
                    >
                        Limite de tentativas atingido. Aguarde{' '}
                        {retrySeconds} segundos para tentar novamente.
                    </p>
                )}

                {syncNotice && (
                    <p
                        role="status"
                        className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
                    >
                        {syncNotice}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm text-red-700">
                        {error}
                    </p>
                )}

                {pending ? (
                    <div className="space-y-2">
                        <button
                            type="button"
                            onClick={() => void handleRefresh()}
                            disabled={busy || checking}
                            className="min-h-12 w-full rounded-xl border border-black/20 px-4 font-medium disabled:opacity-50"
                        >
                            {busy ? 'Atualizando…' : 'Atualizar chamado'}
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleCancel()}
                            disabled={busy || checking}
                            className="min-h-11 w-full rounded-xl text-red-600 hover:bg-red-50 px-4 text-sm font-medium disabled:opacity-50 transition-colors"
                        >
                            {busy ? 'Cancelando…' : 'Cancelar chamado'}
                        </button>
                    </div>
                ) : confirming ? (
                    <div
                        role="group"
                        aria-label="Confirmar chamada do garçom"
                        className="rounded-xl border border-black/10 bg-[var(--page)] p-4"
                    >
                        <p className="font-medium">
                            Deseja chamar um dos nossos garçons?
                        </p>

                        <div className="mt-4 flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => void handleCall()}
                                disabled={
                                    busy ||
                                    checking ||
                                    retrySeconds > 0
                                }
                                className="min-h-12 flex-1 rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50"
                            >
                                {busy ? 'Enviando…' : 'Confirmar'}
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setConfirming(false);
                                    setError('');
                                }}
                                disabled={busy}
                                className="min-h-12 rounded-xl border border-black/20 bg-white px-4 font-medium disabled:opacity-50"
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => {
                            setConfirming(true);
                            setError('');
                        }}
                        disabled={
                            busy ||
                            checking ||
                            retrySeconds > 0
                        }
                        className="min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50"
                    >
                        {checking ? 'Verificando…' : 'Chamar garçom'}
                    </button>
                )}
            </div>
        </section>
    );
}