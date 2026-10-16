/**
 * Utilitário central de alertas sonoros estridentes de alto impacto e vibração.
 * Desenvolvido especialmente para ambientes ruidosos de restaurantes e cozinhas.
 * 100% nativo via Web Audio API (zero arquivos de áudio externos).
 */

export type SoundPresetId =
  | 'ifood_classic'
  | 'kitchen_bell'
  | 'urgent_siren'
  | 'harmonic_chime';

export type SoundEventType = 'kds' | 'waiter' | 'ready';

export interface SoundPresetOption {
  id: SoundPresetId;
  label: string;
  description: string;
}

export const SOUND_PRESETS: SoundPresetOption[] = [
  {
    id: 'ifood_classic',
    label: 'iFood Clássico (Penetrante)',
    description: 'Arpejo duplo agudo em 3 repetições (Estilo Delivery)',
  },
  {
    id: 'kitchen_bell',
    label: 'Campainha Metálica de Balcão',
    description: 'Batida percussiva aguda (Trim-Trim-Trim!)',
  },
  {
    id: 'urgent_siren',
    label: 'Sirene Dupla de Salão',
    description: 'Alternância rápida de alta atenção em 4 ciclos',
  },
  {
    id: 'harmonic_chime',
    label: 'Triplo Chime Forte',
    description: 'Tríade harmônica ascendente brilhante repetida 2x',
  },
];

const STORAGE_KEY = 'elozi_sound_enabled';
const LEGACY_STORAGE_KEY = 'kds_audio_enabled';

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContextClass();
  }
  return sharedAudioContext;
}

/**
 * Desbloqueia o AudioContext após o primeiro clique/toque
 */
export function unlockAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    unlockAudioContext();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const val = localStorage.getItem(STORAGE_KEY);
  if (val === null) {
    const legacyVal = localStorage.getItem(LEGACY_STORAGE_KEY);
    return legacyVal !== 'false';
  }
  return val !== 'false';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, String(enabled));
  localStorage.setItem(LEGACY_STORAGE_KEY, String(enabled));
  window.dispatchEvent(
    new CustomEvent('elozi:sound-setting-changed', { detail: { enabled } })
  );
}

export function toggleSoundEnabled(): boolean {
  const next = !isSoundEnabled();
  setSoundEnabled(next);
  return next;
}

export function getSoundPreset(event: SoundEventType): SoundPresetId {
  if (typeof window === 'undefined') {
    return event === 'ready' ? 'kitchen_bell' : 'ifood_classic';
  }
  const key = `elozi_sound_preset_${event}`;
  const val = localStorage.getItem(key);
  if (
    val === 'ifood_classic' ||
    val === 'kitchen_bell' ||
    val === 'urgent_siren' ||
    val === 'harmonic_chime'
  ) {
    return val;
  }
  return event === 'ready' ? 'kitchen_bell' : 'ifood_classic';
}

export function setSoundPreset(event: SoundEventType, presetId: SoundPresetId): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`elozi_sound_preset_${event}`, presetId);
  window.dispatchEvent(
    new CustomEvent('elozi:sound-setting-changed', {
      detail: { event, presetId, enabled: isSoundEnabled() },
    })
  );
}

function safeVibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // Ignora restrições do navegador
  }
}

interface ToneStep {
  freq: number;
  startTime: number;
  duration: number;
  waves: Array<{ type: OscillatorType; gain: number }>;
}

function playToneSteps(steps: ToneStep[]): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    for (const step of steps) {
      const stepStart = now + step.startTime;
      const stepEnd = stepStart + step.duration;

      for (const wave of step.waves) {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();

        osc.type = wave.type;
        osc.frequency.setValueAtTime(step.freq, stepStart);

        gainNode.gain.setValueAtTime(0.0001, stepStart);
        gainNode.gain.linearRampToValueAtTime(wave.gain, stepStart + 0.015);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, stepEnd);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(stepStart);
        osc.stop(stepEnd);
      }
    }
  } catch (err) {
    console.warn('Erro ao sintetizar áudio estridente:', err);
  }
}

/**
 * Síntese acústica estridente: iFood Clássico
 * Duplo arpejo penetrante em 3 repetições (B5 987Hz -> E6 1318Hz -> B5 987Hz -> E6 1318Hz).
 */
function synthesizeIfoodClassic(): void {
  safeVibrate([300, 100, 300, 100, 400]);

  const steps: ToneStep[] = [];
  const waves: Array<{ type: OscillatorType; gain: number }> = [
    { type: 'square', gain: 0.52 },
    { type: 'triangle', gain: 0.38 },
  ];

  // 3 repetições consecutivas com pausa de 180ms
  for (let rep = 0; rep < 3; rep++) {
    const baseT = rep * (0.24 + 0.18);
    steps.push(
      { freq: 987.77, startTime: baseT, duration: 0.055, waves }, // B5
      { freq: 1318.51, startTime: baseT + 0.06, duration: 0.055, waves }, // E6
      { freq: 987.77, startTime: baseT + 0.12, duration: 0.055, waves }, // B5
      { freq: 1318.51, startTime: baseT + 0.18, duration: 0.07, waves } // E6
    );
  }

  playToneSteps(steps);
}

/**
 * Síntese acústica estridente: Campainha Metálica de Balcão
 * Batida aguda com harmônicos metálicos (1567Hz + 2349Hz batendo 3x: Trim-Trim-Trim!).
 */
function synthesizeKitchenBell(): void {
  safeVibrate([200, 80, 200, 80, 200]);

  const steps: ToneStep[] = [];

  // 3 batidas percussivas rápidas
  for (let hit = 0; hit < 3; hit++) {
    const t = hit * 0.18;
    steps.push(
      {
        freq: 1567.98, // G6
        startTime: t,
        duration: 0.15,
        waves: [
          { type: 'triangle', gain: 0.5 },
          { type: 'square', gain: 0.2 },
        ],
      },
      {
        freq: 2349.32, // D7
        startTime: t,
        duration: 0.14,
        waves: [
          { type: 'sine', gain: 0.35 },
          { type: 'square', gain: 0.15 },
        ],
      }
    );
  }

  playToneSteps(steps);
}

/**
 * Síntese acústica estridente: Sirene Dupla de Salão
 * Alternância aguda A5 (880Hz) <-> E6 (1318Hz) 4 vezes rápidas com ondas sawtooth e square.
 */
function synthesizeUrgentSiren(): void {
  safeVibrate([400, 120, 400]);

  const steps: ToneStep[] = [];
  const waves: Array<{ type: OscillatorType; gain: number }> = [
    { type: 'sawtooth', gain: 0.45 },
    { type: 'square', gain: 0.45 },
  ];

  // 4 alternâncias (8 tons no total)
  for (let i = 0; i < 4; i++) {
    const t = i * 0.15;
    steps.push(
      { freq: 880.0, startTime: t, duration: 0.07, waves }, // A5
      { freq: 1318.51, startTime: t + 0.075, duration: 0.07, waves } // E6
    );
  }

  playToneSteps(steps);
}

/**
 * Síntese acústica estridente: Triplo Chime Forte
 * Tríade ascendente encorpada (C6 1046Hz -> E6 1318Hz -> G6 1568Hz) repetida 2 vezes em alto volume.
 */
function synthesizeHarmonicChime(): void {
  safeVibrate([250, 100, 250]);

  const steps: ToneStep[] = [];
  const waves: Array<{ type: OscillatorType; gain: number }> = [
    { type: 'square', gain: 0.42 },
    { type: 'triangle', gain: 0.48 },
  ];

  for (let rep = 0; rep < 2; rep++) {
    const baseT = rep * 0.45;
    steps.push(
      { freq: 1046.5, startTime: baseT, duration: 0.09, waves }, // C6
      { freq: 1318.51, startTime: baseT + 0.09, duration: 0.09, waves }, // E6
      { freq: 1567.98, startTime: baseT + 0.18, duration: 0.22, waves } // G6
    );
  }

  playToneSteps(steps);
}

/**
 * Executa o preset sonoro selecionado.
 * @param presetId ID do preset configurado
 * @param force Se true, toca mesmo se estiver mudo (usado no botão [ Ouvir ] de teste)
 */
export function playSoundPreset(presetId: SoundPresetId, force = false): void {
  if (!force && !isSoundEnabled()) return;
  unlockAudioContext();

  switch (presetId) {
    case 'ifood_classic':
      synthesizeIfoodClassic();
      break;
    case 'kitchen_bell':
      synthesizeKitchenBell();
      break;
    case 'urgent_siren':
      synthesizeUrgentSiren();
      break;
    case 'harmonic_chime':
      synthesizeHarmonicChime();
      break;
  }
}

/**
 * Alerta sonoro do KDS para novo pedido recebido.
 */
export function playKdsNewOrderSound(): void {
  playSoundPreset(getSoundPreset('kds'));
}

/**
 * Alerta sonoro de chamado do garçom / solicitação de fechamento de mesa.
 */
export function playWaiterCallSound(): void {
  playSoundPreset(getSoundPreset('waiter'));
}

/**
 * Alerta sonoro de prato pronto na cozinha (KDS -> Garçom).
 */
export function playDishReadySound(): void {
  playSoundPreset(getSoundPreset('ready'));
}

/**
 * Alerta sonoro de estoque baixo / ruptura.
 */
export function playLowStockSound(): void {
  if (!isSoundEnabled()) return;
  safeVibrate(150);

  const waves: Array<{ type: OscillatorType; gain: number }> = [
    { type: 'square', gain: 0.35 },
    { type: 'triangle', gain: 0.45 },
  ];

  playToneSteps([
    { freq: 587.33, startTime: 0, duration: 0.08, waves },
    { freq: 440.0, startTime: 0.08, duration: 0.18, waves },
    { freq: 587.33, startTime: 0.3, duration: 0.08, waves },
    { freq: 440.0, startTime: 0.38, duration: 0.22, waves },
  ]);
}
