import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link, useParams } from 'react-router';
import { usePublicMenu, PublicMenuStatus } from '../menu/PublicMenuProvider';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { useTableContext } from '../tables/useTableContext';
import { ExploreMedia } from './ExploreMedia';

const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
});

function formatLikes(count: number) {
    const safeCount = Math.max(0, count);
    if (safeCount >= 1000) {
        return `${(safeCount / 1000).toFixed(1)}k`;
    }
    return String(safeCount);
}

interface PointerStartState {
    pointerId: number;
    productId: string;
    x: number;
    y: number;
    time: number;
}

interface LastTapState {
    productId: string;
    x: number;
    y: number;
    time: number;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
        target.closest(
            'button, a, header, aside, .explore-product-info, .explore-reels-progress, .explore-like-toast',
        ),
    );
}

export function ExplorePage() {
    const { restaurantSlug = '' } = useParams();

    return (
        <ExploreFeed
            key={restaurantSlug}
            restaurantSlug={restaurantSlug}
        />
    );
}

function ExploreFeed({ restaurantSlug }: { restaurantSlug: string }) {
    useRestaurant();
    const table = useTableContext();
    const tableQuery = table.status === 'unverified'
        ? `?mesa=${table.tableNumber}`
        : '';
    const containerRef = useRef<HTMLDivElement>(null);
    const pointerStartRef = useRef<PointerStartState | null>(null);
    const lastTapRef = useRef<LastTapState | null>(null);
    const burstTimerRef = useRef<number | null>(null);

    const [activeIndex, setActiveIndex] = useState(0);
    const [isPaused, setIsPaused] = useState(false);
    const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
    const [burstProductId, setBurstProductId] = useState<string | null>(null);

    const catalog = usePublicMenu();
    const {
        menu,
        isProductLiked,
        isProductLikePending,
        getProductLikesCount,
        likeProduct,
        toggleProductLike,
        likeError,
        clearLikeError,
    } = catalog;

    const products = [...(menu?.products ?? [])]
        .filter((product) => product.available)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    const productIds = products.map((product) => product.id).join('|');

    useEffect(() => {
        return () => {
            if (burstTimerRef.current !== null) {
                window.clearTimeout(burstTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!likeError) return;
        const timer = window.setTimeout(() => {
            clearLikeError();
        }, 4000);
        return () => window.clearTimeout(timer);
    }, [likeError, clearLikeError]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        setActiveIndex(0);
        container.scrollTop = 0;
        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
                if (!visible) return;

                const index = Number((visible.target as HTMLElement).dataset.index);
                if (Number.isInteger(index)) setActiveIndex(index);
            },
            { root: container, threshold: 0.6 },
        );

        Array.from(container.children).forEach((slide) => observer.observe(slide));
        return () => observer.disconnect();
    }, [productIds]);

    function moveTo(index: number) {
        const container = containerRef.current;
        const target = container?.children.item(index);
        if (!container || !(target instanceof HTMLElement)) return;

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        container.scrollTo({
            top: target.offsetTop,
            behavior: reducedMotion ? 'instant' : 'smooth',
        });
    }

    function triggerHeartBurst(productId: string) {
        if (burstTimerRef.current !== null) {
            window.clearTimeout(burstTimerRef.current);
        }
        setBurstProductId(productId);
        burstTimerRef.current = window.setTimeout(() => {
            setBurstProductId((current) => (current === productId ? null : current));
            burstTimerRef.current = null;
        }, 720);
    }

    function handleDoubleTapLike(productId: string) {
        triggerHeartBurst(productId);
        if (!isProductLiked(productId)) {
            void likeProduct(productId);
        }
    }

    function handleSlidePointerDown(productId: string, event: PointerEvent<HTMLElement>) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (isInteractiveTarget(event.target)) {
            pointerStartRef.current = null;
            return;
        }
        pointerStartRef.current = {
            pointerId: event.pointerId,
            productId,
            x: event.clientX,
            y: event.clientY,
            time: performance.now(),
        };
    }

    function handleSlidePointerUp(productId: string, event: PointerEvent<HTMLElement>) {
        const start = pointerStartRef.current;
        pointerStartRef.current = null;

        if (!start || start.pointerId !== event.pointerId || start.productId !== productId) {
            return;
        }
        if (isInteractiveTarget(event.target)) {
            lastTapRef.current = null;
            return;
        }

        const now = performance.now();
        const duration = now - start.time;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);

        // Ignora toque longo, arraste ou swipe de navegação vertical/horizontal
        if (duration > 260 || dx > 14 || dy > 14) {
            lastTapRef.current = null;
            return;
        }

        const prevTap = lastTapRef.current;
        if (
            prevTap &&
            prevTap.productId === productId &&
            now - prevTap.time <= 300 &&
            Math.hypot(event.clientX - prevTap.x, event.clientY - prevTap.y) <= 40
        ) {
            lastTapRef.current = null;
            handleDoubleTapLike(productId);
            return;
        }

        lastTapRef.current = {
            productId,
            x: event.clientX,
            y: event.clientY,
            time: now,
        };
    }

    function handleSlidePointerCancel() {
        pointerStartRef.current = null;
    }

    async function handleShare(name: string, description: string, slug: string) {
        const shareUrl = `${window.location.origin}/${restaurantSlug}/produto/${slug}${tableQuery}`;
        if (navigator.share) {
            try {
                await navigator.share({
                    title: name,
                    text: description,
                    url: shareUrl,
                });
            } catch {
                // Usuário cancelou o compartilhamento nativo
            }
        } else {
            navigator.clipboard?.writeText(shareUrl);
            alert('Link do prato copiado para a área de transferência!');
        }
    }

    if (!menu) return <PublicMenuStatus />;

    if (products.length === 0) {
        return (
            <section className="explore-empty">
                <div className="explore-empty-card">
                    <h1>Nenhum produto para explorar</h1>
                    <p>Confira as opções disponíveis no cardápio.</p>
                    <Link to={`/${restaurantSlug}/cardapio${tableQuery}`} className="explore-return-link">
                        Voltar ao cardápio
                    </Link>
                </div>
            </section>
        );
    }

    return (
        <section className="explore-screen" aria-label="Explorar os produtos">
            {/* Barrinhas de status / progresso estilo Reels e Stories do Instagram / WhatsApp */}
            <div
                className="explore-reels-progress"
                role="progressbar"
                aria-valuenow={activeIndex + 1}
                aria-valuemin={1}
                aria-valuemax={products.length}
            >
                {products.map((p, i) => (
                    <button
                        key={p.id}
                        type="button"
                        className="explore-progress-seg"
                        onClick={() => moveTo(i)}
                        aria-label={`Ir para o prato ${i + 1} de ${products.length}`}
                    >
                        <span
                            className="explore-progress-fill"
                            style={{
                                width: i < activeIndex ? '100%' : i === activeIndex ? '100%' : '0%',
                            }}
                        />
                    </button>
                ))}
            </div>

            {likeError && (
                <div
                    className="explore-like-toast"
                    role="status"
                    aria-live="polite"
                    onClick={clearLikeError}
                >
                    {likeError}
                </div>
            )}

            <div
                ref={containerRef}
                className="explore-feed"
                role="region"
                aria-label="Feed de pratos. Deslize para cima ou para baixo."
                tabIndex={0}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                    if (!direction) return;
                    event.preventDefault();
                    moveTo(Math.max(0, Math.min(products.length - 1, activeIndex + direction)));
                }}
            >
                {products.map((product, index) => {
                    const isLiked = isProductLiked(product.id);
                    const isLikePending = isProductLikePending(product.id);
                    const currentLikes = getProductLikesCount(product.id);
                    const showBurst = burstProductId === product.id;

                    return (
                        <article
                            key={product.id}
                            data-index={index}
                            className="explore-slide"
                            aria-label={`${product.name}, produto ${index + 1} de ${products.length}`}
                            onPointerDown={(event) => handleSlidePointerDown(product.id, event)}
                            onPointerUp={(event) => handleSlidePointerUp(product.id, event)}
                            onPointerCancel={handleSlidePointerCancel}
                        >
                            {/* Mídia de Fundo */}
                            <ExploreMedia
                                key={product.id}
                                product={product}
                                active={index === activeIndex}
                                nearby={Math.abs(index - activeIndex) === 1}
                                paused={isPaused}
                            />

                            {/* Sombreamento Superior e Inferior para legibilidade */}
                            <div className="explore-shade" aria-hidden="true" />

                            {/* Feedback visual discreto de duplo toque */}
                            {showBurst && (
                                <div className="explore-like-burst" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="#e63946">
                                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                                    </svg>
                                </div>
                            )}

                            {/* Cabeçalho Flutuante Superior */}
                            <header className="explore-topbar">
                                <Link
                                    to={`/${restaurantSlug}/cardapio${tableQuery}`}
                                    className="explore-back-link"
                                    aria-label="Voltar ao cardápio"
                                >
                                    <span aria-hidden="true">←</span>
                                    <span>Cardápio</span>
                                </Link>

                                <div className="explore-top-right">
                                    <button
                                        type="button"
                                        className="explore-pause-pill"
                                        onClick={() => setIsPaused((prev) => !prev)}
                                        aria-label={isPaused ? 'Reproduzir prato' : 'Pausar prato'}
                                    >
                                        {isPaused ? 'Play' : 'Pausar'}
                                    </button>
                                </div>
                            </header>

                            {/* Cápsula Lateral Direita de Ações (com botão + que abre e recolhe os ícones) */}
                            <aside
                                className={`explore-actions-sidebar ${actionsMenuOpen ? 'expanded' : 'collapsed'}`}
                                aria-label="Ações do prato"
                            >
                                {/* Grupo de ícones recolhíveis */}
                                <div className="explore-actions-group">
                                    {/* Botão Curtir */}
                                    <button
                                        type="button"
                                        className={`explore-action-item ${isLiked ? 'active' : ''}`}
                                        onClick={() => {
                                            void toggleProductLike(product.id);
                                        }}
                                        aria-label={
                                            isLiked
                                                ? `Descurtir ${product.name} (${currentLikes} curtidas)`
                                                : `Curtir ${product.name} (${currentLikes} curtidas)`
                                        }
                                        aria-pressed={isLiked}
                                        aria-busy={isLikePending}
                                    >
                                        <div className="explore-action-icon">
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill={isLiked ? '#e63946' : 'white'}
                                                stroke={isLiked ? '#e63946' : 'none'}
                                                aria-hidden="true"
                                            >
                                                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                                            </svg>
                                        </div>
                                        <span className="explore-action-label">{formatLikes(currentLikes)}</span>
                                    </button>

                                    {/* Compartilhar */}
                                    <button
                                        type="button"
                                        className="explore-action-item"
                                        onClick={() => handleShare(product.name, product.shortDescription || product.description, product.slug)}
                                        aria-label="Compartilhar prato"
                                    >
                                        <div className="explore-action-icon">
                                            <svg viewBox="0 0 24 24" fill="white" aria-hidden="true">
                                                <path d="M14 5V1l8 8-8 8v-4.1c-6 0-10.5 1.9-13.5 6.1 1.2-6 4.8-12 13.5-14z" />
                                            </svg>
                                        </div>
                                    </button>
                                </div>

                                {/* Botão '+' para alternar o menu lateral (fecha e abre os ícones de ações) */}
                                <button
                                    type="button"
                                    className={`explore-action-item explore-plus-btn ${actionsMenuOpen ? 'active' : ''}`}
                                    onClick={() => setActionsMenuOpen((prev) => !prev)}
                                    aria-label={actionsMenuOpen ? 'Recolher menu de ações' : 'Expandir menu de ações'}
                                    aria-expanded={actionsMenuOpen}
                                >
                                    <div className="explore-action-icon">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="white"
                                            strokeWidth="2.6"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                            className="explore-plus-svg"
                                        >
                                            <line x1="12" y1="5" x2="12" y2="19" />
                                            <line x1="5" y1="12" x2="19" y2="12" />
                                        </svg>
                                    </div>
                                </button>
                            </aside>

                            {/* Informações do Prato (Canto Inferior Esquerdo) */}
                            <div className="explore-product-info">
                                {product.featured ? (
                                    <span className="explore-featured-tag">Destaque da casa</span>
                                ) : (
                                    <span className="explore-featured-tag">Especial do Chef</span>
                                )}

                                <h2 className="explore-dish-title">{product.name}</h2>
                                <p className="explore-dish-description">
                                    {product.shortDescription || product.description}
                                </p>
                                <p className="explore-dish-price">
                                    {currency.format(product.priceInCents / 100)}
                                </p>

                                <Link
                                    to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                                    aria-label={`Ver detalhes de ${product.name}`}
                                    className="explore-details-pill"
                                >
                                    <span>Ver detalhes</span>
                                    <span aria-hidden="true">↗</span>
                                </Link>
                            </div>

                            {/* Dica de Rolagem no Rodapé */}
                            <div className="explore-bottom-hint" aria-hidden="true">
                                <span>
                                    {index === products.length - 1
                                        ? 'Deslize para baixo para voltar ↓'
                                        : 'Deslize para cima para descobrir ↑'}
                                </span>
                            </div>
                        </article>
                    );
                })}
            </div>

            <span className="sr-only" role="status" aria-live="polite">
                Produto {activeIndex + 1} de {products.length}
            </span>
        </section>
    );
}
