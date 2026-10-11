import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { supabase } from '../../lib/supabase';
import type {
  CreatedProductCommentResult,
  ProductCommentsCursor,
  PublicProductCommentsPage,
  RestaurantMenu,
} from '../../types/menu';
import {
  createProductComment as executeCreateProductComment,
  getMyProductLikes,
  getPublicMenu,
  getPublicProductComments as executeGetPublicProductComments,
  toggleProductLike as executeToggleProductLike,
} from './publicMenu';

interface InFlightLikeMutation {
  requestId: number;
  optimisticLiked: boolean;
  optimisticCount: number;
  snapshotLiked: boolean;
  fallbackServerCount: number;
}

interface ConfirmedProductLikeState {
  liked: boolean;
  likesCount: number;
  confirmSeq: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export interface CatalogContext {
  menu: RestaurantMenu | null;
  loading: boolean;
  error: string;
  reload: () => void;
  likedProductIds: ReadonlySet<string>;
  pendingLikeProductIds: ReadonlySet<string>;
  isProductLiked: (productId: string) => boolean;
  isProductLikePending: (productId: string) => boolean;
  getProductLikesCount: (productId: string) => number;
  likeError: string;
  clearLikeError: () => void;
  likeProduct: (productId: string) => Promise<boolean>;
  unlikeProduct: (productId: string) => Promise<boolean>;
  toggleProductLike: (productId: string) => Promise<boolean>;
  pendingCommentProductIds: ReadonlySet<string>;
  isProductCommentSubmitting: (productId: string) => boolean;
  getProductCommentsCount: (productId: string) => number;
  commentError: string;
  clearCommentError: () => void;
  loadProductComments: (
    productId: string,
    options?: { cursor?: ProductCommentsCursor | null; limit?: number },
  ) => Promise<PublicProductCommentsPage>;
  submitProductComment: (
    productId: string,
    authorName: string,
    body: string,
  ) => Promise<CreatedProductCommentResult>;
}

const MenuContext = createContext<CatalogContext | null>(null);

function mergeMenuWithLikesState(
  serverMenu: RestaurantMenu,
  inFlightMap: ReadonlyMap<string, InFlightLikeMutation>,
  confirmedMap: Map<string, ConfirmedProductLikeState>,
  loadStartMutationSeq: number,
): RestaurantMenu {
  return {
    ...serverMenu,
    products: serverMenu.products.map((product) => {
      const serverCount = Math.max(0, product.likesCount ?? 0);
      const safeCommentsCount = Math.max(0, product.commentsCount ?? 0);
      const confirmed = confirmedMap.get(product.id);
      const effectiveServerCount =
        confirmed && confirmed.confirmSeq > loadStartMutationSeq
          ? confirmed.likesCount
          : serverCount;

      if (confirmed && confirmed.confirmSeq <= loadStartMutationSeq) {
        confirmedMap.delete(product.id);
      }

      const inFlight = inFlightMap.get(product.id);
      if (inFlight) {
        inFlight.fallbackServerCount = effectiveServerCount;
        return {
          ...product,
          likesCount: Math.max(0, inFlight.optimisticCount),
          commentsCount: safeCommentsCount,
        };
      }
      return {
        ...product,
        likesCount: Math.max(0, effectiveServerCount),
        commentsCount: safeCommentsCount,
      };
    }),
  };
}

export function PublicMenuProvider({ restaurantSlug, children }: {
  restaurantSlug: string;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<RestaurantMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [likedProductIds, setLikedProductIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [pendingLikeProductIds, setPendingLikeProductIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [likeError, setLikeError] = useState('');
  const [pendingCommentProductIds, setPendingCommentProductIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [commentError, setCommentError] = useState('');

  const menuRef = useRef<RestaurantMenu | null>(null);
  const likedProductIdsRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const inFlightByProductRef = useRef<Map<string, InFlightLikeMutation>>(new Map());
  const confirmedLikesByProductRef = useRef<Map<string, ConfirmedProductLikeState>>(new Map());
  const inFlightCommentByProductRef = useRef<Set<string>>(new Set());
  const disposedRef = useRef(false);
  const contextEpochRef = useRef(0);
  const requestSeqRef = useRef(0);
  const mutationConfirmSeqRef = useRef(0);
  const myLikesSeqRef = useRef(0);
  const activeAnonUserIdRef = useRef<string | null>(null);

  const updateMenuState = useCallback((updater: (prev: RestaurantMenu | null) => RestaurantMenu | null) => {
    setMenu((prev) => {
      const next = updater(prev);
      menuRef.current = next;
      return next;
    });
  }, []);

  const updateLikedProductIds = useCallback((next: ReadonlySet<string>) => {
    likedProductIdsRef.current = next;
    setLikedProductIds(next);
  }, []);

  const syncPendingSet = useCallback(() => {
    const keys = Array.from(inFlightByProductRef.current.keys());
    setPendingLikeProductIds(keys.length === 0 ? EMPTY_SET : new Set(keys));
  }, []);

  const syncPendingCommentsSet = useCallback(() => {
    const keys = Array.from(inFlightCommentByProductRef.current.values());
    setPendingCommentProductIds(keys.length === 0 ? EMPTY_SET : new Set(keys));
  }, []);

  const loadMyLikes = useCallback(async (slug: string, epoch: number) => {
    const seq = ++myLikesSeqRef.current;
    const loadStartMutationSeq = mutationConfirmSeqRef.current;
    try {
      const ids = await getMyProductLikes(slug);
      if (disposedRef.current || epoch !== contextEpochRef.current || seq !== myLikesSeqRef.current) {
        return;
      }
      const nextSet = new Set(ids);

      // Preserva confirmações de curtidas concluídas depois que esta leitura iniciou
      for (const [productId, confirmed] of confirmedLikesByProductRef.current.entries()) {
        if (confirmed.confirmSeq > loadStartMutationSeq) {
          if (confirmed.liked) {
            nextSet.add(productId);
          } else {
            nextSet.delete(productId);
          }
        }
      }

      // Preserva o estado otimista de produtos com mutação ainda em voo
      for (const [productId, inFlight] of inFlightByProductRef.current.entries()) {
        const confirmed = confirmedLikesByProductRef.current.get(productId);
        inFlight.snapshotLiked =
          confirmed && confirmed.confirmSeq > loadStartMutationSeq
            ? confirmed.liked
            : ids.includes(productId);
        if (inFlight.optimisticLiked) {
          nextSet.add(productId);
        } else {
          nextSet.delete(productId);
        }
      }
      updateLikedProductIds(nextSet.size === 0 ? EMPTY_SET : nextSet);
    } catch {
      // Falha silenciosa na hidratação secundária não bloqueia a leitura do cardápio
    }
  }, [updateLikedProductIds]);

  useEffect(() => {
    disposedRef.current = false;
    const epoch = ++contextEpochRef.current;
    inFlightByProductRef.current.clear();
    confirmedLikesByProductRef.current.clear();
    inFlightCommentByProductRef.current.clear();
    syncPendingSet();
    syncPendingCommentsSet();
    updateLikedProductIds(EMPTY_SET);
    setLikeError('');
    setCommentError('');

    let pendingCatalog = false;

    async function loadCatalog() {
      if (disposedRef.current || pendingCatalog || epoch !== contextEpochRef.current) return;
      pendingCatalog = true;
      const loadStartMutationSeq = mutationConfirmSeqRef.current;
      try {
        const result = await getPublicMenu(restaurantSlug);
        if (!disposedRef.current && epoch === contextEpochRef.current) {
          const merged = mergeMenuWithLikesState(
            result,
            inFlightByProductRef.current,
            confirmedLikesByProductRef.current,
            loadStartMutationSeq,
          );
          menuRef.current = merged;
          setMenu(merged);
          setError('');
        }
      } catch (cause) {
        if (!disposedRef.current && epoch === contextEpochRef.current) {
          // Uma falha nunca ativa o catálogo local nem seus preços antigos.
          menuRef.current = null;
          setMenu(null);
          setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o cardápio.');
        }
      } finally {
        pendingCatalog = false;
        if (!disposedRef.current && epoch === contextEpochRef.current) {
          setLoading(false);
        }
      }
    }

    function refreshVisible() {
      if (!document.hidden && !disposedRef.current && epoch === contextEpochRef.current) {
        void loadCatalog();
        void loadMyLikes(restaurantSlug, contextEpochRef.current);
      }
    }

    setLoading(true);
    void loadCatalog();
    void loadMyLikes(restaurantSlug, epoch);

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (disposedRef.current) return;
      const nextAnonUserId = session?.user?.is_anonymous ? session.user.id : null;
      const prevAnonUserId = activeAnonUserIdRef.current;
      activeAnonUserIdRef.current = nextAnonUserId;

      if (prevAnonUserId !== null && prevAnonUserId !== nextAnonUserId) {
        // Troca de usuário ou encerramento de sessão anônima: invalida requisições em voo e limpa estado pessoal
        const nextEpoch = ++contextEpochRef.current;
        inFlightByProductRef.current.clear();
        confirmedLikesByProductRef.current.clear();
        inFlightCommentByProductRef.current.clear();
        syncPendingSet();
        syncPendingCommentsSet();
        updateLikedProductIds(EMPTY_SET);
        setLikeError('');
        setCommentError('');
        if (nextAnonUserId !== null) {
          void loadMyLikes(restaurantSlug, nextEpoch);
        }
        void loadCatalog();
      } else if (prevAnonUserId === null && nextAnonUserId !== null) {
        // Sessão anônima recém-iniciada ou restaurada: se não houver mutação em voo que acabou de criar a sessão, hidrata
        if (inFlightByProductRef.current.size === 0 && inFlightCommentByProductRef.current.size === 0) {
          void loadMyLikes(restaurantSlug, contextEpochRef.current);
        }
      }
    });

    // Compartilhado entre as telas públicas. Não carrega mídia, apenas metadados.
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('online', refreshVisible);

    return () => {
      disposedRef.current = true;
      contextEpochRef.current += 1;
      inFlightByProductRef.current.clear();
      confirmedLikesByProductRef.current.clear();
      inFlightCommentByProductRef.current.clear();
      authListener.subscription.unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [restaurantSlug, refresh, loadMyLikes, syncPendingSet, syncPendingCommentsSet, updateLikedProductIds]);

  const applyProductLike = useCallback(async (productId: string, desiredLiked: boolean): Promise<boolean> => {
    const currentMenu = menuRef.current;
    const targetProduct = currentMenu?.products.find((item) => item.id === productId);
    const currentLiked = likedProductIdsRef.current.has(productId);

    if (!targetProduct || !targetProduct.available) {
      setLikeError('Este produto está temporariamente indisponível para interações.');
      return currentLiked;
    }

    // Se já houver requisição pendente para este produto, ignora cliques repetidos
    const existingInFlight = inFlightByProductRef.current.get(productId);
    if (existingInFlight) {
      return existingInFlight.optimisticLiked;
    }

    // Operação idempotente: se o estado atual já corresponde ao desejado, não dispara RPC nem throttle
    if (currentLiked === desiredLiked) {
      setLikeError('');
      return currentLiked;
    }

    const prevCount = Math.max(0, targetProduct.likesCount ?? 0);
    const optimisticCount = Math.max(0, prevCount + (desiredLiked ? 1 : -1));
    const requestId = ++requestSeqRef.current;
    const epoch = contextEpochRef.current;

    inFlightByProductRef.current.set(productId, {
      requestId,
      optimisticLiked: desiredLiked,
      optimisticCount,
      snapshotLiked: currentLiked,
      fallbackServerCount: prevCount,
    });
    syncPendingSet();
    setLikeError('');

    const optimisticSet = new Set(likedProductIdsRef.current);
    if (desiredLiked) {
      optimisticSet.add(productId);
    } else {
      optimisticSet.delete(productId);
    }
    updateLikedProductIds(optimisticSet.size === 0 ? EMPTY_SET : optimisticSet);

    updateMenuState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        products: prev.products.map((item) =>
          item.id === productId ? { ...item, likesCount: optimisticCount } : item,
        ),
      };
    });

    try {
      const canonical = await executeToggleProductLike(restaurantSlug, productId, desiredLiked);

      if (disposedRef.current || epoch !== contextEpochRef.current) {
        return canonical.liked;
      }

      const activeInFlight = inFlightByProductRef.current.get(productId);
      if (!activeInFlight || activeInFlight.requestId !== requestId) {
        return canonical.liked;
      }

      const safeCanonicalCount = Math.max(0, canonical.likesCount);
      const confirmSeq = ++mutationConfirmSeqRef.current;
      confirmedLikesByProductRef.current.set(productId, {
        liked: canonical.liked,
        likesCount: safeCanonicalCount,
        confirmSeq,
      });

      inFlightByProductRef.current.delete(productId);
      syncPendingSet();

      const nextSet = new Set(likedProductIdsRef.current);
      if (canonical.liked) {
        nextSet.add(productId);
      } else {
        nextSet.delete(productId);
      }
      updateLikedProductIds(nextSet.size === 0 ? EMPTY_SET : nextSet);

      updateMenuState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          products: prev.products.map((item) =>
            item.id === productId ? { ...item, likesCount: safeCanonicalCount } : item,
          ),
        };
      });

      return canonical.liked;
    } catch (cause) {
      if (disposedRef.current || epoch !== contextEpochRef.current) {
        return currentLiked;
      }

      const activeInFlight = inFlightByProductRef.current.get(productId);
      if (activeInFlight && activeInFlight.requestId === requestId) {
        inFlightByProductRef.current.delete(productId);
        syncPendingSet();

        const rollbackSet = new Set(likedProductIdsRef.current);
        if (activeInFlight.snapshotLiked) {
          rollbackSet.add(productId);
        } else {
          rollbackSet.delete(productId);
        }
        updateLikedProductIds(rollbackSet.size === 0 ? EMPTY_SET : rollbackSet);

        const rollbackCount = Math.max(0, activeInFlight.fallbackServerCount);
        updateMenuState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            products: prev.products.map((item) =>
              item.id === productId ? { ...item, likesCount: rollbackCount } : item,
            ),
          };
        });
      }

      setLikeError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível atualizar sua curtida. Tente novamente.',
      );

      return activeInFlight ? activeInFlight.snapshotLiked : currentLiked;
    }
  }, [restaurantSlug, syncPendingSet, updateLikedProductIds, updateMenuState]);

  const isProductLiked = useCallback(
    (productId: string) => likedProductIds.has(productId),
    [likedProductIds],
  );

  const isProductLikePending = useCallback(
    (productId: string) => pendingLikeProductIds.has(productId),
    [pendingLikeProductIds],
  );

  const getProductLikesCount = useCallback(
    (productId: string) => {
      const product = menu?.products.find((item) => item.id === productId);
      return Math.max(0, product?.likesCount ?? 0);
    },
    [menu],
  );

  const clearLikeError = useCallback(() => {
    setLikeError('');
  }, []);

  const likeProduct = useCallback(
    (productId: string) => applyProductLike(productId, true),
    [applyProductLike],
  );

  const unlikeProduct = useCallback(
    (productId: string) => applyProductLike(productId, false),
    [applyProductLike],
  );

  const toggleProductLike = useCallback(
    (productId: string) => {
      const currentLiked = likedProductIdsRef.current.has(productId);
      return applyProductLike(productId, !currentLiked);
    },
    [applyProductLike],
  );

  const isProductCommentSubmitting = useCallback(
    (productId: string) => pendingCommentProductIds.has(productId),
    [pendingCommentProductIds],
  );

  const getProductCommentsCount = useCallback(
    (productId: string) => {
      const product = menu?.products.find((item) => item.id === productId);
      return Math.max(0, product?.commentsCount ?? 0);
    },
    [menu],
  );

  const clearCommentError = useCallback(() => {
    setCommentError('');
  }, []);

  const loadProductComments = useCallback(
    async (
      productId: string,
      options?: { cursor?: ProductCommentsCursor | null; limit?: number },
    ): Promise<PublicProductCommentsPage> => {
      return executeGetPublicProductComments(restaurantSlug, productId, options);
    },
    [restaurantSlug],
  );

  const submitProductComment = useCallback(
    async (
      productId: string,
      authorName: string,
      body: string,
    ): Promise<CreatedProductCommentResult> => {
      const currentMenu = menuRef.current;
      const targetProduct = currentMenu?.products.find((item) => item.id === productId);

      if (!targetProduct || !targetProduct.available) {
        const unavailabilityMessage = 'Este produto está temporariamente indisponível para comentários.';
        setCommentError(unavailabilityMessage);
        throw new Error(unavailabilityMessage);
      }

      if (inFlightCommentByProductRef.current.has(productId)) {
        const duplicateMessage = 'Seu comentário já está sendo enviado. Aguarde um instante.';
        setCommentError(duplicateMessage);
        throw new Error(duplicateMessage);
      }

      const epoch = contextEpochRef.current;
      inFlightCommentByProductRef.current.add(productId);
      syncPendingCommentsSet();
      setCommentError('');

      try {
        const created = await executeCreateProductComment(
          restaurantSlug,
          productId,
          authorName,
          body,
        );

        // Se o comentário foi aprovado automaticamente pelo banco, atualizamos o contador do produto no menu
        if (created.status === 'approved' && !disposedRef.current && epoch === contextEpochRef.current) {
          updateMenuState((currentMenu) => {
            if (!currentMenu) return null;
            return {
              ...currentMenu,
              products: currentMenu.products.map((product) =>
                product.id === productId
                  ? {
                      ...product,
                      commentsCount: Math.max(0, (product.commentsCount ?? 0) + 1),
                    }
                  : product,
              ),
            };
          });
        }

        return created;
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : 'Não foi possível enviar seu comentário. Tente novamente.';
        if (!disposedRef.current && epoch === contextEpochRef.current) {
          setCommentError(message);
        }
        throw cause instanceof Error ? cause : new Error(message);
      } finally {
        if (!disposedRef.current && epoch === contextEpochRef.current) {
          inFlightCommentByProductRef.current.delete(productId);
          syncPendingCommentsSet();
        }
      }
    },
    [restaurantSlug, syncPendingCommentsSet, updateMenuState],
  );

  return (
    <MenuContext.Provider
      value={{
        menu,
        loading,
        error,
        reload: () => setRefresh((value) => value + 1),
        likedProductIds,
        pendingLikeProductIds,
        isProductLiked,
        isProductLikePending,
        getProductLikesCount,
        likeError,
        clearLikeError,
        likeProduct,
        unlikeProduct,
        toggleProductLike,
        pendingCommentProductIds,
        isProductCommentSubmitting,
        getProductCommentsCount,
        commentError,
        clearCommentError,
        loadProductComments,
        submitProductComment,
      }}
    >
      {children}
    </MenuContext.Provider>
  );
}

export function usePublicMenu() {
  const context = useContext(MenuContext);
  if (!context) throw new Error('O catálogo precisa de PublicMenuProvider.');
  return context;
}

export function PublicMenuStatus() {
  const { loading, error, reload } = usePublicMenu();
  return <section className="panel" aria-busy={loading}>
    <h1>{loading ? 'Carregando cardápio…' : 'Cardápio indisponível'}</h1>
    <p role={loading ? 'status' : 'alert'}>
      {loading ? 'Buscando as opções do restaurante.' : error}
    </p>
    {!loading && <button type="button" onClick={reload}
      className="mt-3 min-h-11 rounded-xl bg-[var(--brand)] px-4 text-white">
      Tentar novamente
    </button>}
  </section>;
}
