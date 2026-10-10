import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { confirmGuestSession } from './guestConfirmation';

export function GuestConfirmationForm({
  restaurantSlug,
  tableNumber,
  onConfirmed,
}: {
  restaurantSlug: string;
  tableNumber: number;
  onConfirmed?: () => void;
}) {
  const submitting = useRef(false);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (waitUntil === null) return;

    function updateWait() {
      const seconds = Math.max(
        0,
        Math.ceil((waitUntil! - Date.now()) / 1000),
      );

      setRemaining(seconds);

      if (seconds === 0) {
        setWaitUntil(null);
      }
    }

    updateWait();

    const timer = window.setInterval(updateWait, 1000);
    document.addEventListener('visibilitychange', updateWait);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', updateWait);
    };
  }, [waitUntil]);

  function handleDigitChange(index: number, val: string) {
    const clean = val.replace(/[^0-9]/g, '');
    const updated = [...digits];

    if (!clean) {
      updated[index] = '';
      setDigits(updated);
      return;
    }

    updated[index] = clean[clean.length - 1];
    setDigits(updated);
    setError('');
    setConfirmed(false);

    if (index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
    if (pasted) {
      const updated = [...digits];
      for (let i = 0; i < 6; i++) {
        updated[i] = pasted[i] || '';
      }
      setDigits(updated);
      setError('');
      setConfirmed(false);
      const nextIndex = Math.min(pasted.length, 5);
      inputsRef.current[nextIndex]?.focus();
    }
  }

  const code = digits.join('');
  const isComplete = code.length === 6;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      submitting.current ||
      !isComplete ||
      (waitUntil !== null && waitUntil > Date.now())
    ) {
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError('');
    setConfirmed(false);

    try {
      const result = await confirmGuestSession(
        restaurantSlug,
        tableNumber,
        code,
      );

      if (result.status === 'confirmed') {
        setConfirmed(true);
        setDigits(['', '', '', '', '', '']);
        onConfirmed?.();
      } else if (result.status === 'invalid_code') {
        setError(
          'Código incorreto, vencido ou já utilizado. Confira o código no celular do cliente.',
        );
      } else {
        setRemaining(result.retry_after_seconds);
        setWaitUntil(
          Date.now() + result.retry_after_seconds * 1000,
        );
        setError(
          'Limite de tentativas atingido. Aguarde para tentar novamente.',
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível confirmar o cliente.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const blocked = remaining > 0;

  return (
    <div className="staff-sub-block">
      <h4 className="staff-sub-title">Confirmar Acesso</h4>
      <p className="staff-sub-desc">
        Digite o código de 6 dígitos gerado pelo cliente para vincular à mesa.
      </p>

      <form onSubmit={handleSubmit}>
        <fieldset disabled={busy || blocked}>
          <div className="staff-confirm-row" onPaste={handlePaste}>
            <div className="staff-digit-row">
              {Array.from({ length: 6 }).map((_, i) => (
                <input
                  key={i}
                  ref={(el) => { inputsRef.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]"
                  maxLength={1}
                  autoComplete="off"
                  disabled={busy || blocked}
                  value={digits[i]}
                  placeholder="0"
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  className="staff-digit-box"
                />
              ))}
            </div>

            <button
              type="submit"
              disabled={busy || blocked || !isComplete}
              className="staff-outline-action-btn flex-1 min-w-[150px]"
            >
              {busy
                ? 'Confirmando…'
                : blocked
                  ? `Aguarde ${remaining}s`
                  : 'Confirmar acesso'}
            </button>
          </div>
        </fieldset>
      </form>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 font-medium">
          {error}
        </p>
      )}

      {confirmed && (
        <p
          role="status"
          className="mt-2 text-xs text-green-800 font-medium bg-green-50 p-2.5 rounded-xl border border-green-200"
        >
          Acesso confirmado com sucesso nesta mesa.
        </p>
      )}
    </div>
  );
}