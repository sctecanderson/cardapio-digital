import { useEffect, useState, useTransition } from 'react';
import { Link, useParams } from 'react-router';
import {
  listAdminProductComments,
  moderateProductComment,
  deleteAdminProductComment,
  listRestaurantRestrictedTerms,
  addRestaurantRestrictedTerm,
  removeRestaurantRestrictedTerm,
  type AdminProductComment,
  type AdminCommentCounts,
  type ProductCommentStatus,
  type RestaurantRestrictedTerm,
} from './adminComments';
import { getAdminCatalog, type AdminProduct } from './adminCatalog';

type TabView = 'comments' | 'restricted-terms';

const STATUS_LABELS: Record<ProductCommentStatus, string> = {
  pending: 'Pendente',
  approved: 'Publicado',
  hidden: 'Oculto',
  rejected: 'Rejeitado',
};

const STATUS_BADGE_CLASSES: Record<ProductCommentStatus, string> = {
  pending: 'admin-badge-pending',
  approved: 'admin-badge-approved',
  hidden: 'admin-badge-hidden',
  rejected: 'admin-badge-rejected',
};

export function AdminCommentsPage() {
  const { restaurantSlug = '' } = useParams<{ restaurantSlug: string }>();

  const [activeTab, setActiveTab] = useState<TabView>('comments');

  // Dados de comentários
  const [comments, setComments] = useState<AdminProductComment[]>([]);
  const [counts, setCounts] = useState<AdminCommentCounts>({
    pending: 0,
    approved: 0,
    hidden: 0,
    rejected: 0,
    total: 0,
  });
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<{ createdAt: string; id: string } | null>(null);

  // Filtros
  const [selectedStatus, setSelectedStatus] = useState<ProductCommentStatus | 'all'>('all');
  const [selectedProduct, setSelectedProduct] = useState<string>('all');
  const [productsList, setProductsList] = useState<Array<{ id: string; name: string }>>([]);

  // Estados de tela de comentários
  const [loadingComments, setLoadingComments] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Modal de exclusão definitiva
  const [commentToDelete, setCommentToDelete] = useState<AdminProductComment | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // Termos restritos
  const [terms, setTerms] = useState<RestaurantRestrictedTerm[]>([]);
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [newTermInput, setNewTermInput] = useState('');
  const [termActionBusy, setTermActionBusy] = useState(false);
  const [termToDelete, setTermToDelete] = useState<RestaurantRestrictedTerm | null>(null);

  const [, startTransition] = useTransition();

  // Carrega produtos do catálogo para o filtro
  useEffect(() => {
    if (!restaurantSlug) return;
    let active = true;
    getAdminCatalog(restaurantSlug)
      .then((cat) => {
        if (!active) return;
        const list = cat.products.map((p: AdminProduct) => ({ id: p.id, name: p.name }));
        setProductsList(list);
      })
      .catch((err) => {
        console.warn('[admin-comments] falha ao buscar catálogo de produtos:', err);
      });
    return () => {
      active = false;
    };
  }, [restaurantSlug]);

  // Carrega lista inicial de comentários
  const loadComments = async (isInitial = true) => {
    if (!restaurantSlug) return;
    if (isInitial) {
      setLoadingComments(true);
    } else {
      setLoadingMore(true);
    }
    setFeedbackMsg(null);

    try {
      const res = await listAdminProductComments(restaurantSlug, {
        status: selectedStatus === 'all' ? null : selectedStatus,
        productId: selectedProduct === 'all' ? null : selectedProduct,
        cursorCreatedAt: isInitial ? null : nextCursor?.createdAt,
        cursorId: isInitial ? null : nextCursor?.id,
        limit: 25,
      });

      if (isInitial) {
        setComments(res.items);
      } else {
        setComments((prev) => [...prev, ...res.items]);
      }
      setCounts(res.counts);
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível carregar os comentários.',
      });
    } finally {
      if (isInitial) setLoadingComments(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadComments(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantSlug, selectedStatus, selectedProduct]);

  // Carrega lista de palavras restritas ao alternar para a aba
  const loadRestrictedTerms = async () => {
    if (!restaurantSlug) return;
    setLoadingTerms(true);
    try {
      const data = await listRestaurantRestrictedTerms(restaurantSlug);
      setTerms(data);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível listar as palavras restritas.',
      });
    } finally {
      setLoadingTerms(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'restricted-terms') {
      void loadRestrictedTerms();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, restaurantSlug]);

  // Ação de moderação
  const handleModerate = async (comment: AdminProductComment, newStatus: 'approved' | 'hidden' | 'rejected') => {
    if (!restaurantSlug) return;
    setActionBusyId(comment.id);
    setFeedbackMsg(null);
    try {
      const updated = await moderateProductComment(restaurantSlug, comment.id, newStatus);
      // Atualiza estado local
      setComments((prev) =>
        prev.map((c) =>
          c.id === comment.id
            ? {
                ...c,
                status: updated.status,
                moderatedAt: updated.moderatedAt,
              }
            : c,
        ),
      );
      // Ajusta contagens locais
      setCounts((prev) => {
        const oldStatus = comment.status;
        if (oldStatus === newStatus) return prev;
        return {
          ...prev,
          [oldStatus]: Math.max(0, prev[oldStatus] - 1),
          [newStatus]: prev[newStatus] + 1,
        };
      });
      setFeedbackMsg({
        type: 'success',
        text: `Comentário alterado para "${STATUS_LABELS[newStatus]}".`,
      });
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao moderar comentário.',
      });
    } finally {
      setActionBusyId(null);
    }
  };

  // Suporte a teclado: fecha modais de confirmação com Escape
  useEffect(() => {
    if (!commentToDelete && !termToDelete) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!deletePending && !termActionBusy) {
          setCommentToDelete(null);
          setTermToDelete(null);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commentToDelete, termToDelete, deletePending, termActionBusy]);

  // Exclusão definitiva de comentário
  const handleConfirmDeleteComment = async () => {
    if (!restaurantSlug || !commentToDelete) return;
    setDeletePending(true);
    try {
      await deleteAdminProductComment(restaurantSlug, commentToDelete.id);
      // Remove da lista
      setComments((prev) => prev.filter((c) => c.id !== commentToDelete.id));
      // Decrementa contadores
      setCounts((prev) => ({
        ...prev,
        [commentToDelete.status]: Math.max(0, prev[commentToDelete.status] - 1),
        total: Math.max(0, prev.total - 1),
      }));
      setFeedbackMsg({
        type: 'success',
        text: 'Comentário e curtidas excluídos definitivamente.',
      });
      setCommentToDelete(null);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao excluir comentário.',
      });
    } finally {
      setDeletePending(false);
    }
  };

  // Adição de palavra restrita
  const handleAddTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTerm = newTermInput.trim();
    if (!restaurantSlug || !cleanTerm) return;
    if (cleanTerm.length < 2 || cleanTerm.length > 60) {
      setFeedbackMsg({
        type: 'error',
        text: 'A palavra ou expressão deve ter entre 2 e 60 caracteres.',
      });
      return;
    }
    setTermActionBusy(true);
    setFeedbackMsg(null);
    try {
      const added = await addRestaurantRestrictedTerm(restaurantSlug, cleanTerm);
      setTerms((prev) => [added, ...prev]);
      setNewTermInput('');
      setFeedbackMsg({
        type: 'success',
        text: `Termo "${added.term}" adicionado com sucesso.`,
      });
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível adicionar o termo.',
      });
    } finally {
      setTermActionBusy(false);
    }
  };

  // Remoção de palavra restrita
  const handleConfirmDeleteTerm = async () => {
    if (!restaurantSlug || !termToDelete) return;
    setTermActionBusy(true);
    setFeedbackMsg(null);
    try {
      await removeRestaurantRestrictedTerm(restaurantSlug, termToDelete.id);
      setTerms((prev) => prev.filter((t) => t.id !== termToDelete.id));
      setFeedbackMsg({
        type: 'success',
        text: `Termo "${termToDelete.term}" removido com sucesso.`,
      });
      setTermToDelete(null);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível remover o termo.',
      });
    } finally {
      setTermActionBusy(false);
    }
  };

  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    } catch {
      return isoString;
    }
  };

  return (
    <div className="admin-stack">
      {/* Cabeçalho */}
      <header className="admin-page-heading">
        <div>
          <p className="admin-breadcrumb">
            <Link to={`/${restaurantSlug}/admin`}>Administração</Link> / Comentários
          </p>
          <h1>Comentários e moderação</h1>
          <p>Gerencie os comentários dos clientes e as regras de retenção automática do restaurante.</p>
        </div>
      </header>

      {/* Alerta de Feedback */}
      {feedbackMsg && (
        <div
          role="alert"
          className={`admin-alert ${feedbackMsg.type === 'error' ? 'error' : 'success'}`}
          style={{
            padding: '12px 16px',
            borderRadius: '10px',
            background: feedbackMsg.type === 'error' ? '#fde8e8' : '#e6f8ea',
            color: feedbackMsg.type === 'error' ? '#9b1c1c' : '#0e622b',
            border: `1px solid ${feedbackMsg.type === 'error' ? '#f8b4b4' : '#bcf0da'}`,
            fontSize: '14px',
          }}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* Cards de Métricas / Contadores */}
      <div className="admin-table-grid">
        <section
          className={`admin-card admin-stat ${selectedStatus === 'pending' ? 'admin-stat-active' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => {
            startTransition(() => setSelectedStatus('pending'));
          }}
          title="Clique para filtrar pendentes"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d97706' }} />
            Pendentes
          </span>
          <strong style={{ color: counts.pending > 0 ? '#b45309' : undefined }}>{counts.pending}</strong>
        </section>

        <section
          className={`admin-card admin-stat ${selectedStatus === 'approved' ? 'admin-stat-active' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => {
            startTransition(() => setSelectedStatus('approved'));
          }}
          title="Clique para filtrar publicados"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
            Publicados
          </span>
          <strong>{counts.approved}</strong>
        </section>

        <section
          className={`admin-card admin-stat ${selectedStatus === 'hidden' ? 'admin-stat-active' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => {
            startTransition(() => setSelectedStatus('hidden'));
          }}
          title="Clique para filtrar ocultos"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#64748b' }} />
            Ocultos
          </span>
          <strong>{counts.hidden}</strong>
        </section>

        <section
          className={`admin-card admin-stat ${selectedStatus === 'rejected' ? 'admin-stat-active' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => {
            startTransition(() => setSelectedStatus('rejected'));
          }}
          title="Clique para filtrar rejeitados"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
            Rejeitados
          </span>
          <strong>{counts.rejected}</strong>
        </section>
      </div>

      {/* Navegação entre Abas */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          borderBottom: '1px solid var(--color-border, #e9e0d7)',
          paddingBottom: '12px',
          marginTop: '8px',
        }}
      >
        <button
          type="button"
          className={`admin-tab-btn ${activeTab === 'comments' ? 'active' : ''}`}
          onClick={() => setActiveTab('comments')}
          style={{
            padding: '10px 18px',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: activeTab === 'comments' ? '#dc2626' : 'var(--color-bg-subtle, #f3ede6)',
            color: activeTab === 'comments' ? '#fff' : 'var(--color-text-main, #4a3f35)',
            transition: 'background 0.2s',
          }}
        >
          Moderação de Comentários ({counts.total})
        </button>

        <button
          type="button"
          className={`admin-tab-btn ${activeTab === 'restricted-terms' ? 'active' : ''}`}
          onClick={() => setActiveTab('restricted-terms')}
          style={{
            padding: '10px 18px',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: activeTab === 'restricted-terms' ? '#dc2626' : 'var(--color-bg-subtle, #f3ede6)',
            color: activeTab === 'restricted-terms' ? '#fff' : 'var(--color-text-main, #4a3f35)',
            transition: 'background 0.2s',
          }}
        >
          Palavras Restritas do Restaurante
        </button>
      </div>

      {/* ABA 1: MODERAÇÃO DE COMENTÁRIOS */}
      {activeTab === 'comments' && (
        <section className="admin-card" style={{ padding: '24px' }}>
          {/* Barra de Filtros */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '16px',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid var(--color-border, #f0e9e1)',
            }}
          >
            {/* Filtro de Status */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted, #6d6158)' }}>Status:</span>
              <button
                type="button"
                className={`admin-filter-pill ${selectedStatus === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('all')}
              >
                Todos ({counts.total})
              </button>
              <button
                type="button"
                className={`admin-filter-pill ${selectedStatus === 'pending' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('pending')}
              >
                Pendentes ({counts.pending})
              </button>
              <button
                type="button"
                className={`admin-filter-pill ${selectedStatus === 'approved' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('approved')}
              >
                Publicados ({counts.approved})
              </button>
              <button
                type="button"
                className={`admin-filter-pill ${selectedStatus === 'hidden' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('hidden')}
              >
                Ocultos ({counts.hidden})
              </button>
              <button
                type="button"
                className={`admin-filter-pill ${selectedStatus === 'rejected' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('rejected')}
              >
                Rejeitados ({counts.rejected})
              </button>
            </div>

            {/* Filtro de Produto */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '220px' }}>
              <label htmlFor="admin-filter-product" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted, #6d6158)' }}>
                Prato:
              </label>
              <select
                id="admin-filter-product"
                value={selectedProduct}
                onChange={(e) => setSelectedProduct(e.target.value)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border, #d4c9bd)',
                  fontSize: '13px',
                  background: 'var(--color-surface, #fff)',
                  color: 'var(--color-text-main, #1c1917)',
                  flex: 1,
                }}
              >
                <option value="all">Todos os pratos</option>
                {productsList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Listagem */}
          {loadingComments ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-muted, #8c7e73)' }}>
              Carregando comentários do restaurante…
            </div>
          ) : comments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--color-text-muted, #8c7e73)' }}>
              <p style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 6px' }}>Nenhum comentário encontrado</p>
              <p style={{ fontSize: '14px', margin: 0 }}>
                {selectedStatus !== 'all' || selectedProduct !== 'all'
                  ? 'Experimente limpar ou alterar os filtros acima.'
                  : 'Os comentários dos clientes aparecerão aqui assim que forem enviados.'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {comments.map((comment) => {
                const isBusy = actionBusyId === comment.id;
                return (
                  <article
                    key={comment.id}
                    className="admin-comment-card"
                    style={{
                      border: '1px solid var(--color-border, #eee7df)',
                      borderRadius: '12px',
                      padding: '16px 20px',
                      background: 'var(--color-bg-subtle, #faf8f5)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '12px',
                    }}
                  >
                    {/* Linha superior: Autor, Prato, Data, Status */}
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                        <strong style={{ fontSize: '15px', color: 'var(--color-text-main, #2b1d17)' }}>{comment.authorName}</strong>
                        <span style={{ fontSize: '13px', color: 'var(--color-text-muted, #81766e)' }}>
                          em <strong style={{ color: 'var(--color-text-main, #4a3f35)' }}>{comment.productName}</strong>
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--color-text-muted, #a09489)' }}>• {formatDate(comment.createdAt)}</span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {/* Likes reais */}
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '13px',
                            color: 'var(--color-text-muted, #6d6158)',
                            fontWeight: 500,
                          }}
                          title={`${comment.likesCount} curtida(s)`}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M7 10v12" />
                            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
                          </svg>
                          {comment.likesCount}
                        </span>

                        {/* Status Badge */}
                        <span className={`admin-badge ${STATUS_BADGE_CLASSES[comment.status]}`}>
                          {STATUS_LABELS[comment.status]}
                        </span>
                      </div>
                    </div>

                    {/* Corpo do comentário */}
                    <p
                      style={{
                        margin: 0,
                        fontSize: '14.5px',
                        lineHeight: 1.5,
                        color: 'var(--color-text-main, #382b23)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {comment.body}
                    </p>

                    {/* Ações de Moderação */}
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px',
                        paddingTop: '8px',
                        borderTop: '1px solid var(--color-border, #f0e9e1)',
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {/* Se Pendente: Aprovar ou Rejeitar */}
                        {comment.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              className="admin-btn-action btn-approve"
                              onClick={() => void handleModerate(comment, 'approved')}
                            >
                              ✓ Aprovar e publicar
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              className="admin-btn-action btn-reject"
                              onClick={() => void handleModerate(comment, 'rejected')}
                            >
                              ✕ Rejeitar
                            </button>
                          </>
                        )}

                        {/* Se Publicado: Ocultar */}
                        {comment.status === 'approved' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            className="admin-btn-action btn-hide"
                            onClick={() => void handleModerate(comment, 'hidden')}
                          >
                            Ocultar comentário
                          </button>
                        )}

                        {/* Se Oculto: Publicar novamente */}
                        {comment.status === 'hidden' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            className="admin-btn-action btn-approve"
                            onClick={() => void handleModerate(comment, 'approved')}
                          >
                            ✓ Publicar novamente
                          </button>
                        )}

                        {/* Se Rejeitado: Permitir Aprovação */}
                        {comment.status === 'rejected' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            className="admin-btn-action btn-approve"
                            onClick={() => void handleModerate(comment, 'approved')}
                          >
                            ✓ Aprovar comentário
                          </button>
                        )}
                      </div>

                      {/* Botão de Exclusão Definitiva (Disponível em todos os status) */}
                      <div>
                        <button
                          type="button"
                          disabled={isBusy}
                          className="admin-btn-action btn-delete"
                          onClick={() => setCommentToDelete(comment)}
                          title="Excluir definitivamente este comentário e suas curtidas"
                        >
                          Excluir definitivamente
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Botão Carregar Mais */}
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '24px' }}>
              <button
                type="button"
                disabled={loadingMore}
                className="admin-button"
                onClick={() => void loadComments(false)}
                style={{ minWidth: '180px' }}
              >
                {loadingMore ? 'Carregando mais…' : 'Carregar mais comentários'}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ABA 2: PALAVRAS RESTRITAS DO RESTAURANTE */}
      {activeTab === 'restricted-terms' && (
        <section className="admin-card" style={{ padding: '24px' }}>
          <header style={{ marginBottom: '20px' }}>
            <h2 style={{ fontSize: '18px', margin: '0 0 8px' }}>Filtro de Conteúdo do Restaurante</h2>
            <p className="admin-help" style={{ margin: 0, fontSize: '14px', maxWidth: '780px' }}>
              Comentários de clientes que contiverem qualquer um destes termos não serão publicados imediatamente.
              Eles serão retidos automaticamente na aba <strong>Pendentes</strong> para análise e aprovação manual da sua equipe.
            </p>
          </header>

          {/* Formulário de Adição */}
          <form
            onSubmit={(e) => void handleAddTerm(e)}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '10px',
              maxWidth: '600px',
              marginBottom: '28px',
            }}
          >
            <input
              type="text"
              placeholder="Ex.: cabelo, cru, mosca, azedo..."
              value={newTermInput}
              onChange={(e) => setNewTermInput(e.target.value)}
              disabled={termActionBusy}
              maxLength={60}
              style={{
                flex: 1,
                minWidth: '220px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid var(--color-border, #d4c9bd)',
                fontSize: '14px',
                background: 'var(--color-surface, #fff)',
                color: 'var(--color-text-main, #1c1917)',
              }}
            />
            <button
              type="submit"
              disabled={termActionBusy || !newTermInput.trim()}
              className="admin-button primary"
              style={{ minHeight: '44px', padding: '0 20px' }}
            >
              {termActionBusy ? 'Adicionando…' : 'Adicionar palavra'}
            </button>
          </form>

          {/* Lista de Termos Cadastrados */}
          {loadingTerms ? (
            <div style={{ color: 'var(--color-text-muted, #8c7e73)', padding: '20px 0' }}>Carregando palavras restritas…</div>
          ) : terms.length === 0 ? (
            <div
              style={{
                padding: '30px',
                borderRadius: '10px',
                background: 'var(--color-bg-subtle, #faf8f5)',
                border: '1px dashed var(--color-border, #dcd3c8)',
                textAlign: 'center',
                color: 'var(--color-text-muted, #72665d)',
              }}
            >
              <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Nenhuma palavra restrita cadastrada no restaurante</p>
              <p style={{ margin: 0, fontSize: '13px' }}>
                Todos os comentários passarão pelo filtro global da plataforma e serão publicados automaticamente se permitidos.
              </p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted, #6d6158)', marginBottom: '12px' }}>
                Termos ativos ({terms.length}):
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                {terms.map((t) => (
                  <div
                    key={t.id}
                    className="admin-restricted-tag"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      background: 'var(--color-surface, #fff)',
                      border: '1px solid var(--color-border, #dfd6cd)',
                      fontSize: '13.5px',
                      color: 'var(--color-text-main, #2b1d17)',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                    }}
                  >
                    <span>{t.term}</span>
                    <button
                      type="button"
                      disabled={termActionBusy}
                      onClick={() => setTermToDelete(t)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#a13b3b',
                        cursor: 'pointer',
                        padding: '2px 4px',
                        fontSize: '14px',
                        lineHeight: 1,
                        borderRadius: '4px',
                      }}
                      title={`Remover "${t.term}"`}
                      aria-label={`Remover "${t.term}"`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* MODAL DE CONFIRMAÇÃO: EXCLUSÃO DEFINITIVA DE COMENTÁRIO */}
      {commentToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-del-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
          }}
        >
          <div
            className="admin-modal-card"
            style={{
              background: 'var(--color-surface, #fff)',
              border: '1px solid var(--color-border, #e2e8f0)',
              borderRadius: '16px',
              maxWidth: '480px',
              width: '100%',
              padding: '28px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#b91c1c' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <h3 id="modal-del-title" style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--color-text-main, #2b1d17)' }}>
                Excluir comentário definitivamente?
              </h3>
            </div>

            <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-text-muted, #52453c)', lineHeight: 1.5 }}>
              Esta ação é <strong>irreversível</strong>. O comentário de <strong>{commentToDelete.authorName}</strong> no
              prato <strong>{commentToDelete.productName}</strong> e todas as <strong>{commentToDelete.likesCount}</strong> curtidas
              associadas serão apagados do banco de dados.
            </p>

            <div
              style={{
                padding: '12px',
                borderRadius: '8px',
                background: '#fcf6f4',
                border: '1px solid #f3d4ce',
                fontSize: '13px',
                color: '#7f231c',
                fontStyle: 'italic',
                maxHeight: '100px',
                overflowY: 'auto',
              }}
            >
              &ldquo;{commentToDelete.body}&rdquo;
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                type="button"
                disabled={deletePending}
                className="admin-button"
                onClick={() => setCommentToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletePending}
                className="admin-button"
                onClick={() => void handleConfirmDeleteComment()}
                style={{
                  background: '#dc2626',
                  color: '#fff',
                  borderColor: '#dc2626',
                }}
              >
                {deletePending ? 'Excluindo…' : 'Sim, excluir definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE CONFIRMAÇÃO: REMOÇÃO DE TERMO RESTRITO */}
      {termToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-del-term"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
          }}
        >
          <div
            className="admin-modal-card"
            style={{
              background: 'var(--color-surface, #fff)',
              border: '1px solid var(--color-border, #e2e8f0)',
              borderRadius: '16px',
              maxWidth: '440px',
              width: '100%',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h3 id="modal-del-term" style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--color-text-main, #2b1d17)' }}>
              Remover palavra restrita?
            </h3>

            <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-text-muted, #52453c)', lineHeight: 1.5 }}>
              Deseja remover o termo <strong>&ldquo;{termToDelete.term}&rdquo;</strong> do filtro do restaurante? Novos
              comentários com este termo não serão mais retidos automaticamente por esta regra.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                type="button"
                disabled={termActionBusy}
                className="admin-button"
                onClick={() => setTermToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={termActionBusy}
                className="admin-button primary"
                onClick={() => void handleConfirmDeleteTerm()}
              >
                {termActionBusy ? 'Removendo…' : 'Remover'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
