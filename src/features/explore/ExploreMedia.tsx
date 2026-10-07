import { useEffect, useRef, useState } from 'react';
import type { Product } from '../../types/menu';

interface ExploreMediaProps {
  product: Product;
  active: boolean;
  nearby: boolean;
}

export function ExploreMedia({
  product,
  active,
  nearby,
}: ExploreMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const manuallyPaused = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const cover = product.images.find(
    (image) => image.id === product.coverImageId,
  );

  const prepareVideo =
    !!product.video && (active || nearby) && !videoFailed;

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !prepareVideo) return;

    let disposed = false;

    function pause() {
      video!.pause();
    }

    function attemptPlay() {
      if (
        disposed ||
        !active ||
        document.hidden ||
        manuallyPaused.current
      ) {
        return;
      }

      void video!.play().catch(() => {
        // Se o navegador bloquear autoplay, o botão permite iniciar.
      });
    }

    function handleVisibility() {
      if (document.hidden) {
        pause();
      } else {
        attemptPlay();
      }
    }

    if (active) {
      attemptPlay();
    } else {
      manuallyPaused.current = false;
      pause();
    }

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      pause();
      document.removeEventListener(
        'visibilitychange',
        handleVisibility,
      );
    };
  }, [active, prepareVideo, product.video?.url]);

  async function togglePlayback() {
    const video = videoRef.current;

    if (!video || !active) return;

    if (!video.paused) {
      manuallyPaused.current = true;
      video.pause();
      return;
    }

    manuallyPaused.current = false;

    try {
      await video.play();
    } catch {
      setPlaying(false);
    }
  }

  return (
    <div className="absolute inset-0 bg-[#111512]">
      {cover && !imageFailed ? (
        <img
          src={cover.url}
          alt={cover.alt}
          className="absolute inset-0 h-full w-full object-cover"
          loading={active || nearby ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-white">
          Foto em preparação
        </div>
      )}

      {prepareVideo && product.video && (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          poster={cover?.url}
          preload={active ? 'auto' : 'metadata'}
          muted
          playsInline
          loop
          aria-label={`Vídeo de ${product.name}`}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            setVideoFailed(true);
            setPlaying(false);
          }}
        >
          <source
            src={product.video.url}
            type={product.video.mimeType}
          />
        </video>
      )}

      {active && prepareVideo && (
        <button
          type="button"
          onClick={() => void togglePlayback()}
          aria-label={playing ? 'Pausar vídeo' : 'Reproduzir vídeo'}
          className="absolute right-4 top-20 z-20 min-h-11 rounded-full border border-white bg-black/60 px-4 text-sm text-white"
        >
          {playing ? 'Pausar' : 'Reproduzir'}
        </button>
      )}
    </div>
  );
}