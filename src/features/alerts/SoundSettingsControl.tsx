import { useState, useEffect, useRef } from 'react';
import {
  isSoundEnabled,
  toggleSoundEnabled,
  setSoundEnabled,
  getSoundPreset,
  setSoundPreset,
  playSoundPreset,
  SOUND_PRESETS,
  type SoundPresetId,
  type SoundEventType,
} from '../../lib/soundAlerts';

interface SoundSettingsControlProps {
  className?: string;
  showLabels?: boolean;
}

export function SoundSettingsControl({ className = '', showLabels = false }: SoundSettingsControlProps) {
  const [soundActive, setSoundActive] = useState(() => isSoundEnabled());
  const [kdsPreset, setKdsPreset] = useState<SoundPresetId>(() => getSoundPreset('kds'));
  const [waiterPreset, setWaiterPreset] = useState<SoundPresetId>(() => getSoundPreset('waiter'));
  const [readyPreset, setReadyPreset] = useState<SoundPresetId>(() => getSoundPreset('ready'));
  const [isOpen, setIsOpen] = useState(false);
  const [testingPreset, setTestingPreset] = useState<SoundPresetId | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleSoundChange = () => {
      setSoundActive(isSoundEnabled());
      setKdsPreset(getSoundPreset('kds'));
      setWaiterPreset(getSoundPreset('waiter'));
      setReadyPreset(getSoundPreset('ready'));
    };
    window.addEventListener('elozi:sound-setting-changed', handleSoundChange);
    return () => {
      window.removeEventListener('elozi:sound-setting-changed', handleSoundChange);
    };
  }, []);

  // Fechar ao clicar fora do modal/popover
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleTestSound = (presetId: SoundPresetId) => {
    setTestingPreset(presetId);
    playSoundPreset(presetId, true);
    setTimeout(() => {
      setTestingPreset((current) => (current === presetId ? null : current));
    }, 1200);
  };

  const handlePresetChange = (event: SoundEventType, presetId: SoundPresetId) => {
    setSoundPreset(event, presetId);
    if (event === 'kds') setKdsPreset(presetId);
    if (event === 'waiter') setWaiterPreset(presetId);
    if (event === 'ready') setReadyPreset(presetId);
  };

  return (
    <div className={`relative inline-flex items-center gap-1.5 ${className}`}>
      {/* Botão de Som Geral: Ativo / Mudo */}
      <button
        type="button"
        onClick={() => {
          const next = toggleSoundEnabled();
          setSoundActive(next);
        }}
        aria-label={soundActive ? 'Silenciar alertas sonoros' : 'Ativar alertas sonoros'}
        title={soundActive ? 'Alertas sonoros ativos — Clique para silenciar' : 'Alertas sonoros mudos — Clique para ativar'}
        className="inline-flex items-center justify-center gap-1.5 h-9 px-2.5 rounded-xl border border-black/10 text-xs font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 transition-colors"
        style={{
          color: soundActive ? 'var(--color-primary, #ea580c)' : 'var(--color-text-muted, #9ca3af)',
        }}
      >
        {soundActive ? (
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        ) : (
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
        {showLabels && (
          <span className="hidden sm:inline font-medium">
            {soundActive ? 'Som Ativo' : 'Mudo'}
          </span>
        )}
      </button>

      {/* Botão de Configurar Toques */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Configurar toques de alerta"
        title="Personalizar toques de alerta (iFood, Campainha, Sirene, Chime)"
        className={`inline-flex items-center justify-center gap-1.5 h-9 px-2.5 rounded-xl border text-xs font-semibold transition-colors ${
          isOpen
            ? 'bg-black/10 dark:bg-white/15 border-black/20 dark:border-white/20 text-stone-900 dark:text-stone-100'
            : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 text-stone-600 dark:text-stone-300'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        {showLabels && <span className="hidden sm:inline">Toques</span>}
      </button>

      {/* Popover / Modal de Configuração */}
      {isOpen && (
        <div
          ref={modalRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: '340px',
            maxWidth: 'calc(100vw - 24px)',
            zIndex: 9999,
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            borderRadius: '16px',
            border: '1px solid var(--color-border, #e5e7eb)',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            padding: '16px',
            animation: 'fadeIn 0.15s ease-out',
          }}
        >
          <div className="flex items-center justify-between pb-3 border-b border-black/10 dark:border-white/10">
            <div>
              <h3 className="text-sm font-bold text-stone-900 dark:text-stone-100 m-0">
                Toques de Notificação
              </h3>
              <p className="text-[11px] text-stone-500 dark:text-stone-400 m-0 mt-0.5">
                Áudio estridente estilo iFood para salão e cozinha
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
              aria-label="Fechar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Toggle Geral */}
          <div className="py-3 flex items-center justify-between border-b border-black/5 dark:border-white/5">
            <div>
              <span className="text-xs font-semibold text-stone-800 dark:text-stone-200 block">
                Som dos Alertas
              </span>
              <span className="text-[11px] text-stone-500 dark:text-stone-400">
                {soundActive ? 'Reproduzindo toques e vibrações' : 'Alertas silenciados'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !soundActive;
                setSoundEnabled(next);
                setSoundActive(next);
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                soundActive ? 'bg-orange-600' : 'bg-stone-300 dark:bg-stone-700'
              }`}
              role="switch"
              aria-checked={soundActive}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  soundActive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="pt-3 space-y-4">
            {/* Evento 1: Cliente Chamou / Fechar Mesa */}
            <div>
              <label className="block text-[11px] font-bold text-stone-700 dark:text-stone-300 mb-1">
                Cliente chamou na mesa ou pediu conta:
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  value={waiterPreset}
                  onChange={(e) => handlePresetChange('waiter', e.target.value as SoundPresetId)}
                  className="flex-1 text-xs py-1.5 px-2 rounded-lg border border-black/15 dark:border-white/15 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 font-medium focus:outline-none focus:ring-1 focus:ring-orange-500"
                >
                  {SOUND_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleTestSound(waiterPreset)}
                  disabled={testingPreset === waiterPreset}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 text-stone-700 dark:text-stone-200 transition-colors shrink-0"
                  title="Testar este som agora"
                >
                  {testingPreset === waiterPreset ? 'Tocando…' : 'Ouvir'}
                </button>
              </div>
            </div>

            {/* Evento 2: Cozinha Finalizou Prato */}
            <div>
              <label className="block text-[11px] font-bold text-stone-700 dark:text-stone-300 mb-1">
                Cozinha avisou prato pronto para entrega:
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  value={readyPreset}
                  onChange={(e) => handlePresetChange('ready', e.target.value as SoundPresetId)}
                  className="flex-1 text-xs py-1.5 px-2 rounded-lg border border-black/15 dark:border-white/15 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 font-medium focus:outline-none focus:ring-1 focus:ring-orange-500"
                >
                  {SOUND_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleTestSound(readyPreset)}
                  disabled={testingPreset === readyPreset}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 text-stone-700 dark:text-stone-200 transition-colors shrink-0"
                  title="Testar este som agora"
                >
                  {testingPreset === readyPreset ? 'Tocando…' : 'Ouvir'}
                </button>
              </div>
            </div>

            {/* Evento 3: Novo Pedido no KDS */}
            <div>
              <label className="block text-[11px] font-bold text-stone-700 dark:text-stone-300 mb-1">
                Entrada de novo pedido no KDS:
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  value={kdsPreset}
                  onChange={(e) => handlePresetChange('kds', e.target.value as SoundPresetId)}
                  className="flex-1 text-xs py-1.5 px-2 rounded-lg border border-black/15 dark:border-white/15 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 font-medium focus:outline-none focus:ring-1 focus:ring-orange-500"
                >
                  {SOUND_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleTestSound(kdsPreset)}
                  disabled={testingPreset === kdsPreset}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 text-stone-700 dark:text-stone-200 transition-colors shrink-0"
                  title="Testar este som agora"
                >
                  {testingPreset === kdsPreset ? 'Tocando…' : 'Ouvir'}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-black/10 dark:border-white/10 flex justify-end">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-3 py-1.5 text-xs font-bold rounded-xl bg-orange-600 hover:bg-orange-700 text-white transition-colors"
            >
              Concluir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
