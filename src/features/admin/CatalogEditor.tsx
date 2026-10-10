import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { priceToCents, saveCatalogEntry, slugify } from "./adminCatalog";
import type { AdminCategory, AdminProduct } from "./adminCatalog";
import { ProductMediaFields } from "./ProductMediaFields";
import { uploadMenuMedia } from "./menuMedia";
import type { DraftPhoto, DraftVideo } from "./menuMedia";

export type CatalogSelection =
  | { kind: "category"; entry: AdminCategory | null }
  | { kind: "product"; entry: AdminProduct | null };

const inputClass =
  "mt-1 min-h-11 w-full rounded-xl border border-black/20 bg-white px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]";
const buttonClass =
  "min-h-11 rounded-xl border border-black/20 px-4 py-2 font-medium disabled:opacity-50";

export function CatalogEditor({
  selection,
  categories,
  restaurantSlug,
  restaurantId,
  onSaved,
  onCancel,
}: {
  selection: CatalogSelection;
  categories: AdminCategory[];
  restaurantSlug: string;
  restaurantId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const entry = selection.entry;
  const product = selection.kind === "product" ? selection.entry : null;
  const category = selection.kind === "category" ? selection.entry : null;
  const isProduct = selection.kind === "product";
  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [draft, setDraft] = useState({
    name: entry?.name ?? "",
    slug: entry?.slug ?? "",
    order: String(entry?.sort_order ?? 0),
    active: category?.active ?? true,
    categoryId:
      product?.category_id ??
      categories.find((item) => item.active)?.id ??
      categories[0]?.id ??
      "",
    shortDescription: product?.short_description ?? "",
    description: product?.description ?? "",
    price: product
      ? (product.price_in_cents / 100).toFixed(2).replace(".", ",")
      : "",
    available: product?.available ?? true,
    featured: product?.featured ?? false,
    dietaryInformation: product?.dietary_information ?? "",
  });
  const [photos, setPhotos] = useState<DraftPhoto[]>(() =>
    [...(product?.images ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
  );
  const [video, setVideo] = useState<DraftVideo | null>(product?.video ?? null);
  const [coverId, setCoverId] = useState(
    product?.cover_image_id ?? product?.images[0]?.id ?? "",
  );
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState("");
  const uploadCache = useRef(new Map<string, string>());
  const previews = useRef({ photos, video });
  previews.current = { photos, video };
  const [dirty, setDirty] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => {
      mounted.current = false;
      previews.current.photos.forEach(
        (photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl),
      );
      if (previews.current.video?.previewUrl)
        URL.revokeObjectURL(previews.current.video.previewUrl);
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function cancel() {
    if (busy || preparing) return;
    if (!dirty || window.confirm("Descartar as alterações deste formulário?"))
      onCancel();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || preparing) return;
    setError("");
    if (!draft.name.trim()) {
      setError("Informe um nome.");
      return;
    }
    if (!/^\d{1,4}$/.test(draft.order)) {
      setError("Informe uma ordem entre 0 e 9999.");
      return;
    }
    if (isProduct && video && photos.length === 0) {
      setError("Adicione uma foto de capa para o vídeo do Explorar.");
      return;
    }
    if (photos.some((photo) => !photo.alt.trim())) {
      setError("Descreva cada foto do produto.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const values: Record<string, unknown> = {
        name: draft.name.trim(),
        slug: draft.slug,
        sort_order: Number(draft.order),
        ...(isProduct
          ? {
              category_id: draft.categoryId,
              short_description: draft.shortDescription.trim(),
              description: draft.description.trim(),
              price_in_cents: priceToCents(draft.price),
              available: draft.available,
              featured: draft.featured,
              dietary_information: draft.dietaryInformation.trim(),
            }
          : { active: draft.active }),
      };
      if (isProduct) {
        const media = await uploadMenuMedia(
          photos,
          video,
          restaurantId,
          id,
          uploadCache.current,
          (message) => {
            if (mounted.current) setProgress(message);
          },
        );
        Object.assign(values, media, { cover_image_id: coverId || null });
      }
      if (mounted.current) setProgress("Salvando produto…");
      await saveCatalogEntry(
        restaurantSlug,
        selection.kind,
        id,
        entry?.revision ?? 0,
        values,
      );
      if (mounted.current) {
        setDirty(false);
        onSaved();
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Não foi possível salvar.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }

  return (
    <section className="admin-card">
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {entry ? "Editar" : "Cadastrar"} {isProduct ? "produto" : "categoria"}
      </h2>
      <div className={isProduct ? "catalog-editor-grid" : ""}>
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-5 admin-form"
          aria-busy={busy}
        >
          <fieldset
            disabled={busy || preparing}
            className="space-y-4"
            onChange={() => setDirty(true)}
          >
            <legend className="sr-only">
              Dados {isProduct ? "do produto" : "da categoria"}
            </legend>
            <label className="block text-sm font-medium">
              Nome
              <input
                required
                maxLength={isProduct ? 120 : 100}
                value={draft.name}
                className={inputClass}
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    name,
                    slug: !entry && !slugEdited ? slugify(name) : current.slug,
                  }));
                }}
              />
            </label>
            <label className="block text-sm font-medium">
              Identificador no endereço
              <input
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={120}
                readOnly={!!entry}
                value={draft.slug}
                className={`${inputClass} read-only:bg-stone-50`}
                aria-describedby="catalog-slug-help"
                onChange={(event) => {
                  setSlugEdited(true);
                  setDraft({ ...draft, slug: event.target.value });
                }}
              />
            </label>
            <p id="catalog-slug-help" className="text-xs opacity-75">
              {entry
                ? "O endereço é preservado para manter os links existentes."
                : "Gerado a partir do nome. Use letras minúsculas, números e hífens."}
            </p>
            {isProduct && (
              <>
                <label className="block text-sm font-medium">
                  Categoria
                  <select
                    required
                    value={draft.categoryId}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({ ...draft, categoryId: event.target.value })
                    }
                  >
                    <option value="" disabled>
                      Selecione uma categoria
                    </option>
                    {categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.active ? "" : " — oculta"}
                      </option>
                    ))}
                  </select>
                </label>
                {categories.find((item) => item.id === draft.categoryId)
                  ?.active === false && (
                  <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                    Esta categoria está oculta. O produto também ficará fora do
                    cardápio público.
                  </p>
                )}
                <ProductMediaFields
                  photos={photos}
                  video={video}
                  coverId={coverId}
                  productName={draft.name}
                  disabled={busy}
                  onPreparing={setPreparing}
                  onChange={(nextPhotos, nextVideo, nextCover) => {
                    setPhotos(nextPhotos);
                    setVideo(nextVideo);
                    setCoverId(nextCover);
                    setDirty(true);
                  }}
                />
                <label className="block text-sm font-medium">
                  Descrição curta
                  <input
                    maxLength={240}
                    value={draft.shortDescription}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        shortDescription: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="block text-sm font-medium">
                  Descrição completa
                  <textarea
                    rows={4}
                    maxLength={5000}
                    value={draft.description}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                  />
                </label>
                <label className="block text-sm font-medium">
                  Preço (R$)
                  <input
                    required
                    type="text"
                    inputMode="decimal"
                    maxLength={9}
                    placeholder="58,90"
                    value={draft.price}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({ ...draft, price: event.target.value })
                    }
                  />
                </label>
                <p className="text-xs opacity-75">
                  O novo preço vale para os próximos lançamentos. Consumos já
                  registrados mantêm o valor original.
                </p>
                <label className="block text-sm font-medium">
                  Ingredientes, alergênicos e restrições
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={draft.dietaryInformation}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        dietaryInformation: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.available}
                    className="h-5 w-5 accent-[var(--brand)]"
                    onChange={(event) =>
                      setDraft({ ...draft, available: event.target.checked })
                    }
                  />
                  Disponível para consumo
                </label>
                <p className="text-xs opacity-75">
                  Desmarcado: aparece como indisponível no cardápio e sai do
                  Explorar.
                </p>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.featured}
                    className="h-5 w-5 accent-[var(--brand)]"
                    onChange={(event) =>
                      setDraft({ ...draft, featured: event.target.checked })
                    }
                  />
                  Destaque da casa
                </label>
                <p className="text-xs opacity-75">
                  A capa do cardápio usa o primeiro destaque disponível na ordem
                  de exibição.
                </p>
              </>
            )}
            <label className="block text-sm font-medium">
              Ordem de exibição
              <input
                required
                type="number"
                min={0}
                max={9999}
                step={1}
                value={draft.order}
                className={inputClass}
                onChange={(event) =>
                  setDraft({ ...draft, order: event.target.value })
                }
              />
            </label>
            <p className="text-xs opacity-75">
              Números menores aparecem primeiro. Use, por exemplo, 10, 20 e 30.
            </p>
            {!isProduct && (
              <>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    className="h-5 w-5 accent-[var(--brand)]"
                    onChange={(event) =>
                      setDraft({ ...draft, active: event.target.checked })
                    }
                  />
                  Categoria visível no cardápio
                </label>
                <p className="text-xs opacity-75">
                  Ocultar uma categoria também oculta seus produtos e impede
                  novos lançamentos deles pelo painel de consumo.
                </p>
              </>
            )}
            {busy && progress && (
              <p role="status" className="text-sm">
                {progress}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-xl bg-red-50 p-3 text-sm text-red-800"
              >
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-3 border-t border-black/10 pt-4">
              <button
                type="submit"
                className={`${buttonClass} bg-[var(--brand)] text-white`}
              >
                {busy
                  ? "Salvando…"
                  : preparing
                    ? "Preparando mídia…"
                    : "Salvar alterações"}
              </button>
              <button type="button" onClick={cancel} className={buttonClass}>
                Cancelar
              </button>
            </div>
          </fieldset>
        </form>
        {isProduct && (
          <aside className="admin-card catalog-editor-preview">
            <h2>Prévia no cardápio</h2>
            {photos.find((p) => p.id === coverId) && (
              <img
                src={
                  photos.find((p) => p.id === coverId)!.previewUrl ||
                  photos.find((p) => p.id === coverId)!.url
                }
                alt={photos.find((p) => p.id === coverId)!.alt}
              />
            )}
            <h3>{draft.name || "Nome do produto"}</h3>
            <p>{draft.shortDescription || "Descrição curta do produto"}</p>
            <strong>R$ {draft.price || "0,00"}</strong>
            <p className="admin-help">
              {draft.featured ? "Destaque da casa · " : ""}
              {draft.available ? "Disponível" : "Indisponível"}
            </p>
            <p className="admin-help">
              Prévia das alterações ainda não salvas.
            </p>
          </aside>
        )}
      </div>
    </section>
  );
}
