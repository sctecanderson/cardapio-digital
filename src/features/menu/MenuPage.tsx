import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePublicMenu, PublicMenuStatus } from './PublicMenuProvider';
import type { Product } from '../../types/menu';
import { useTableContext } from '../tables/useTableContext';
import { GuestSessionPanel } from '../tables/GuestSessionPanel';
import { WaiterCallPanel } from '../service/WaiterCallPanel';
import { GuestTabPanel } from '../service/GuestTabPanel';


const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function ProductImage({
  product,
  large = false,
}: {
  product: Product;
  large?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const cover = product.images.find(
    (image) => image.id === product.coverImageId,
  );

  const className = large
    ? 'aspect-[16/10] w-full'
    : 'h-24 w-24 shrink-0';

  if (!cover || failedUrl === cover.url) {
    return (
      <div
        className={`${className} flex items-center justify-center rounded-xl bg-[#F1E8DE] p-3 text-center text-xs text-[#62564B]`}
        role="img"
        aria-label={`Foto de ${product.name} ainda não disponível`}
      >
        Foto em preparação
      </div>
    );
  }

  return (
    <img
      src={cover.url}
      alt={cover.alt}
      className={`${className} rounded-xl object-cover`}
      loading={large ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailedUrl(cover.url)}
    />
  );
}

export function MenuPage() {
  const { restaurantSlug = '' } = useParams();

  // Reinicia busca e categoria ao mudar de restaurante.
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

  const tableQuery =
    table.status === 'unverified'
      ? `?mesa=${table.tableNumber}`
      : '';
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('all');

  const catalog = usePublicMenu();
  const menu = catalog.menu;

  if (!menu) {
    return <div className="space-y-6">
      <WaiterCallPanel />
      <GuestSessionPanel />
      <GuestTabPanel />
      <PublicMenuStatus />
    </div>;
  }

  if (menu.products.length === 0) {
    return <div className="space-y-6">
      <WaiterCallPanel />
      <GuestSessionPanel />
      <GuestTabPanel />
      <section className="panel">
        <h1>Cardápio em preparação</h1>
        <p>Este restaurante ainda não publicou produtos em categorias ativas.</p>
      </section>
    </div>;
  }

  const categories = [...menu.categories].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  const products = [...menu.products].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  const search = normalize(query);

  const filteredProducts = products.filter((product) => {
    const matchesCategory =
      categoryId === 'all' || product.categoryId === categoryId;

    const matchesSearch = normalize(
      `${product.name} ${product.shortDescription} ${product.description}`,
    ).includes(search);

    return matchesCategory && matchesSearch;
  });

  const featuredProduct = products.find(
    (product) => product.featured && product.available,
  );

  const showFeatured =
    featuredProduct && categoryId === 'all' && !search;

  return (
    <div className="space-y-6">
      <WaiterCallPanel />
      <GuestSessionPanel />
      <GuestTabPanel />

      <section aria-label="Pesquisar e filtrar produtos">
        <label htmlFor="menu-search" className="sr-only">
          Buscar prato ou bebida
        </label>

        <div className="flex items-center gap-2 rounded-xl border border-[#DED7CD] bg-white px-4">
          <input
            id="menu-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar prato ou bebida"
            className="min-w-0 flex-1 bg-transparent py-3 text-base"
          />

          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="min-h-11 px-2 text-sm underline"
            >
              Limpar
            </button>
          )}
        </div>

        <div
          className="mt-4 flex gap-2 overflow-x-auto pb-2"
          role="group"
          aria-label="Categorias"
        >
          {[
            { id: 'all', name: 'Todos' },
            ...categories,
          ].map((category) => {
            const selected = categoryId === category.id;

            return (
              <button
                key={category.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setCategoryId(category.id)}
                className={`min-h-11 shrink-0 rounded-full border px-5 text-sm ${selected
                  ? 'border-transparent bg-[var(--brand)] text-white'
                  : 'border-[#DED7CD] bg-white'
                  }`}
              >
                {category.name}
              </button>
            );
          })}
        </div>
      </section>

      {showFeatured && (
        <section aria-labelledby="featured-title">
          <h2
            id="featured-title"
            className="mb-3 text-2xl font-bold"
          >
            Destaque da casa
          </h2>

          <article className="overflow-hidden rounded-2xl border border-[#DED7CD] bg-white">
            <ProductImage product={featuredProduct} large />

            <div className="p-4">
              <h3 className="text-xl font-bold">
                {featuredProduct.name}
              </h3>
              <p>{featuredProduct.shortDescription}</p>
              <strong className="text-xl text-[var(--brand)]">
                {currency.format(featuredProduct.priceInCents / 100)}
              </strong>
              <Link
                to={`/${restaurantSlug}/produto/${featuredProduct.slug}${tableQuery}`}
                aria-label={`Ver detalhes de ${featuredProduct.name}`}
                className="mt-3 inline-flex min-h-11 items-center font-medium text-[var(--brand)] underline underline-offset-4"
              >
                Ver detalhes →
              </Link>
            </div>
          </article>
        </section>
      )}

      <section aria-labelledby="menu-title">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="menu-title" className="text-2xl font-bold">
            Cardápio
          </h2>

          <span className="text-sm" role="status">
            {filteredProducts.length}{' '}
            {filteredProducts.length === 1 ? 'produto' : 'produtos'}
          </span>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="panel">
            <h3 className="font-bold">Nenhum produto encontrado</h3>
            <p>Tente outro nome ou selecione uma categoria diferente.</p>

            <button
              type="button"
              onClick={() => {
                setQuery('');
                setCategoryId('all');
              }}
              className="mt-3 min-h-11 underline"
            >
              Limpar filtros
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {filteredProducts.map((product) => (
              <li key={product.id}>
                <article className="flex gap-4 rounded-2xl border border-[#DED7CD] bg-white p-3">
                  <ProductImage product={product} />

                  <div className="min-w-0 flex-1">
                    <h3 className="font-bold">{product.name}</h3>

                    <p className="text-sm">
                      {product.shortDescription}
                    </p>

                    <strong className="text-[var(--brand)]">
                      {currency.format(product.priceInCents / 100)}
                    </strong>

                    {!product.available && (
                      <span className="mt-1 block text-sm font-medium">
                        Indisponível no momento
                      </span>
                    )}
                    <Link
                      to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                      aria-label={`Ver detalhes de ${product.name}`}
                      className="mt-1 flex min-h-11 w-fit items-center text-sm font-medium text-[var(--brand)] underline underline-offset-4"
                    >
                      Ver detalhes →
                    </Link>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}