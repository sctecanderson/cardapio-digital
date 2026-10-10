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

type MenuAction = 'waiter' | 'bill' | null;

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function getCover(product: Product) {
  return product.images.find((image) => image.id === product.coverImageId)
    ?? product.images[0]
    ?? null;
}

function MenuIcon({ name }: { name: 'home' | 'waiter' | 'bill' }) {
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

export function MenuPage() {
  const { restaurantSlug = '' } = useParams();
  return (
    <RestaurantMenuContent
      key={restaurantSlug}
      restaurantSlug={restaurantSlug}
    />
  );
}

function RestaurantMenuContent({
  restaurantSlug,
}: {
  restaurantSlug: string;
}) {
  const table = useTableContext();
  const { restaurant } = useRestaurant();
  const tableQuery = table.status === 'unverified' ? `?mesa=${table.tableNumber}` : '';

  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);

  const catalog = usePublicMenu();
  const menu = catalog.menu;

  if (!menu) return <PublicMenuStatus />;

  if (menu.products.length === 0) {
    return (
      <div className="menu-page">
        <section className="home-promo-empty">
          <h1>Cardápio em preparação</h1>
          <p>Este restaurante ainda não publicou produtos disponíveis.</p>
        </section>
      </div>
    );
  }

  const categories = [...menu.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const products = [...menu.products].sort((a, b) => a.sortOrder - b.sortOrder);
  const search = normalize(query);

  const filteredProducts = products.filter((product) => {
    const matchesCategory = categoryId === 'all' || product.categoryId === categoryId;
    const matchesSearch = normalize(
      `${product.name} ${product.shortDescription} ${product.description}`,
    ).includes(search);
    return matchesCategory && matchesSearch;
  });

  // Prato em destaque (Hero) do cardápio: o primeiro disponível ou com flag featured
  const featuredProduct = products.find((p) => p.featured && p.available) ?? products[0];
  const showFeaturedHero = featuredProduct && categoryId === 'all' && !search;
  
  // Itens da lista compacta (excluindo o destaque principal caso ele esteja em exibição hero)
  const listProducts = showFeaturedHero
    ? filteredProducts.filter((p) => p.id !== featuredProduct.id)
    : filteredProducts;

  return (
    <div className="menu-page">
      {/* Linha superior: botão de busca discreto */}
      <div className="menu-top-row">
        <button
          type="button"
          className="menu-search-toggle"
          aria-label={searchOpen ? 'Fechar busca' : 'Buscar no cardápio'}
          aria-expanded={searchOpen}
          aria-controls="menu-search"
          onClick={() => setSearchOpen((open) => !open)}
        >
          {searchOpen ? (
            <span aria-hidden="true">×</span>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4.5 4.5" />
            </svg>
          )}
        </button>
      </div>

      {/* Campo expansível de busca */}
      {searchOpen && (
        <div className="menu-search-field">
          <svg viewBox="0 0 24 24" fill="none" stroke="#8c7867" strokeWidth="2" width="18" height="18" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4.5 4.5" />
          </svg>
          <label htmlFor="menu-search" className="sr-only">
            Buscar prato ou bebida
          </label>
          <input
            id="menu-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar no cardápio..."
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="menu-search-clear"
            >
              Limpar
            </button>
          )}
        </div>
      )}

      {/* Filtro de Categorias (Pills horizontais) */}
      <div className="menu-categories-rail" role="group" aria-label="Categorias">
        {[{ id: 'all', name: 'Todos' }, ...categories].map((category) => {
          const selected = categoryId === category.id;
          return (
            <button
              key={category.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setCategoryId(category.id)}
              className={`menu-category-pill ${selected ? 'active' : ''}`}
            >
              {category.name}
            </button>
          );
        })}
      </div>

      {/* Prato Hero em Destaque (Estilo Polvo Grelhado da referência) */}
      {showFeaturedHero && (
        <section aria-label="Destaque principal">
          {(() => {
            const image = getCover(featuredProduct);
            return (
              <Link
                to={`/${restaurantSlug}/produto/${featuredProduct.slug}${tableQuery}`}
                className="menu-featured-card"
                aria-label={`${featuredProduct.name}, ${currency.format(featuredProduct.priceInCents / 100)}`}
              >
                <div className="menu-featured-image-wrap">
                  {image ? (
                    <img
                      src={image.url}
                      alt={image.alt}
                      className="menu-featured-image"
                      fetchPriority="high"
                    />
                  ) : (
                    <div className="home-dish-placeholder">
                      {featuredProduct.name}
                    </div>
                  )}
                  <span className="menu-featured-rating">
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    4.9
                  </span>
                </div>
                <div className="menu-featured-copy">
                  <div className="menu-featured-header-row">
                    <h2 className="menu-featured-title">{featuredProduct.name}</h2>
                    <span className="menu-featured-inline-rating">
                      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                      4.9
                    </span>
                  </div>
                  <div className="menu-featured-desc-row">
                    <p className="menu-featured-desc">{featuredProduct.shortDescription || featuredProduct.description}</p>
                    <strong className="menu-featured-price">{currency.format(featuredProduct.priceInCents / 100)}</strong>
                  </div>
                </div>
              </Link>
            );
          })()}
        </section>
      )}

      {/* Lista de Pratos Compactos (Estilo Risoto / Bruschetta da referência) */}
      <section aria-label="Lista de pratos">
        {listProducts.length === 0 ? (
          <div className="home-empty">
            <p>Nenhum produto encontrado para os filtros selecionados.</p>
          </div>
        ) : (
          <ul className="menu-items-list">
            {listProducts.map((product) => {
              const image = getCover(product);
              return (
                <li key={product.id}>
                  <Link
                    to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                    className="menu-item-card"
                    aria-label={`${product.name}, ${currency.format(product.priceInCents / 100)}`}
                  >
                    <div className="menu-item-image-wrap">
                      {image ? (
                        <img
                          src={image.url}
                          alt={image.alt}
                          className="menu-item-image"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="home-dish-placeholder">
                          {product.name}
                        </div>
                      )}
                    </div>
                    <div className="menu-item-copy">
                      <h3 className="menu-item-title">{product.name}</h3>
                      <p className="menu-item-desc">{product.shortDescription || product.description}</p>
                      <div className="menu-item-footer">
                        <strong className="menu-item-price">{currency.format(product.priceInCents / 100)}</strong>
                        <span className="menu-item-rating">
                          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                          {product.featured ? '4.8' : '4.7'}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Dock / Barra de ações inferior flutuante */}
      <nav className="home-bottom-nav" aria-label="Ações da mesa">
        <Link to={`/${restaurantSlug}${tableQuery}`}>
          <MenuIcon name="home" /><span>Início</span>
        </Link>
        <button type="button" onClick={() => setActiveAction('waiter')}>
          <MenuIcon name="waiter" /><span>Chamar Garçom</span>
        </button>
        <Link to={`/${restaurantSlug}/comanda${tableQuery}`}>
          <MenuIcon name="bill" /><span>Comanda</span>
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
