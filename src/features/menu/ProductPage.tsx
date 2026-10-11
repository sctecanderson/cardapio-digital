import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePublicMenu, PublicMenuStatus } from './PublicMenuProvider';
import type { Product } from '../../types/menu';
import { useTableContext } from '../tables/useTableContext';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ServiceActionPopup, type ServiceActionType } from '../service/ServiceActionPopup';

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

type ProductAction = 'waiter' | 'bill' | null;

function ProductNavIcon({ name }: { name: 'home' | 'waiter' | 'bill' }) {
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
  const tableQuery = table.status === 'unverified' ? `?mesa=${table.tableNumber}` : '';
  const { restaurantSlug = '', productSlug = '' } = useParams();

  const [activeImage, setActiveImage] = useState(0);
  const [restrictionsOpen, setRestrictionsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
  const galleryRail = useRef<HTMLDivElement>(null);

  const catalog = usePublicMenu();
  const product = catalog.menu?.products.find((item) => item.slug === productSlug);

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

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: product.name,
          text: product.shortDescription || product.description,
          url: window.location.href,
        });
      } catch {
        // Ignora cancelamento pelo usuário
      }
    } else {
      navigator.clipboard?.writeText(window.location.href);
      alert('Link do prato copiado para a área de transferência!');
    }
  };

  function scrollToImage(index: number) {
    const rail = galleryRail.current;
    const slide = rail?.children.item(index);
    if (!rail || !(slide instanceof HTMLElement)) return;
    rail.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' });
  }

  // Ingredientes simulados amigáveis derivados da descrição ou padrão gastronômico
  const ingredientsList = product.description
    ? product.description.split('.').filter(Boolean)[0]
    : 'Ingredientes selecionados e temperos frescos da casa';

  return (
    <div className="product-page">
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
          <h1 className="product-title">{product.name}</h1>

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
            <span className="product-meta-item time">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              25 min
            </span>
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

          <div className="product-price">
            {currency.format(product.priceInCents / 100)}
          </div>
        </div>

        {/* Descrição */}
        <div className="product-section">
          <h2 className="product-section-title">Descrição</h2>
          <p className="product-section-text">
            {product.description || product.shortDescription || 'Receita autoral preparada com ingredientes selecionados pelo nosso chef, finalizada com toques contemporâneos de azeite e ervas frescas.'}
          </p>
        </div>

        {/* Ingredientes */}
        <div className="product-section">
          <h2 className="product-section-title">Ingredientes</h2>
          <div className="product-ingredients-text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a9 9 0 0 1 9 9c0 4.97-4.03 9-9 9s-9-4.03-9-9a9 9 0 0 1 9-9z" />
              <path d="M12 2v18" />
            </svg>
            <span>{ingredientsList}</span>
          </div>
        </div>

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

      {/* Aviso: Faça seu pedido com o garçom */}
      <div className="product-order-notice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span>Faça seu pedido com o garçom.</span>
      </div>

      {/* Dock / Barra de ações inferior flutuante */}
      <nav className="home-bottom-nav" aria-label="Ações da mesa">
        <Link to={`/${restaurantSlug}${tableQuery}`}>
          <ProductNavIcon name="home" /><span>Início</span>
        </Link>
        <button type="button" onClick={() => setActiveAction('waiter')}>
          <ProductNavIcon name="waiter" /><span>Chamar Garçom</span>
        </button>
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
