import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
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

    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [session, setSession] = useState<GuestSession | null>(null);
    const [code, setCode] = useState<GuestConfirmationCode | null>(null);
    const [remaining, setRemaining] = useState(0);

    useEffect(() => {
        let disposed = false;

        async function restoreSession() {
            try {
                const state = await getGuestSessionState(
                    restaurantSlug,
                    tableNumber,
                );

                if (disposed) return;

                setSession(state.session);
                setRemaining(
                    state.code ? secondsUntil(state.code.expires_at) : 0,
                );
                setCode(state.code);
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

    useEffect(() => {
        if (!code) return;

        function updateClock() {
            setRemaining(secondsUntil(code!.expires_at));
        }

        updateClock();

        const timer = window.setInterval(updateClock, 1000);
        document.addEventListener('visibilitychange', updateClock);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', updateClock);
        };
    }, [code]);

    function applyState(state: GuestSessionState) {
        setSession(state.session);
        setRemaining(
            state.code ? secondsUntil(state.code.expires_at) : 0,
        );
        setCode(state.code);
    }

    const confirmed = session?.status === 'active';
    const validCode = !!code && remaining > 0;

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
            setError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível verificar sua sessão.',
            );
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }

    return (
        <section className="overflow-hidden rounded-2xl border border-black/10 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-black/5 px-4 py-3">
                <h2 className="font-semibold">Seu atendimento</h2>

                <span className="rounded-full bg-[var(--page)] px-3 py-1 text-sm font-medium">
                    Mesa {String(tableNumber).padStart(2, '0')}
                </span>
            </div>

            <div className="space-y-4 p-4">
                {checking ? (
                    <p role="status" className="text-sm opacity-75">
                        Recuperando sua sessão…
                    </p>
                ) : confirmed ? (
                    <div
                        role="status"
                        className="rounded-xl bg-green-50 p-4 text-sm text-green-900"
                    >
                        Sua presença foi confirmada pela equipe.
                    </div>
                ) : (
                    <>
                        <p className="text-sm opacity-75">
                            Mostre o código ao funcionário para confirmar sua
                            presença nesta mesa.
                        </p>

                        {code && (
                            validCode ? (
                                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-[var(--page)] p-4">
                                    <div>
                                        <p className="text-xs font-medium opacity-75">
                                            Código de confirmação
                                        </p>

                                        <p className="mt-1 font-mono text-3xl font-semibold tracking-widest">
                                            {code.code}
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-black/10 bg-white px-3 py-2 text-center">
                                        <p className="text-xs opacity-75">Expira em</p>

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