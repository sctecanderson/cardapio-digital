import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../../lib/supabase";
import type { Restaurant } from "../../types/restaurant";

export interface RestaurantIdentity extends Restaurant {
  id: string;
  revision: number;
  logo: IdentityMedia | null;
  cover: IdentityMedia | null;
  description: string;
  address: string;
  phone: string;
  openingHours: string;
  serviceFeePercent: number;
  timezone: string;
}
export interface IdentityMedia {
  url: string;
  storagePath: string;
}
export function parseRestaurant(value: unknown): RestaurantIdentity {
  if (!value || typeof value !== "object")
    throw new Error("Identidade inválida.");
  const v = value as Record<string, unknown>;
  const theme = v.theme as Record<string, unknown> | undefined;
  if (
    !theme ||
    !["primary", "background", "text"].every(
      (k) =>
        typeof theme[k] === "string" &&
        /^#[\da-f]{6}$/i.test(theme[k] as string),
    ) ||
    ![
      "id",
      "slug",
      "name",
      "subtitle",
      "description",
      "address",
      "phone",
      "openingHours",
    ].every((k) => typeof v[k] === "string") ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1
  )
    throw new Error("Identidade inválida.");
  const serviceFeePercent =
    typeof v.serviceFeePercent === "number" && Number.isFinite(v.serviceFeePercent)
      ? v.serviceFeePercent
      : 10;
  const timezone =
    typeof v.timezone === "string" && v.timezone.trim().length > 0
      ? v.timezone.trim()
      : "America/Sao_Paulo";
  for (const key of ["logo", "cover"]) {
    const m = v[key] as IdentityMedia | null;
    if (
      m !== null &&
      (!m ||
        typeof m.storagePath !== "string" ||
        typeof m.url !== "string" ||
        !/^https:\/\//.test(m.url))
    )
      throw new Error("Imagem da identidade inválida.");
  }
  return value as RestaurantIdentity;
}
interface ContextValue {
  restaurant: RestaurantIdentity;
  reload: () => Promise<void>;
}
const Context = createContext<ContextValue | null>(null);
export function useRestaurant() {
  const context = useContext(Context);
  if (!context) throw new Error("Identidade fora do restaurante.");
  return context;
}
export function RestaurantProvider({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  const [restaurant, setRestaurant] = useState<RestaurantIdentity | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // Cada montagem/slug tem seu próprio ciclo; respostas antigas não substituem a identidade atual.
  const [version] = useState(() => ({ mounted: true, request: 0 }));
  const reload = useCallback(async () => {
    const request = ++version.request;
    const { data, error } = await supabase.rpc("get_public_restaurant", {
      p_slug: slug,
    });
    if (!version.mounted || request !== version.request) return;
    if (error)
      throw new Error(
        "Não foi possível carregar o restaurante. Confira a conexão e a migração.",
      );
    if (!data) {
      setRestaurant(null);
      setError('Este restaurante está temporariamente indisponível.');
      return;
    }
    const next = parseRestaurant(data);
    if (next.slug !== slug) throw new Error("Restaurante incorreto.");
    setRestaurant(next);
    setError("");
  }, [slug, version]);
  useEffect(() => {
    version.mounted = true;
    void reload().catch((cause) => {
      if (version.mounted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Falha ao carregar restaurante.",
        );
    });
    function refresh() {
      if (!document.hidden)
        void reload().catch(() => {
          /* Mantém a última identidade válida no refresh de fundo. */
        });
    }
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      version.mounted = false;
      version.request++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [reload, retry, version]);
  if (!restaurant)
    return (
      <main className="shell py-8">
        <p role={error ? "alert" : "status"}>
          {error || "Carregando restaurante…"}
        </p>
        {error && (
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Tentar novamente
          </button>
        )}
      </main>
    );
  return (
    <Context.Provider value={{ restaurant, reload }}>
      {children}
    </Context.Provider>
  );
}
