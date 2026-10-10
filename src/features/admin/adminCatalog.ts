import { supabase } from '../../lib/supabase';
import type { AdminImage, AdminVideo } from './menuMedia';
export interface AdminCategory {
  id: string; name: string; slug: string; sort_order: number; active: boolean; revision: number;
}
export interface AdminProduct {
  id: string; category_id: string; name: string; slug: string; short_description: string;
  description: string; price_in_cents: number; available: boolean; featured: boolean;
  sort_order: number; dietary_information: string | null; revision: number;
  images: AdminImage[]; cover_image_id: string | null; video: AdminVideo | null;
}
export interface AdminCatalog { categories: AdminCategory[]; products: AdminProduct[] }
function message(error: {code?: string; message: string}): Error {
  if (error.code === '23505') return new Error('Já existe um cadastro com este endereço. Escolha outro.');
  if (['42501','22023','40001'].includes(error.code ?? '')) return new Error(error.message);
  return new Error('Não foi possível concluir. Confira sua conexão e tente novamente.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Catálogo inválido. Atualize a página.');
  return value as Record<string, unknown>;
}
function categoryFields(row: Record<string, unknown>): boolean {
  return ['id', 'name', 'slug'].every((key) => typeof row[key] === 'string')
    && typeof row.sort_order === 'number' && Number.isSafeInteger(row.sort_order)
    && typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision > 0;
}
export function parseAdminCatalog(value: unknown): AdminCatalog {
  const data = object(value);
  if (!Array.isArray(data.categories) || !Array.isArray(data.products)) throw new Error('Catálogo inválido.');
  const categories = data.categories.map((value) => {
    const row = object(value);
    if (!categoryFields(row) || typeof row.active !== 'boolean') throw new Error('Categoria inválida.');
    return row as unknown as AdminCategory;
  });
  const categoryIds = new Set(categories.map((category) => category.id));
  const products = data.products.map((value) => {
    const row = object(value);
    if (!categoryFields(row) || typeof row.category_id !== 'string' || !categoryIds.has(row.category_id)
      || typeof row.price_in_cents !== 'number' || !Number.isSafeInteger(row.price_in_cents) || row.price_in_cents < 0
      || typeof row.short_description !== 'string' || typeof row.description !== 'string'
      || typeof row.available !== 'boolean' || typeof row.featured !== 'boolean'
      || (row.dietary_information !== null && typeof row.dietary_information !== 'string')) throw new Error('Produto inválido.');
    if (!Array.isArray(row.images) || (row.cover_image_id !== null && typeof row.cover_image_id !== 'string')) {
      throw new Error('Galeria inválida.');
    }
    for (const value of row.images) {
      const image = object(value);
      if (typeof image.id !== 'string' || typeof image.url !== 'string' || typeof image.alt !== 'string'
        || typeof image.sortOrder !== 'number' || !Number.isSafeInteger(image.sortOrder)
        || (image.storagePath !== undefined && typeof image.storagePath !== 'string')) throw new Error('Foto inválida.');
    }
    if (row.video !== null) {
      const video = object(row.video);
      if (typeof video.url !== 'string' || !['video/mp4', 'video/webm'].includes(String(video.mimeType))
        || (video.storagePath !== undefined && typeof video.storagePath !== 'string')
        || (video.durationSeconds !== undefined && (typeof video.durationSeconds !== 'number'
          || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0))) throw new Error('Vídeo inválido.');
    }
    return row as unknown as AdminProduct;
  });
  if (categoryIds.size !== categories.length || new Set(products.map((product) => product.id)).size !== products.length) {
    throw new Error('O catálogo contém cadastros duplicados.');
  }
  return { categories, products };
}
export async function getAdminCatalog(slug: string): Promise<AdminCatalog> {
  const { data, error } = await supabase.rpc('get_admin_catalog', { p_slug: slug });
  if (error) throw message(error);
  return parseAdminCatalog(data);
}
export async function saveCatalogEntry(slug:string,kind:'category'|'product',id:string,revision:number,values:Record<string,unknown>) {
  const {data,error}=await supabase.rpc(kind==='category'?'save_menu_category':'save_menu_product_with_media',
    {p_slug:slug,p_id:id,p_revision:revision,p_values:values});
  if(error) throw message(error);
  if(data !== id) throw new Error('O servidor não confirmou o cadastro. Atualize a lista antes de tentar novamente.');
}
export function priceToCents(value:string):number {
  if (!/^\d{1,6}([,.]\d{1,2})?$/.test(value.trim())) throw new Error('Informe um preço como 58,90, sem separador de milhar.');
  const [whole,fraction='']=value.trim().replace(',','.').split('.');
  return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
export function slugify(value:string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,120).replace(/-$/,'');
}
