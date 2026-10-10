import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useTableContext } from '../tables/useTableContext';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { usePublicMenu } from '../menu/PublicMenuProvider';
import { getGuestTabState } from './guestTab';
import type { GuestTabState } from './guestTab';
import {
    getGuestSessionState,
    issueGuestConfirmationCode,
    startGuestSession,
} from '../tables/guestSessions';
import type {
    GuestConfirmationCode,
    GuestSession,
} from '../tables/guestSessions';
import { ServiceActionPopup, type ServiceActionType } from './ServiceActionPopup';

const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
});

function secondsUntil(expiresAt: string) {
    return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

function formatCountdown(seconds: number) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function TabOrdersPage() {
    const { restaurantSlug = '' } = useParams();
    const table = useTableContext();
    const { restaurant } = useRestaurant();
    const { menu } = usePublicMenu();

    const tableQuery = table.status === 'unverified' ? `?mesa=${table.tableNumber}` : '';
    const tableNumber = table.status === 'unverified' ? Number(table.tableNumber) : 7;
    const tableLabel = `Mesa ${String(tableNumber).padStart(2, '0')}`;

    const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
    const [tabState, setTabState] = useState<GuestTabState | null>(null);
    const [guestSession, setGuestSession] = useState<GuestSession | null>(null);
    const [confirmationCode, setConfirmationCode] = useState<GuestConfirmationCode | null>(null);
    const [codeRemaining, setCodeRemaining] = useState(0);
    const [isGeneratingCode, setIsGeneratingCode] = useState(false);
    const [revision, setRevision] = useState(0);
    const requestVersion = useRef(0);

    const refresh = useCallback(() => {
        requestVersion.current += 1;
        setRevision((prev) => prev + 1);
    }, []);

    // 1. Carregar sessão de cliente da mesa e código de confirmação
    useEffect(() => {
        if (!restaurantSlug || table.status !== 'unverified') return;
        let disposed = false;

        async function loadSession() {
            try {
                const res = await getGuestSessionState(restaurantSlug, tableNumber);
                if (!disposed) {
                    setGuestSession(res.session);
                    setConfirmationCode(res.code);
                    setCodeRemaining(res.code ? secondsUntil(res.code.expires_at) : 0);
                }
            } catch {
                // Silencia falha se não houver sessão ativa
            }
        }

        void loadSession();
        return () => { disposed = true; };
    }, [restaurantSlug, table.status, tableNumber, revision]);

    // 2. Carregar consumo e comanda vinculada no Supabase
    useEffect(() => {
        if (!restaurantSlug || table.status !== 'unverified') return;
        let disposed = false;
        const currentVersion = requestVersion.current;

        async function loadTab() {
            try {
                const res = await getGuestTabState(restaurantSlug, tableNumber);
                if (!disposed && currentVersion === requestVersion.current) {
                    setTabState(res);
                }
            } catch {
                // Silencia falha caso ainda não esteja confirmada
            }
        }

        void loadTab();
        return () => { disposed = true; };
    }, [restaurantSlug, table.status, tableNumber, revision]);

    // 3. Temporizador do código de confirmação
    useEffect(() => {
        if (!confirmationCode || codeRemaining <= 0) return;

        const interval = window.setInterval(() => {
            const next = secondsUntil(confirmationCode.expires_at);
            setCodeRemaining(next);
            if (next <= 0) {
                window.clearInterval(interval);
            }
        }, 1000);

        return () => window.clearInterval(interval);
    }, [confirmationCode, codeRemaining]);

    // 4. Inscrição Realtime no Supabase para sincronizar automaticamente com o painel /equipe
    useEffect(() => {
        const userId = tabState?.userId;
        const guestId = tabState?.guestSessionId || guestSession?.id;
        const tabId = tabState?.tabId;

        function scheduleRefresh() {
            if (!document.hidden) refresh();
        }

        // Polling ativo a cada 4 segundos caso haja comanda aberta ou código pendente
        const pollTimer = window.setInterval(scheduleRefresh, 4000);
        document.addEventListener('visibilitychange', scheduleRefresh);

        let channel = supabase.channel(`tab-realtime:${restaurantSlug}:${tableNumber}:${guestId ?? 'session'}`);

        if (userId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'guest_sessions', filter: `user_id=eq.${userId}` }, scheduleRefresh);
        }
        if (guestId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'guest_sessions', filter: `id=eq.${guestId}` }, scheduleRefresh)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tab_guests', filter: `guest_session_id=eq.${guestId}` }, scheduleRefresh);
        }
        if (tabId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tabs', filter: `id=eq.${tabId}` }, scheduleRefresh)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tab_items', filter: `table_tab_id=eq.${tabId}` }, scheduleRefresh);
        }

        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'table_visits' }, scheduleRefresh);

        channel.subscribe();

        return () => {
            window.clearInterval(pollTimer);
            document.removeEventListener('visibilitychange', scheduleRefresh);
            void supabase.removeChannel(channel);
        };
    }, [tabState?.userId, tabState?.guestSessionId, tabState?.tabId, guestSession?.id, restaurantSlug, tableNumber, refresh]);

    // Função para gerar a comanda / código para o garçom
    async function handleGenerateCode() {
        if (isGeneratingCode) return;
        setIsGeneratingCode(true);
        try {
            const session = await startGuestSession(restaurantSlug, tableNumber);
            setGuestSession(session);
            if (session.status === 'pending') {
                const code = await issueGuestConfirmationCode(session.id);
                setConfirmationCode(code);
                setCodeRemaining(secondsUntil(code.expires_at));
            }
            refresh();
        } catch (err) {
            console.error('Erro ao gerar comanda para o garçom:', err);
        } finally {
            setIsGeneratingCode(false);
        }
    }

    // Função para reiniciar/abrir nova comanda após fechamento
    function handleResetTab() {
        setTabState(null);
        setGuestSession(null);
        setConfirmationCode(null);
        void handleGenerateCode();
    }

    // Determinação dos estados da Comanda
    const isClosed = tabState?.status === 'closed' || guestSession?.status === 'revoked';
    const isReady = !isClosed && tabState?.status === 'ready';
    const hasCode = !isClosed && !isReady && guestSession?.status === 'pending' && !!confirmationCode && codeRemaining > 0;
    const isWaiting = !isClosed && !isReady && (tabState?.status === 'waiting' || (guestSession?.status === 'pending' && !hasCode));
    const isInitial = !isClosed && !isReady && !hasCode && !isWaiting;

    // Buscar imagens do catálogo para os itens da comanda
    const getProductImage = (name: string) => {
        const found = menu?.products.find((p) =>
            p.name.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(p.name.toLowerCase())
        );
        return found?.images[0]?.url;
    };

    // Itens reais vindos do Supabase
    const realItems = isReady && tabState ? tabState.items : [];
    const hasRealItems = realItems.length > 0;

    const displayItems = realItems.map((item) => ({
        id: item.id,
        name: item.product_name,
        status: item.status === 'cancelled' ? 'Cancelado' : 'Pedido entregue',
        quantity: item.quantity,
        unitPriceInCents: item.unit_price_in_cents,
        imageUrl: getProductImage(item.product_name),
    }));

    const subtotalInCents = isReady && tabState ? tabState.totalInCents : 0;
    const serviceFeeInCents = Math.round(subtotalInCents * 0.1);
    const totalInCents = subtotalInCents + serviceFeeInCents;

    return (
        <div className="tab-orders-page">
            {/* Header da Comanda */}
            <header className="tab-orders-header">
                <div className="tab-orders-title-row">
                    <h1 className="tab-orders-title">Consumo da {tableLabel}</h1>
                    <span className={`tab-orders-status-badge ${
                        isClosed
                            ? 'tab-closed-badge'
                            : isReady
                                ? 'active'
                                : hasCode || isWaiting
                                    ? 'waiting'
                                    : ''
                    }`}>
                        {isClosed
                            ? 'Atendimento Encerrado'
                            : isReady
                                ? 'Comanda Aberta'
                                : hasCode
                                    ? 'Aguardando Garçom'
                                    : isWaiting
                                        ? 'Mesa Confirmada'
                                        : 'Sem Comanda'}
                    </span>
                </div>

                <div className="tab-orders-meta-row">
                    <span className="tab-meta-item">
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
                        </svg>
                        {isReady ? 'Mesa Ativa' : tableLabel}
                    </span>
                    <span className="tab-meta-divider">/</span>
                    <span className="tab-meta-item">
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                        </svg>
                        {isReady ? `Comanda: ${tabState.tab.label}` : 'Atendimento Digital'}
                    </span>
                </div>
            </header>

            {/* ESTADO 1: Inicial - Gerar Comanda */}
            {isInitial && (
                <div className="tab-hero-card">
                    <div className="tab-hero-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                            <polyline points="10 9 9 9 8 9" />
                        </svg>
                    </div>
                    <h2>Abra sua Comanda</h2>
                    <p>
                        Gere o número da comanda desta mesa para apresentar ao garçom. Ele lançará seus pedidos e você acompanhará tudo em tempo real.
                    </p>
                    <button
                        type="button"
                        className="tab-hero-primary-btn"
                        onClick={handleGenerateCode}
                        disabled={isGeneratingCode}
                    >
                        {isGeneratingCode ? (
                            'Gerando comanda…'
                        ) : (
                            <>
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                <span>Gerar Comanda</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* ESTADO 2: Código Gerado - Aguardando Garçom colocar na tela dele */}
            {hasCode && (
                <div className="tab-code-highlight-card">
                    <span className="tab-code-title">Informe este código ao garçom</span>
                    <div className="tab-code-big-number">
                        {confirmationCode?.code.slice(0, 3)} {confirmationCode?.code.slice(3)}
                    </div>
                    <div className="tab-code-timer-badge">
                        <span>⏱️ Válido por:</span>
                        <strong>{formatCountdown(codeRemaining)}</strong>
                    </div>
                    <p className="tab-code-instruction">
                        O garçom inserirá este número no sistema para iniciar o atendimento e começar a registrar os pedidos da sua mesa.
                    </p>
                    <div className="tab-code-waiting-pulse">
                        <span className="tab-pulse-dot" />
                        <span>Aguardando o garçom confirmar e lançar os pedidos…</span>
                    </div>
                    <button
                        type="button"
                        className="tab-renew-code-btn"
                        onClick={handleGenerateCode}
                        disabled={isGeneratingCode}
                    >
                        {isGeneratingCode ? 'Gerando novo código…' : 'Gerar novo código'}
                    </button>
                </div>
            )}

            {/* ESTADO 3: Mesa confirmada - Aguardando vínculo/primeiro pedido */}
            {isWaiting && (
                <div className="tab-hero-card">
                    <div className="tab-hero-icon" style={{ background: '#fef3c7', color: '#b45309' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                        </svg>
                    </div>
                    <h2>Presença Confirmada!</h2>
                    <p>
                        O garçom já confirmou sua mesa no sistema. Ele está preparando sua comanda e logo começará a lançar os pedidos.
                    </p>
                    <div className="tab-code-waiting-pulse">
                        <span className="tab-pulse-dot" />
                        <span>Sincronizando com o atendimento…</span>
                    </div>
                </div>
            )}

            {/* ESTADO 4: Comanda Aberta - Acompanhamento dos Pedidos em Tempo Real */}
            {isReady && (
                <section className="tab-orders-section">
                    <div className="tab-orders-section-heading">
                        <h2>Pedidos da Mesa</h2>
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="clock-icon">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                        </svg>
                    </div>

                    {!hasRealItems ? (
                        <div className="tab-empty-orders-box">
                            <span className="empty-icon">🍽️</span>
                            <h3>Comanda conectada!</h3>
                            <p>
                                Nenhum pedido lançado ainda. Assim que o garçom registrar seus pedidos na tela dele, eles aparecerão aqui em tempo real.
                            </p>
                            <Link
                                to={`/${restaurantSlug}${tableQuery}`}
                                className="tab-hero-primary-btn"
                                style={{ maxWidth: '240px', minHeight: '44px', fontSize: '14px', textDecoration: 'none' }}
                            >
                                Ver Cardápio
                            </Link>
                        </div>
                    ) : (
                        <>
                            <ul className="tab-orders-list">
                                {displayItems.map((item) => (
                                    <li key={item.id} className="tab-order-item">
                                        <div className="tab-order-avatar">
                                            {item.imageUrl ? (
                                                <img src={item.imageUrl} alt={item.name} loading="lazy" />
                                            ) : (
                                                <span className="tab-order-avatar-fallback">🍽️</span>
                                            )}
                                        </div>

                                        <div className="tab-order-details">
                                            <span className="tab-order-name">{item.name}</span>
                                            <span className="tab-order-status">{item.status}</span>
                                        </div>

                                        <div className="tab-order-pricing">
                                            <div className="tab-order-price-row">
                                                <span className="tab-order-qty">{item.quantity}x</span>
                                                <strong className="tab-order-price">
                                                    {currency.format((item.unitPriceInCents * item.quantity) / 100)}
                                                </strong>
                                            </div>
                                            {item.quantity > 1 && (
                                                <span className="tab-order-unit-price">
                                                    {currency.format(item.unitPriceInCents / 100)} cada
                                                </span>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            {/* Subtotais e Total Real */}
                            <div className="tab-orders-summary">
                                <div className="tab-summary-row">
                                    <span>Subtotal</span>
                                    <strong>{currency.format(subtotalInCents / 100)}</strong>
                                </div>
                                <div className="tab-summary-row">
                                    <span>Taxa de Serviço (10% - opcional)</span>
                                    <strong>{currency.format(serviceFeeInCents / 100)}</strong>
                                </div>
                                <div className="tab-summary-row total">
                                    <span>Total</span>
                                    <strong className="tab-grand-total">{currency.format(totalInCents / 100)}</strong>
                                </div>
                            </div>

                            {/* Botão para solicitar a conta direto da comanda */}
                            <div className="tab-orders-cta-block">
                                <button
                                    type="button"
                                    className="tab-request-bill-btn"
                                    onClick={() => setActiveAction('bill')}
                                >
                                    Solicitar a Conta
                                </button>
                            </div>
                        </>
                    )}
                </section>
            )}

            {/* ESTADO 5: Conta Encerrada pelo Garçom */}
            {isClosed && (
                <div className="tab-closed-box">
                    <div className="closed-icon">✓</div>
                    <h2>Atendimento Encerrado</h2>
                    <p>
                        A conta desta mesa foi encerrada pela equipe. Agradecemos muito pela sua visita!
                    </p>
                    <button
                        type="button"
                        className="tab-hero-primary-btn"
                        onClick={handleResetTab}
                        disabled={isGeneratingCode}
                    >
                        {isGeneratingCode ? 'Iniciando…' : 'Abrir Nova Comanda'}
                    </button>
                </div>
            )}

            {/* Barra Inferior (Dock: Início, Chamar Garçom, Comanda) */}
            <nav className="home-bottom-nav" aria-label="Ações da mesa">
                <Link to={`/${restaurantSlug}${tableQuery}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        <polyline points="9 22 9 12 15 12 15 22" />
                    </svg>
                    <span>Início</span>
                </Link>

                <button type="button" onClick={() => setActiveAction('waiter')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                    <span>Chamar Garçom</span>
                </button>

                <Link to={`/${restaurantSlug}/comanda${tableQuery}`} className="active" aria-current="page">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2z" />
                        <line x1="8" y1="8" x2="16" y2="8" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                        <line x1="8" y1="16" x2="12" y2="16" />
                    </svg>
                    <span>Comanda</span>
                </Link>
            </nav>

            {/* Popup Integrado de Chamar Garçom / Pedir Conta */}
            <ServiceActionPopup
                isOpen={!!activeAction}
                mode={activeAction}
                onClose={() => setActiveAction(null)}
            />
        </div>
    );
}
