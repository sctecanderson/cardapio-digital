import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { usePublicMenu } from '../menu/PublicMenuProvider';
import type {
  ProductCommentsCursor,
  PublicProductComment,
} from '../../types/menu';
import {
  getMyProductCommentLikes,
  toggleProductCommentLike,
} from '../menu/publicMenu';

export interface ProductCommentDraft {
  authorName: string;
  body: string;
}

export type ProductCommentsCloseReason = 'escape' | 'close-button' | 'outside';

// Armazena rascunhos isolados por (restaurante + produto) durante a sessão de navegação,
// preservando nome e mensagem ao fechar/reabrir o balão ou alternar entre pratos.
const sessionDraftsByKey = new Map<string, ProductCommentDraft>();

function makeDraftKey(restaurantSlug: string | undefined, productId: string): string {
  const cleanRestaurant = (restaurantSlug ?? '').trim().toLowerCase() || '_default_';
  return `${cleanRestaurant}::${productId.trim()}`;
}

export function getSavedProductCommentDraft(
  productId: string,
  restaurantSlug?: string,
): ProductCommentDraft {
  if (!productId) {
    return { authorName: '', body: '' };
  }
  const existing = sessionDraftsByKey.get(makeDraftKey(restaurantSlug, productId));
  if (!existing) {
    return { authorName: '', body: '' };
  }
  return {
    authorName: existing.authorName,
    body: existing.body,
  };
}

export function saveProductCommentDraft(
  productId: string,
  draft: ProductCommentDraft,
  restaurantSlug?: string,
): void {
  if (!productId) return;
  const key = makeDraftKey(restaurantSlug, productId);
  if (!draft.authorName && !draft.body) {
    sessionDraftsByKey.delete(key);
    return;
  }
  sessionDraftsByKey.set(key, {
    authorName: draft.authorName,
    body: draft.body,
  });
}

function formatCommentCount(count: number): string {
  const safe = Math.max(0, count);
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(1)}k`;
  }
  return String(safe);
}

const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
});

export function formatRelativeCommentDate(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 45) {
    return 'agora há pouco';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `há ${diffMinutes} min`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `há ${diffHours} h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'ontem';
  }
  if (diffDays < 7) {
    return `há ${diffDays} dias`;
  }
  return shortDateFormatter.format(new Date(timestamp));
}

type ArrowPlacement = 'right' | 'top' | 'bottom' | 'none';

interface PopoverGeometry {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  arrowPlacement: ArrowPlacement;
  arrowOffsetPx: number;
}

const VIEWPORT_MARGIN = 10;
const TOP_SAFE_MARGIN = 48;
const ANCHOR_GAP = 10;
const DEFAULT_POPOVER_WIDTH = 296;
const MIN_POPOVER_WIDTH = 216;
const MAX_POPOVER_HEIGHT = 376;
const MIN_POPOVER_HEIGHT = 224;

function computePopoverGeometry(
  anchorEl: HTMLElement | null,
  containerEl: HTMLElement | null,
  popoverEl: HTMLElement | null,
  preferredPlacement: 'left-below' | 'below-end',
): PopoverGeometry | null {
  if (typeof window === 'undefined' || !anchorEl) {
    return null;
  }

  const anchorRect = anchorEl.getBoundingClientRect();
  if (anchorRect.width === 0 && anchorRect.height === 0) {
    return null;
  }

  const visualVp = window.visualViewport;
  const viewportHeight = visualVp ? visualVp.height : window.innerHeight;
  const viewportWidth = visualVp ? visualVp.width : window.innerWidth;

  const rawBounds = containerEl
    ? containerEl.getBoundingClientRect()
    : {
        top: 0,
        left: 0,
        right: viewportWidth,
        bottom: viewportHeight,
        width: viewportWidth,
        height: viewportHeight,
      };

  const visibleBottom = Math.min(rawBounds.bottom, viewportHeight);
  const effectiveBoundsHeight = Math.max(
    MIN_POPOVER_HEIGHT + VIEWPORT_MARGIN * 2,
    visibleBottom - rawBounds.top,
  );

  const availableLeftSpace = anchorRect.left - rawBounds.left - VIEWPORT_MARGIN - ANCHOR_GAP;
  const canPlaceLeft =
    preferredPlacement === 'left-below' && availableLeftSpace >= MIN_POPOVER_WIDTH;

  if (canPlaceLeft) {
    const width = Math.min(DEFAULT_POPOVER_WIDTH, Math.floor(availableLeftSpace));
    const maxAllowedHeight = Math.max(
      MIN_POPOVER_HEIGHT,
      Math.min(
        MAX_POPOVER_HEIGHT,
        Math.floor(effectiveBoundsHeight - TOP_SAFE_MARGIN - VIEWPORT_MARGIN),
      ),
    );

    const renderedHeight = popoverEl
      ? Math.min(popoverEl.offsetHeight || maxAllowedHeight, maxAllowedHeight)
      : Math.min(310, maxAllowedHeight);

    const anchorCenterY = anchorRect.top - rawBounds.top + anchorRect.height / 2;
    // Abre à esquerda e levemente abaixo do botão de comentários, mantendo a pontinha
    // triangular apontada diretamente para o centro do ícone acionador.
    const desiredTop = anchorCenterY - 28;
    const minTop = Math.min(TOP_SAFE_MARGIN, Math.max(VIEWPORT_MARGIN, effectiveBoundsHeight - renderedHeight - VIEWPORT_MARGIN));
    const maxTop = Math.max(
      minTop,
      effectiveBoundsHeight - renderedHeight - VIEWPORT_MARGIN,
    );
    const clampedTop = Math.min(Math.max(desiredTop, minTop), maxTop);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.floor(anchorRect.left - rawBounds.left - width - ANCHOR_GAP),
    );
    const arrowOffsetPx = Math.min(
      Math.max(Math.round(anchorCenterY - clampedTop), 20),
      Math.max(24, renderedHeight - 22),
    );

    return {
      top: Math.round(clampedTop),
      left,
      width,
      maxHeight: maxAllowedHeight,
      arrowPlacement: 'right',
      arrowOffsetPx,
    };
  }

  // Fallback responsivo quando não há espaço lateral suficiente
  const width = Math.min(
    312,
    Math.max(MIN_POPOVER_WIDTH, Math.floor(rawBounds.width - VIEWPORT_MARGIN * 2)),
  );
  const anchorRightRel = anchorRect.right - rawBounds.left;
  const anchorCenterX = anchorRect.left - rawBounds.left + anchorRect.width / 2;
  const desiredLeft = anchorRightRel - width;
  const minLeft = VIEWPORT_MARGIN;
  const maxLeft = Math.max(minLeft, rawBounds.width - width - VIEWPORT_MARGIN);
  const clampedLeft = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
  const arrowOffsetPx = Math.min(
    Math.max(Math.round(anchorCenterX - clampedLeft), 22),
    width - 22,
  );

  const spaceBelow = visibleBottom - anchorRect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchorRect.top - rawBounds.top - ANCHOR_GAP - VIEWPORT_MARGIN;

  if (spaceBelow >= MIN_POPOVER_HEIGHT || spaceBelow >= spaceAbove) {
    const maxHeight = Math.max(
      MIN_POPOVER_HEIGHT,
      Math.min(MAX_POPOVER_HEIGHT, Math.floor(spaceBelow)),
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, Math.round(anchorRect.bottom - rawBounds.top + ANCHOR_GAP)),
      Math.max(VIEWPORT_MARGIN, effectiveBoundsHeight - maxHeight - VIEWPORT_MARGIN),
    );
    return {
      top,
      left: Math.round(clampedLeft),
      width,
      maxHeight,
      arrowPlacement: 'top',
      arrowOffsetPx,
    };
  }

  const maxHeight = Math.max(
    MIN_POPOVER_HEIGHT,
    Math.min(MAX_POPOVER_HEIGHT, Math.floor(spaceAbove)),
  );
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.round(anchorRect.top - rawBounds.top - maxHeight - ANCHOR_GAP),
  );
  return {
    top,
    left: Math.round(clampedLeft),
    width,
    maxHeight,
    arrowPlacement: 'bottom',
    arrowOffsetPx,
  };
}

export interface ProductCommentsPopoverProps {
  restaurantSlug?: string;
  productId: string;
  productName: string;
  open: boolean;
  onClose: (reason?: ProductCommentsCloseReason) => void;
  onOpenFullPage?: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorEl?: HTMLElement | null;
  boundaryRef?: RefObject<HTMLElement | null>;
  preferredPlacement?: 'left-below' | 'below-end';
  draft?: ProductCommentDraft;
  onDraftChange?: (productId: string, draft: ProductCommentDraft) => void;
  onPlaybackHoldChange?: (holding: boolean) => void;
}

export function ProductCommentsPopover({
  restaurantSlug,
  productId,
  productName,
  open,
  onClose,
  onOpenFullPage,
  anchorRef,
  anchorEl,
  boundaryRef,
  preferredPlacement = 'left-below',
  draft: controlledDraft,
  onDraftChange,
  onPlaybackHoldChange,
}: ProductCommentsPopoverProps) {
  const {
    getProductCommentsCount,
    loadProductComments,
    submitProductComment,
    isProductCommentSubmitting,
    commentError,
    clearCommentError,
  } = usePublicMenu();

  const headingId = useId();
  const authorInputId = useId();
  const bodyInputId = useId();
  const feedbackId = useId();

  const popoverRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeProductIdRef = useRef(productId);
  activeProductIdRef.current = productId;

  const [internalDraft, setInternalDraft] = useState<ProductCommentDraft>(() =>
    controlledDraft ?? getSavedProductCommentDraft(productId, restaurantSlug),
  );
  const [comments, setComments] = useState<PublicProductComment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<ProductCommentsCursor | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [localFormError, setLocalFormError] = useState('');
  const [pendingNotice, setPendingNotice] = useState('');
  const [autoApprovedNotice, setAutoApprovedNotice] = useState('');
  const [likedCommentIds, setLikedCommentIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [inFlightCommentLikes, setInFlightCommentLikes] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [geometry, setGeometry] = useState<PopoverGeometry | null>(null);

  const loadSeqRef = useRef(0);
  const inFlightLikesRef = useRef<Set<string>>(new Set());

  const draft = controlledDraft ?? internalDraft;
  const resolvedAnchor = anchorEl ?? anchorRef?.current ?? null;
  const approvedCount = getProductCommentsCount(productId);
  const isSubmitting = isProductCommentSubmitting(productId);

  const returnFocusToAnchor = useCallback(() => {
    const targetAnchor = anchorEl ?? anchorRef?.current ?? null;
    if (targetAnchor && typeof targetAnchor.focus === 'function') {
      targetAnchor.focus({ preventScroll: true });
    }
  }, [anchorEl, anchorRef]);

  const closeWithReason = useCallback(
    (reason: ProductCommentsCloseReason) => {
      onClose(reason);
      if (reason === 'escape' || reason === 'close-button') {
        window.requestAnimationFrame(() => {
          returnFocusToAnchor();
        });
      }
    },
    [onClose, returnFocusToAnchor],
  );

  // Sincroniza rascunho isolado quando o produto ou restaurante ativo muda
  useEffect(() => {
    const saved = getSavedProductCommentDraft(productId, restaurantSlug);
    setInternalDraft(saved);
    setLocalFormError('');
    setPendingNotice('');
    setAutoApprovedNotice('');
    clearCommentError();
  }, [productId, restaurantSlug, clearCommentError]);

  // Notifica opcionalmente o componente pai (ex.: Explorar) para pausar o vídeo enquanto o balão estiver aberto
  useEffect(() => {
    if (!onPlaybackHoldChange) return;
    onPlaybackHoldChange(open);
    return () => {
      if (open) {
        onPlaybackHoldChange(false);
      }
    };
  }, [open, onPlaybackHoldChange]);

  const commitDraft = useCallback(
    (targetProductId: string, nextDraft: ProductCommentDraft) => {
      saveProductCommentDraft(targetProductId, nextDraft, restaurantSlug);
      if (activeProductIdRef.current === targetProductId) {
        setInternalDraft(nextDraft);
      }
      onDraftChange?.(targetProductId, nextDraft);
    },
    [restaurantSlug, onDraftChange],
  );

  const updateDraftField = useCallback(
    (field: keyof ProductCommentDraft, value: string) => {
      const base = controlledDraft ?? getSavedProductCommentDraft(productId, restaurantSlug);
      const next: ProductCommentDraft = {
        ...base,
        [field]: value,
      };
      commitDraft(productId, next);
      if (localFormError) {
        setLocalFormError('');
      }
      if (pendingNotice && field === 'body' && value.trim().length > 0) {
        setPendingNotice('');
      }
      if (autoApprovedNotice && field === 'body' && value.trim().length > 0) {
        setAutoApprovedNotice('');
      }
      if (commentError) {
        clearCommentError();
      }
    },
    [
      controlledDraft,
      productId,
      restaurantSlug,
      commitDraft,
      localFormError,
      pendingNotice,
      autoApprovedNotice,
      commentError,
      clearCommentError,
    ],
  );

  const fetchInitialComments = useCallback(
    async (targetProductId: string) => {
      const seq = ++loadSeqRef.current;
      setLoadingInitial(true);
      setListError('');
      try {
        const page = await loadProductComments(targetProductId, {
          cursor: null,
          limit: 12,
        });
        if (seq !== loadSeqRef.current || activeProductIdRef.current !== targetProductId) {
          return;
        }
        setComments(page.items);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (seq !== loadSeqRef.current || activeProductIdRef.current !== targetProductId) {
          return;
        }
        setListError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível carregar os comentários deste prato.',
        );
      } finally {
        if (seq === loadSeqRef.current && activeProductIdRef.current === targetProductId) {
          setLoadingInitial(false);
        }
      }
    },
    [loadProductComments],
  );

  const handleLoadMore = useCallback(async () => {
    if (loadingInitial || loadingMore || !hasMore || !nextCursor) {
      return;
    }
    const targetProductId = productId;
    const seq = loadSeqRef.current;
    setLoadingMore(true);
    setListError('');
    try {
      const page = await loadProductComments(targetProductId, {
        cursor: nextCursor,
        limit: 12,
      });
      if (seq !== loadSeqRef.current || activeProductIdRef.current !== targetProductId) {
        return;
      }
      setComments((prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        const appended = page.items.filter((item) => !existingIds.has(item.id));
        return [...prev, ...appended];
      });
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (seq !== loadSeqRef.current || activeProductIdRef.current !== targetProductId) {
        return;
      }
      setListError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível carregar mais comentários.',
      );
    } finally {
      if (seq === loadSeqRef.current && activeProductIdRef.current === targetProductId) {
        setLoadingMore(false);
      }
    }
  }, [loadingInitial, loadingMore, hasMore, nextCursor, productId, loadProductComments]);

  // Carrega os comentários aprovados e as curtidas do visitante quando o balão abre ou troca de produto
  useEffect(() => {
    if (!open || !productId) {
      loadSeqRef.current += 1;
      setLoadingInitial(false);
      setLoadingMore(false);
      return;
    }
    setComments([]);
    setHasMore(false);
    setNextCursor(null);
    void fetchInitialComments(productId);

    if (restaurantSlug) {
      void getMyProductCommentLikes(restaurantSlug)
        .then((likedIds) => {
          setLikedCommentIds(new Set(likedIds));
        })
        .catch(() => {
          // Falha silenciosa na hidratação de curtidas de comentários
        });
    }
  }, [open, productId, restaurantSlug, fetchInitialComments]);

  const handleToggleCommentLike = useCallback(
    async (commentId: string) => {
      if (!restaurantSlug || inFlightLikesRef.current.has(commentId)) {
        return;
      }

      const isCurrentlyLiked = likedCommentIds.has(commentId);
      const targetLiked = !isCurrentlyLiked;

      // Lock local para evitar chamadas simultâneas repetidas no mesmo comentário
      inFlightLikesRef.current.add(commentId);
      setInFlightCommentLikes(new Set(inFlightLikesRef.current));

      // Atualização otimista imediata
      setLikedCommentIds((prev) => {
        const next = new Set(prev);
        if (targetLiked) {
          next.add(commentId);
        } else {
          next.delete(commentId);
        }
        return next;
      });

      setComments((prev) =>
        prev.map((c) => {
          if (c.id === commentId) {
            const currentCount = c.likesCount ?? 0;
            const optimisticCount = targetLiked
              ? currentCount + 1
              : Math.max(0, currentCount - 1);
            return { ...c, likesCount: optimisticCount };
          }
          return c;
        }),
      );

      try {
        const result = await toggleProductCommentLike(
          restaurantSlug,
          commentId,
          targetLiked,
        );

        // Confirmação com dados canônicos do banco
        setLikedCommentIds((prev) => {
          const next = new Set(prev);
          if (result.liked) {
            next.add(commentId);
          } else {
            next.delete(commentId);
          }
          return next;
        });

        setComments((prev) =>
          prev.map((c) =>
            c.id === commentId ? { ...c, likesCount: result.likesCount } : c,
          ),
        );
      } catch (cause) {
        // Rollback fiel em caso de erro
        setLikedCommentIds((prev) => {
          const next = new Set(prev);
          if (isCurrentlyLiked) {
            next.add(commentId);
          } else {
            next.delete(commentId);
          }
          return next;
        });

        setComments((prev) =>
          prev.map((c) => {
            if (c.id === commentId) {
              const currentCount = c.likesCount ?? 0;
              const revertedCount = targetLiked
                ? Math.max(0, currentCount - 1)
                : currentCount + 1;
              return { ...c, likesCount: revertedCount };
            }
            return c;
          }),
        );

        setListError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível atualizar a curtida do comentário.',
        );
      } finally {
        inFlightLikesRef.current.delete(commentId);
        setInFlightCommentLikes(new Set(inFlightLikesRef.current));
      }
    },
    [restaurantSlug, likedCommentIds],
  );

  // Calcula e atualiza o posicionamento ancorado sem sair da viewport
  useLayoutEffect(() => {
    if (!open) {
      setGeometry(null);
      return;
    }

    const currentAnchor = anchorEl ?? anchorRef?.current ?? null;
    const currentBoundary = boundaryRef?.current ?? null;

    function recalculate() {
      const nextGeometry = computePopoverGeometry(
        currentAnchor,
        currentBoundary,
        popoverRef.current,
        preferredPlacement,
      );
      setGeometry(nextGeometry);
    }

    recalculate();

    const visualVp = window.visualViewport;
    window.addEventListener('resize', recalculate);
    window.addEventListener('orientationchange', recalculate);
    visualVp?.addEventListener('resize', recalculate);
    visualVp?.addEventListener('scroll', recalculate);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recalculate);
      if (currentBoundary) observer.observe(currentBoundary);
      if (currentAnchor) observer.observe(currentAnchor);
      if (popoverRef.current) observer.observe(popoverRef.current);
    }

    return () => {
      window.removeEventListener('resize', recalculate);
      window.removeEventListener('orientationchange', recalculate);
      visualVp?.removeEventListener('resize', recalculate);
      visualVp?.removeEventListener('scroll', recalculate);
      observer?.disconnect();
    };
  }, [
    open,
    productId,
    anchorEl,
    anchorRef,
    boundaryRef,
    preferredPlacement,
    comments.length,
    loadingInitial,
    pendingNotice,
    localFormError,
    commentError,
  ]);

  // Gerencia foco acessível ao abrir sem provocar rolagem acidental
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Fecha ao clicar fora ou pressionar Escape, sem fechar durante digitação ou interação interna
  useEffect(() => {
    if (!open) return;

    function handleDocumentPointerDown(event: globalThis.PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const popoverElement = popoverRef.current;
      if (popoverElement && popoverElement.contains(target)) {
        return;
      }

      const currentAnchor = anchorEl ?? anchorRef?.current ?? null;
      if (currentAnchor && currentAnchor.contains(target)) {
        return;
      }

      closeWithReason('outside');
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeWithReason('escape');
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleDocumentKeyDown, true);

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [open, closeWithReason, anchorEl, anchorRef]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting) return;

    const cleanAuthor = draft.authorName
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cleanBody = draft.body
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();

    if (cleanAuthor.length < 2 || cleanAuthor.length > 40) {
      setLocalFormError('Informe seu nome com 2 a 40 caracteres.');
      return;
    }

    if (cleanBody.length < 3 || cleanBody.length > 280) {
      setLocalFormError('O comentário deve ter entre 3 e 280 caracteres.');
      return;
    }

    setLocalFormError('');
    setPendingNotice('');
    setAutoApprovedNotice('');
    clearCommentError();

    const targetProductId = productId;
    try {
      const result = await submitProductComment(targetProductId, cleanAuthor, cleanBody);
      // Limpa somente o texto do comentário após confirmação de envio,
      // preservando o nome digitado no rascunho daquele produto.
      const updatedDraft: ProductCommentDraft = {
        authorName: cleanAuthor,
        body: '',
      };
      commitDraft(targetProductId, updatedDraft);

      if (activeProductIdRef.current === targetProductId) {
        if (result.status === 'approved') {
          // Publicação automática: insere o comentário no topo da lista sem duplicar
          setComments((prev) => {
            if (prev.some((c) => c.id === result.id)) return prev;
            const newComment: PublicProductComment = {
              id: result.id,
              productId: result.productId,
              authorName: result.authorName,
              body: result.body,
              createdAt: result.createdAt,
              likesCount: result.likesCount ?? 0,
            };
            return [newComment, ...prev];
          });
          setAutoApprovedNotice('Comentário publicado!');
        } else if (result.status === 'pending') {
          setPendingNotice(
            'Comentário enviado! Ele ficará visível assim que for avaliado pelo restaurante.',
          );
        }
      }
    } catch {
      // O erro já é exposto por commentError no PublicMenuProvider, mantendo o rascunho intacto.
    }
  }

  // Isola completamente os eventos de ponteiro, toque, roda e teclado para não interferir no feed Explorar
  function stopPointerPropagation(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function stopMousePropagation(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function stopTouchPropagation(event: ReactTouchEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function stopWheelPropagation(event: ReactWheelEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handlePopoverKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeWithReason('escape');
      return;
    }
    event.stopPropagation();
  }

  if (!open) {
    return null;
  }

  const effectiveError = localFormError || commentError;
  const trimmedAuthorLength = draft.authorName.trim().length;
  const trimmedBodyLength = draft.body.trim().length;
  const canSubmit =
    !isSubmitting &&
    trimmedAuthorLength >= 2 &&
    trimmedAuthorLength <= 40 &&
    trimmedBodyLength >= 3 &&
    trimmedBodyLength <= 280;

  const arrowPlacement: ArrowPlacement =
    geometry?.arrowPlacement ?? (resolvedAnchor ? 'right' : 'none');

  const inlineStyle: CSSProperties | undefined = geometry
    ? ({
        top: `${geometry.top}px`,
        left: `${geometry.left}px`,
        width: `${geometry.width}px`,
        maxHeight: `${geometry.maxHeight}px`,
        '--popover-arrow-offset': `${geometry.arrowOffsetPx}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-label={`Comentários sobre ${productName}`}
      data-arrow={arrowPlacement}
      className={`product-comments-popover ${geometry ? 'is-positioned' : 'is-fallback-position'}`}
      style={inlineStyle}
      onPointerDown={stopPointerPropagation}
      onPointerMove={stopPointerPropagation}
      onPointerUp={stopPointerPropagation}
      onPointerCancel={stopPointerPropagation}
      onClick={stopMousePropagation}
      onDoubleClick={stopMousePropagation}
      onTouchStart={stopTouchPropagation}
      onTouchMove={stopTouchPropagation}
      onTouchEnd={stopTouchPropagation}
      onWheel={stopWheelPropagation}
      onKeyDown={handlePopoverKeyDown}
    >
      {arrowPlacement !== 'none' && (
        <span
          className={`product-comments-popover-arrow arrow-${arrowPlacement}`}
          aria-hidden="true"
        />
      )}

      {/* 1. Cabeçalho discreto */}
      <header className="product-comments-header">
        <div className="product-comments-title-group">
          <h3 id={headingId} className="product-comments-title">
            Comentários
          </h3>
          <span
            className="product-comments-count-pill"
            aria-label={`${approvedCount} ${approvedCount === 1 ? 'comentário aprovado' : 'comentários aprovados'}`}
          >
            {formatCommentCount(approvedCount)}
          </span>
        </div>

        <div className="product-comments-header-actions">
          {onOpenFullPage && (
            <button
              type="button"
              className="product-comments-view-all-btn"
              onClick={() => {
                onOpenFullPage();
              }}
              aria-label="Ver todos os comentários em tela cheia"
            >
              <span>Ver todos</span>
              <span aria-hidden="true">↗</span>
            </button>
          )}

          <button
            ref={closeButtonRef}
            type="button"
            className="product-comments-close-btn"
            onClick={() => closeWithReason('close-button')}
            aria-label="Fechar comentários"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      {/* 2. Lista de comentários aprovados com scroll interno exclusivo */}
      <div className="product-comments-list" role="region" aria-label="Lista de comentários aprovados">
        {loadingInitial ? (
          <div className="product-comments-state" role="status" aria-live="polite">
            <span className="product-comments-spinner" aria-hidden="true" />
            <span>Carregando comentários…</span>
          </div>
        ) : listError && comments.length === 0 ? (
          <div className="product-comments-state is-error" role="alert">
            <p>{listError}</p>
            <button
              type="button"
              className="product-comments-retry-btn"
              onClick={() => {
                void fetchInitialComments(productId);
              }}
            >
              Tentar novamente
            </button>
          </div>
        ) : comments.length === 0 ? (
          <div className="product-comments-empty" role="status">
            <p className="product-comments-empty-title">Nenhum comentário ainda</p>
            <p className="product-comments-empty-sub">
              Experimentou {productName}? Conte o que achou.
            </p>
          </div>
        ) : (
          <>
            <ul className="product-comments-items">
              {comments.map((comment) => (
                <li key={comment.id} className="product-comments-item">
                  <div className="product-comments-item-meta">
                    <strong className="product-comments-item-author">
                      {comment.authorName}
                    </strong>
                    <time
                      dateTime={comment.createdAt}
                      className="product-comments-item-date"
                    >
                      {formatRelativeCommentDate(comment.createdAt)}
                    </time>
                  </div>
                  <p className="product-comments-item-body">{comment.body}</p>
                  <div className="product-comments-item-footer">
                    <button
                      type="button"
                      className={`product-comment-like-btn ${likedCommentIds.has(comment.id) ? 'is-liked' : ''}`}
                      disabled={inFlightCommentLikes.has(comment.id)}
                      onClick={() => void handleToggleCommentLike(comment.id)}
                      aria-label={`${likedCommentIds.has(comment.id) ? 'Remover curtida do comentário' : 'Curtir comentário'}. Total: ${comment.likesCount ?? 0}`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill={likedCommentIds.has(comment.id) ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth={likedCommentIds.has(comment.id) ? '0' : '2'}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="product-comment-like-icon"
                        aria-hidden="true"
                      >
                        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                      </svg>
                      <span className="product-comment-like-count">
                        {(comment.likesCount ?? 0) > 0 ? comment.likesCount : ''}
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {listError && (
              <div className="product-comments-inline-error" role="alert">
                <span>{listError}</span>
                <button
                  type="button"
                  className="product-comments-retry-btn"
                  onClick={() => {
                    void handleLoadMore();
                  }}
                >
                  Tentar novamente
                </button>
              </div>
            )}

            {hasMore && nextCursor && (
              <div className="product-comments-more-wrap">
                <button
                  type="button"
                  className="product-comments-more-btn"
                  onClick={() => {
                    void handleLoadMore();
                  }}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Carregando…' : 'Carregar mais'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 3. Formulário compacto de novo comentário */}
      <form className="product-comments-form" onSubmit={handleSubmit} noValidate>
        {autoApprovedNotice && (
          <div
            id={feedbackId}
            className="product-comments-feedback is-approved"
            role="status"
            aria-live="polite"
          >
            <span>{autoApprovedNotice}</span>
            <button
              type="button"
              className="product-comments-feedback-dismiss"
              onClick={() => setAutoApprovedNotice('')}
              aria-label="Fechar confirmação de comentário publicado"
            >
              ×
            </button>
          </div>
        )}

        {pendingNotice && (
          <div
            id={feedbackId}
            className="product-comments-feedback is-pending-moderation"
            role="status"
            aria-live="polite"
          >
            <span>{pendingNotice}</span>
            <button
              type="button"
              className="product-comments-feedback-dismiss"
              onClick={() => setPendingNotice('')}
              aria-label="Fechar aviso de comentário enviado"
            >
              ×
            </button>
          </div>
        )}

        {effectiveError && (
          <div
            id={feedbackId}
            className="product-comments-feedback is-error"
            role="alert"
          >
            <span>{effectiveError}</span>
            <button
              type="button"
              className="product-comments-feedback-dismiss"
              onClick={() => {
                setLocalFormError('');
                clearCommentError();
              }}
              aria-label="Fechar aviso de erro"
            >
              ×
            </button>
          </div>
        )}

        <div className="product-comments-field-row">
          <label htmlFor={authorInputId} className="sr-only">
            Seu nome
          </label>
          <input
            id={authorInputId}
            type="text"
            className="product-comments-name-input"
            placeholder="Seu nome"
            maxLength={40}
            autoComplete="name"
            value={draft.authorName}
            disabled={isSubmitting}
            onChange={(event) => updateDraftField('authorName', event.target.value)}
          />
        </div>

        <div className="product-comments-compose-row">
          <label htmlFor={bodyInputId} className="sr-only">
            Seu comentário
          </label>
          <textarea
            id={bodyInputId}
            rows={2}
            className="product-comments-body-input"
            placeholder="Escreva um comentário…"
            maxLength={280}
            value={draft.body}
            disabled={isSubmitting}
            aria-describedby={effectiveError || pendingNotice ? feedbackId : undefined}
            onChange={(event) => updateDraftField('body', event.target.value)}
          />

          <div className="product-comments-compose-footer">
            <span
              className={`product-comments-char-counter ${draft.body.length >= 260 ? 'is-near-limit' : ''}`}
              aria-live="off"
            >
              {draft.body.length}/280
            </span>

            <button
              type="submit"
              className="product-comments-submit-btn"
              disabled={!canSubmit}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
