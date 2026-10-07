import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'react-router';
import { openTableVisit } from './tableVisits';
import type { TableVisit } from './tableVisits';

export function StaffServicePage() {
  const { restaurantSlug } = useParams();

  if (!restaurantSlug) {
    return <p role="alert">Restaurante não identificado.</p>;
  }

  return (
    <TableVisitForm
      key={restaurantSlug}
      restaurantSlug={restaurantSlug}
    />
  );
}

function TableVisitForm({
  restaurantSlug,
}: {
  restaurantSlug: string;
}) {
  const submitting = useRef(false);

  const [tableNumber, setTableNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    tableNumber: number;
    visit: TableVisit;
  } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitting.current) return;

    const value = tableNumber.trim();

    if (!/^\d{1,3}$/.test(value)) {
      setError('Informe um número de mesa entre 1 e 999.');
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError('');
    setResult(null);

    try {
      const number = Number(value);
      const visit = await openTableVisit(restaurantSlug, number);

      setResult({ tableNumber: number, visit });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível abrir o atendimento.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-3xl border border-black/10 bg-white p-6">
      <h1 className="text-2xl font-semibold">Atendimento de mesas</h1>

      <p className="mt-2 text-sm opacity-75">
        Informe a mesa para iniciar ou retomar seu atendimento.
      </p>

      <form onSubmit={handleSubmit} className="mt-6">
        <fieldset disabled={busy} className="space-y-4">
          <div>
            <label
              htmlFor="service-table-number"
              className="mb-2 block text-sm font-medium"
            >
              Número da mesa
            </label>

            <input
              id="service-table-number"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{1,3}"
              maxLength={3}
              autoComplete="off"
              placeholder="Ex.: 07"
              required
              value={tableNumber}
              onChange={(event) => {
                setTableNumber(event.target.value);
                setError('');
                setResult(null);
              }}
              className="min-h-12 w-full rounded-xl border border-black/20 px-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
            />
          </div>

          <button
            type="submit"
            className="min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Abrindo atendimento…' : 'Assumir mesa'}
          </button>
        </fieldset>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-green-700/20 bg-green-50 p-4 text-green-900"
        >
          <p className="font-semibold">
            Mesa {String(result.tableNumber).padStart(2, '0')}
          </p>

          <p className="mt-1 text-sm">
            Atendimento aberto e vinculado à sua conta.
          </p>
        </div>
      )}
    </section>
  );
}