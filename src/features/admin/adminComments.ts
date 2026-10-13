import { supabase } from '../../lib/supabase';

export type ProductCommentStatus = 'pending' | 'approved' | 'hidden' | 'rejected';

export interface AdminProductComment {
  id: string;
  productId: string;
  productName: string;
  authorName: string;
  body: string;
  status: ProductCommentStatus;
  createdAt: string;
  moderatedAt: string | null;
  moderatedBy: string | null;
  likesCount: number;
}

export interface AdminCommentCounts {
  pending: number;
  approved: number;
  hidden: number;
  rejected: number;
  total: number;
}

export interface AdminProductCommentsPage {
  items: AdminProductComment[];
  hasMore: boolean;
  nextCursor: { createdAt: string; id: string } | null;
  counts: AdminCommentCounts;
}

export interface RestaurantRestrictedTerm {
  id: string;
  term: string;
  normalizedTerm: string;
  createdAt: string;
}

export async function listAdminProductComments(
  restaurantSlug: string,
  options?: {
    status?: ProductCommentStatus | null;
    productId?: string | null;
    cursorCreatedAt?: string | null;
    cursorId?: string | null;
    limit?: number;
  },
): Promise<AdminProductCommentsPage> {
  const cleanSlug = restaurantSlug.trim();
  if (!cleanSlug) throw new Error('Informe o restaurante.');

  const { data, error } = await supabase.rpc('list_admin_product_comments', {
    p_restaurant_slug: cleanSlug,
    p_status: options?.status ?? null,
    p_product_id: options?.productId ?? null,
    p_cursor_created_at: options?.cursorCreatedAt ?? null,
    p_cursor_id: options?.cursorId ?? null,
    p_limit: options?.limit ?? 25,
  });

  if (error) {
    console.warn('[admin-comments] list_admin_product_comments falhou:', error);
    throw new Error(error.message || 'Não foi possível carregar os comentários.');
  }

  const res = data as Record<string, unknown>;
  const itemsRaw = Array.isArray(res?.items) ? res.items : [];
  const countsRaw = (res?.counts ?? {}) as Record<string, unknown>;

  const items: AdminProductComment[] = itemsRaw.map((raw: any) => ({
    id: String(raw.id),
    productId: String(raw.productId),
    productName: String(raw.productName || 'Prato'),
    authorName: String(raw.authorName || 'Anônimo'),
    body: String(raw.body || ''),
    status: raw.status as ProductCommentStatus,
    createdAt: String(raw.createdAt),
    moderatedAt: raw.moderatedAt ? String(raw.moderatedAt) : null,
    moderatedBy: raw.moderatedBy ? String(raw.moderatedBy) : null,
    likesCount: Number(raw.likesCount ?? 0),
  }));

  const counts: AdminCommentCounts = {
    pending: Number(countsRaw.pending ?? 0),
    approved: Number(countsRaw.approved ?? 0),
    hidden: Number(countsRaw.hidden ?? 0),
    rejected: Number(countsRaw.rejected ?? 0),
    total: Number(countsRaw.total ?? 0),
  };

  const nextCursor =
    res?.nextCursor && typeof res.nextCursor === 'object'
      ? {
          createdAt: String((res.nextCursor as any).createdAt),
          id: String((res.nextCursor as any).id),
        }
      : null;

  return {
    items,
    hasMore: Boolean(res?.hasMore),
    nextCursor,
    counts,
  };
}

export async function moderateProductComment(
  restaurantSlug: string,
  commentId: string,
  newStatus: 'approved' | 'hidden' | 'rejected',
): Promise<{
  id: string;
  productId: string;
  status: ProductCommentStatus;
  moderatedAt: string | null;
  commentsCount: number;
}> {
  const cleanSlug = restaurantSlug.trim();
  const cleanCommentId = commentId.trim();
  if (!cleanSlug || !cleanCommentId) throw new Error('Dados incompletos para moderação.');

  const { data, error } = await supabase.rpc('moderate_product_comment', {
    p_restaurant_slug: cleanSlug,
    p_comment_id: cleanCommentId,
    p_new_status: newStatus,
  });

  if (error) {
    console.warn('[admin-comments] moderate_product_comment falhou:', error);
    throw new Error(error.message || 'Não foi possível moderar o comentário.');
  }

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    productId: String(row.productId),
    status: row.status as ProductCommentStatus,
    moderatedAt: row.moderatedAt ? String(row.moderatedAt) : null,
    commentsCount: Number(row.commentsCount ?? 0),
  };
}

export async function deleteAdminProductComment(
  restaurantSlug: string,
  commentId: string,
): Promise<{
  id: string;
  productId: string;
  deleted: boolean;
  commentsCount: number;
}> {
  const cleanSlug = restaurantSlug.trim();
  const cleanCommentId = commentId.trim();
  if (!cleanSlug || !cleanCommentId) throw new Error('Dados incompletos para exclusão.');

  const { data, error } = await supabase.rpc('delete_admin_product_comment', {
    p_restaurant_slug: cleanSlug,
    p_comment_id: cleanCommentId,
  });

  if (error) {
    console.warn('[admin-comments] delete_admin_product_comment falhou:', error);
    throw new Error(error.message || 'Não foi possível excluir o comentário.');
  }

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    productId: String(row.productId),
    deleted: Boolean(row.deleted),
    commentsCount: Number(row.commentsCount ?? 0),
  };
}

export async function listRestaurantRestrictedTerms(
  restaurantSlug: string,
): Promise<RestaurantRestrictedTerm[]> {
  const cleanSlug = restaurantSlug.trim();
  if (!cleanSlug) throw new Error('Informe o restaurante.');

  const { data, error } = await supabase.rpc('list_restaurant_comment_restricted_terms', {
    p_restaurant_slug: cleanSlug,
  });

  if (error) {
    console.warn('[admin-comments] list_restaurant_comment_restricted_terms falhou:', error);
    throw new Error(error.message || 'Não foi possível listar as palavras restritas.');
  }

  if (!Array.isArray(data)) return [];

  return data.map((raw: any) => ({
    id: String(raw.id),
    term: String(raw.term),
    normalizedTerm: String(raw.normalizedTerm),
    createdAt: String(raw.createdAt),
  }));
}

export async function addRestaurantRestrictedTerm(
  restaurantSlug: string,
  term: string,
): Promise<RestaurantRestrictedTerm> {
  const cleanSlug = restaurantSlug.trim();
  const cleanTerm = term.trim();
  if (!cleanSlug || !cleanTerm) throw new Error('Informe o termo restrito.');

  const { data, error } = await supabase.rpc('add_restaurant_comment_restricted_term', {
    p_restaurant_slug: cleanSlug,
    p_term: cleanTerm,
  });

  if (error) {
    console.warn('[admin-comments] add_restaurant_comment_restricted_term falhou:', error);
    throw new Error(error.message || 'Não foi possível adicionar o termo restrito.');
  }

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    term: String(row.term),
    normalizedTerm: String(row.normalizedTerm),
    createdAt: String(row.createdAt),
  };
}

export async function removeRestaurantRestrictedTerm(
  restaurantSlug: string,
  termId: string,
): Promise<boolean> {
  const cleanSlug = restaurantSlug.trim();
  const cleanTermId = termId.trim();
  if (!cleanSlug || !cleanTermId) throw new Error('Informe o termo a ser removido.');

  const { data, error } = await supabase.rpc('remove_restaurant_comment_restricted_term', {
    p_restaurant_slug: cleanSlug,
    p_term_id: cleanTermId,
  });

  if (error) {
    console.warn('[admin-comments] remove_restaurant_comment_restricted_term falhou:', error);
    throw new Error(error.message || 'Não foi possível remover o termo restrito.');
  }

  const row = data as Record<string, unknown>;
  return Boolean(row.success);
}
