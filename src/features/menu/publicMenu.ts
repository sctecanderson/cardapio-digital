import { supabase } from '../../lib/supabase';
import type { RestaurantMenu, Product, ProductImage } from '../../types/menu';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('O catálogo retornado pelo servidor é inválido.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Texto inválido no catálogo.');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Valor inválido no catálogo.');
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Disponibilidade inválida no catálogo.');
  return value;
}
function mediaUrl(value: unknown): string {
  const url = text(value);
  // Caminhos locais existentes ou HTTPS do futuro armazenamento/CDN.
  if ((url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) ||
      /^https:\/\//i.test(url)) return url;
  throw new Error('Endereço de mídia inválido no catálogo.');
}

export function parsePublicMenu(value: unknown): RestaurantMenu {
  const data = record(value);
  const restaurantId = text(data.restaurantId);
  if (!Array.isArray(data.categories) || !Array.isArray(data.products)) {
    throw new Error('As categorias ou os produtos do catálogo são inválidos.');
  }
  const categories = data.categories.map((value) => {
    const row = record(value);
    if (text(row.restaurantId) !== restaurantId) throw new Error('Categoria de outro restaurante.');
    return { id: text(row.id), restaurantId, name: text(row.name),
      slug: text(row.slug), sortOrder: integer(row.sortOrder) };
  });
  const categoryIds = new Set(categories.map((category) => category.id));
  if (categoryIds.size !== categories.length) throw new Error('Categorias duplicadas.');
  const products: Product[] = data.products.map((value) => {
    const row = record(value);
    const categoryId = text(row.categoryId);
    if (text(row.restaurantId) !== restaurantId || !categoryIds.has(categoryId)) {
      throw new Error('Produto fora do catálogo deste restaurante.');
    }
    const priceInCents = integer(row.priceInCents);
    if (priceInCents < 0) throw new Error('Preço inválido no catálogo.');
    if (!Array.isArray(row.images)) throw new Error('Galeria inválida no catálogo.');
    const images: ProductImage[] = row.images.map((value) => {
      const image = record(value);
      return { id: text(image.id), url: mediaUrl(image.url),
        alt: text(image.alt), sortOrder: integer(image.sortOrder) };
    });
    if (new Set(images.map((image) => image.id)).size !== images.length) {
      throw new Error('Fotos duplicadas no catálogo.');
    }
    const coverImageId = row.coverImageId == null ? images[0]?.id ?? '' : text(row.coverImageId);
    if (coverImageId && !images.some((image) => image.id === coverImageId)) {
      throw new Error('A capa não pertence à galeria do produto.');
    }
    let video: Product['video'];
    if (row.video != null) {
      const media = record(row.video);
      if (media.mimeType !== 'video/mp4' && media.mimeType !== 'video/webm') {
        throw new Error('Formato de vídeo inválido no catálogo.');
      }
      video = { url: mediaUrl(media.url), mimeType: media.mimeType };
    }
    return { id: text(row.id), restaurantId, categoryId, slug: text(row.slug),
      name: text(row.name), shortDescription: text(row.shortDescription),
      description: text(row.description), priceInCents,
      available: boolean(row.available), featured: boolean(row.featured),
      sortOrder: integer(row.sortOrder), coverImageId, images, video,
      dietaryInformation: row.dietaryInformation == null ? undefined : text(row.dietaryInformation) };
  });
  if (new Set(products.map((product) => product.id)).size !== products.length ||
      new Set(products.map((product) => product.slug)).size !== products.length) {
    throw new Error('Produtos duplicados no catálogo.');
  }
  return { restaurantId, categories, products };
}

export async function getPublicMenu(restaurantSlug: string): Promise<RestaurantMenu> {
  const { data, error } = await supabase.rpc('get_public_menu', {
    p_restaurant_slug: restaurantSlug,
  });
  if (error) throw new Error('Não foi possível carregar o cardápio. Tente novamente.');
  if (!data) throw new Error('O cardápio deste restaurante está indisponível.');
  return parsePublicMenu(data);
}
