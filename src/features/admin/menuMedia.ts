import { supabase } from '../../lib/supabase';
import type { ProductImage, ProductVideo } from '../../types/menu';

export interface AdminImage extends ProductImage { storagePath?: string }
export interface AdminVideo extends ProductVideo { storagePath?: string; durationSeconds?: number }
export interface DraftPhoto extends AdminImage { file?: Blob; previewUrl?: string }
export interface DraftVideo extends AdminVideo { file?: File; previewUrl?: string; uploadId?: string }
export const MAX_PHOTOS = 6;
export const MAX_IMAGE_INPUT = 10 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 12 * 1024 * 1024;

export async function preparePhoto(file: File, alt: string): Promise<DraftPhoto> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Use uma foto JPG, PNG ou WebP.');
  }
  if (!file.size || file.size > MAX_IMAGE_INPUT) throw new Error('Cada foto deve ter no máximo 10 MB.');
  let bitmap: ImageBitmap | HTMLImageElement;
  let inputUrl: string | null = null;
  try {
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(file);
    else {
      inputUrl = URL.createObjectURL(file);
      bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Foto inválida.'));
        image.src = inputUrl!;
      });
    }
  } catch {
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    throw new Error('Não foi possível abrir esta foto. Tente outro arquivo.');
  }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) {
      throw new Error('A foto é grande demais. Reduza a resolução e tente novamente.');
    }
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Seu navegador não conseguiu preparar a foto.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result && result.type === 'image/webp' ? resolve(result)
        : reject(new Error('Seu navegador não conseguiu converter a foto para WebP.')), 'image/webp', 0.82);
    });
    if (blob.size > 2 * 1024 * 1024) throw new Error('A foto ficou acima de 2 MB após a otimização. Use uma versão menor.');
    return { id: crypto.randomUUID(), url: '', alt: alt.trim().slice(0, 240) || 'Foto do produto',
      sortOrder: 0, file: blob, previewUrl: URL.createObjectURL(blob) };
  } finally {
    if ('close' in bitmap) bitmap.close();
    if (inputUrl) URL.revokeObjectURL(inputUrl);
  }
}

export async function prepareVideo(file: File): Promise<DraftVideo> {
  if (!['video/mp4', 'video/webm'].includes(file.type)) throw new Error('Use vídeo MP4 ou WebM.');
  if (!file.size || file.size > MAX_VIDEO_SIZE) throw new Error('O vídeo deve ter no máximo 12 MB.');
  const previewUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => { clear(); reject(new Error('Não foi possível verificar o vídeo. Tente um MP4 H.264.')); }, 15_000);
      function clear() { window.clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; }
      video.onloadedmetadata = () => { clear(); resolve(video.duration); };
      video.onerror = () => { clear(); reject(new Error('Este vídeo não foi reconhecido pelo navegador. Tente um MP4 H.264.')); };
      video.src = previewUrl;
    });
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('Use um vídeo de até 30 segundos.');
    return { url: '', mimeType: file.type as AdminVideo['mimeType'], file, previewUrl,
      uploadId: crypto.randomUUID(), durationSeconds: duration };
  } catch (cause) { URL.revokeObjectURL(previewUrl); throw cause; }
  finally { video.removeAttribute('src'); video.load(); }
}

export async function uploadMenuMedia(photos: DraftPhoto[], video: DraftVideo | null,
  restaurantId: string, productId: string, cache: Map<string, string>, onProgress: (message: string) => void,
) {
  async function upload(bucket: string, path: string, file: Blob, contentType: string) {
    const key = `${bucket}:${path}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const store = supabase.storage.from(bucket);
    const { error } = await store.upload(path, file, { contentType, cacheControl: '31536000', upsert: false });
    if (error) {
      // O upload pode ter terminado, mas sua resposta ter sido perdida. Arquivos têm nomes imutáveis.
      const slash = path.lastIndexOf('/');
      const { data, error: listError } = await store.list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 10 });
      if (listError || !data?.some((object) => object.name === path.slice(slash + 1))) {
        throw new Error('Não foi possível enviar a mídia. Confira a conexão, a migração de Storage e o perfil de administrador.');
      }
    }
    const { data } = store.getPublicUrl(path);
    cache.set(key, data.publicUrl);
    return data.publicUrl;
  }
  const images: AdminImage[] = [];
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    let url = photo.url;
    let storagePath = photo.storagePath;
    if (photo.file) {
      onProgress(`Enviando foto ${index + 1} de ${photos.length}…`);
      storagePath = `${restaurantId}/products/${productId}/${photo.id}.webp`;
      url = await upload('menu-images', storagePath, photo.file, 'image/webp');
    }
    images.push({ id: photo.id, url, alt: photo.alt.trim(), sortOrder: index + 1,
      ...(storagePath ? { storagePath } : {}) });
  }
  let savedVideo: AdminVideo | null = null;
  if (video) {
    let url = video.url;
    let storagePath = video.storagePath;
    if (video.file) {
      onProgress('Enviando vídeo…');
      const extension = video.mimeType === 'video/mp4' ? 'mp4' : 'webm';
      storagePath = `${restaurantId}/products/${productId}/${video.uploadId}.${extension}`;
      url = await upload('menu-videos', storagePath, video.file, video.mimeType);
    }
    savedVideo = { url, mimeType: video.mimeType,
      ...(storagePath ? { storagePath } : {}),
      ...(video.durationSeconds != null ? { durationSeconds: video.durationSeconds } : {}) };
  }
  return { images, video: savedVideo };
}
