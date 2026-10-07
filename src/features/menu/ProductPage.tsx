import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { menus } from '../../data/menu';
import type { Product, ProductImage } from '../../types/menu';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function GalleryImage({ image }: { image: ProductImage }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className="flex aspect-[4/3] items-center justify-center bg-[#F1E8DE] p-6 text-center text-[#62564B]"
        role="img"
        aria-label={image.alt}
      >
        Foto em preparação
      </div>
    );
  }

  return (
    <img
      src={image.url}
      alt={image.alt}
      className="aspect-[4/3] w-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function ProductGallery({ product }: { product: Product }) {
  const [activeIndex, setActiveIndex] = useState(0);

  const images = [...product.images].sort((a, b) => {
    if (a.id === product.coverImageId) return -1;
    if (b.id === product.coverImageId) return 1;
    return a.sortOrder - b.sortOrder;
  });

  function moveTo(
    container: HTMLDivElement,
    index: number,
  ) {
    const target = container.children.item(index);

    if (!(target instanceof HTMLElement)) return;

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    container.scrollTo({
      left: target.offsetLeft,
      behavior: reducedMotion ? 'instant' : 'smooth',
    });
  }

  if (images.length === 0) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-[#F1E8DE]">
        Foto em preparação
      </div>
    );
  }

  return (
    <section aria-label={`Fotos de ${product.name}`}>
      <div
        className="relative flex snap-x snap-mandatory overflow-x-auto rounded-2xl"
        role="region"
        aria-label="Galeria de fotos. Deslize para os lados."
        tabIndex={0}
        onScroll={(event) => {
          const container = event.currentTarget;
          const width = container.clientWidth;

          if (width === 0) return;

          const index = Math.round(container.scrollLeft / width);

          setActiveIndex(
            Math.max(0, Math.min(images.length - 1, index)),
          );
        }}
        onKeyDown={(event) => {
          const direction =
            event.key === 'ArrowRight'
              ? 1
              : event.key === 'ArrowLeft'
                ? -1
                : 0;

          if (!direction) return;

          event.preventDefault();

          moveTo(
            event.currentTarget,
            Math.max(
              0,
              Math.min(images.length - 1, activeIndex + direction),
            ),
          );
        }}
      >
        {images.map((image) => (
          <div
            key={image.id}
            className="w-full shrink-0 snap-start snap-always"
          >
            <GalleryImage key={image.url} image={image} />
          </div>
        ))}
      </div>

      {images.length > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={activeIndex === 0}
            aria-label="Foto anterior"
            className="min-h-11 rounded-lg border border-[#DED7CD] px-4 disabled:opacity-40"
            onClick={(event) => {
              const container =
                event.currentTarget.parentElement
                  ?.previousElementSibling;

              if (container instanceof HTMLDivElement) {
                moveTo(container, activeIndex - 1);
              }
            }}
          >
            ← Anterior
          </button>

          <span className="text-sm" role="status">
            {activeIndex + 1} de {images.length}
          </span>

          <button
            type="button"
            disabled={activeIndex === images.length - 1}
            aria-label="Próxima foto"
            className="min-h-11 rounded-lg border border-[#DED7CD] px-4 disabled:opacity-40"
            onClick={(event) => {
              const container =
                event.currentTarget.parentElement
                  ?.previousElementSibling;

              if (container instanceof HTMLDivElement) {
                moveTo(container, activeIndex + 1);
              }
            }}
          >
            Próxima →
          </button>
        </div>
      )}
    </section>
  );
}

export function ProductPage() {
  const {
    restaurantSlug = '',
    productSlug = '',
  } = useParams();

  const product = menus[restaurantSlug]?.products.find(
    (item) => item.slug === productSlug,
  );

  if (!product) {
    return (
      <section className="panel">
        <h1>Produto não encontrado</h1>
        <p>Este produto não está disponível neste endereço.</p>
        <Link
          to={`/${restaurantSlug}`}
          className="mt-4 inline-block underline"
        >
          Voltar ao cardápio
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to={`/${restaurantSlug}`}
        className="inline-flex min-h-11 items-center underline"
      >
        ← Voltar ao cardápio
      </Link>

      <ProductGallery key={product.id} product={product} />

      <section aria-labelledby="product-title">
        {product.featured && (
          <span className="eyebrow">Destaque da casa</span>
        )}

        <h1 id="product-title">{product.name}</h1>

        <p className="text-2xl font-bold text-[var(--brand)]">
          {currency.format(product.priceInCents / 100)}
        </p>

        {!product.available && (
          <p className="font-medium">Indisponível no momento</p>
        )}

        <p>{product.description}</p>
      </section>

      {!!product.variants?.length && (
        <section className="panel" aria-labelledby="variants-title">
          <h2 id="variants-title" className="text-lg font-bold">
            Opções e preços
          </h2>

          <ul className="mt-3 space-y-3">
            {product.variants.map((variant) => (
              <li
                key={variant.id}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {variant.name}
                  {!variant.available && ' · Indisponível'}
                </span>
                <strong>
                  {currency.format(variant.priceInCents / 100)}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="dietary-title">
        <h2 id="dietary-title" className="text-lg font-bold">
          Ingredientes e restrições
        </h2>
        <p>
          {product.dietaryInformation ||
            'Consulte a equipe sobre alergênicos e adaptações.'}
        </p>
      </section>

      <p className="text-sm">Faça seu pedido com o garçom.</p>
    </div>
  );
}