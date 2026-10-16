import { supabase } from '../../lib/supabase';
import { ensureGuestIdentity } from '../auth/guestAuth';
import type {
  CreatedProductCommentResult,
  Product,
  ProductCommentsCursor,
  ProductImage,
  PublicProductComment,
  PublicProductCommentsPage,
  RestaurantMenu,
} from '../../types/menu';

export type {
  CreatedProductCommentResult,
  ProductCommentsCursor,
  PublicProductComment,
  PublicProductCommentsPage,
};

export interface ProductLikeToggleResult {
  liked: boolean;
  likesCount: number;
}

const FORBIDDEN_PRIVATE_KEYS = [
  'user_id',
  'userId',
  'moderated_by',
  'moderatedBy',
  'moderated_at',
  'moderatedAt',
  'content_fingerprint',
  'contentFingerprint',
] as const;

function hasForbiddenPrivateFields(row: Record<string, unknown>): boolean {
  return FORBIDDEN_PRIVATE_KEYS.some((key) => key in row);
}

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
function isoTimestamp(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string') {
    throw new Error(errorMessage);
  }
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(errorMessage);
  }
  return trimmed;
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
    const likesCount = row.likesCount == null ? 0 : integer(row.likesCount);
    if (likesCount < 0) throw new Error('Contagem de curtidas inválida no catálogo.');
    const commentsCount = row.commentsCount == null ? 0 : integer(row.commentsCount);
    if (commentsCount < 0) throw new Error('Contagem de comentários inválida no catálogo.');
    if (hasForbiddenPrivateFields(row)) {
      throw new Error('Dados privados não permitidos no catálogo público.');
    }
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
    const prepTimeMinMinutes =
      row.prepTimeMinMinutes == null
        ? undefined
        : integer(row.prepTimeMinMinutes);
    const prepTimeMaxMinutes =
      row.prepTimeMaxMinutes == null
        ? undefined
        : integer(row.prepTimeMaxMinutes);
    const inventoryItemId =
      row.inventoryItemId != null
        ? String(row.inventoryItemId)
        : row.inventory_item_id != null
          ? String(row.inventory_item_id)
          : null;
    const isOutOfStock =
      row.isOutOfStock === true || row.is_out_of_stock === true;
    return { id: text(row.id), restaurantId, categoryId, slug: text(row.slug),
      name: text(row.name), shortDescription: text(row.shortDescription),
      description: text(row.description), priceInCents,
      available: boolean(row.available), featured: boolean(row.featured),
      sortOrder: integer(row.sortOrder), coverImageId, images, video,
      dietaryInformation: row.dietaryInformation == null ? undefined : text(row.dietaryInformation),
      prepTimeMinMinutes, prepTimeMaxMinutes,
      likesCount, commentsCount,
      inventoryItemId, isOutOfStock };
  });
  if (new Set(products.map((product) => product.id)).size !== products.length ||
      new Set(products.map((product) => product.slug)).size !== products.length) {
    throw new Error('Produtos duplicados no catálogo.');
  }
  return { restaurantId, categories, products };
}

export function parseMyProductLikes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('A lista de curtidas retornada pelo servidor é inválida.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error('Identificador de produto inválido nas curtidas.');
    }
    if (!seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids;
}

export function parseToggleProductLikeResult(value: unknown): ProductLikeToggleResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A resposta da curtida é inválida.');
  }
  const row = value as Record<string, unknown>;
  if (hasForbiddenPrivateFields(row)) {
    throw new Error('Dados privados não permitidos na resposta de curtida.');
  }
  if (typeof row.liked !== 'boolean') {
    throw new Error('Estado da curtida inválido.');
  }
  if (typeof row.likesCount !== 'number' || !Number.isSafeInteger(row.likesCount) || row.likesCount < 0) {
    throw new Error('Contagem de curtidas inválida.');
  }
  return {
    liked: row.liked,
    likesCount: row.likesCount,
  };
}

export function parsePublicProductComment(
  value: unknown,
  expectedProductId?: string,
): PublicProductComment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('O comentário público retornado pelo servidor é inválido.');
  }
  const row = value as Record<string, unknown>;
  if (hasForbiddenPrivateFields(row)) {
    throw new Error('Dados privados não permitidos nos comentários públicos.');
  }
  if ('status' in row && row.status !== 'approved') {
    throw new Error('Comentário não aprovado não permitido na listagem pública.');
  }
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const productId = typeof row.productId === 'string' ? row.productId.trim() : '';
  if (!id || !productId) {
    throw new Error('Identificador inválido no comentário público.');
  }
  if (expectedProductId && productId !== expectedProductId) {
    throw new Error('Comentário pertencente a outro produto.');
  }
  if (typeof row.authorName !== 'string') {
    throw new Error('Autor inválido no comentário público.');
  }
  const authorName = row.authorName.trim();
  if (authorName.length < 2 || authorName.length > 40) {
    throw new Error('Nome do autor fora do padrão nos comentários públicos.');
  }
  if (typeof row.body !== 'string') {
    throw new Error('Texto inválido no comentário público.');
  }
  const body = row.body.trim();
  if (body.length < 3 || body.length > 280) {
    throw new Error('Conteúdo do comentário fora do limite permitido.');
  }
  const createdAt = isoTimestamp(row.createdAt, 'Data inválida no comentário público.');
  const likesCount =
    typeof row.likesCount === 'number' && Number.isSafeInteger(row.likesCount) && row.likesCount >= 0
      ? row.likesCount
      : 0;
  return {
    id,
    productId,
    authorName,
    body,
    createdAt,
    likesCount,
  };
}

export function parsePublicProductCommentsPage(
  value: unknown,
  expectedProductId?: string,
): PublicProductCommentsPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A página de comentários retornada pelo servidor é inválida.');
  }
  const data = value as Record<string, unknown>;
  if (hasForbiddenPrivateFields(data)) {
    throw new Error('Dados privados não permitidos na página de comentários.');
  }
  if (!Array.isArray(data.items)) {
    throw new Error('A lista de comentários públicos é inválida.');
  }
  if (typeof data.hasMore !== 'boolean') {
    throw new Error('Indicador de paginação inválido nos comentários.');
  }

  const seenIds = new Set<string>();
  const items: PublicProductComment[] = data.items.map((item) => {
    const parsed = parsePublicProductComment(item, expectedProductId);
    if (seenIds.has(parsed.id)) {
      throw new Error('Comentários duplicados na mesma página.');
    }
    seenIds.add(parsed.id);
    return parsed;
  });

  let nextCursor: ProductCommentsCursor | null = null;
  if (data.nextCursor == null) {
    if (data.hasMore) {
      throw new Error('Cursor de paginação ausente para comentários públicos.');
    }
  } else {
    if (typeof data.nextCursor !== 'object' || Array.isArray(data.nextCursor)) {
      throw new Error('Cursor de paginação inválido nos comentários.');
    }
    const cursorRow = data.nextCursor as Record<string, unknown>;
    if (hasForbiddenPrivateFields(cursorRow)) {
      throw new Error('Dados privados não permitidos no cursor de comentários.');
    }
    const cursorCreatedAt = isoTimestamp(
      cursorRow.createdAt,
      'Data inválida no cursor de comentários.',
    );
    const cursorId = typeof cursorRow.id === 'string' ? cursorRow.id.trim() : '';
    if (!cursorId) {
      throw new Error('Identificador inválido no cursor de comentários.');
    }
    nextCursor = {
      createdAt: cursorCreatedAt,
      id: cursorId,
    };
  }

  return {
    items,
    hasMore: data.hasMore,
    nextCursor,
  };
}

export function parseCreatedProductComment(
  value: unknown,
  expectedProductId?: string,
): CreatedProductCommentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A confirmação do comentário retornado pelo servidor é inválida.');
  }
  const row = value as Record<string, unknown>;
  if (hasForbiddenPrivateFields(row)) {
    throw new Error('Dados privados não permitidos na confirmação de comentário.');
  }
  if (row.status !== 'approved' && row.status !== 'pending') {
    throw new Error('Status inicial do comentário inválido.');
  }
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const productId = typeof row.productId === 'string' ? row.productId.trim() : '';
  if (!id || !productId) {
    throw new Error('Identificador inválido na confirmação de comentário.');
  }
  if (expectedProductId && productId !== expectedProductId) {
    throw new Error('Confirmação de comentário pertence a outro produto.');
  }
  if (typeof row.authorName !== 'string') {
    throw new Error('Autor inválido na confirmação de comentário.');
  }
  const authorName = row.authorName.trim();
  if (authorName.length < 2 || authorName.length > 40) {
    throw new Error('Nome do autor inválido na confirmação de comentário.');
  }
  if (typeof row.body !== 'string') {
    throw new Error('Texto inválido na confirmação de comentário.');
  }
  const body = row.body.trim();
  if (body.length < 3 || body.length > 280) {
    throw new Error('Texto do comentário fora do limite permitido.');
  }
  const createdAt = isoTimestamp(row.createdAt, 'Data inválida na confirmação de comentário.');
  const likesCount =
    typeof row.likesCount === 'number' && Number.isSafeInteger(row.likesCount) && row.likesCount >= 0
      ? row.likesCount
      : 0;

  return {
    id,
    productId,
    authorName,
    body,
    status: row.status,
    createdAt,
    likesCount,
  };
}

export function parseToggleProductCommentLike(
  value: unknown,
  expectedCommentId?: string,
): { commentId: string; liked: boolean; likesCount: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A resposta da curtida do comentário é inválida.');
  }
  const row = value as Record<string, unknown>;
  if (hasForbiddenPrivateFields(row)) {
    throw new Error('Dados privados não permitidos na curtida do comentário.');
  }
  const commentId = typeof row.commentId === 'string' ? row.commentId.trim() : '';
  if (!commentId) {
    throw new Error('Identificador do comentário ausente na resposta.');
  }
  if (expectedCommentId && commentId !== expectedCommentId) {
    throw new Error('Resposta de curtida referente a outro comentário.');
  }
  if (typeof row.liked !== 'boolean') {
    throw new Error('Estado da curtida do comentário inválido.');
  }
  if (typeof row.likesCount !== 'number' || !Number.isSafeInteger(row.likesCount) || row.likesCount < 0) {
    throw new Error('Contagem de curtidas do comentário inválida.');
  }
  return {
    commentId,
    liked: row.liked,
    likesCount: row.likesCount,
  };
}

function mapProductCommentLikeError(message?: string): string {
  const clean = (message ?? '').trim();
  if (
    clean === 'Esta operação exige uma sessão de cliente.' ||
    clean === 'Informe o restaurante, o comentário e a ação de curtida.' ||
    clean === 'Restaurante indisponível.' ||
    clean === 'Comentário não encontrado.' ||
    clean === 'Apenas comentários aprovados podem receber curtidas.' ||
    clean === 'Você está conectado com uma conta da equipe. Saia dela para interagir como cliente.' ||
    clean === 'Não foi possível iniciar sua sessão para esta interação. Tente novamente.'
  ) {
    return clean;
  }
  return 'Não foi possível atualizar a curtida do comentário. Tente novamente.';
}

function mapProductLikeError(message?: string): string {
  const clean = (message ?? '').trim();
  if (
    clean === 'Aguarde um momento antes de alterar sua curtida novamente.' ||
    clean === 'Muitas interações recentes. Aguarde um minuto para continuar.' ||
    clean === 'Este produto está temporariamente indisponível para interações.' ||
    clean === 'Restaurante indisponível.' ||
    clean === 'Produto não encontrado.' ||
    clean === 'Esta operação exige uma sessão de cliente.' ||
    clean === 'Informe o restaurante, o produto e a ação de curtida.'
  ) {
    return clean;
  }
  return 'Não foi possível atualizar sua curtida. Tente novamente.';
}

function mapProductCommentError(message?: string): string {
  const clean = (message ?? '').trim();
  if (
    clean === 'Esta operação exige uma sessão de cliente.' ||
    clean === 'Apenas clientes anônimos podem enviar comentários públicos.' ||
    clean === 'Informe o restaurante e o produto.' ||
    clean === 'Informe seu nome com 2 a 40 caracteres válidos.' ||
    clean === 'Informe seu nome com 2 a 40 caracteres.' ||
    clean === 'O comentário contém caracteres inválidos.' ||
    clean === 'O comentário deve ter entre 3 e 280 caracteres.' ||
    clean === 'Restaurante indisponível.' ||
    clean === 'Produto não encontrado.' ||
    clean === 'Este produto está temporariamente indisponível para comentários.' ||
    clean === 'Aguarde alguns segundos antes de enviar outro comentário neste prato.' ||
    clean === 'Você já enviou este mesmo comentário recentemente.' ||
    clean === 'Você já possui comentários aguardando avaliação neste prato.' ||
    clean === 'Muitos comentários enviados em sequência. Aguarde alguns minutos.' ||
    clean === 'Você está conectado com uma conta da equipe. Saia dela para interagir como cliente.' ||
    clean === 'Não foi possível iniciar sua sessão para esta interação. Tente novamente.'
  ) {
    return clean;
  }
  return 'Não foi possível enviar seu comentário. Tente novamente.';
}

export async function getPublicMenu(restaurantSlug: string): Promise<RestaurantMenu> {
  const { data, error } = await supabase.rpc('get_public_menu', {
    p_restaurant_slug: restaurantSlug,
  });
  if (error) throw new Error('Não foi possível carregar o cardápio. Tente novamente.');
  if (!data) throw new Error('O cardápio deste restaurante está indisponível.');
  return parsePublicMenu(data);
}

export async function getMyProductLikes(restaurantSlug: string): Promise<string[]> {
  if (!restaurantSlug.trim()) return [];

  // Não cria sessão anônima apenas por carregar a página e nunca substitui sessão de equipe/admin.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    return [];
  }
  if (!sessionData.session.user?.is_anonymous) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_my_product_likes', {
    p_restaurant_slug: restaurantSlug,
  });
  if (error) {
    throw new Error('Não foi possível carregar suas curtidas.');
  }
  return parseMyProductLikes(data ?? []);
}

export async function toggleProductLike(
  restaurantSlug: string,
  productId: string,
  liked: boolean,
): Promise<ProductLikeToggleResult> {
  if (!restaurantSlug.trim() || !productId.trim() || typeof liked !== 'boolean') {
    throw new Error('Informe o restaurante, o produto e a ação de curtida.');
  }

  // Inicia ou reutiliza a identidade anônima somente diante da ação explícita do cliente.
  // Se houver sessão de equipe/admin conectada, ensureGuestIdentity() bloqueia sem sobrescrevê-la.
  await ensureGuestIdentity();

  const { data, error } = await supabase.rpc('toggle_product_like', {
    p_restaurant_slug: restaurantSlug,
    p_product_id: productId,
    p_liked: liked,
  });

  if (error) {
    throw new Error(mapProductLikeError(error.message));
  }

  return parseToggleProductLikeResult(data);
}

export async function getPublicProductComments(
  restaurantSlug: string,
  productId: string,
  options?: {
    cursor?: ProductCommentsCursor | null;
    limit?: number;
  },
): Promise<PublicProductCommentsPage> {
  const cleanSlug = restaurantSlug.trim();
  const cleanProductId = productId.trim();
  if (!cleanSlug || !cleanProductId) {
    throw new Error('Informe o restaurante e o produto para carregar os comentários.');
  }

  const cursor = options?.cursor ?? null;
  if (cursor !== null) {
    if (!cursor.createdAt?.trim() || !cursor.id?.trim()) {
      throw new Error('Cursor de paginação inválido para os comentários.');
    }
  }

  const limit =
    options?.limit != null && Number.isSafeInteger(options.limit)
      ? Math.min(Math.max(options.limit, 1), 30)
      : 15;

  // Leitura pública: não exige nem cria sessão anônima apenas por visualizar comentários.
  const { data, error } = await supabase.rpc('get_public_product_comments', {
    p_restaurant_slug: cleanSlug,
    p_product_id: cleanProductId,
    p_cursor_created_at: cursor ? cursor.createdAt.trim() : null,
    p_cursor_id: cursor ? cursor.id.trim() : null,
    p_limit: limit,
  });

  if (error) {
    throw new Error('Não foi possível carregar os comentários deste prato. Tente novamente.');
  }

  return parsePublicProductCommentsPage(data, cleanProductId);
}

export async function createProductComment(
  restaurantSlug: string,
  productId: string,
  authorName: string,
  body: string,
): Promise<CreatedProductCommentResult> {
  const cleanSlug = restaurantSlug.trim();
  const cleanProductId = productId.trim();
  if (!cleanSlug || !cleanProductId) {
    throw new Error('Informe o restaurante e o produto.');
  }

  const cleanAuthor = authorName.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (cleanAuthor.length < 2 || cleanAuthor.length > 40) {
    throw new Error('Informe seu nome com 2 a 40 caracteres.');
  }

  const cleanBody = body
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (cleanBody.length < 3 || cleanBody.length > 280) {
    throw new Error('O comentário deve ter entre 3 e 280 caracteres.');
  }

  // Inicia ou reutiliza a identidade anônima somente quando o visitante efetivamente envia o comentário.
  // Nunca sobrescreve sessão de equipe/admin.
  try {
    await ensureGuestIdentity();
  } catch (cause) {
    // Mensagens de ensureGuestIdentity (ex.: conta da equipe conectada) já são seguras e
    // orientam o usuário; não devem ser mascaradas pela mensagem genérica.
    console.warn('[comments] ensureGuestIdentity falhou:', cause);
    throw cause instanceof Error
      ? cause
      : new Error('Não foi possível iniciar sua sessão para esta interação. Tente novamente.');
  }

  const { data, error } = await supabase.rpc('create_product_comment', {
    p_restaurant_slug: cleanSlug,
    p_product_id: cleanProductId,
    p_author_name: cleanAuthor,
    p_body: cleanBody,
  });

  if (error) {
    console.warn('[comments] create_product_comment falhou:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw new Error(mapProductCommentError(error.message));
  }

  try {
    return parseCreatedProductComment(data, cleanProductId);
  } catch (cause) {
    console.warn('[comments] resposta de create_product_comment rejeitada pelo parser:', cause, data);
    throw cause;
  }
}

export async function toggleProductCommentLike(
  restaurantSlug: string,
  commentId: string,
  liked: boolean,
): Promise<{ commentId: string; liked: boolean; likesCount: number }> {
  const cleanSlug = restaurantSlug.trim();
  const cleanCommentId = commentId.trim();
  if (!cleanSlug || !cleanCommentId) {
    throw new Error('Informe o restaurante e o comentário.');
  }

  // Inicia ou reutiliza a identidade anônima quando o visitante curte um comentário.
  // Nunca sobrescreve sessão de equipe/admin.
  try {
    await ensureGuestIdentity();
  } catch (cause) {
    console.warn('[comment-likes] ensureGuestIdentity falhou:', cause);
    throw cause instanceof Error
      ? cause
      : new Error('Não foi possível iniciar sua sessão para esta interação. Tente novamente.');
  }

  const { data, error } = await supabase.rpc('toggle_product_comment_like', {
    p_restaurant_slug: cleanSlug,
    p_comment_id: cleanCommentId,
    p_liked: liked,
  });

  if (error) {
    console.warn('[comment-likes] toggle_product_comment_like falhou:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw new Error(mapProductCommentLikeError(error.message));
  }

  return parseToggleProductCommentLike(data, cleanCommentId);
}

export async function getMyProductCommentLikes(restaurantSlug: string): Promise<string[]> {
  const cleanSlug = restaurantSlug.trim();
  if (!cleanSlug) return [];

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_my_product_comment_likes', {
    p_restaurant_slug: cleanSlug,
  });

  if (error) {
    console.warn('[comment-likes] get_my_product_comment_likes falhou:', error);
    return [];
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
}

export interface DirectOrderResult {
  itemId: string;
  tabId: string;
  tableId: string;
  tableNumber: number;
  productName: string;
  quantity: number;
  productionStatus: string;
  message: string;
}

export interface TableAssistanceResult {
  alertId: string;
  type: string;
  tableId: string;
  tableNumber: number;
  message: string;
}

export async function createDirectTableOrder(
  tableId: string,
  productId: string,
  quantity: number = 1
): Promise<DirectOrderResult> {
  const { data, error } = await supabase.rpc('create_direct_table_order', {
    p_table_id: tableId,
    p_product_id: productId,
    p_quantity: quantity,
  });

  if (error) {
    if (error.message.includes('ITEM_OUT_OF_STOCK')) {
      throw new Error('Este item acabou de esgotar no estoque.');
    }
    throw new Error(error.message || 'Não foi possível realizar o pedido. Tente novamente.');
  }

  return data as DirectOrderResult;
}

export async function requestTableAssistance(
  tableId: string,
  requestType: 'call_waiter' | 'close_table_request'
): Promise<TableAssistanceResult> {
  const { data, error } = await supabase.rpc('request_table_assistance', {
    p_table_id: tableId,
    p_request_type: requestType,
  });

  if (error) {
    if (error.message.includes('ASSISTANCE_COOLDOWN')) {
      throw new Error('Sua solicitação recente já foi recebida. Um atendente irá até sua mesa em breve.');
    }
    throw new Error(error.message || 'Não foi possível chamar atendimento.');
  }

  return data as TableAssistanceResult;
}
