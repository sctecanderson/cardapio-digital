import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { useTableContext } from '../tables/useTableContext';
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

function ProductCard({ product, restaurantSlug, tableQuery }: {
  product: Product;
  restaurantSlug: string;
  tableQuery: string;
}) {
  const image = getCover(product);

  return (
    <Link
      to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
      className="home-dish-card"
      aria-label={`${product.name}, ${currency.format(product.priceInCents / 100)}. Ver prato`}
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
        <span className="home-dish-rating">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          {product.featured ? '4.9 (120)' : '4.8'}
        </span>
      </div>
      <div className="home-dish-copy">
        <div className="home-dish-title-row">
          <h3>{product.name}</h3>
          {product.featured && (
            <span className="home-dish-inline-rating">
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              4.9 (120)
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
  const { menu } = usePublicMenu();
  const [activeBanner, setActiveBanner] = useState(0);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
  const bannerRail = useRef<HTMLDivElement>(null);
  const tableQuery = table.status === 'unverified'
    ? `?mesa=${table.tableNumber}`
    : '';

  if (!menu) return <PublicMenuStatus />;

  const products = [...menu.products]
    .filter((product) => product.available)
    .sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder);
  const featuredProducts = products.filter((product) => product.featured);
  const banners = (featuredProducts.length ? featuredProducts : products).slice(0, 5);
  const entryProducts = products.filter((product) => {
    const category = menu.categories.find((item) => item.id === product.categoryId);
    return /entrad|aperitivo|entrada|starter/i.test(`${category?.name ?? ''} ${category?.slug ?? ''}`);
  });
  const highlights = entryProducts.length ? entryProducts.slice(0, 8) : products.slice(0, 4);
  const highlightIds = new Set(highlights.map((product) => product.id));
  const remainingProducts = products.filter((product) => !highlightIds.has(product.id));
  // "Mais Amados" usa os produtos restantes, ou os mais bem ranqueados do catálogo se a lista for curta
  const otherProducts = (remainingProducts.length > 0 ? remainingProducts : products).slice(0, 8);

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
                <ProductCard product={product} restaurantSlug={restaurantSlug} tableQuery={tableQuery} />
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
              return (
                <li key={product.id}>
                  <Link to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`} className="home-loved-card" aria-label={`Ver ${product.name}`}>
                    {image ? <img src={image.url} alt={image.alt} loading="lazy" decoding="async" /> : <span aria-hidden="true" className="home-loved-placeholder" />}
                    <span className="home-loved-rating">
                      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                      5.0
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
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
