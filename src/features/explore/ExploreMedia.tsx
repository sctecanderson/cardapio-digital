import { useEffect, useRef, useState } from 'react';
import type { Product } from '../../types/menu';

interface NavigatorNetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

function shouldConserveMobileData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (
    navigator as Navigator & { connection?: NavigatorNetworkInformation }
  ).connection;
  if (!connection) return false;
  return (
    Boolean(connection.saveData) ||
    connection.effectiveType === 'slow-2g' ||
    connection.effectiveType === '2g'
  );
}

interface ExploreMediaProps {
  product: Product;
  active: boolean;
  nearby: boolean;
  paused?: boolean;
  onAutoplayBlocked?: (productId: string) => void;
  onVideoError?: (productId: string, videoUrl: string) => void;
}

export function ExploreMedia({
  product,
  active,
  nearby,
  paused = false,
  onAutoplayBlocked,
  onVideoError,
}: ExploreMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wasActiveRef = useRef(false);
  const playGenerationRef = useRef(0);
  const callbacksRef = useRef({ onAutoplayBlocked, onVideoError });
  callbacksRef.current = { onAutoplayBlocked, onVideoError };

  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  const cover = product.images.find(
    (image) => image.id === product.coverImageId,
  );
  const coverUrl = cover?.url ?? null;
  const videoUrl = product.video?.url ?? null;

  const imageFailed = coverUrl !== null && failedImageUrl === coverUrl;
  const videoFailed = videoUrl !== null && failedVideoUrl === videoUrl;

  const allowNearbyPreload = nearby && !shouldConserveMobileData();
  const prepareVideo =
    !!product.video && (active || allowNearbyPreload) && !videoFailed;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !prepareVideo || !videoUrl) return;

    return () => {
      playGenerationRef.current += 1;
      if (!video.paused) {
        video.pause();
      }
    };
  }, [prepareVideo, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !prepareVideo || !videoUrl) {
      wasActiveRef.current = false;
      return;
    }

    const currentVideoUrl = videoUrl;
    let disposed = false;
    let blockedByBrowser = false;
    let retryFrameId: number | null = null;

    function pauseVideo(resetTime: boolean) {
      if (!video) return;
      playGenerationRef.current += 1;
      if (retryFrameId !== null) {
        window.cancelAnimationFrame(retryFrameId);
        retryFrameId = null;
      }
      if (!video.paused) {
        video.pause();
      }
      if (resetTime) {
        try {
          if (video.currentTime > 0) {
            video.currentTime = 0;
          }
        } catch {
          // Ignora se o navegador ainda não carregou metadados suficientes para seek
        }
      }
    }

    function attemptPlay(isRetry = false) {
      if (
        !video ||
        disposed ||
        blockedByBrowser ||
        !active ||
        paused ||
        document.hidden
      ) {
        return;
      }

      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;

      const generation = ++playGenerationRef.current;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        void playPromise.catch((err: unknown) => {
          if (
            disposed ||
            !active ||
            paused ||
            document.hidden ||
            generation !== playGenerationRef.current
          ) {
            return;
          }
          const errorName = err instanceof DOMException ? err.name : '';
          // Se uma transição de atributo/buffer gerou AbortError enquanto o slide segue ativo, retenta quando pronto.
          if (errorName === 'AbortError') {
            if (!isRetry && video.readyState >= 2) {
              retryFrameId = window.requestAnimationFrame(() => {
                retryFrameId = null;
                attemptPlay(true);
              });
            }
            return;
          }
          if (errorName === 'NotAllowedError') {
            blockedByBrowser = true;
            callbacksRef.current.onAutoplayBlocked?.(product.id);
            return;
          }
          if (video.error) {
            setFailedVideoUrl(currentVideoUrl);
            callbacksRef.current.onVideoError?.(product.id, currentVideoUrl);
          }
        });
      }
    }

    function handleReadyToPlay() {
      if (
        !disposed &&
        !blockedByBrowser &&
        active &&
        !paused &&
        !document.hidden &&
        video &&
        video.paused
      ) {
        attemptPlay(true);
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        pauseVideo(false);
      } else if (active && !paused && !blockedByBrowser) {
        attemptPlay();
      }
    }

    if (active) {
      if (paused || document.hidden) {
        pauseVideo(false);
      } else {
        attemptPlay();
      }
      wasActiveRef.current = true;
    } else {
      pauseVideo(wasActiveRef.current);
      wasActiveRef.current = false;
    }

    video.addEventListener('loadeddata', handleReadyToPlay);
    video.addEventListener('canplay', handleReadyToPlay);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      if (retryFrameId !== null) {
        window.cancelAnimationFrame(retryFrameId);
      }
      video.removeEventListener('loadeddata', handleReadyToPlay);
      video.removeEventListener('canplay', handleReadyToPlay);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [active, paused, prepareVideo, videoUrl, product.id]);

  function handleVideoError() {
    if (videoUrl) {
      setFailedVideoUrl(videoUrl);
      callbacksRef.current.onVideoError?.(product.id, videoUrl);
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
          draggable={false}
          onError={() => setFailedImageUrl(cover.url)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-white">
          Foto em preparação
        </div>
      )}

      {prepareVideo && product.video && (
        <video
          ref={videoRef}
          src={product.video.url}
          className="absolute inset-0 h-full w-full object-cover bg-transparent"
          poster={cover && !imageFailed ? cover.url : undefined}
          preload={active ? 'auto' : 'metadata'}
          muted
          playsInline
          loop
          aria-label={`Vídeo de ${product.name}`}
          onError={handleVideoError}
        />
      )}
    </div>
  );
}