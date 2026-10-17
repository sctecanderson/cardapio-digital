import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { usePublicMenu, PublicMenuStatus } from '../menu/PublicMenuProvider';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { useTableContext, getTableQueryString } from '../tables/useTableContext';
import {
  formatRelativeCommentDate,
  getSavedProductCommentDraft,
  saveProductCommentDraft,
  type ProductCommentDraft,
} from './ProductCommentsPopover';
import {
  clearExploreNavigationState,
  getExploreNavigationState,
  saveExploreNavigationState,
  type ExploreNavigationState,
} from './exploreNavigation';
import {
  getMyProductCommentLikes,
  toggleProductCommentLike,
} from '../menu/publicMenu';
import type {
  ProductCommentsCursor,
  PublicProductComment,
} from '../../types/menu';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';

export function ProductCommentsPage() {
  const { restaurantSlug = '', productId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const table = useTableContext();
  const { restaurant } = useRestaurant();
  const tableQuery = getTableQueryString(table);

  const catalog = usePublicMenu();
  const {
    menu,
    loading,
    error,
    getProductCommentsCount,
    loadProductComments,
    submitProductComment,
    isProductCommentSubmitting,
    commentError,
    clearCommentError,
  } = catalog;

  // Busca produto por id ou por slug (garante suporte a ambos)
  const product = menu?.products.find(
    (item) => item.id === productId || item.slug === productId,
  );
  const resolvedProductId = product?.id ?? productId;
  const productName = product?.name ?? 'Prato';

  const authorInputId = useId();
  const bodyInputId = useId();
  const feedbackId = useId();

  const [draft, setDraft] = useState<ProductCommentDraft>(() =>
    getSavedProductCommentDraft(resolvedProductId, restaurantSlug),
  );
  const [comments, setComments] = useState<PublicProductComment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<ProductCommentsCursor | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [localFormError, setLocalFormError] = useState('');
  const [pendingNotice, setPendingNotice] = useState('');
  const [autoApprovedNotice, setAutoApprovedNotice] = useState('');
  const [likedCommentIds, setLikedCommentIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [inFlightCommentLikes, setInFlightCommentLikes] = useState<ReadonlySet<string>>(() => new Set<string>());

  const loadSeqRef = useRef(0);
  const inFlightLikesRef = useRef<Set<string>>(new Set());

  // Recupera estado de navegação vindo do Explorar
  const navStateRef = useRef<ExploreNavigationState | null>(null);
  if (navStateRef.current === null) {
    const locState = location.state as ExploreNavigationState | null;
    navStateRef.current = locState?.fromExplore
      ? locState
      : getExploreNavigationState(restaurantSlug);
  }

  // Carrega rascunho salvo
  useEffect(() => {
    if (!resolvedProductId) return;
    const saved = getSavedProductCommentDraft(resolvedProductId, restaurantSlug);
    setDraft(saved);
  }, [resolvedProductId, restaurantSlug]);

  // Carrega comentários aprovados e curtidas do visitante
  const fetchInitial = useCallback(
    async (targetId: string) => {
      const seq = ++loadSeqRef.current;
      setLoadingInitial(true);
      setListError('');
      try {
        const page = await loadProductComments(targetId, {
          cursor: null,
          limit: 15,
        });
        if (seq !== loadSeqRef.current) return;
        setComments(page.items);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (seq !== loadSeqRef.current) return;
        setListError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível carregar os comentários deste prato.',
        );
      } finally {
        if (seq === loadSeqRef.current) {
          setLoadingInitial(false);
        }
      }
    },
    [loadProductComments],
  );

  useEffect(() => {
    if (!resolvedProductId) return;
    void fetchInitial(resolvedProductId);

    if (restaurantSlug) {
      void getMyProductCommentLikes(restaurantSlug)
        .then((likedIds) => {
          setLikedCommentIds(new Set(likedIds));
        })
        .catch(() => {
          // Silencioso na hidratação secundária
        });
    }
  }, [resolvedProductId, restaurantSlug, fetchInitial]);

  const handleLoadMore = useCallback(async () => {
    if (loadingInitial || loadingMore || !hasMore || !nextCursor || !resolvedProductId) {
      return;
    }
    const seq = loadSeqRef.current;
    setLoadingMore(true);
    setListError('');
    try {
      const page = await loadProductComments(resolvedProductId, {
        cursor: nextCursor,
        limit: 15,
      });
      if (seq !== loadSeqRef.current) return;
      setComments((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const appended = page.items.filter((c) => !existingIds.has(c.id));
        return [...prev, ...appended];
      });
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (seq !== loadSeqRef.current) return;
      setListError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível carregar mais comentários.',
      );
    } finally {
      if (seq === loadSeqRef.current) {
        setLoadingMore(false);
      }
    }
  }, [loadingInitial, loadingMore, hasMore, nextCursor, resolvedProductId, loadProductComments]);

  const handleToggleLike = useCallback(
    async (commentId: string) => {
      if (!restaurantSlug || inFlightLikesRef.current.has(commentId)) {
        return;
      }
      const isCurrentlyLiked = likedCommentIds.has(commentId);
      const targetLiked = !isCurrentlyLiked;

      inFlightLikesRef.current.add(commentId);
      setInFlightCommentLikes(new Set(inFlightLikesRef.current));

      // Otimista
      setLikedCommentIds((prev) => {
        const next = new Set(prev);
        if (targetLiked) next.add(commentId);
        else next.delete(commentId);
        return next;
      });

      setComments((prev) =>
        prev.map((c) => {
          if (c.id === commentId) {
            const cur = c.likesCount ?? 0;
            return {
              ...c,
              likesCount: targetLiked ? cur + 1 : Math.max(0, cur - 1),
            };
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
        setLikedCommentIds((prev) => {
          const next = new Set(prev);
          if (result.liked) next.add(commentId);
          else next.delete(commentId);
          return next;
        });
        setComments((prev) =>
          prev.map((c) =>
            c.id === commentId ? { ...c, likesCount: result.likesCount } : c,
          ),
        );
      } catch (cause) {
        // Rollback
        setLikedCommentIds((prev) => {
          const next = new Set(prev);
          if (isCurrentlyLiked) next.add(commentId);
          else next.delete(commentId);
          return next;
        });
        setComments((prev) =>
          prev.map((c) => {
            if (c.id === commentId) {
              const cur = c.likesCount ?? 0;
              return {
                ...c,
                likesCount: targetLiked ? Math.max(0, cur - 1) : cur + 1,
              };
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

  function updateDraftField(field: keyof ProductCommentDraft, value: string) {
    const next: ProductCommentDraft = {
      ...draft,
      [field]: value,
    };
    setDraft(next);
    saveProductCommentDraft(resolvedProductId, next, restaurantSlug);

    if (localFormError) setLocalFormError('');
    if (pendingNotice && field === 'body' && value.trim().length > 0) setPendingNotice('');
    if (autoApprovedNotice && field === 'body' && value.trim().length > 0) setAutoApprovedNotice('');
    if (commentError) clearCommentError();
  }

  const isSubmitting = isProductCommentSubmitting(resolvedProductId);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

    try {
      const result = await submitProductComment(resolvedProductId, cleanAuthor, cleanBody);
      const updatedDraft: ProductCommentDraft = {
        authorName: cleanAuthor,
        body: '',
      };
      setDraft(updatedDraft);
      saveProductCommentDraft(resolvedProductId, updatedDraft, restaurantSlug);

      if (result.status === 'approved') {
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
    } catch {
      // Preserva nome e mensagem em draft
    }
  }

  // Ação de Voltar: Restaura o produto e o feed Explorar
  function handleBack() {
    const savedState = navStateRef.current ?? getExploreNavigationState(restaurantSlug);
    if (savedState?.fromExplore) {
      // Salva para consumo imediato pelo feed Explorar
      saveExploreNavigationState(restaurantSlug, savedState);
      navigate(`/${restaurantSlug}/explorar${tableQuery}`);
      return;
    }

    // Fallback: tenta histórico anterior do browser ou vai para o Explorar
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(`/${restaurantSlug}/explorar${tableQuery}`);
    }
  }

  if (loading && !menu) {
    return <PublicMenuStatus />;
  }

  if (error && !menu) {
    return <PublicMenuStatus />;
  }

  const approvedTotal = getProductCommentsCount(resolvedProductId);
  const effectiveError = localFormError || commentError;
  const canSubmit =
    !isSubmitting &&
    draft.authorName.trim().length >= 2 &&
    draft.authorName.trim().length <= 40 &&
    draft.body.trim().length >= 3 &&
    draft.body.trim().length <= 280;

  return (
    <div className="product-comments-full-page">
      {/* 1. Cabeçalho fixo com botão voltar, nome do prato e contador */}
      <header className="product-comments-full-header">
        <button
          type="button"
          onClick={handleBack}
          className="product-comments-full-back-btn"
          aria-label="Voltar para o Explorar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div className="product-comments-full-title-wrap">
          <h1 className="product-comments-full-title">
            Comentários
          </h1>
          <span className="product-comments-full-subtitle">
            {productName}
          </span>
        </div>

        <div className="product-comments-full-header-actions">
          <span
            className="product-comments-full-count-pill"
            aria-label={`${approvedTotal} comentários aprovados`}
          >
            {approvedTotal}
          </span>
          <ThemeToggleButton className="product-comments-theme-toggle" />
        </div>
      </header>

      {/* 2. Lista de comentários com paginação */}
      <main className="product-comments-full-body" role="region" aria-label={`Comentários de ${productName}`}>
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
              onClick={() => void fetchInitial(resolvedProductId)}
            >
              Tentar novamente
            </button>
          </div>
        ) : comments.length === 0 ? (
          <div className="product-comments-empty" role="status">
            <p className="product-comments-empty-title">Nenhum comentário ainda</p>
            <p className="product-comments-empty-sub">
              Experimentou {productName}? Seja o primeiro a compartilhar sua experiência!
            </p>
          </div>
        ) : (
          <div className="product-comments-full-list-container">
            <ul className="product-comments-items">
              {comments.map((comment) => (
                <li key={comment.id} className="product-comments-item">
                  <div className="product-comments-item-meta">
                    <strong className="product-comments-item-author">
                      {comment.authorName?.trim() || 'Cliente'}
                    </strong>
                    <time dateTime={comment.createdAt} className="product-comments-item-date">
                      {formatRelativeCommentDate(comment.createdAt)}
                    </time>
                  </div>
                  <p className="product-comments-item-body">{comment.body}</p>
                  <div className="product-comments-item-footer">
                    <button
                      type="button"
                      className={`product-comment-like-btn ${likedCommentIds.has(comment.id) ? 'is-liked' : ''}`}
                      disabled={inFlightCommentLikes.has(comment.id)}
                      onClick={() => void handleToggleLike(comment.id)}
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
                  onClick={() => void handleLoadMore()}
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
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Carregando…' : 'Carregar mais comentários'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* 3. Rodapé fixo com formulário compacto de novo comentário */}
      <footer className="product-comments-full-footer">
        <form className="product-comments-form" onSubmit={handleSubmit} noValidate>
          {autoApprovedNotice && (
            <div id={feedbackId} className="product-comments-feedback is-approved" role="status" aria-live="polite">
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
            <div id={feedbackId} className="product-comments-feedback is-pending-moderation" role="status" aria-live="polite">
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
            <div id={feedbackId} className="product-comments-feedback is-error" role="alert">
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
            <label htmlFor={authorInputId} className="sr-only">Seu nome</label>
            <input
              id={authorInputId}
              type="text"
              className="product-comments-name-input"
              placeholder="Seu nome"
              maxLength={40}
              autoComplete="name"
              value={draft.authorName}
              disabled={isSubmitting}
              onChange={(e) => updateDraftField('authorName', e.target.value)}
            />
          </div>

          <div className="product-comments-compose-row">
            <label htmlFor={bodyInputId} className="sr-only">Seu comentário</label>
            <textarea
              id={bodyInputId}
              rows={2}
              className="product-comments-body-input"
              placeholder="Escreva um comentário…"
              maxLength={280}
              value={draft.body}
              disabled={isSubmitting}
              aria-describedby={effectiveError || pendingNotice ? feedbackId : undefined}
              onChange={(e) => updateDraftField('body', e.target.value)}
            />

            <div className="product-comments-compose-footer">
              <span className={`product-comments-char-counter ${draft.body.length >= 260 ? 'is-near-limit' : ''}`} aria-live="off">
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
      </footer>
    </div>
  );
}
