import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * ConfettiBurst — Microanimação de confetes sutil e premium.
 *
 * Características:
 * - 18 partículas leves em CSS puro.
 * - Cores elegantes alinhadas com a paleta Elozi (Terracota, Dourado suave, Bronze, Creme, Verde sálvia).
 * - Duração breve (~1.3s) com auto-remoção do DOM.
 * - Totalmente transparente a eventos de ponteiro (pointer-events: none).
 * - Respeita rigorosamente `prefers-reduced-motion` (não renderiza partículas).
 * - Não anunciado a leitores de tela (aria-hidden="true").
 */
interface ConfettiBurstProps {
  onDone?: () => void;
}

const PARTICLES = [
  { x: -65, y: -75, rot: 55, color: 'var(--brand, #b9472b)', w: 8, h: 12, delay: 0 },
  { x: 55, y: -80, rot: -65, color: '#e0a96d', w: 7, h: 11, delay: 30 },
  { x: -95, y: -45, rot: 35, color: '#2a9d8f', w: 8, h: 11, delay: 20 },
  { x: 85, y: -50, rot: -50, color: 'var(--brand, #b9472b)', w: 7, h: 10, delay: 50 },
  { x: -35, y: -100, rot: 80, color: '#f4a261', w: 6, h: 9, delay: 25 },
  { x: 30, y: -105, rot: -30, color: '#2b1d17', w: 7, h: 11, delay: 40 },
  { x: -80, y: 15, rot: 95, color: '#e76f51', w: 8, h: 12, delay: 70 },
  { x: 75, y: 10, rot: -80, color: '#e0a96d', w: 6, h: 10, delay: 60 },
  { x: -20, y: -65, rot: 20, color: '#b9472b', w: 7, h: 10, delay: 10 },
  { x: 20, y: -70, rot: -20, color: '#f4a261', w: 8, h: 12, delay: 35 },
  { x: -110, y: -15, rot: 130, color: '#2a9d8f', w: 7, h: 11, delay: 80 },
  { x: 105, y: -20, rot: -120, color: '#e76f51', w: 7, h: 10, delay: 75 },
  { x: -45, y: 35, rot: 45, color: '#e0a96d', w: 6, h: 9, delay: 90 },
  { x: 45, y: 30, rot: -55, color: 'var(--brand, #b9472b)', w: 7, h: 11, delay: 85 },
  { x: -5, y: -110, rot: 15, color: '#e0a96d', w: 7, h: 10, delay: 45 },
  { x: 5, y: -90, rot: -10, color: '#2a9d8f', w: 6, h: 9, delay: 15 },
  { x: -70, y: -95, rot: 70, color: '#f4a261', w: 7, h: 11, delay: 60 },
  { x: 65, y: -90, rot: -75, color: '#e76f51', w: 8, h: 12, delay: 55 },
];

export function ConfettiBurst({ onDone }: ConfettiBurstProps = {}) {
  const [visible, setVisible] = useState(() => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return true;
  });

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!visible) {
      onDoneRef.current?.();
      return;
    }

    const timer = window.setTimeout(() => {
      setVisible(false);
      onDoneRef.current?.();
    }, 1350);

    return () => {
      window.clearTimeout(timer);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="confetti-burst-container" aria-hidden="true">
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="confetti-particle"
          style={
            {
              '--target-x': `${p.x}px`,
              '--target-y': `${p.y}px`,
              '--target-rot': `${p.rot}deg`,
              '--color': p.color,
              '--width': `${p.w}px`,
              '--height': `${p.h}px`,
              '--delay': `${p.delay}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

