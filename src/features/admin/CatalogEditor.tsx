import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { priceToCents, saveCatalogEntry, slugify } from "./adminCatalog";
import type { AdminCategory, AdminProduct } from "./adminCatalog";
import { ProductMediaFields } from "./ProductMediaFields";
import { uploadMenuMedia } from "./menuMedia";
import type { DraftPhoto, DraftVideo } from "./menuMedia";
import { fetchInventory } from "../inventory/inventoryService";
import type { InventoryItem } from "../inventory/inventoryService";

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
    prepTimeMin:
      product?.prep_time_min_minutes != null
        ? String(product.prep_time_min_minutes)
        : "",
    prepTimeMax:
      product?.prep_time_max_minutes != null
        ? String(product.prep_time_max_minutes)
        : "",
    preparationStation: (product?.preparation_station as 'kitchen' | 'bar' | 'none') ?? 'kitchen',
    inventoryItemId: product?.inventory_item_id ?? "",
  });
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);

  useEffect(() => {
    if (isProduct && restaurantId) {
      fetchInventory(restaurantId)
        .then(setInventoryItems)
        .catch((err) => console.error("Erro ao carregar estoque para vinculo:", err));
    }
  }, [isProduct, restaurantId]);

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
    let prepMin: number | null = null;
    let prepMax: number | null = null;
    if (isProduct) {
      const minTrim = draft.prepTimeMin.trim();
      const maxTrim = draft.prepTimeMax.trim();
      if ((minTrim && !maxTrim) || (!minTrim && maxTrim)) {
        setError("Informe tanto o tempo mínimo quanto o máximo ou deixe ambos em branco.");
        return;
      }
      if (minTrim && maxTrim) {
        const parsedMin = parseInt(minTrim, 10);
        const parsedMax = parseInt(maxTrim, 10);
        if (
          isNaN(parsedMin) ||
          isNaN(parsedMax) ||
          parsedMin < 1 ||
          parsedMax < 1 ||
          parsedMin > 1440 ||
          parsedMax > 1440
        ) {
          setError("O tempo estimado de preparo deve estar entre 1 e 1440 minutos.");
          return;
        }
        if (parsedMin > parsedMax) {
          setError("O tempo mínimo de preparo não pode ser maior que o tempo máximo.");
          return;
        }
        prepMin = parsedMin;
        prepMax = parsedMax;
      }
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
              prep_time_min_minutes: prepMin,
              prep_time_max_minutes: prepMax,
              preparation_station: draft.preparationStation,
              inventory_item_id: draft.inventoryItemId.trim() ? draft.inventoryItemId.trim() : null,
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
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm font-medium">
                    Tempo mínimo (min)
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      placeholder="Ex: 15"
                      value={draft.prepTimeMin}
                      className={inputClass}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          prepTimeMin: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm font-medium">
                    Tempo máximo (min)
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      placeholder="Ex: 25"
                      value={draft.prepTimeMax}
                      className={inputClass}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          prepTimeMax: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <p className="text-xs opacity-75">
                  Opcional. Para estimativa única, informe o mesmo valor nos dois campos. Deixe em branco se não quiser exibir.
                </p>
                <label className="block text-sm font-medium">
                  Estação de Preparo (KDS)
                  <select
                    value={draft.preparationStation}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        preparationStation: event.target.value as 'kitchen' | 'bar' | 'none',
                      })
                    }
                  >
                    <option value="kitchen">Cozinha (Padrão)</option>
                    <option value="bar">Bar (Bebidas e Drinks)</option>
                    <option value="none">Sem preparo / Pronta entrega</option>
                  </select>
                </label>
                <p className="text-xs opacity-75">
                  Define em qual esteira do KDS o pedido será preparado. Itens sem preparo não entram nas filas de produção da cozinha ou do bar.
                </p>
                <label className="block text-sm font-medium">
                  Vincular ao Estoque (Baixa automática)
                  <select
                    value={draft.inventoryItemId}
                    className={inputClass}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inventoryItemId: event.target.value,
                      })
                    }
                  >
                    <option value="">Nenhum vínculo (Estoque ilimitado)</option>
                    {inventoryItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.unit_measure}) — Saldo: {item.current_quantity}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs opacity-75">
                  Quando um pedido for feito na mesa, 1 unidade deste insumo/produto terá baixa automática no estoque. Caso o saldo chegue a zero, o produto exibirá status esgotado no cardápio.
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
