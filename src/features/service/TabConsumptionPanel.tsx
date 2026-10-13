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
  const initialLoaded = useRef(false);
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
      if (!initialLoaded.current) {
        setLoading(true);
      }
      setLoadError('');
      try {
        const result = await getTabConsumption(restaurantId, tab.id);
        if (!disposed) {
          setProducts(result.products);
          setItems(result.items);
          setTotal(result.totalInCents);
          initialLoaded.current = true;
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
    <section aria-labelledby={`consumption-title-${tab.id}`} className="mt-3 border-t border-[#ebdccb] pt-3">
      <div className="staff-tab-consume-box">
        <div className="flex items-center justify-between mb-2">
          <h5 id={`consumption-title-${tab.id}`} className="staff-tab-consume-title m-0">Registrar Consumo</h5>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
            className="text-xs text-[var(--brand)] underline disabled:opacity-50"
          >
            Atualizar
          </button>
        </div>

        {!closed && (
          <form onSubmit={handleAdd} className="space-y-2">
            <select
              id={`consumption-product-${tab.id}`}
              required
              value={productId}
              onChange={(event) => { setProductId(event.target.value); pendingItemId.current = null; setNotice(''); }}
              className="staff-product-select"
            >
              <option value="">Selecione um prato ou bebida</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} — {currency.format(product.price_in_cents / 100)}
                </option>
              ))}
            </select>

            <div className="staff-qty-action-row">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <label
                  htmlFor={`consumption-quantity-${tab.id}`}
                  style={{ fontSize: '11px', color: '#8c7867', marginBottom: '2px', fontWeight: 600 }}
                >
                  Quantidade
                </label>
                <input
                  id={`consumption-quantity-${tab.id}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{1,2}"
                  required
                  maxLength={2}
                  value={quantity}
                  onChange={(event) => { setQuantity(event.target.value); pendingItemId.current = null; setNotice(''); }}
                  className="staff-qty-input"
                />
              </div>

              <button
                type="submit"
                disabled={products.length === 0 || busy}
                className="staff-primary-action-btn flex-1 self-end"
                style={{ height: '42px', minHeight: '42px' }}
              >
                {busy ? 'Registrando…' : 'Registrar consumo'}
              </button>
            </div>
          </form>
        )}
      </div>

      {actionError && <p role="alert" className="mt-2 text-xs text-red-700">{actionError}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-green-800">{notice}</p>}

      {loading ? (
        <p role="status" className="mt-3 text-xs opacity-75">Carregando consumo…</p>
      ) : loadError ? (
        <p role="alert" className="mt-3 text-xs text-red-700">{loadError}</p>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="mt-3 text-xs text-[#8c7867] italic">Nenhum consumo registrado.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {items.map((item) => {
                const isCancelled = item.status === 'cancelled';
                return (
                  <li
                    key={item.id}
                    className={`rounded-xl border border-[#ded5c8] p-2.5 text-xs transition-opacity ${
                      isCancelled ? 'opacity-60 bg-[#faf8f5]' : 'bg-white'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <p
                        className={`font-semibold text-[13px] ${
                          isCancelled ? 'line-through text-gray-500' : 'text-[#2b1d17]'
                        }`}
                      >
                        {item.quantity} × {item.product_name}
                      </p>
                      <span
                        className={`${
                          isCancelled
                            ? 'line-through text-gray-400 font-normal'
                            : 'font-bold text-[var(--brand)]'
                        }`}
                      >
                        {currency.format(item.line_total_in_cents / 100)}
                      </span>
                    </div>
                    <p
                      className={`mt-0.5 text-xs ${
                        isCancelled ? 'line-through text-gray-400' : 'text-[#7a6655]'
                      }`}
                    >
                      {currency.format(item.unit_price_in_cents / 100)} por unidade
                    </p>
                    {isCancelled ? (
                      <div className="mt-1.5">
                        <span className="inline-block px-2 py-0.5 text-[11px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200">
                          Cancelado{item.cancellation_reason ? ` — ${item.cancellation_reason}` : ''}
                        </span>
                      </div>
                    ) : !closed && (
                    cancellingId === item.id ? (
                      <form onSubmit={handleCancel} className="mt-2 space-y-2">
                        <label htmlFor={`cancel-reason-${item.id}`} className="block text-xs font-medium">Motivo do cancelamento</label>
                        <input
                          id={`cancel-reason-${item.id}`}
                          required
                          minLength={3}
                          maxLength={300}
                          value={reason}
                          disabled={disabled}
                          onChange={(event) => setReason(event.target.value)}
                          className="min-h-9 w-full rounded-lg border border-black/20 px-2 text-xs"
                        />
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={disabled}
                            className="min-h-8 rounded-lg bg-[var(--brand)] px-3 text-xs text-white disabled:opacity-50"
                          >
                            Confirmar cancelamento
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => { setCancellingId(null); setReason(''); }}
                            className="min-h-8 rounded-lg border border-black/15 px-3 text-xs"
                          >
                            Voltar
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { setCancellingId(item.id); setReason(''); setActionError(''); }}
                        className="mt-1 text-xs text-[var(--brand)] underline disabled:opacity-50"
                      >
                        Cancelar lançamento
                      </button>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="staff-tab-total-row">
            <span className="staff-tab-total-label">Total da comanda</span>
            <strong className="staff-tab-total-value">{currency.format(total / 100)}</strong>
          </div>
        </>
      )}
    </section>
  );
}
