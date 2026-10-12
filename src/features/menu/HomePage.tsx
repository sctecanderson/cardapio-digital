import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { useTableContext, getTableQueryString } from '../tables/useTableContext';
import { ServiceActionPopup, type ServiceActionType } from '../service/ServiceActionPopup';
import { usePublicMenu, PublicMenuStatus } from './PublicMenuProvider';
import type { Product } from '../../types/menu';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

type HomeAction = 'waiter' | 'bill' | null;

function getCover(product: Product) {
  return product.images.find((image) => image.id === product.coverImageId)
    ?? product.images[0]
    ?? null;
}

function formatLikes(count: number) {
  const safeCount = Math.max(0, count);
  if (safeCount >= 1000) {
    return `${(safeCount / 1000).toFixed(1)}k`;
  }
  return String(safeCount);
}

function compareCatalogOrder(a: Product, b: Product): number {
  const featuredDiff = Number(b.featured) - Number(a.featured);
  if (featuredDiff !== 0) return featuredDiff;
  const sortDiff = a.sortOrder - b.sortOrder;
  if (sortDiff !== 0) return sortDiff;
  return a.id.localeCompare(b.id);
}

function compareByLikesCountDesc(a: Product, b: Product): number {
  const likesDiff = Math.max(0, b.likesCount ?? 0) - Math.max(0, a.likesCount ?? 0);
  if (likesDiff !== 0) return likesDiff;
  const sortDiff = a.sortOrder - b.sortOrder;
  if (sortDiff !== 0) return sortDiff;
  return a.id.localeCompare(b.id);
}

function HeartBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

function ProductCard({ product, restaurantSlug, tableQuery, likesCount }: {
  product: Product;
  restaurantSlug: string;
  tableQuery: string;
  likesCount: number;
}) {
  const image = getCover(product);
  const formattedLikes = formatLikes(likesCount);

  return (
    <Link
      to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
      className="home-dish-card"
      aria-label={`${product.name}, ${currency.format(product.priceInCents / 100)}, ${likesCount === 1 ? '1 curtida' : `${likesCount} curtidas`}. Ver prato`}
    >
      <div className="home-dish-image-wrap">
        {image ? (
          <img
            src={image.url}
            alt={image.alt}
            loading="lazy"
            decoding="async"
            className="home-dish-image"
          />
        ) : (
          <div className="home-dish-placeholder" aria-hidden="true">
            {product.name}
          </div>
        )}
        <span className="home-dish-rating" aria-hidden="true">
          <HeartBadgeIcon />
          {formattedLikes}
        </span>
      </div>
      <div className="home-dish-copy">
        <div className="home-dish-title-row">
          <h3>{product.name}</h3>
          {product.featured && (
            <span className="home-dish-inline-rating" aria-hidden="true">
              <HeartBadgeIcon />
              {formattedLikes}
            </span>
          )}
        </div>
        <p>{product.shortDescription || product.description || 'Ingredientes selecionados e preparo especial da casa.'}</p>
        <div className="home-dish-footer">
          <strong>{currency.format(product.priceInCents / 100)}</strong>
          <span className="home-dish-btn">Ver Prato <b aria-hidden="true">+</b></span>
        </div>
      </div>
    </Link>
  );
}

function HomeIcon({ name }: { name: 'home' | 'waiter' | 'bill' }) {
  if (name === 'home') return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
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

export function HomePage() {
  const { restaurantSlug = '' } = useParams();
  const { restaurant } = useRestaurant();
  const table = useTableContext();
  const { menu, getProductLikesCount } = usePublicMenu();
  const [activeBanner, setActiveBanner] = useState(0);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
  const bannerRail = useRef<HTMLDivElement>(null);
  const tableQuery = getTableQueryString(table);

  if (!menu) return <PublicMenuStatus />;

  const products = [...menu.products]
    .filter((product) => product.available && product.restaurantId === menu.restaurantId)
    .sort(compareCatalogOrder);
  const featuredProducts = products.filter((product) => product.featured);
  const banners = (featuredProducts.length ? featuredProducts : products).slice(0, 5);
  const entryProducts = products.filter((product) => {
    const category = menu.categories.find((item) => item.id === product.categoryId);
    return /entrad|aperitivo|entrada|starter/i.test(`${category?.name ?? ''} ${category?.slug ?? ''}`);
  });
  const highlights = entryProducts.length ? entryProducts.slice(0, 8) : products.slice(0, 4);
  const highlightIds = new Set(highlights.map((product) => product.id));
  const remainingProducts = products.filter((product) => !highlightIds.has(product.id));
  // "Mais Amados" ordena por likesCount real decrescente, com desempate determinístico por sortOrder e id
  const lovedPool = remainingProducts.length > 0 ? remainingProducts : products;
  const otherProducts = [...lovedPool].sort((a, b) => {
    const likesA = getProductLikesCount(a.id);
    const likesB = getProductLikesCount(b.id);
    const likesDiff = likesB - likesA;
    if (likesDiff !== 0) return likesDiff;
    const sortDiff = a.sortOrder - b.sortOrder;
    if (sortDiff !== 0) return sortDiff;
    return a.id.localeCompare(b.id);
  }).slice(0, 8);

  function scrollToBanner(index: number) {
    const rail = bannerRail.current;
    const card = rail?.children.item(index);
    if (!rail || !(card instanceof HTMLElement)) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft, behavior: reducedMotion ? 'instant' : 'smooth' });
  }

  return (
    <div className="home-page">
      <section className="home-promo-section" aria-label="Destaques do restaurante">
        {banners.length ? (
          <div
            ref={bannerRail}
            className="home-promo-rail"
            role="region"
            aria-label="Destaques. Deslize para os lados."
            onScroll={(event) => {
              const rail = event.currentTarget;
              const cards = Array.from(rail.children);
              const nearest = cards.reduce((best, child, index) => {
                if (!(child instanceof HTMLElement)) return best;
                if (!(best.card instanceof HTMLElement)) return { card: child, index };
                return Math.abs(child.offsetLeft - rail.scrollLeft) < Math.abs(best.card.offsetLeft - rail.scrollLeft)
                  ? { card: child, index }
                  : best;
              }, { card: null as Element | null, index: 0 });
              setActiveBanner(nearest.index);
            }}
          >
            {banners.map((product, index) => {
              const image = getCover(product);
              return (
                <Link
                  key={product.id}
                  to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                  className="home-promo-card"
                  aria-label={`Destaque ${index + 1}: ${product.name}. Ver prato`}
                >
                  {image ? (
                    <img src={image.url} alt={image.alt} className="home-promo-image" fetchPriority={index === 0 ? 'high' : 'auto'} decoding="async" />
                  ) : (
                    <div className="home-promo-image home-promo-fallback" aria-hidden="true" />
                  )}
                  <span className="home-promo-shade" />
                  <span className="home-promo-badge">Patrocinado</span>
                  <div className="home-promo-content">
                    <h2 className="home-promo-title">Destaques<br />da Semana</h2>
                    <p className="home-promo-desc">O melhor da nossa culinária contemporânea</p>
                  </div>
                  <span className="home-promo-tag">Parceria Especial</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="home-promo-empty">
            <span className="home-section-kicker">{restaurant.name} · {restaurant.subtitle}</span>
            <h1>Destaques da semana</h1>
            <p>O cardápio está sendo preparado. Volte em breve.</p>
          </div>
        )}
        {banners.length > 1 && (
          <div className="home-promo-dots" aria-label={`Destaque ${activeBanner + 1} de ${banners.length}`}>
            {banners.map((product, index) => (
              <button
                key={product.id}
                type="button"
                className={index === activeBanner ? 'active' : ''}
                aria-label={`Ver destaque ${index + 1}`}
                aria-current={index === activeBanner ? 'true' : undefined}
                onClick={() => scrollToBanner(index)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="home-section" aria-labelledby="home-highlights-title">
        <div className="home-section-heading">
          <h2 id="home-highlights-title">Destaques e Entradas</h2>
        </div>
        {highlights.length ? (
          <ul className="home-dish-rail" aria-label="Pratos em destaque. Deslize para os lados.">
            {highlights.map((product) => (
              <li key={product.id}>
                <ProductCard
                  product={product}
                  restaurantSlug={restaurantSlug}
                  tableQuery={tableQuery}
                  likesCount={getProductLikesCount(product.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="home-empty">Este restaurante ainda não publicou produtos disponíveis.</p>
        )}
      </section>

      {otherProducts.length > 0 && (
        <section className="home-section" aria-labelledby="home-more-title">
          <div className="home-section-heading">
            <h2 id="home-more-title">Mais Amados</h2>
          </div>
          <ul className="home-loved-rail" aria-label="Mais amados do cardápio. Deslize para os lados.">
            {otherProducts.map((product) => {
              const image = getCover(product);
              const likesCount = getProductLikesCount(product.id);
              return (
                <li key={product.id}>
                  <Link
                    to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                    className="home-loved-card"
                    aria-label={`Ver ${product.name}, ${likesCount === 1 ? '1 curtida' : `${likesCount} curtidas`}`}
                  >
                    {image ? <img src={image.url} alt={image.alt} loading="lazy" decoding="async" /> : <span aria-hidden="true" className="home-loved-placeholder" />}
                    <span className="home-loved-rating" aria-hidden="true">
                      <HeartBadgeIcon />
                      {formatLikes(likesCount)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {restaurant.googleReviewUrl && (
        <section className="home-google-review-section" aria-label="Avaliações do restaurante">
          <div className="home-google-card">
            <div className="home-google-card-header">
              <div className="home-google-badge">
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                  className="home-google-g-icon"
                >
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>Google</span>
              </div>
              <span className="home-google-verified-tag">Avaliação oficial</span>
            </div>

            <div className="home-google-card-body">
              <div className="home-google-stars-group" aria-hidden="true">
                <div className="home-google-stars-bar">
                  <span className="home-google-star-glyph">★</span>
                  <span className="home-google-star-glyph">★</span>
                  <span className="home-google-star-glyph">★</span>
                  <span className="home-google-star-glyph">★</span>
                  <span className="home-google-star-glyph">★</span>
                </div>
                <span className="home-google-stars-sub">Experiência dos clientes</span>
              </div>

              <div className="home-google-cta-copy">
                <h3 className="home-google-title">Avalie este restaurante</h3>
                <p className="home-google-desc">Sua avaliação será publicada no Google</p>
              </div>
            </div>

            <div className="home-google-card-footer">
              <a
                href={restaurant.googleReviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="home-google-action-btn"
                aria-label={`Avaliar ${restaurant.name} no Google (abre em nova aba)`}
              >
                <span>Avaliar</span>
                <span className="home-google-action-arrow" aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </section>
      )}

      <nav className="home-bottom-nav" aria-label="Ações da mesa">
        <Link to={`/${restaurantSlug}${tableQuery}`} className="active" aria-current="page">
          <HomeIcon name="home" /><span>Início</span>
        </Link>
        <button type="button" onClick={() => setActiveAction('waiter')}>
          <HomeIcon name="waiter" /><span>Chamar Garçom</span>
        </button>
        <Link to={`/${restaurantSlug}/comanda${tableQuery}`}>
          <HomeIcon name="bill" /><span>Comanda</span>
        </Link>
      </nav>

      <ServiceActionPopup
        isOpen={!!activeAction}
        mode={activeAction}
        onClose={() => setActiveAction(null)}
      />
    </div>
  );
}
