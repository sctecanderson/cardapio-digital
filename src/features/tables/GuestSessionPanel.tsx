import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useTableContext } from './useTableContext';
import {
    getGuestSessionState,
    issueGuestConfirmationCode,
    startGuestSession,
} from './guestSessions';
import type {
    GuestConfirmationCode,
    GuestSession,
    GuestSessionState,
} from './guestSessions';

function secondsUntil(expiresAt: string) {
    return Math.max(
        0,
        Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000),
    );
}

function formatTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;

    return `${String(minutes).padStart(2, '0')}:${String(
        remainder,
    ).padStart(2, '0')}`;
}

export function GuestSessionPanel() {
    const { restaurantSlug } = useParams();
    const table = useTableContext();

    if (!restaurantSlug || table.status !== 'unverified') {
        return null;
    }

    return (
        <SessionPanel
            key={`${restaurantSlug}:${table.tableNumber}`}
            restaurantSlug={restaurantSlug}
            tableNumber={Number(table.tableNumber)}
        />
    );
}

function SessionPanel({
    restaurantSlug,
    tableNumber,
}: {
    restaurantSlug: string;
    tableNumber: number;
}) {
    const submitting = useRef(false);
    const stateRevision = useRef(0);
    const mounted = useRef(false);

    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [syncNotice, setSyncNotice] = useState('');
    const [session, setSession] = useState<GuestSession | null>(null);
    const [code, setCode] = useState<GuestConfirmationCode | null>(null);
    const [remaining, setRemaining] = useState(0);

    const sessionId = session?.id;
    const confirmed = session?.status === 'active';
    const validCode = !!code && remaining > 0;

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    // Recupera a sessão existente sem gerar outro código.
    useEffect(() => {
        let disposed = false;

        async function restoreSession() {
            try {
                const state = await getGuestSessionState(
                    restaurantSlug,
                    tableNumber,
                );

                if (disposed) return;

                stateRevision.current += 1;
                setSession(state.session);
                setCode(state.code);
                setRemaining(
                    state.code ? secondsUntil(state.code.expires_at) : 0,
                );
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível recuperar sua sessão.',
                    );
                }
            } finally {
                if (!disposed) {
                    setChecking(false);
                }
            }
        }

        void restoreSession();

        return () => {
            disposed = true;
        };
    }, [restaurantSlug, tableNumber]);

    // Calcula o contador pela data de vencimento do código.
    useEffect(() => {
        if (!code) return;

        const expiresAt = code.expires_at;

        function updateClock() {
            setRemaining(secondsUntil(expiresAt));
        }

        updateClock();

        const timer = window.setInterval(updateClock, 1000);
        document.addEventListener('visibilitychange', updateClock);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', updateClock);
        };
    }, [code]);

    // Escuta alterações somente da sessão exibida.
    useEffect(() => {
        if (!sessionId) return;

        let disposed = false;
        let refreshing = false;
        let refreshRequested = false;
        let connected = false;
        let refreshTimer: number | undefined;

        function scheduleRefresh() {
            if (disposed || refreshTimer !== undefined) return;

            refreshTimer = window.setTimeout(() => {
                refreshTimer = undefined;
                void refreshSession();
            }, 250);
        }

        async function refreshSession() {
            if (disposed) return;

            // Aguarda uma ação manual terminar antes de consultar.
            if (submitting.current) {
                scheduleRefresh();
                return;
            }

            // Agrupa eventos recebidos durante uma consulta.
            if (refreshing) {
                refreshRequested = true;
                return;
            }

            refreshing = true;
            const revision = stateRevision.current;

            try {
                const state = await getGuestSessionState(
                    restaurantSlug,
                    tableNumber,
                );

                if (disposed) return;

                // Descarta uma resposta anterior a uma ação mais recente.
                if (
                    submitting.current ||
                    revision !== stateRevision.current
                ) {
                    refreshRequested = true;
                    return;
                }

                stateRevision.current += 1;
                setSession(state.session);
                setCode(state.code);
                setRemaining(
                    state.code ? secondsUntil(state.code.expires_at) : 0,
                );

                if (connected) {
                    setSyncNotice('');
                }
            } catch {
                if (!disposed) {
                    setSyncNotice(
                        'Não foi possível atualizar automaticamente. Use o botão abaixo para verificar sua sessão.',
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
            .channel(`guest-session:${sessionId}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'guest_sessions',
                    filter: `id=eq.${sessionId}`,
                },
                () => {
                    void refreshSession();
                },
            )
            .subscribe((status) => {
                if (disposed) return;

                if (status === 'SUBSCRIBED') {
                    connected = true;
                    setSyncNotice('');

                    // Recupera mudanças ocorridas antes da conexão
                    // ou enquanto ela estava indisponível.
                    void refreshSession();
                } else if (
                    status === 'CHANNEL_ERROR' ||
                    status === 'TIMED_OUT' ||
                    status === 'CLOSED'
                ) {
                    connected = false;
                    setSyncNotice(
                        'A atualização automática está indisponível. Use o botão abaixo para verificar sua sessão.',
                    );
                }
            });

        function handleVisibility() {
            if (!document.hidden) {
                void refreshSession();
            }
        }

        function handleOnline() {
            void refreshSession();
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
    }, [sessionId, restaurantSlug, tableNumber]);

    function applyState(state: GuestSessionState) {
        if (!mounted.current) return;

        stateRevision.current += 1;
        setSession(state.session);
        setCode(state.code);
        setRemaining(
            state.code ? secondsUntil(state.code.expires_at) : 0,
        );
    }

    async function handleAction() {
        if (submitting.current || checking) return;

        submitting.current = true;
        setBusy(true);
        setError('');

        try {
            if (confirmed || validCode) {
                const state = await getGuestSessionState(
                    restaurantSlug,
                    tableNumber,
                );

                applyState(state);
            } else {
                const currentSession = await startGuestSession(
                    restaurantSlug,
                    tableNumber,
                );

                if (!mounted.current) return;

                const confirmation =
                    currentSession.status === 'pending'
                        ? await issueGuestConfirmationCode(currentSession.id)
                        : null;

                applyState({
                    session: currentSession,
                    code: confirmation,
                });
            }
        } catch (cause) {
            if (mounted.current) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível verificar sua sessão.',
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
        <section className="overflow-hidden rounded-2xl border border-black/10 bg-white text-stone-900 shadow-sm dark:border-white/10 dark:bg-stone-900 dark:text-stone-100">
            <div className="flex items-center justify-between gap-3 border-b border-black/5 dark:border-white/10 px-4 py-3">
                <h2 className="font-semibold text-stone-900 dark:text-stone-100">Seu atendimento</h2>

                <span className="rounded-full bg-[var(--page)] px-3 py-1 text-sm font-medium text-stone-700 dark:text-stone-300">
                    Mesa {String(tableNumber).padStart(2, '0')}
                </span>
            </div>

            <div className="space-y-4 p-4">
                {checking ? (
                    <p role="status" className="text-sm opacity-75 text-stone-600 dark:text-stone-300">
                        Recuperando sua sessão…
                    </p>
                ) : confirmed ? (
                    <div
                        role="status"
                        className="rounded-xl bg-green-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 p-4 text-sm text-green-900 dark:text-emerald-200"
                    >
                        Sua presença foi confirmada pela equipe.
                    </div>
                ) : (
                    <>
                        <p className="text-sm opacity-75 text-stone-600 dark:text-stone-300">
                            Mostre o código ao funcionário para confirmar sua
                            presença nesta mesa.
                        </p>

                        {code && (
                            validCode ? (
                                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-[var(--page)] p-4 border border-black/5 dark:border-white/10">
                                    <div>
                                        <p className="text-xs font-medium opacity-75 text-stone-600 dark:text-stone-300">
                                            Código de confirmação
                                        </p>

                                        <p className="mt-1 font-mono text-3xl font-semibold tracking-widest text-stone-900 dark:text-stone-100">
                                            {code.code}
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-black/10 bg-white text-stone-900 shadow-xs dark:border-white/10 dark:bg-stone-800 dark:text-stone-100 px-3 py-2 text-center">
                                        <p className="text-xs opacity-75">
                                            Expira em
                                        </p>

                                        <p
                                            role="timer"
                                            aria-live="off"
                                            className="mt-1 font-mono text-xl font-semibold tabular-nums text-[var(--brand)]"
                                        >
                                            {formatTime(remaining)}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <p
                                    role="status"
                                    className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900"
                                >
                                    Código vencido. Gere um novo para continuar.
                                </p>
                            )
                        )}
                    </>
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

                <button
                    type="button"
                    onClick={() => void handleAction()}
                    disabled={busy || checking}
                    className="min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-60"
                >
                    {checking
                        ? 'Recuperando…'
                        : busy
                            ? 'Verificando…'
                            : confirmed
                                ? 'Atualizar sessão'
                                : validCode
                                    ? 'Verificar confirmação'
                                    : code
                                        ? 'Gerar novo código'
                                        : 'Gerar código'}
                </button>
            </div>
        </section>
    );
}