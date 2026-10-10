import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useRestaurant,
  type RestaurantIdentity,
  type IdentityMedia,
} from "../restaurants/RestaurantProvider";
import { preparePhoto, type DraftPhoto } from "./menuMedia";
import { contrast, saveIdentity, uploadIdentity } from "./restaurantAdmin";
import { getAdminCatalog, type AdminProduct } from "./adminCatalog";

type Media = DraftPhoto | IdentityMedia | null;
function preview(m: Media) {
  return (m && (("previewUrl" in m && m.previewUrl) || m.url)) || "";
}
function release(m: Media) {
  if (m && "previewUrl" in m && m.previewUrl) URL.revokeObjectURL(m.previewUrl);
}
export function IdentityPage() {
  const { restaurant, reload } = useRestaurant();
  const [draft, setDraft] = useState<RestaurantIdentity>(restaurant);
  const [logo, setLogo] = useState<Media>(restaurant.logo);
  const [cover, setCover] = useState<Media>(restaurant.cover);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [featured, setFeatured] = useState<AdminProduct | null>(null);
  const live = useRef({ logo, cover });
  live.current = { logo, cover };
  const mounted = useRef(true);
  const processing = useRef(false);
  const submitting = useRef(false);
  const uploads = useRef(new Map<string, string>());
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void getAdminCatalog(restaurant.slug)
      .then((c) => {
        if (!disposed)
          setFeatured(
            c.products.find((p) => p.featured && p.available) ||
              c.products.find((p) => p.available) ||
              null,
          );
      })
      .catch(() => {});
    return () => {
      disposed = true;
      mounted.current = false;
      release(live.current.logo);
      release(live.current.cover);
    };
  }, [restaurant.slug]);
  const changed =
    JSON.stringify(draft) !== JSON.stringify(restaurant) ||
    logo !== restaurant.logo ||
    cover !== restaurant.cover;
  const brandContrast = contrast(draft.theme.primary, "#FFFFFF");
  const textContrast = contrast(draft.theme.text, draft.theme.background);
  const validColors =
    Number.isFinite(brandContrast) &&
    Number.isFinite(textContrast) &&
    brandContrast >= 4.5 &&
    textContrast >= 4.5 &&
    contrast(draft.theme.text, "#FFFFFF") >= 4.5;
  function field(key: keyof RestaurantIdentity, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice("");
  }
  async function photo(file: File | undefined, key: "logo" | "cover") {
    if (!file || processing.current || submitting.current) return;
    processing.current = true;
    setPreparing(true);
    setError("");
    setNotice("");
    try {
      const prepared = await preparePhoto(
        file,
        key === "logo" ? "Logo do restaurante" : "Capa do restaurante",
      );
      if (!mounted.current) {
        release(prepared);
        return;
      }
      release(live.current[key]);
      if (key === "logo") setLogo(prepared);
      else setCover(prepared);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Não foi possível preparar a foto.",
        );
    } finally {
      processing.current = false;
      if (mounted.current) setPreparing(false);
    }
  }
  function reset() {
    release(logo);
    release(cover);
    setDraft(restaurant);
    setLogo(restaurant.logo);
    setCover(restaurant.cover);
    setError("");
    setNotice("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || processing.current) return;
    if (!validColors) {
      setError(
        "Ajuste as cores para atingir contraste de 4,5:1 nos textos, cards e botões.",
      );
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const nextLogo = await uploadIdentity(
        logo,
        restaurant.id,
        uploads.current,
      );
      const nextCover = await uploadIdentity(
        cover,
        restaurant.id,
        uploads.current,
      );
      const saved = await saveIdentity(draft, nextLogo, nextCover);
      if (!mounted.current) return;
      release(logo);
      release(cover);
      setDraft(saved);
      setLogo(saved.logo);
      setCover(saved.cover);
      setNotice(
        "Identidade salva. O cardápio aberto em outra aba será atualizado em até 60 segundos.",
      );
      await reload();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Não foi possível salvar.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const featuredCover = featured?.images.find(
    (p) => p.id === featured.cover_image_id,
  );
  return (
    <form onSubmit={(event) => void submit(event)} className="admin-form">
      <header className="admin-page-heading">
        <div>
          <p className="admin-breadcrumb">Configurações / Identidade visual</p>
          <h1>Identidade do restaurante</h1>
        </div>
        <div className="admin-actions">
          <button
            type="button"
            onClick={reset}
            disabled={busy || preparing}
            className="admin-button"
          >
            Cancelar
          </button>
          <button
            disabled={busy || preparing || !changed}
            className="admin-button primary"
          >
            {preparing
              ? "Preparando imagem…"
              : busy
                ? "Salvando…"
                : "Salvar alterações"}
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="admin-alert error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-alert success">
          {notice}
        </p>
      )}
      <div className="admin-split">
        <fieldset disabled={busy || preparing} className="admin-stack">
          <section className="admin-card">
            <h2>Informações básicas</h2>
            <div className="admin-grid-2">
              <label>
                Nome do restaurante
                <input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => field("name", e.target.value)}
                />
              </label>
              <label>
                Complemento
                <input
                  maxLength={120}
                  value={draft.subtitle}
                  onChange={(e) => field("subtitle", e.target.value)}
                />
              </label>
            </div>
            <label>
              Endereço do cardápio
              <input value={`/${draft.slug}`} readOnly />
            </label>
            <p className="admin-help">
              O endereço é preservado para manter seus QR Codes e tags NFC.
            </p>
          </section>
          <section className="admin-card">
            <h2>Logo e capa</h2>
            <div className="admin-grid-2">
              {(["logo", "cover"] as const).map((key) => (
                <div key={key}>
                  <p>
                    {key === "logo"
                      ? "Logo do restaurante"
                      : "Capa do cardápio"}
                  </p>
                  <div className={`identity-upload ${key}`}>
                    {preview(key === "logo" ? logo : cover) ? (
                      <img
                        src={preview(key === "logo" ? logo : cover)}
                        alt={
                          key === "logo" ? "Prévia do logo" : "Prévia da capa"
                        }
                      />
                    ) : (
                      <span>
                        {key === "logo" ? draft.name : "Selecione uma capa"}
                      </span>
                    )}
                  </div>
                  <label className="admin-button file-button">
                    {key === "logo" ? "Trocar logo" : "Trocar capa"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => {
                        void photo(e.target.files?.[0], key);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="admin-text-button"
                    onClick={() => {
                      release(key === "logo" ? logo : cover);
                      key === "logo" ? setLogo(null) : setCover(null);
                    }}
                  >
                    Remover
                  </button>
                </div>
              ))}
            </div>
            <p className="admin-help">
              JPG, PNG ou WebP até 10 MB. Otimização automática para WebP. Use
              PNG transparente para o logo.
            </p>
          </section>
          <section className="admin-card">
            <h2>Cores da marca</h2>
            <div className="identity-colors">
              {(["primary", "background", "text"] as const).map((key, i) => (
                <label key={key}>
                  {["Principal", "Fundo", "Texto"][i]}
                  <div>
                    <input
                      type="color"
                      aria-label={`Selecionar cor ${key}`}
                      value={
                        /^#[\da-f]{6}$/i.test(draft.theme[key])
                          ? draft.theme[key]
                          : "#000000"
                      }
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          theme: { ...d.theme, [key]: e.target.value },
                        }))
                      }
                    />
                    <input
                      aria-label={`Código da cor ${key}`}
                      maxLength={7}
                      pattern="#[0-9a-fA-F]{6}"
                      value={draft.theme[key]}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          theme: { ...d.theme, [key]: e.target.value },
                        }))
                      }
                    />
                  </div>
                </label>
              ))}
            </div>
            <p className={`admin-help ${validColors ? "" : "text-red-800"}`}>
              Contraste: botões{" "}
              {Number.isFinite(brandContrast) ? brandContrast.toFixed(2) : "—"}
              :1 · texto{" "}
              {Number.isFinite(textContrast) ? textContrast.toFixed(2) : "—"}:1.
              Mínimo 4,5:1, inclusive no texto sobre os cards brancos.
            </p>
          </section>
          <section className="admin-card">
            <h2>Informações do restaurante</h2>
            <label>
              Apresentação
              <textarea
                maxLength={1000}
                rows={3}
                value={draft.description}
                onChange={(e) => field("description", e.target.value)}
              />
            </label>
            <label>
              Endereço
              <input
                maxLength={300}
                value={draft.address}
                onChange={(e) => field("address", e.target.value)}
              />
            </label>
            <label>
              Telefone
              <input
                maxLength={40}
                value={draft.phone}
                onChange={(e) => field("phone", e.target.value)}
              />
            </label>
            <label>
              Horários
              <textarea
                rows={3}
                maxLength={500}
                value={draft.openingHours}
                onChange={(e) => field("openingHours", e.target.value)}
              />
            </label>
          </section>
          <section className="admin-card">
            <h2>Taxa de serviço e Fuso horário</h2>
            <div className="admin-grid-2">
              <label>
                Taxa de serviço (%)
                <input
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  required
                  value={draft.serviceFeePercent}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setDraft((d) => ({
                      ...d,
                      serviceFeePercent: Number.isFinite(val) ? Math.min(30, Math.max(0, val)) : 0,
                    }));
                    setNotice("");
                  }}
                />
              </label>
              <label>
                Fuso horário (Timezone)
                <select
                  value={draft.timezone}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, timezone: e.target.value }));
                    setNotice("");
                  }}
                >
                  <option value="America/Sao_Paulo">Brasília / São Paulo (UTC-3)</option>
                  <option value="America/Manaus">Manaus (UTC-4)</option>
                  <option value="America/Cuiaba">Cuiabá (UTC-4)</option>
                  <option value="America/Belem">Belém (UTC-3)</option>
                  <option value="America/Fortaleza">Fortaleza (UTC-3)</option>
                  <option value="America/Recife">Recife (UTC-3)</option>
                  <option value="America/Porto_Velho">Porto Velho (UTC-4)</option>
                  <option value="America/Rio_Branco">Rio Branco (UTC-5)</option>
                  <option value="America/Noronha">Fernando de Noronha (UTC-2)</option>
                </select>
              </label>
            </div>
            <p className="admin-help">
              A taxa de serviço é opcional e depende da aceitação do cliente (0% a 30%). Se definida em 0%, nenhuma cobrança de serviço é sugerida aos clientes.
            </p>
            <p className="admin-help mt-1">
              O fuso horário é utilizado para agrupar e filtrar os atendimentos e comandas no horário local do restaurante.
            </p>
          </section>
        </fieldset>
        <aside className="admin-card identity-preview">
          <h2>Prévia do cardápio</h2>
          <div
            className="preview-phone"
            style={{
              background: draft.theme.background,
              color: draft.theme.text,
            }}
          >
            <div className="preview-heading">
              {preview(logo) ? (
                <img src={preview(logo)} alt="Logo na prévia" />
              ) : (
                <div className="wordmark">
                  {draft.name}
                  <span>{draft.subtitle}</span>
                </div>
              )}
              <span className="badge">Mesa 07</span>
            </div>
            {preview(cover) && (
              <img
                className="preview-cover"
                src={preview(cover)}
                alt="Capa na prévia"
              />
            )}
            <div className="preview-body">
              <div className="preview-tabs">
                <span
                  style={{ background: draft.theme.primary, color: "white" }}
                >
                  Cardápio
                </span>
                <span>Explorar</span>
              </div>
              <div className="preview-search">Buscar prato ou bebida</div>
              <p className="text-sm">Todos · Pratos · Bebidas</p>
              <h3>Destaque da casa</h3>
              {featuredCover && (
                <img
                  className="preview-product"
                  src={featuredCover.url}
                  alt={featuredCover.alt}
                />
              )}
              <strong>{featured?.name || "Seu próximo destaque"}</strong>
              {featured && (
                <p style={{ color: draft.theme.primary }}>
                  {new Intl.NumberFormat("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  }).format(featured.price_in_cents / 100)}
                </p>
              )}
              <div
                className="preview-call"
                style={{ background: draft.theme.primary }}
              >
                Chamar garçom
              </div>
            </div>
          </div>
          <p className="admin-help">
            {changed ? "● Alterações ainda não salvas" : "Identidade publicada"}{" "}
            · Prévia ilustrativa.
          </p>
        </aside>
      </div>
    </form>
  );
}
