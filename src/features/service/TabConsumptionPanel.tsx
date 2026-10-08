import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TableTab } from './tableTabs';
import { addTabConsumption, cancelTabConsumption, getTabConsumption } from './tabConsumption';
import type { ConsumptionProduct, TabConsumptionItem } from './tabConsumption';

interface Props {
  restaurantSlug: string;
  restaurantId: string;
  tab: TableTab;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function TabConsumptionPanel(props: Props) {
  return <ConsumptionContent key={`${props.restaurantId}:${props.tab.id}`} {...props} />;
}

function ConsumptionContent({ restaurantSlug, restaurantId, tab }: Props) {
  const submitting = useRef(false);
  const pendingItemId = useRef<string | null>(null);
  const mounted = useRef(false);
  const [products, setProducts] = useState<ConsumptionProduct[]>([]);
  const [items, setItems] = useState<TabConsumptionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    async function load() {
      setLoading(true);
      setLoadError('');
      try {
        const result = await getTabConsumption(restaurantId, tab.id);
        if (!disposed) {
          setProducts(result.products);
          setItems(result.items);
          setTotal(result.totalInCents);
        }
      } catch (cause) {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : 'Não foi possível carregar o consumo.');
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [restaurantId, tab.id, tab.status, refresh]);

  const closed = tab.status === 'closed';
  const disabled = closed || busy || loading || !!loadError;

  async function perform(operation: () => Promise<unknown>, message: string, onSuccess: () => void) {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await operation();
      if (mounted.current) {
        onSuccess();
        setNotice(message);
        setRefresh((value) => value + 1);
      }
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || disabled) return;
    const value = quantity.trim();
    if (!products.some((product) => product.id === productId) || !/^\d{1,2}$/.test(value) || Number(value) < 1) {
      setActionError('Selecione o produto e uma quantidade entre 1 e 99.');
      return;
    }
    const id = pendingItemId.current ?? crypto.randomUUID();
    pendingItemId.current = id;
    await perform(
      () => addTabConsumption(restaurantSlug, tab.id, productId, Number(value), id),
      'Consumo registrado.',
      () => { pendingItemId.current = null; setProductId(''); setQuantity('1'); },
    );
  }

  async function handleCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancellingId) return;
    await perform(
      () => cancelTabConsumption(restaurantSlug, cancellingId, reason),
      'Lançamento cancelado. O total foi atualizado.',
      () => { setCancellingId(null); setReason(''); },
    );
  }

  return (
    <section aria-labelledby={`consumption-title-${tab.id}`} className="mt-4 border-t border-black/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 id={`consumption-title-${tab.id}`} className="font-semibold">Consumo</h5>
        <button type="button" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}
          className="min-h-11 px-3 text-sm text-[var(--brand)] disabled:opacity-50">Atualizar consumo</button>
      </div>

      {!closed && (
        <form onSubmit={handleAdd} className="mt-3">
          <fieldset disabled={disabled} className="space-y-3">
            <label htmlFor={`consumption-product-${tab.id}`} className="block text-sm font-medium">Produto</label>
            <select id={`consumption-product-${tab.id}`} required value={productId}
              onChange={(event) => { setProductId(event.target.value); pendingItemId.current = null; setNotice(''); }}
              className="min-h-12 w-full rounded-xl border border-black/20 bg-white px-3">
              <option value="">Selecione um prato ou bebida</option>
              {products.map((product) => <option key={product.id} value={product.id}>
                {product.name} — {currency.format(product.price_in_cents / 100)}
              </option>)}
            </select>
            <label htmlFor={`consumption-quantity-${tab.id}`} className="block text-sm font-medium">Quantidade</label>
            <input id={`consumption-quantity-${tab.id}`} type="text" inputMode="numeric" pattern="[0-9]{1,2}"
              required maxLength={2} value={quantity}
              onChange={(event) => { setQuantity(event.target.value); pendingItemId.current = null; setNotice(''); }}
              className="min-h-12 w-full rounded-xl border border-black/20 bg-white px-3" />
            <button type="submit" disabled={products.length === 0}
              className="min-h-12 w-full rounded-xl bg-[var(--brand)] px-4 font-medium text-white disabled:opacity-50">
              {busy ? 'Processando…' : 'Registrar consumo'}
            </button>
          </fieldset>
        </form>
      )}

      {actionError && <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-green-800">{notice}</p>}

      {loading ? <p role="status" className="mt-4 text-sm opacity-75">Carregando consumo…</p>
        : loadError ? <p role="alert" className="mt-4 text-sm text-red-700">{loadError}</p>
        : <>
          {items.length === 0 ? <p className="mt-4 text-sm opacity-75">Nenhum consumo registrado.</p>
            : <ul className="mt-4 space-y-3">
              {items.map((item) => <li key={item.id} className="rounded-xl border border-black/10 bg-white p-3">
                <p className="font-medium">{item.quantity} × {item.product_name}</p>
                <p className="mt-1 text-sm">{currency.format(item.unit_price_in_cents / 100)} por unidade ·{' '}
                  {currency.format(item.line_total_in_cents / 100)}</p>
                {item.status === 'cancelled' ? <p className="mt-2 text-sm text-amber-900">
                  Cancelado — {item.cancellation_reason}
                </p> : !closed && (
                  cancellingId === item.id ? <form onSubmit={handleCancel} className="mt-3 space-y-2">
                    <label htmlFor={`cancel-reason-${item.id}`} className="block text-sm">Motivo do cancelamento</label>
                    <input id={`cancel-reason-${item.id}`} required minLength={3} maxLength={300} value={reason}
                      disabled={disabled} onChange={(event) => setReason(event.target.value)}
                      className="min-h-12 w-full rounded-xl border border-black/20 px-3" />
                    <p className="text-xs opacity-75">O cancelamento remove todas as {item.quantity} unidades desta linha do total.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" disabled={disabled}
                        className="min-h-11 rounded-xl bg-[var(--brand)] px-3 text-sm text-white disabled:opacity-50">Confirmar cancelamento</button>
                      <button type="button" disabled={busy} onClick={() => { setCancellingId(null); setReason(''); }}
                        className="min-h-11 rounded-xl border border-black/15 px-3 text-sm">Voltar</button>
                    </div>
                  </form> : <button type="button" disabled={disabled}
                    onClick={() => { setCancellingId(item.id); setReason(''); setActionError(''); }}
                    className="mt-2 min-h-11 text-sm text-[var(--brand)] underline disabled:opacity-50">Cancelar lançamento</button>
                )}
              </li>)}
            </ul>}
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-white p-3">
            <span className="font-semibold">Total da comanda</span>
            <strong className="text-lg text-[var(--brand)]">{currency.format(total / 100)}</strong>
          </div>
        </>}
    </section>
  );
}
