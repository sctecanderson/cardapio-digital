import { supabase } from "../../lib/supabase";
import {
  parseRestaurant,
  type RestaurantIdentity,
  type IdentityMedia,
} from "../restaurants/RestaurantProvider";
import type { DraftPhoto } from "./menuMedia";

export function contrast(a: string, b: string) {
  function luminance(hex: string) {
    if (!/^#[\da-f]{6}$/i.test(hex)) return NaN;
    const channels = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export async function uploadIdentity(
  photo: DraftPhoto | IdentityMedia | null,
  restaurantId: string,
  cache: Map<string, string>,
): Promise<IdentityMedia | null> {
  if (!photo) return null;
  if (!("file" in photo) || !photo.file)
    return { url: photo.url, storagePath: photo.storagePath! };
  const path = `${restaurantId}/identity/${photo.id}.webp`;
  let url = cache.get(path);
  const bucket = supabase.storage.from("restaurant-images");
  if (!url) {
    const { error } = await bucket.upload(path, photo.file, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: false,
    });
    if (error) {
      const { data, error: listError } = await bucket.list(
        `${restaurantId}/identity`,
        { search: `${photo.id}.webp`, limit: 10 },
      );
      if (listError || !data?.some((item) => item.name === `${photo.id}.webp`))
        throw new Error(
          "Não foi possível enviar a imagem. Confira Storage, conexão e permissão.",
        );
    }
    url = bucket.getPublicUrl(path).data.publicUrl;
    cache.set(path, url);
  }
  return { url, storagePath: path };
}
export async function saveIdentity(
  r: RestaurantIdentity,
  logo: IdentityMedia | null,
  cover: IdentityMedia | null,
) {
  const { data, error } = await supabase.rpc("save_restaurant_identity", {
    p_slug: r.slug,
    p_revision: r.revision,
    p_values: {
      name: r.name.trim(),
      subtitle: r.subtitle,
      description: r.description,
      address: r.address,
      phone: r.phone,
      opening_hours: r.openingHours,
      theme_primary: r.theme.primary,
      theme_background: r.theme.background,
      theme_text: r.theme.text,
      logo,
      cover,
      service_fee_percent: r.serviceFeePercent,
      timezone: r.timezone,
      google_review_url: r.googleReviewUrl ? r.googleReviewUrl.trim() : null,
    },
  });
  if (error)
    throw new Error(
      ["22023", "42501", "40001"].includes(error.code)
        ? error.message
        : "Não foi possível salvar a identidade. Tente novamente.",
    );
  return parseRestaurant(data);
}
export interface AdminTable {
  id: string;
  tableNumber: number;
  label: string;
  active: boolean;
  isActive?: boolean;
  isLockedByPlan?: boolean;
  revision: number;
  visitId: string | null;
  tabCount: number;
  totalInCents: number;
  billPending: boolean;
}
export async function getAdminTables(slug: string): Promise<AdminTable[]> {
  const { data, error } = await supabase.rpc("get_admin_tables", {
    p_slug: slug,
  });
  if (error)
    throw new Error(
      ["42501"].includes(error.code)
        ? error.message
        : "Não foi possível carregar as mesas.",
    );
  if (
    !Array.isArray(data) ||
    !data.every(
      (t: AdminTable) =>
        t &&
        typeof t.id === "string" &&
        Number.isInteger(t.tableNumber) &&
        t.tableNumber >= 1 &&
        t.tableNumber <= 999 &&
        typeof t.label === "string" &&
        typeof t.active === "boolean" &&
        Number.isInteger(t.revision) &&
        Number.isInteger(t.tabCount) &&
        Number.isSafeInteger(t.totalInCents) &&
        t.totalInCents >= 0 &&
        typeof t.billPending === "boolean" &&
        (t.visitId === null || typeof t.visitId === "string"),
    )
  )
    throw new Error("Dados de mesas inválidos.");
  return data as AdminTable[];
}
export async function saveTable(slug: string, t: AdminTable) {
  const { data, error } = await supabase.rpc("save_restaurant_table", {
    p_slug: slug,
    p_id: t.id,
    p_revision: t.revision,
    p_number: t.tableNumber,
    p_label: t.label,
    p_active: t.active,
  });
  if (error)
    throw new Error(
      ["22023", "42501", "40001", "P0001"].includes(error.code)
        ? error.message
        : "Não foi possível salvar a mesa.",
    );
  if (data !== t.id)
    throw new Error("A mesa salva não foi confirmada. Atualize a lista.");
}

export async function deleteTable(slug: string, tableNumber: number) {
  const { data, error } = await supabase.rpc("delete_restaurant_table", {
    p_slug: slug,
    p_table_number: tableNumber,
  });
  if (error) {
    throw new Error(
      ["22023", "42501", "40001", "P0001"].includes(error.code)
        ? error.message
        : "Não foi possível excluir a mesa.",
    );
  }
  return data;
}
