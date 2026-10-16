import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePublicMenu, PublicMenuStatus } from './PublicMenuProvider';
import type { Product } from '../../types/menu';
import { shareProduct } from './productShare';
import { useTableContext, getTableQueryString } from '../tables/useTableContext';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ServiceActionPopup, type ServiceActionType } from '../service/ServiceActionPopup';
import { createDirectTableOrder, requestTableAssistance } from './publicMenu';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function formatLikes(count: number) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace('.0', '')}k`;
  }
  return String(Math.max(0, count));
}

function ProductNavIcon({ name }: { name: 'home' | 'waiter' | 'bill' | 'close' }) {
  if (name === 'home') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
  if (name === 'waiter') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
  if (name === 'close') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12h6" />
      <path d="M12 9v6" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function ProductPage() {
  const table = useTableContext();
  const { restaurant } = useRestaurant();
  const tableQuery = getTableQueryString(table);
  const { restaurantSlug = '', productSlug = '' } = useParams();

  const [activeImage, setActiveImage] = useState(0);
  const [restrictionsOpen, setRestrictionsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
  const galleryRail = useRef<HTMLDivElement>(null);

  // Estados do Bloco 17: Disparo Direto para Cozinha/Bar e Assistência
  const [orderQuantity, setOrderQuantity] = useState(1);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderSuccessMessage, setOrderSuccessMessage] = useState<string | null>(null);
  const [orderErrorMessage, setOrderErrorMessage] = useState<string | null>(null);

  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const [assistanceMessage, setAssistanceMessage] = useState<string | null>(null);

  const catalog = usePublicMenu();
  const product = catalog.menu?.products.find((item) => item.slug === productSlug);

  const handleDirectOrder = async () => {
    if (!product || !table.tableId || orderBusy || product.isOutOfStock) return;
    setOrderBusy(true);
    setOrderErrorMessage(null);
    setOrderSuccessMessage(null);
    try {
      const result = await createDirectTableOrder(table.tableId, product.id, orderQuantity);
      setOrderSuccessMessage(result.message || 'Pedido enviado com sucesso para a cozinha/bar!');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Não foi possível enviar o pedido.';
      setOrderErrorMessage(msg);
    } finally {
      setOrderBusy(false);
    }
  };

  const handleTableAssistance = async (type: 'call_waiter' | 'close_table_request') => {
    if (!table.tableId || assistanceBusy) {
      if (type === 'call_waiter') setActiveAction('waiter');
      else setActiveAction('bill');
      return;
    }
    setAssistanceBusy(true);
    setAssistanceMessage(null);
    try {
      const res = await requestTableAssistance(table.tableId, type);
      setAssistanceMessage(res.message);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Não foi possível solicitar atendimento.';
      setAssistanceMessage(msg);
    } finally {
      setAssistanceBusy(false);
    }
  };

  useEffect(() => {
    if (!catalog.likeError) return;
    const timer = window.setTimeout(() => {
      catalog.clearLikeError();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [catalog.likeError, catalog.clearLikeError]);

  if (!catalog.menu) return <PublicMenuStatus />;

  if (!product) {
    return (
      <section className="home-promo-empty">
        <h1>Produto não encontrado</h1>
        <p>Este produto não está disponível no cardápio.</p>
        <Link
          to={`/${restaurantSlug}/cardapio${tableQuery}`}
          className="home-explore-link mt-4 inline-block"
        >
          Voltar ao cardápio
        </Link>
      </section>
    );
  }

  const images = [...product.images].sort((a, b) => {
    if (a.id === product.coverImageId) return -1;
    if (b.id === product.coverImageId) return 1;
    return a.sortOrder - b.sortOrder;
  });

  const isLiked = catalog.isProductLiked(product.id);
  const isLikePending = catalog.isProductLikePending(product.id);
  const likesCount = catalog.getProductLikesCount(product.id);
  const likesLabel = likesCount === 1 ? '1 curtida' : `${formatLikes(likesCount)} curtidas`;

  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const shareNoticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shareNoticeTimerRef.current !== null) {
        window.clearTimeout(shareNoticeTimerRef.current);
      }
    };
  }, []);

  const showShareNotice = (message: string) => {
    if (shareNoticeTimerRef.current !== null) {
      window.clearTimeout(shareNoticeTimerRef.current);
    }
    setShareNotice(message);
    shareNoticeTimerRef.current = window.setTimeout(() => {
      setShareNotice(null);
      shareNoticeTimerRef.current = null;
    }, 3200);
  };

  const handleShare = async () => {
    const result = await shareProduct({
      restaurantSlug,
      productSlug: product.slug,
      productName: product.name,
      productDescription: product.shortDescription || product.description,
    });
    if (result.status !== 'aborted' && result.message) {
      showShareNotice(result.message);
    }
  };

  function scrollToImage(index: number) {
    const rail = galleryRail.current;
    const slide = rail?.children.item(index);
    if (!rail || !(slide instanceof HTMLElement)) return;
    rail.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' });
  }

  return (
    <div className="product-page">
      {/* Toast no topo da tela para aviso discreto de compartilhamento */}
      {shareNotice && (
        <div
          className="product-top-toast"
          role="status"
          aria-live="polite"
          onClick={() => setShareNotice(null)}
        >
          {shareNotice}
        </div>
      )}

      {/* Imagem / Carrossel com Botões Flutuantes */}
      <div className="product-gallery-container">
        {/* Botão ← Voltar */}
        <Link
          to={`/${restaurantSlug}/cardapio${tableQuery}`}
          className="product-top-btn product-back-btn"
          aria-label="Voltar ao cardápio"
        >
          ← voltar
        </Link>

        {/* Botão Compartilhar */}
        <button
          type="button"
          onClick={handleShare}
          className="product-top-btn product-share-btn"
          aria-label="Compartilhar prato"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>

        {/* Trilho de Fotos Deslizante */}
        <div
          ref={galleryRail}
          className="product-gallery-rail"
          onScroll={(e) => {
            const width = e.currentTarget.clientWidth;
            if (width > 0) {
              const idx = Math.round(e.currentTarget.scrollLeft / width);
              setActiveImage(Math.max(0, Math.min(images.length - 1, idx)));
            }
          }}
        >
          {images.length > 0 ? (
            images.map((img) => (
              <div key={img.id} className="product-gallery-slide">
                <img
                  src={img.url}
                  alt={img.alt}
                  fetchPriority="high"
                  decoding="async"
                />
              </div>
            ))
          ) : (
            <div className="home-dish-placeholder">
              {product.name}
            </div>
          )}
        </div>

        {/* Bolinhas de paginação da galeria (se houver mais de uma foto) */}
        {images.length > 1 && (
          <div className="product-gallery-dots">
            {images.map((img, i) => (
              <button
                key={img.id}
                type="button"
                className={i === activeImage ? 'active' : ''}
                aria-label={`Ver foto ${i + 1}`}
                onClick={() => scrollToImage(i)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Card Principal de Detalhes */}
      <article className="product-card">
        <div className="product-header-group">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="product-title m-0">{product.name}</h1>
            {!product.available && (
              <span
                role="status"
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-700/50"
                aria-label="Item indisponível no momento"
              >
                Indisponível no momento
              </span>
            )}
          </div>

          <div className="product-meta-row">
            <button
              type="button"
              className={`product-meta-item rating product-like-btn ${isLiked ? 'liked' : ''}`}
              onClick={() => {
                if (catalog.likeError) catalog.clearLikeError();
                void catalog.toggleProductLike(product.id);
              }}
              disabled={isLikePending}
              aria-pressed={isLiked}
              aria-busy={isLikePending}
              aria-label={`${isLiked ? 'Descurtir' : 'Curtir'} ${product.name} (${likesLabel})`}
            >
              <svg
                viewBox="0 0 24 24"
                fill={isLiked ? '#e63946' : 'none'}
                stroke={isLiked ? '#e63946' : 'currentColor'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              <span>{likesLabel}</span>
            </button>

            {product.prepTimeMinMinutes != null && product.prepTimeMaxMinutes != null && (
              <span
                className="product-meta-item time"
                title="Estimativa média de tempo de preparo da cozinha"
                aria-label={`Preparo estimado: ${
                  product.prepTimeMinMinutes === product.prepTimeMaxMinutes
                    ? `${product.prepTimeMinMinutes} minutos`
                    : `${product.prepTimeMinMinutes} a ${product.prepTimeMaxMinutes} minutos`
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>
                  {product.prepTimeMinMinutes === product.prepTimeMaxMinutes
                    ? `Preparo: ${product.prepTimeMinMinutes} min`
                    : `Preparo: ${product.prepTimeMinMinutes}–${product.prepTimeMaxMinutes} min`}
                </span>
              </span>
            )}
          </div>

          {catalog.likeError && (
            <div className="product-like-error" role="status" aria-live="polite">
              <span>{catalog.likeError}</span>
              <button
                type="button"
                onClick={catalog.clearLikeError}
                aria-label="Fechar aviso"
              >
                ×
              </button>
            </div>
          )}

          <div className="product-price flex items-center justify-between gap-3">
            <span>{currency.format(product.priceInCents / 100)}</span>
            {product.isOutOfStock && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 border border-red-200 dark:border-red-900/50">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-3.5 h-3.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                Esgotado
              </span>
            )}
          </div>
        </div>

        {/* Descrição */}
        {(product.description || product.shortDescription) && (
          <div className="product-section">
            <h2 className="product-section-title">Descrição</h2>
            <p className="product-section-text">
              {product.description || product.shortDescription}
            </p>
          </div>
        )}

        {/* Ingredientes / Detalhes Adicionais */}
        {product.dietaryInformation && (
          <div className="product-section">
            <h2 className="product-section-title">Informações Dietéticas e Alergênicos</h2>
            <div className="product-ingredients-text">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a9 9 0 0 1 9 9c0 4.97-4.03 9-9 9s-9-4.03-9-9a9 9 0 0 1 9-9z" />
                <path d="M12 2v18" />
              </svg>
              <span>{product.dietaryInformation}</span>
            </div>
          </div>
        )}

        {/* Sanfona de Restrições */}
        <div className="product-restrictions-accordion">
          <button
            type="button"
            className="product-restrictions-toggle"
            onClick={() => setRestrictionsOpen((prev) => !prev)}
            aria-expanded={restrictionsOpen}
          >
            <span className="product-restrictions-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Ingredientes e restrições
            </span>
            <span className={`arrow ${restrictionsOpen ? 'open' : ''}`} aria-hidden="true">∨</span>
          </button>
          {restrictionsOpen && (
            <p className="product-restrictions-content">
              {product.dietaryInformation || 'Consulte a equipe sobre alergênicos, intolerâncias e adaptações disponíveis.'}
            </p>
          )}
        </div>
      </article>

      {/* Bloco 17: Disparo Direto para a Cozinha / Bar para Mesa Ativa */}
      {table.status === 'unverified' && table.tableId && !product.isOutOfStock && product.available && (
        <section className="product-direct-order-card mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900" aria-label="Fazer pedido direto para a mesa">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-orange-600 dark:text-orange-400">
                Disparo Direto para Cozinha / Bar
              </span>
              <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                Mesa {table.tableNumber}
              </h3>
            </div>
            <div className="flex items-center border border-zinc-300 dark:border-zinc-700 rounded-xl overflow-hidden bg-zinc-50 dark:bg-zinc-800">
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-lg font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-95 disabled:opacity-30"
                onClick={() => setOrderQuantity((q) => Math.max(1, q - 1))}
                disabled={orderQuantity <= 1 || orderBusy}
                aria-label="Diminuir quantidade"
              >
                -
              </button>
              <span className="w-10 text-center font-bold text-base text-zinc-900 dark:text-zinc-100">
                {orderQuantity}
              </span>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-lg font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-95 disabled:opacity-30"
                onClick={() => setOrderQuantity((q) => Math.min(99, q + 1))}
                disabled={orderQuantity >= 99 || orderBusy}
                aria-label="Aumentar quantidade"
              >
                +
              </button>
            </div>
          </div>

          {orderSuccessMessage ? (
            <div className="p-3.5 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/50 text-sm font-medium flex items-center gap-2.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 flex-shrink-0">
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{orderSuccessMessage}</span>
            </div>
          ) : (
            <button
              type="button"
              className="w-full min-h-12 py-3 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-semibold text-base shadow-sm transition-transform active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-50"
              onClick={handleDirectOrder}
              disabled={orderBusy}
            >
              {orderBusy ? (
                <>
                  <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Enviando pedido...</span>
                </>
              ) : (
                <>
                  <span>Fazer Pedido ({currency.format((product.priceInCents * orderQuantity) / 100)})</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <polyline points="9 18 15 12 9 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </>
              )}
            </button>
          )}

          {orderErrorMessage && (
            <p className="mt-2.5 text-xs font-medium text-red-600 dark:text-red-400">
              {orderErrorMessage}
            </p>
          )}
        </section>
      )}

      {/* Aviso: Estoque esgotado ou Faça seu pedido */}
      {product.isOutOfStock ? (
        <div className="product-order-notice border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="status" aria-live="polite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Este produto atingiu o limite de estoque e está esgotado no momento.</span>
        </div>
      ) : (
        <div className="product-order-notice" role="status" aria-live="polite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span>
            {product.available
              ? (table.status === 'unverified' ? "Pedido direto enviado ao KDS com baixa de estoque." : "Faça seu pedido com o garçom.")
              : "Este item está temporariamente indisponível para pedidos."}
          </span>
        </div>
      )}

      {/* Toast / Alerta de Assistência */}
      {assistanceMessage && (
        <div className="fixed bottom-24 left-4 right-4 z-50 p-4 rounded-xl bg-zinc-900 text-white shadow-xl text-sm flex items-center justify-between border border-zinc-700">
          <span>{assistanceMessage}</span>
          <button type="button" onClick={() => setAssistanceMessage(null)} className="ml-3 font-bold text-zinc-400 hover:text-white text-base">
            ×
          </button>
        </div>
      )}

      {/* Dock / Barra de ações inferior flutuante */}
      <nav className="home-bottom-nav" aria-label="Ações da mesa">
        <Link to={`/${restaurantSlug}${tableQuery}`}>
          <ProductNavIcon name="home" /><span>Início</span>
        </Link>
        <button type="button" onClick={() => handleTableAssistance('call_waiter')}>
          <ProductNavIcon name="waiter" /><span>Chamar Garçom</span>
        </button>
        {table.status === 'unverified' && (
          <button type="button" onClick={() => handleTableAssistance('close_table_request')}>
            <ProductNavIcon name="close" /><span>Encerrar</span>
          </button>
        )}
        <Link to={`/${restaurantSlug}/comanda${tableQuery}`}>
          <ProductNavIcon name="bill" /><span>Comanda</span>
        </Link>
      </nav>

      {/* Modal / Dialog de Chamar Garçom e Pedir Conta */}
      <ServiceActionPopup
        isOpen={!!activeAction}
        mode={activeAction}
        onClose={() => setActiveAction(null)}
      />
    </div>
  );
}
