import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { confirmGuestSession } from './guestConfirmation';

export function GuestConfirmationForm({
  restaurantSlug,
  tableNumber,
}: {
  restaurantSlug: string;
  tableNumber: number;
}) {
  const inputId = useId();
  const submitting = useRef(false);

  const [code, setCode] = useState('');
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      submitting.current ||
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
        setCode('');
      } else if (result.status === 'invalid_code') {
        setError(
          'Código incorreto, vencido ou já utilizado. ' +
            'Confira o código no celular do cliente.',
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
    <form
      onSubmit={handleSubmit}
      className="mt-4 border-t border-black/10 pt-4"
    >
      <fieldset disabled={busy || blocked}>
        <legend className="text-sm font-semibold">
          Confirmar cliente
        </legend>

        <p className="mt-1 text-xs opacity-75">
          Digite o código exibido no celular do cliente.
        </p>

        <label
          htmlFor={inputId}
          className="mb-2 mt-4 block text-sm font-medium"
        >
          Código de seis dígitos
        </label>

        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          placeholder="000000"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/[^0-9]/g, ''));
            setError('');
            setConfirmed(false);
          }}
          className="min-h-12 w-full rounded-xl border border-black/20 px-4 font-mono text-lg tracking-widest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        />

        <button
          type="submit"
          className="mt-3 min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy
            ? 'Confirmando…'
            : blocked
              ? `Aguarde ${remaining}s`
              : 'Confirmar cliente'}
        </button>
      </fieldset>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {confirmed && (
        <p
          role="status"
          className="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-900"
        >
          Cliente confirmado nesta mesa.
        </p>
      )}
    </form>
  );
}