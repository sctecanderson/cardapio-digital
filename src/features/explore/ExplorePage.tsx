import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
    ProductCommentsPopover,
    getSavedProductCommentDraft,
    saveProductCommentDraft,
    type ProductCommentDraft,
    type ProductCommentsCloseReason,
} from '../comments/ProductCommentsPopover';
import {
    clearExploreNavigationState,
    getExploreNavigationState,
    saveExploreNavigationState,
} from '../comments/exploreNavigation';
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

function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const DOUBLE_TAP_DELAY_MS = 280;

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

interface PlaybackFeedbackState {
    productId: string;
    mode: 'playing' | 'paused';
    key: number;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
        target.closest(
            'button, a, header, aside, .explore-product-info, .explore-reels-progress, .explore-like-toast, .product-comments-popover',
        ),
    );
}

function isArrowNavigationIgnoredTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return Boolean(
        target.closest(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="menubar"], [role="radiogroup"], [role="tablist"], [role="tree"], [role="grid"]',
        ),
    );
}

function isPlaybackKeyIgnoredTarget(target: EventTarget | null): boolean {
    if (isArrowNavigationIgnoredTarget(target)) return true;
    if (!(target instanceof Element)) return false;
    return Boolean(
        target.closest('button, a, [role="button"], [role="link"]'),
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
    const screenRef = useRef<HTMLElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const commentButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const activeIndexRef = useRef(0);
    const pointerStartRef = useRef<PointerStartState | null>(null);
    const lastTapRef = useRef<LastTapState | null>(null);
    const suppressNextSlideTapRef = useRef(false);
    const singleTapTimerRef = useRef<number | null>(null);
    const burstTimerRef = useRef<number | null>(null);
    const playbackTimerRef = useRef<number | null>(null);

    const navigate = useNavigate();

    const [activeIndex, setActiveIndex] = useState(0);
    const [activeSlidePaused, setActiveSlidePaused] = useState(false);
    const activeSlidePausedRef = useRef(activeSlidePaused);
    activeSlidePausedRef.current = activeSlidePaused;

    const [failedVideoUrls, setFailedVideoUrls] = useState<Record<string, string>>({});
    const failedVideoUrlsRef = useRef(failedVideoUrls);
    failedVideoUrlsRef.current = failedVideoUrls;

    const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
    const [commentsOpenProductId, setCommentsOpenProductId] = useState<string | null>(null);
    const commentsOpenProductIdRef = useRef<string | null>(null);
    commentsOpenProductIdRef.current = commentsOpenProductId;

    const [commentDrafts, setCommentDrafts] = useState<Record<string, ProductCommentDraft>>({});
    const [burstProductId, setBurstProductId] = useState<string | null>(null);
    const [playbackFeedback, setPlaybackFeedback] = useState<PlaybackFeedbackState | null>(null);

    const catalog = usePublicMenu();
    const {
        menu,
        isProductLiked,
        isProductLikePending,
        getProductLikesCount,
        getProductCommentsCount,
        likeProduct,
        toggleProductLike,
        likeError,
        clearLikeError,
    } = catalog;

    const hasMenu = Boolean(menu);
    const products = [...(menu?.products ?? [])]
        .filter((product) => product.available)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    const productIds = products.map((product) => product.id).join('|');
    const productsRef = useRef(products);
    productsRef.current = products;

    function clearPendingSingleTap() {
        if (singleTapTimerRef.current !== null) {
            window.clearTimeout(singleTapTimerRef.current);
            singleTapTimerRef.current = null;
        }
    }

    function clearGestureTracking() {
        clearPendingSingleTap();
        pointerStartRef.current = null;
        lastTapRef.current = null;
    }

    function handleCommentDraftChange(productId: string, draft: ProductCommentDraft) {
        saveProductCommentDraft(productId, draft, restaurantSlug);
        setCommentDrafts((prev) => {
            const current = prev[productId];
            if (
                current &&
                current.authorName === draft.authorName &&
                current.body === draft.body
            ) {
                return prev;
            }
            return {
                ...prev,
                [productId]: draft,
            };
        });
    }

    function closeCommentsPopover(reason?: ProductCommentsCloseReason) {
        if (commentsOpenProductIdRef.current === null) return;
        if (reason === 'outside') {
            suppressNextSlideTapRef.current = true;
            clearGestureTracking();
        }
        commentsOpenProductIdRef.current = null;
        setCommentsOpenProductId(null);
    }

    function toggleCommentsPopover(productId: string) {
        suppressNextSlideTapRef.current = false;
        clearGestureTracking();
        if (commentsOpenProductIdRef.current === productId) {
            commentsOpenProductIdRef.current = null;
            setCommentsOpenProductId(null);
            return;
        }
        setCommentDrafts((prev) => {
            if (prev[productId]) return prev;
            return {
                ...prev,
                [productId]: getSavedProductCommentDraft(productId, restaurantSlug),
            };
        });
        commentsOpenProductIdRef.current = productId;
        setCommentsOpenProductId(productId);
    }

    function activateSlide(nextIndex: number) {
        if (activeIndexRef.current === nextIndex) return;
        activeIndexRef.current = nextIndex;
        suppressNextSlideTapRef.current = false;
        clearGestureTracking();
        if (commentsOpenProductIdRef.current !== null) {
            commentsOpenProductIdRef.current = null;
            setCommentsOpenProductId(null);
        }
        activeSlidePausedRef.current = false;
        setActiveIndex(nextIndex);
        setActiveSlidePaused(false);
        setPlaybackFeedback(null);
    }

    function handleFeedScroll() {
        suppressNextSlideTapRef.current = false;
        clearGestureTracking();
        const container = containerRef.current;
        if (!container || container.clientHeight <= 0) return;

        const rawIndex = container.scrollTop / container.clientHeight;
        const nearestIndex = Math.round(rawIndex);
        if (
            Math.abs(rawIndex - nearestIndex) <= 0.35 &&
            nearestIndex >= 0 &&
            nearestIndex < productsRef.current.length
        ) {
            activateSlide(nearestIndex);
        }
    }

    useEffect(() => {
        return () => {
            if (singleTapTimerRef.current !== null) {
                window.clearTimeout(singleTapTimerRef.current);
            }
            if (burstTimerRef.current !== null) {
                window.clearTimeout(burstTimerRef.current);
            }
            if (playbackTimerRef.current !== null) {
                window.clearTimeout(playbackTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        function handleMotionPreferenceChange(event: MediaQueryListEvent) {
            if (event.matches) {
                activeSlidePausedRef.current = true;
                setActiveSlidePaused(true);
            }
        }
        mediaQuery.addEventListener('change', handleMotionPreferenceChange);
        return () => mediaQuery.removeEventListener('change', handleMotionPreferenceChange);
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

        // Verifica se há estado salvo de retorno do "Ver todos os comentários"
        const navState = getExploreNavigationState(restaurantSlug);
        let initialIndex = 0;
        let initialPaused = false;

        if (navState && navState.fromExplore) {
            clearExploreNavigationState(restaurantSlug);
            if (navState.returnProductId) {
                const foundIndex = productsRef.current.findIndex(
                    (p) => p.id === navState.returnProductId,
                );
                if (foundIndex >= 0) {
                    initialIndex = foundIndex;
                }
            } else if (
                typeof navState.returnIndex === 'number' &&
                navState.returnIndex >= 0 &&
                navState.returnIndex < productsRef.current.length
            ) {
                initialIndex = navState.returnIndex;
            }
            initialPaused = Boolean(navState.returnPaused);
        }

        activeIndexRef.current = initialIndex;
        suppressNextSlideTapRef.current = false;
        clearPendingSingleTap();
        pointerStartRef.current = null;
        lastTapRef.current = null;
        commentsOpenProductIdRef.current = null;
        setCommentsOpenProductId(null);
        activeSlidePausedRef.current = initialPaused;
        setActiveIndex(initialIndex);
        setActiveSlidePaused(initialPaused);
        setPlaybackFeedback(null);

        if (initialIndex > 0) {
            // Rola diretamente para o slide restaurado
            window.requestAnimationFrame(() => {
                if (container && container.clientHeight > 0) {
                    container.scrollTop = initialIndex * container.clientHeight;
                }
            });
        } else {
            container.scrollTop = 0;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries
                    .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
                if (!visible) return;

                const index = Number((visible.target as HTMLElement).dataset.index);
                if (Number.isInteger(index)) {
                    activateSlide(index);
                }
            },
            { root: container, threshold: [0.6, 0.75, 0.9] },
        );

        Array.from(container.children).forEach((slide) => observer.observe(slide));
        return () => observer.disconnect();
    }, [hasMenu, productIds, restaurantSlug]);

    function productHasPlayableVideo(productId: string): boolean {
        const targetProduct = productsRef.current.find((item) => item.id === productId);
        const videoUrl = targetProduct?.video?.url ?? null;
        return videoUrl !== null && failedVideoUrlsRef.current[productId] !== videoUrl;
    }

    function triggerPlaybackFeedback(productId: string, mode: 'playing' | 'paused') {
        if (playbackTimerRef.current !== null) {
            window.clearTimeout(playbackTimerRef.current);
        }
        setPlaybackFeedback((prev) => ({
            productId,
            mode,
            key: (prev?.key ?? 0) + 1,
        }));
        playbackTimerRef.current = window.setTimeout(() => {
            setPlaybackFeedback((current) =>
                current?.productId === productId ? null : current,
            );
            playbackTimerRef.current = null;
        }, 680);
    }

    function toggleSlidePlayback(productId: string) {
        const currentActiveProduct = productsRef.current[activeIndexRef.current];
        if (!currentActiveProduct || currentActiveProduct.id !== productId) {
            return;
        }
        if (!productHasPlayableVideo(productId)) {
            return;
        }

        const nextPaused = !activeSlidePausedRef.current;
        activeSlidePausedRef.current = nextPaused;
        setActiveSlidePaused(nextPaused);
        triggerPlaybackFeedback(productId, nextPaused ? 'paused' : 'playing');
    }

    function moveTo(index: number) {
        const container = containerRef.current;
        const target = container?.children.item(index);
        if (!container || !(target instanceof HTMLElement)) return;

        suppressNextSlideTapRef.current = false;
        clearGestureTracking();
        if (index !== activeIndexRef.current && commentsOpenProductIdRef.current !== null) {
            commentsOpenProductIdRef.current = null;
            setCommentsOpenProductId(null);
        }

        const activeElement = document.activeElement;
        if (
            activeElement instanceof HTMLElement &&
            container.contains(activeElement) &&
            activeElement !== container &&
            !target.contains(activeElement)
        ) {
            container.focus({ preventScroll: true });
        }

        const reducedMotion = prefersReducedMotion();
        container.scrollTo({
            top: target.offsetTop,
            behavior: reducedMotion ? 'instant' : 'smooth',
        });
    }

    function handleScreenKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.defaultPrevented) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

        if (
            (event.key === ' ' ||
                event.key === 'Enter' ||
                event.key === 'k' ||
                event.key === 'K') &&
            !isPlaybackKeyIgnoredTarget(event.target)
        ) {
            if (commentsOpenProductIdRef.current !== null) {
                return;
            }
            const currentActiveProduct = productsRef.current[activeIndexRef.current];
            if (currentActiveProduct && productHasPlayableVideo(currentActiveProduct.id)) {
                event.preventDefault();
                toggleSlidePlayback(currentActiveProduct.id);
            }
            return;
        }

        if (isArrowNavigationIgnoredTarget(event.target)) return;

        const direction =
            event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        if (!direction) return;

        event.preventDefault();
        moveTo(Math.max(0, Math.min(products.length - 1, activeIndex + direction)));
    }

    function handleAutoplayBlocked(productId: string) {
        const currentActiveProductId =
            productsRef.current[activeIndexRef.current]?.id ?? null;
        if (!currentActiveProductId || productId !== currentActiveProductId) {
            return;
        }
        activeSlidePausedRef.current = true;
        setActiveSlidePaused(true);
    }

    function handleVideoError(productId: string, videoUrl: string) {
        setFailedVideoUrls((prev) => {
            if (prev[productId] === videoUrl) return prev;
            const next = { ...prev, [productId]: videoUrl };
            failedVideoUrlsRef.current = next;
            return next;
        });
        setPlaybackFeedback((current) =>
            current?.productId === productId ? null : current,
        );
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
        if (suppressNextSlideTapRef.current) {
            suppressNextSlideTapRef.current = false;
            clearGestureTracking();
            return;
        }
        if (commentsOpenProductIdRef.current !== null || isInteractiveTarget(event.target)) {
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

    function handleSlidePointerMove(event: PointerEvent<HTMLElement>) {
        const start = pointerStartRef.current;
        if (!start || start.pointerId !== event.pointerId) return;

        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        if (dx > 14 || dy > 14) {
            clearGestureTracking();
        }
    }

    function handleSlidePointerUp(
        productId: string,
        hasPlayableVideo: boolean,
        event: PointerEvent<HTMLElement>,
    ) {
        if (suppressNextSlideTapRef.current) {
            suppressNextSlideTapRef.current = false;
            clearGestureTracking();
            return;
        }
        if (commentsOpenProductIdRef.current !== null) {
            clearGestureTracking();
            return;
        }

        const start = pointerStartRef.current;
        pointerStartRef.current = null;

        if (!start || start.pointerId !== event.pointerId || start.productId !== productId) {
            return;
        }
        if (isInteractiveTarget(event.target)) {
            clearGestureTracking();
            return;
        }

        const now = performance.now();
        const duration = now - start.time;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);

        // Ignora toque longo, arraste ou swipe de navegação vertical/horizontal
        if (duration > 260 || dx > 14 || dy > 14) {
            clearGestureTracking();
            return;
        }

        const prevTap = lastTapRef.current;
        if (
            prevTap &&
            prevTap.productId === productId &&
            now - prevTap.time <= DOUBLE_TAP_DELAY_MS &&
            Math.hypot(event.clientX - prevTap.x, event.clientY - prevTap.y) <= 40
        ) {
            clearPendingSingleTap();
            lastTapRef.current = null;
            handleDoubleTapLike(productId);
            return;
        }

        clearPendingSingleTap();
        lastTapRef.current = {
            productId,
            x: event.clientX,
            y: event.clientY,
            time: now,
        };

        if (hasPlayableVideo) {
            singleTapTimerRef.current = window.setTimeout(() => {
                singleTapTimerRef.current = null;
                lastTapRef.current = null;
                toggleSlidePlayback(productId);
            }, DOUBLE_TAP_DELAY_MS);
        }
    }

    function handleSlidePointerCancel() {
        suppressNextSlideTapRef.current = false;
        clearGestureTracking();
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

    const activeProduct = products[activeIndex] ?? null;
    const activeCommentsProductId =
        activeProduct && commentsOpenProductId === activeProduct.id
            ? activeProduct.id
            : null;

    return (
        <section
            ref={screenRef}
            className="explore-screen"
            aria-label="Explorar os produtos"
            onKeyDown={handleScreenKeyDown}
        >
            {/* Barrinhas de status / progresso estilo Reels e Stories do Instagram / WhatsApp */}
            <div
                className="explore-reels-progress"
                role="group"
                aria-label={`Progresso dos pratos: ${activeIndex + 1} de ${products.length}`}
            >
                {products.map((p, i) => (
                    <button
                        key={p.id}
                        type="button"
                        className="explore-progress-seg"
                        onClick={() => moveTo(i)}
                        aria-label={`Ir para ${p.name} (prato ${i + 1} de ${products.length})`}
                        aria-current={i === activeIndex ? 'step' : undefined}
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
                onScroll={handleFeedScroll}
            >
                {products.map((product, index) => {
                    const isLiked = isProductLiked(product.id);
                    const isLikePending = isProductLikePending(product.id);
                    const currentLikes = getProductLikesCount(product.id);
                    const currentComments = getProductCommentsCount(product.id);
                    const isCommentsOpenForSlide =
                        index === activeIndex && commentsOpenProductId === product.id;
                    const showBurst = burstProductId === product.id;
                    const videoUrl = product.video?.url ?? null;
                    const hasPlayableVideo =
                        videoUrl !== null && failedVideoUrls[product.id] !== videoUrl;
                    const isSlidePaused =
                        index === activeIndex
                            ? activeSlidePaused || isCommentsOpenForSlide
                            : true;
                    const showPlaybackFeedback =
                        hasPlayableVideo &&
                        playbackFeedback !== null &&
                        playbackFeedback.productId === product.id;

                    return (
                        <article
                            key={product.id}
                            data-index={index}
                            className="explore-slide"
                            aria-label={`${product.name}, produto ${index + 1} de ${products.length}`}
                            onPointerDown={(event) => handleSlidePointerDown(product.id, event)}
                            onPointerMove={handleSlidePointerMove}
                            onPointerUp={(event) =>
                                handleSlidePointerUp(product.id, hasPlayableVideo, event)
                            }
                            onPointerCancel={handleSlidePointerCancel}
                        >
                            {/* Mídia de Fundo */}
                            <ExploreMedia
                                key={product.id}
                                product={product}
                                active={index === activeIndex}
                                nearby={Math.abs(index - activeIndex) === 1}
                                paused={isSlidePaused}
                                onAutoplayBlocked={handleAutoplayBlocked}
                                onVideoError={handleVideoError}
                            />

                            {/* Sombreamento Superior e Inferior para legibilidade */}
                            <div className="explore-shade" aria-hidden="true" />

                            {/* Feedback visual discreto de Play/Pausa por toque simples */}
                            {showPlaybackFeedback && playbackFeedback && (
                                <div
                                    key={playbackFeedback.key}
                                    className="explore-playback-burst"
                                    aria-hidden="true"
                                >
                                    <div className="explore-playback-badge">
                                        {playbackFeedback.mode === 'paused' ? (
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                                className="explore-playback-icon-pause"
                                            >
                                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                                            </svg>
                                        ) : (
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                                className="explore-playback-icon-play"
                                            >
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        )}
                                    </div>
                                </div>
                            )}

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

                                    {/* Botão Comentários */}
                                    <button
                                        ref={(node) => {
                                            commentButtonRefs.current[product.id] = node;
                                        }}
                                        type="button"
                                        className={`explore-action-item explore-comment-btn ${isCommentsOpenForSlide ? 'active' : ''}`}
                                        onClick={() => toggleCommentsPopover(product.id)}
                                        aria-label={
                                            isCommentsOpenForSlide
                                                ? `Fechar comentários de ${product.name} (${currentComments} comentários)`
                                                : `Ver comentários de ${product.name} (${currentComments} comentários)`
                                        }
                                        aria-expanded={isCommentsOpenForSlide}
                                        aria-haspopup="dialog"
                                    >
                                        <div className="explore-action-icon">
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M12 3C6.48 3 2 6.58 2 11c0 2.54 1.48 4.8 3.8 6.26L4.5 21l4.38-1.95c1 .23 2.04.35 3.12.35 5.52 0 10-3.58 10-8.4S17.52 3 12 3z" />
                                            </svg>
                                        </div>
                                        <span className="explore-action-label">{formatLikes(currentComments)}</span>
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
                                    onClick={() => {
                                        setActionsMenuOpen((prev) => {
                                            const next = !prev;
                                            if (!next) {
                                                closeCommentsPopover();
                                            }
                                            return next;
                                        });
                                    }}
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

            {activeProduct && (
                <ProductCommentsPopover
                    productId={activeProduct.id}
                    productName={activeProduct.name}
                    restaurantSlug={restaurantSlug}
                    open={activeCommentsProductId === activeProduct.id}
                    onClose={closeCommentsPopover}
                    onOpenFullPage={() => {
                        saveExploreNavigationState(restaurantSlug, {
                            fromExplore: true,
                            returnIndex: activeIndex,
                            returnProductId: activeProduct.id,
                            returnPaused: activeSlidePausedRef.current,
                        });
                        closeCommentsPopover();
                        navigate(`/${restaurantSlug}/produto/${activeProduct.id}/comentarios${tableQuery}`, {
                            state: {
                                fromExplore: true,
                                returnIndex: activeIndex,
                                returnProductId: activeProduct.id,
                                returnPaused: activeSlidePausedRef.current,
                            },
                        });
                    }}
                    anchorEl={commentButtonRefs.current[activeProduct.id] ?? null}
                    boundaryRef={screenRef}
                    draft={
                        commentDrafts[activeProduct.id] ??
                        getSavedProductCommentDraft(activeProduct.id, restaurantSlug)
                    }
                    onDraftChange={handleCommentDraftChange}
                />
            )}

            <span className="sr-only" role="status" aria-live="polite">
                Produto {activeIndex + 1} de {products.length}
            </span>
        </section>
    );
}
