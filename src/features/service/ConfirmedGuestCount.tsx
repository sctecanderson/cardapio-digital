import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { countConfirmedGuestSessions } from './tableVisits';

interface ConfirmedGuestCountProps {
    restaurantId: string;
    tableVisitId: string;
}

export function ConfirmedGuestCount({
    restaurantId,
    tableVisitId,
}: ConfirmedGuestCountProps) {
    const reload = useRef<() => void>(() => {});

    const [count, setCount] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [connectionIssue, setConnectionIssue] = useState(false);

    useEffect(() => {
        let disposed = false;
        let fetching = false;
        let requestedAgain = false;

        setCount(null);
        setLoading(true);
        setError('');
        setConnectionIssue(false);

        async function loadCount() {
            if (disposed) return;

            if (fetching) {
                requestedAgain = true;
                return;
            }

            fetching = true;
            setLoading(true);

            try {
                const total = await countConfirmedGuestSessions(
                    restaurantId,
                    tableVisitId,
                );

                if (!disposed) {
                    setCount(total);
                    setError('');
                }
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível atualizar a contagem.',
                    );
                }
            } finally {
                fetching = false;

                if (!disposed) {
                    setLoading(false);

                    if (requestedAgain) {
                        requestedAgain = false;
                        void loadCount();
                    }
                }
            }
        }

        reload.current = () => {
            void loadCount();
        };

        const channel = supabase
            .channel(`confirmed-guests:${restaurantId}:${tableVisitId}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'guest_sessions',
                    filter: `table_visit_id=eq.${tableVisitId}`,
                },
                () => {
                    void loadCount();
                },
            )
            .subscribe((status) => {
                if (disposed) return;

                if (status === 'SUBSCRIBED') {
                    setConnectionIssue(false);
                    void loadCount();
                } else if (
                    status === 'CHANNEL_ERROR' ||
                    status === 'TIMED_OUT' ||
                    status === 'CLOSED'
                ) {
                    setConnectionIssue(true);
                }
            });

        function handleVisibility() {
            if (!document.hidden) {
                void loadCount();
            }
        }

        function handleOnline() {
            void loadCount();
        }

        const timer = window.setInterval(() => {
            if (!document.hidden) {
                void loadCount();
            }
        }, 60_000);

        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleOnline);

        void loadCount();

        return () => {
            disposed = true;
            reload.current = () => {};

            window.clearInterval(timer);
            document.removeEventListener(
                'visibilitychange',
                handleVisibility,
            );
            window.removeEventListener('online', handleOnline);

            void supabase.removeChannel(channel);
        };
    }, [restaurantId, tableVisitId]);

    return (
        <div className="mb-3">
            <span role="status" className="staff-access-pill">
                {count === null
                    ? loading
                        ? 'Carregando acessos…'
                        : 'Contagem indisponível'
                    : `Acessos confirmados: ${count}`}
            </span>

            {error && (
                <p role="alert" className="mt-1 text-xs text-red-700">
                    {error}
                </p>
            )}

            {connectionIssue && (
                <p className="mt-1 text-xs opacity-75">
                    Atualização automática indisponível.
                </p>
            )}

            {(error || connectionIssue) && (
                <button
                    type="button"
                    onClick={() => reload.current()}
                    disabled={loading}
                    className="mt-1 text-xs font-medium text-[var(--brand)] underline disabled:opacity-50"
                >
                    {loading ? 'Atualizando…' : 'Atualizar contagem'}
                </button>
            )}
        </div>
    );
}