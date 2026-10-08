import { useEffect, useRef, useState } from 'react';
import { MAX_PHOTOS, preparePhoto, prepareVideo } from './menuMedia';
import type { DraftPhoto, DraftVideo } from './menuMedia';

export function ProductMediaFields({ photos, video, coverId, productName, disabled, onChange, onPreparing }: {
  photos: DraftPhoto[]; video: DraftVideo | null; coverId: string; productName: string; disabled: boolean;
  onChange: (photos: DraftPhoto[], video: DraftVideo | null, coverId: string) => void;
  onPreparing: (preparing: boolean) => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const processing = useRef(false);
  const latest = useRef({ photos, video, coverId });
  latest.current = { photos, video, coverId };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function addPhotos(files: File[]) {
    if (processing.current || disabled || !files.length) return;
    setError('');
    if (photos.length + files.length > MAX_PHOTOS) { setError('Use no máximo 6 fotos por produto.'); return; }
    processing.current = true; setPreparing(true); onPreparing(true);
    const prepared: DraftPhoto[] = [];
    try {
      for (const file of files) prepared.push(await preparePhoto(file, `Foto de ${productName.trim() || 'produto'}`));
      if (!mounted.current) { prepared.forEach((photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl)); return; }
      const state = latest.current;
      onChange([...state.photos, ...prepared], state.video, state.coverId || prepared[0].id);
    } catch (cause) {
      prepared.forEach((photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl));
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Não foi possível preparar as fotos.');
    } finally {
      processing.current = false;
      if (mounted.current) { setPreparing(false); onPreparing(false); }
    }
  }
  async function addVideo(file: File) {
    if (processing.current || disabled) return;
    processing.current = true; setPreparing(true); onPreparing(true); setError('');
    try {
      const prepared = await prepareVideo(file);
      if (!mounted.current) { if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl); return; }
      const state = latest.current;
      if (state.video?.previewUrl) URL.revokeObjectURL(state.video.previewUrl);
      onChange(state.photos, prepared, state.coverId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Não foi possível preparar o vídeo.');
    } finally {
      processing.current = false;
      if (mounted.current) { setPreparing(false); onPreparing(false); }
    }
  }
  const locked = disabled || preparing;
  const buttonClass = 'min-h-11 rounded-lg border border-black/20 px-3 text-sm disabled:opacity-40';
  return <div className="space-y-4 rounded-2xl border border-black/10 bg-stone-50 p-4">
    <h3 className="font-semibold">Fotos e vídeo do produto</h3>
    <p className="text-sm opacity-75">Escolha os arquivos agora. Eles serão enviados ao salvar o produto.</p>
    <label className="block text-sm font-medium">
      Adicionar fotos
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={locked || photos.length >= MAX_PHOTOS}
        className="mt-2 block min-h-11 w-full text-sm file:mr-3 file:rounded-lg file:border file:border-black/20 file:bg-white file:px-3 file:py-2"
        onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addPhotos(files); }} />
    </label>
    <p className="text-xs opacity-75">Até 6 fotos JPG, PNG ou WebP, de até 10 MB cada. Otimizadas automaticamente para WebP com até 1600 px.</p>
    <ul className="grid gap-3 sm:grid-cols-2">
      {photos.map((photo, index) => <li key={photo.id} className="space-y-2 rounded-xl border border-black/10 bg-white p-3">
        <img src={photo.previewUrl || photo.url} alt={photo.alt} className="aspect-[4/3] w-full rounded-lg object-cover" />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="product-cover" checked={coverId === photo.id} disabled={locked}
            onChange={() => onChange(photos, video, photo.id)} />
          {coverId === photo.id ? 'Foto de capa' : 'Usar como capa'}
        </label>
        <label className="block text-xs font-medium">
          Descrição da foto {index + 1}
          <input required maxLength={240} value={photo.alt} disabled={locked}
            className="mt-1 min-h-11 w-full rounded-lg border border-black/20 px-2 text-sm"
            onChange={(event) => onChange(photos.map((item) => item.id === photo.id ? { ...item, alt: event.target.value } : item), video, coverId)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={locked || index === 0} aria-label={`Mover foto ${index + 1} para antes`}
            onClick={() => { const reordered = [...photos]; [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]]; onChange(reordered, video, coverId); }}>←</button>
          <button type="button" className={buttonClass} disabled={locked || index === photos.length - 1} aria-label={`Mover foto ${index + 1} para depois`}
            onClick={() => { const reordered = [...photos]; [reordered[index + 1], reordered[index]] = [reordered[index], reordered[index + 1]]; onChange(reordered, video, coverId); }}>→</button>
          <button type="button" className={buttonClass} disabled={locked} aria-label={`Remover foto ${index + 1}`}
            onClick={() => {
              const next = photos.filter((item) => item.id !== photo.id);
              if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
              onChange(next, video, coverId === photo.id ? next[0]?.id ?? '' : coverId);
            }}>Remover</button>
        </div>
      </li>)}
    </ul>
    <div className="border-t border-black/10 pt-4">
      <label className="block text-sm font-medium">
        Vídeo para o Explorar
        <input type="file" accept="video/mp4,video/webm" disabled={locked}
          className="mt-2 block min-h-11 w-full text-sm file:mr-3 file:rounded-lg file:border file:border-black/20 file:bg-white file:px-3 file:py-2"
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void addVideo(file); }} />
      </label>
      <p className="text-xs opacity-75">Um vídeo de até 30 segundos e 12 MB. Prefira MP4 H.264 em 720p; WebM também é aceito. Adicione uma foto de capa.</p>
      {video && <>
        <video key={video.previewUrl || video.url} src={video.previewUrl || video.url}
          poster={photos.find((photo) => photo.id === coverId)?.previewUrl || photos.find((photo) => photo.id === coverId)?.url}
          controls playsInline muted preload="metadata" aria-label="Prévia do vídeo do produto"
          className="mt-3 max-h-80 w-full rounded-xl bg-black" />
        <button type="button" className={`${buttonClass} mt-2`} disabled={locked}
          onClick={() => { if (video.previewUrl) URL.revokeObjectURL(video.previewUrl); onChange(photos, null, coverId); }}>Remover vídeo</button>
      </>}
    </div>
    {preparing && <p role="status" className="text-sm">Preparando mídia…</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
  </div>;
}
