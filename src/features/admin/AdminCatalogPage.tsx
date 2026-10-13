import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import type { StaffAccess } from "../auth/staffAuth";
import { getAdminCatalog } from "./adminCatalog";
import type { AdminCatalog } from "./adminCatalog";
import { CatalogEditor } from "./CatalogEditor";
import type { CatalogSelection } from "./CatalogEditor";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const buttonClass =
  "min-h-11 rounded-xl border border-black/20 px-4 py-2 text-sm font-medium disabled:opacity-50";
function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function AdminCatalogPage() {
  const { restaurantSlug = "" } = useParams();
  const access = useOutletContext<StaffAccess>();
  return (
    <CatalogContent
      key={`${restaurantSlug}:${access.memberId}`}
      restaurantSlug={restaurantSlug}
      restaurantId={access.restaurantId}
    />
  );
}

function CatalogContent({
  restaurantSlug,
  restaurantId,
}: {
  restaurantSlug: string;
  restaurantId: string;
}) {
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [section, setSection] = useState<"product" | "category">("product");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selection, setSelection] = useState<CatalogSelection | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    async function load() {
      try {
        const result = await getAdminCatalog(restaurantSlug);
        if (!disposed) setCatalog(result);
      } catch (cause) {
        if (!disposed) {
          setCatalog(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível carregar o catálogo.",
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => {
      disposed = true;
    };
  }, [restaurantSlug, refresh]);

  function open(selection: CatalogSelection) {
    setNotice("");
    setSelection(selection);
  }
  function saved() {
    setSelection(null);
    setNotice(
      "Alterações salvas. O cardápio público será atualizado em até 60 segundos; recarregue a página para ver agora.",
    );
    setRefresh((value) => value + 1);
  }
  const categories = catalog?.categories ?? [];
  const categoryMap = new Map(
    categories.map((category) => [category.id, category]),
  );
  const search = normalize(query);
  const products = (catalog?.products ?? []).filter(
    (product) =>
      (categoryFilter === "all" || product.category_id === categoryFilter) &&
      normalize(`${product.name} ${product.short_description}`).includes(
        search,
      ),
  );
  const filteredCategories = categories.filter((category) =>
    normalize(category.name).includes(search),
  );

  return (
    <div className="space-y-5">
      <header>
        <span className="eyebrow">Administração</span>
        <h1>Seu catálogo</h1>
        <p className="text-sm opacity-75">
          Organize as categorias e mantenha os produtos e preços atualizados.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link
            className={`${buttonClass} inline-flex items-center`}
            to={`/${restaurantSlug}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ver cardápio ↗
          </Link>
          <Link
            className={`${buttonClass} inline-flex items-center`}
            to={`/${restaurantSlug}/equipe`}
          >
            Atendimento
          </Link>
          <Link
            className={`${buttonClass} inline-flex items-center`}
            to={`/${restaurantSlug}/acesso`}
          >
            Minha conta
          </Link>
        </div>
      </header>

      {notice && (
        <p
          role="status"
          className="rounded-xl bg-green-50 p-4 text-sm text-green-900"
        >
          {notice}
        </p>
      )}

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Área do catálogo"
      >
        {(["product", "category"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={!!selection}
            aria-pressed={section === kind}
            onClick={() => {
              setSection(kind);
              setQuery("");
            }}
            className={`${buttonClass} ${section === kind ? "bg-[var(--brand)] text-white" : "bg-white"}`}
          >
            {kind === "product"
              ? `Produtos (${catalog?.products.length ?? 0})`
              : `Categorias (${categories.length})`}
          </button>
        ))}
        <button
          type="button"
          disabled={loading || !!selection}
          className={`${buttonClass} ml-auto`}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Atualizar
        </button>
      </div>

      {selection && catalog ? (
        <CatalogEditor
          key={`${selection.kind}:${selection.entry?.id ?? "new"}`}
          selection={selection}
          categories={categories}
          restaurantSlug={restaurantSlug}
          restaurantId={restaurantId}
          onSaved={saved}
          onCancel={() => setSelection(null)}
        />
      ) : loading ? (
        <p role="status" className="panel">
          Carregando catálogo…
        </p>
      ) : error ? (
        <div className="panel">
          <p role="alert" className="text-red-800">
            {error}
          </p>
          <button
            className={buttonClass}
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Tentar novamente
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">
              {section === "product" ? "Produtos" : "Categorias"}
            </h2>
            <button
              type="button"
              className={`${buttonClass} bg-[var(--brand)] text-white`}
              disabled={section === "product" && categories.length === 0}
              onClick={() =>
                open(
                  section === "product"
                    ? { kind: "product", entry: null }
                    : { kind: "category", entry: null },
                )
              }
            >
              {section === "product" ? "+ Novo produto" : "+ Nova categoria"}
            </button>
          </div>
          {section === "product" && categories.length === 0 && (
            <p className="panel">
              Cadastre uma categoria antes de adicionar produtos.
            </p>
          )}
          <label className="block text-sm font-medium">
            {section === "product" ? "Buscar produto" : "Buscar categoria"}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-black/20 bg-white px-4"
            />
          </label>
          {section === "product" && (
            <label className="block text-sm font-medium">
              Filtrar por categoria
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-black/20 bg-white px-3"
              >
                <option value="all">Todas as categorias</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.active ? "" : " — oculta"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-sm opacity-75">
            A ordem é crescente: números menores aparecem primeiro.
          </p>
          {section === "product" ? (
            <>
              {products.length === 0 && (
                <p role="status" className="panel">
                  Nenhum produto encontrado.
                </p>
              )}
              <ul className="grid gap-3 sm:grid-cols-2">
                {products.map((product) => (
                  <li
                    key={product.id}
                    className="catalog-card flex flex-col rounded-2xl border border-black/10 bg-white p-4"
                  >
                    <>
                      {product.images.find(
                        (i) => i.id === product.cover_image_id,
                      ) && (
                        <img
                          src={
                            product.images.find(
                              (i) => i.id === product.cover_image_id,
                            )!.url
                          }
                          alt={
                            product.images.find(
                              (i) => i.id === product.cover_image_id,
                            )!.alt
                          }
                          loading="lazy"
                        />
                      )}
                    </>
                    <p className="text-xs opacity-75">
                      {categoryMap.get(product.category_id)?.name} · Ordem{" "}
                      {product.sort_order}
                    </p>
                    <h3 className="break-words text-lg font-semibold">
                      {product.name}
                    </h3>
                    <p className="font-semibold text-[var(--brand)]">
                      {money.format(product.price_in_cents / 100)}
                    </p>
                    <div className="mb-4 flex flex-wrap gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-1 ${product.available ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"}`}
                      >
                        {product.available ? "Disponível" : "Indisponível"}
                      </span>
                      {product.featured && (
                        <span className="rounded-full bg-stone-100 px-2 py-1">
                          Destaque
                        </span>
                      )}
                      {!categoryMap.get(product.category_id)?.active && (
                        <span className="rounded-full bg-stone-100 px-2 py-1">
                          Categoria oculta
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`${buttonClass} mt-auto`}
                      aria-label={`Editar ${product.name}`}
                      onClick={() => open({ kind: "product", entry: product })}
                    >
                      Editar produto
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              {filteredCategories.length === 0 && (
                <p role="status" className="panel">
                  Nenhuma categoria encontrada.
                </p>
              )}
              <ul className="grid gap-3 sm:grid-cols-2">
                {filteredCategories.map((category) => (
                  <li
                    key={category.id}
                    className="catalog-card flex flex-col rounded-2xl border border-black/10 bg-white p-4"
                  >
                    <h3 className="break-words text-lg font-semibold">
                      {category.name}
                    </h3>
                    <p className="text-sm">
                      Ordem {category.sort_order} ·{" "}
                      {category.active ? "Visível" : "Oculta"}
                    </p>
                    <p className="mb-4 text-sm opacity-75">
                      {catalog?.products.filter(
                        (product) => product.category_id === category.id,
                      ).length ?? 0}{" "}
                      produtos
                    </p>
                    <button
                      type="button"
                      className={`${buttonClass} mt-auto`}
                      aria-label={`Editar categoria ${category.name}`}
                      onClick={() =>
                        open({ kind: "category", entry: category })
                      }
                    >
                      Editar categoria
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
