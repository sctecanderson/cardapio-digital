import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { menus } from '../../data/menu';
import { ExploreMedia } from './ExploreMedia';


const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
});

export function ExplorePage() {
    const { restaurantSlug = '' } = useParams();

    return (
        <ExploreFeed
            key={restaurantSlug}
            restaurantSlug={restaurantSlug}
        />
    );
}

function ExploreFeed({
    restaurantSlug,
}: {
    restaurantSlug: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    const menu = menus[restaurantSlug];

    const products = [...(menu?.products ?? [])]
        .filter((product) => product.available)
        .sort((a, b) => a.sortOrder - b.sortOrder);

    const productIds = products.map((product) => product.id).join('|');

    useEffect(() => {
        const container = containerRef.current;

        if (!container) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

                if (!visible) return;

                const index = Number(
                    (visible.target as HTMLElement).dataset.index,
                );

                if (Number.isInteger(index)) {
                    setActiveIndex(index);
                }
            },
            {
                root: container,
                threshold: 0.6,
            },
        );

        Array.from(container.children).forEach((slide) => {
            observer.observe(slide);
        });

        return () => observer.disconnect();
    }, [productIds]);

    function moveTo(index: number) {
        const container = containerRef.current;
        const target = container?.children.item(index);

        if (!container || !(target instanceof HTMLElement)) return;

        const reducedMotion = window.matchMedia(
            '(prefers-reduced-motion: reduce)',
        ).matches;

        container.scrollTo({
            top: target.offsetTop,
            behavior: reducedMotion ? 'instant' : 'smooth',
        });
    }

    if (!menu || products.length === 0) {
        return (
            <section className="panel">
                <h1>Nenhum produto para explorar</h1>
                <p>Confira as opções disponíveis no cardápio.</p>
                <Link
                    to={`/${restaurantSlug}`}
                    className="mt-3 inline-flex min-h-11 items-center underline"
                >
                    Voltar ao cardápio
                </Link>
            </section>
        );
    }

    return (
        <section aria-label="Explorar os produtos">
            <div
                ref={containerRef}
                className="relative h-[calc(100svh-240px)] min-h-[420px] snap-y snap-mandatory overflow-y-auto rounded-2xl bg-[#111512]"
                role="region"
                aria-label="Feed de pratos. Deslize para cima ou para baixo."
                tabIndex={0}
                onKeyDown={(event) => {
                    // Não interfere com teclas usadas nos links internos.
                    if (event.target !== event.currentTarget) return;

                    const direction =
                        event.key === 'ArrowDown'
                            ? 1
                            : event.key === 'ArrowUp'
                                ? -1
                                : 0;

                    if (!direction) return;

                    event.preventDefault();

                    moveTo(
                        Math.max(
                            0,
                            Math.min(products.length - 1, activeIndex + direction),
                        ),
                    );
                }}
            >
                {products.map((product, index) => (
                    <article
                        key={product.id}
                        data-index={index}
                        className="relative flex h-full snap-start snap-always flex-col justify-end overflow-hidden text-white"
                        aria-label={`${product.name}, produto ${index + 1} de ${products.length}`}
                    >
                        <ExploreMedia
                            key={product.id}
                            product={product}
                            active={index === activeIndex}
                            nearby={Math.abs(index - activeIndex) === 1}
                        />

                        <div
                            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"
                            aria-hidden="true"
                        />

                        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
                            {product.featured ? (
                                <span className="rounded-full bg-[var(--brand)] px-3 py-2 text-xs font-medium">
                                    Destaque da casa
                                </span>
                            ) : (
                                <span />
                            )}

                            <span className="rounded-full bg-black/60 px-3 py-2 text-xs">
                                {index + 1} / {products.length}
                            </span>
                        </div>

                        <div className="relative p-5">
                            <h2 className="text-2xl font-bold">
                                {product.name}
                            </h2>

                            <p className="mt-2 text-sm">
                                {product.shortDescription}
                            </p>

                            <p className="mt-3 text-2xl font-bold">
                                {currency.format(product.priceInCents / 100)}
                            </p>

                            <Link
                                to={`/${restaurantSlug}/produto/${product.slug}`}
                                aria-label={`Ver detalhes de ${product.name}`}
                                className="mt-3 inline-flex min-h-11 items-center rounded-full border border-white px-5 font-medium"
                            >
                                Ver detalhes
                            </Link>

                            <p className="mt-4 text-center text-xs">
                                {index === products.length - 1
                                    ? 'Fim da seleção · deslize para baixo para voltar'
                                    : 'Deslize para cima para descobrir ↑'}
                            </p>
                        </div>
                    </article>
                ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
                <button
                    type="button"
                    disabled={activeIndex === 0}
                    onClick={() => moveTo(activeIndex - 1)}
                    className="min-h-11 rounded-lg border border-[#DED7CD] px-3 disabled:opacity-40"
                >
                    ↑ Anterior
                </button>

                <span className="text-sm" role="status">
                    {activeIndex + 1} de {products.length}
                </span>

                <button
                    type="button"
                    disabled={activeIndex === products.length - 1}
                    onClick={() => moveTo(activeIndex + 1)}
                    className="min-h-11 rounded-lg border border-[#DED7CD] px-3 disabled:opacity-40"
                >
                    Próximo ↓
                </button>
            </div>
        </section>
    );
}