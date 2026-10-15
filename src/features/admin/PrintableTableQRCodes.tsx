import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { RestaurantIdentity } from '../restaurants/RestaurantProvider';
import type { AdminTable } from './restaurantAdmin';

/**
 * Retorna a URL canônica e segura para o QR Code da mesa.
 * Formato dinâmico: [window.location.origin]/[restaurant.slug]?t=[table.id]
 * A URL NUNCA expõe o número sequencial da mesa.
 */
export function getTableQrCodeUrl(restaurantSlug: string, tableId: string): string {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'https://app.elozi.com.br';
  const cleanSlug = encodeURIComponent((restaurantSlug || '').trim());
  const cleanTableId = encodeURIComponent((tableId || '').trim());
  return `${origin}/${cleanSlug}?t=${cleanTableId}`;
}

/**
 * Faz o download do QR Code no formato vetorial SVG puro com alta nitidez.
 */
export function downloadTableQrCodeSvg(
  svgElementId: string,
  restaurantSlug: string,
  tableNumber: number,
) {
  const svgEl = document.getElementById(svgElementId);
  if (!svgEl) return;

  const serializer = new XMLSerializer();
  let source = serializer.serializeToString(svgEl);

  // Adiciona namespace xml se não estiver presente
  if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
    source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qrcode-mesa-${String(tableNumber).padStart(2, '0')}-${restaurantSlug}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface PrintableTableQRCodesProps {
  restaurant: RestaurantIdentity;
  tables: AdminTable[];
}

/**
 * Grade de impressão em lote formatada para folhas A4 (4 a 6 cartões por página).
 * Renderizada no fluxo normal para acionamento via window.print() sem cortes de modal.
 */
export function PrintableTableQRCodes({ restaurant, tables }: PrintableTableQRCodesProps) {
  if (tables.length === 0) return null;

  return (
    <aside
      aria-label="Grade de cartões de mesa para impressão"
      className="hidden print:block print-qr-sheet w-full bg-white text-black p-0 m-0"
    >
      <div className="grid grid-cols-2 gap-6 print:grid-cols-2 print:gap-6 p-4">
        {tables.map((t) => {
          const qrUrl = getTableQrCodeUrl(restaurant.slug, t.id);
          const svgId = `print-qr-svg-${t.tableNumber}`;

          return (
            <div
              key={t.id}
              className="print-qr-card break-inside-avoid page-break-inside-avoid border-2 border-dashed border-slate-400 rounded-2xl p-6 flex flex-col items-center justify-between text-center bg-white"
              style={{
                minHeight: '340px',
                pageBreakInside: 'avoid',
                breakInside: 'avoid',
              }}
            >
              {/* Topo: Identidade do Estabelecimento */}
              <div className="flex flex-col items-center gap-1.5 mb-2">
                {restaurant.logo ? (
                  <img
                    src={restaurant.logo.url}
                    alt={restaurant.name}
                    className="h-10 max-w-[130px] object-contain"
                  />
                ) : (
                  <span className="text-lg font-black text-slate-900 tracking-tight">
                    {restaurant.name}
                  </span>
                )}
                {restaurant.subtitle && (
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    {restaurant.subtitle}
                  </span>
                )}
              </div>

              {/* Centro: QR Code SVG de Alta Resolução (160x160px) */}
              <div className="p-3 bg-white border border-slate-300 rounded-xl my-2 inline-block">
                <QRCodeSVG
                  id={svgId}
                  value={qrUrl}
                  size={160}
                  level="H"
                  includeMargin={false}
                />
              </div>

              {/* Rodapé: Identificação da Mesa e Instruções */}
              <div className="mt-2 flex flex-col items-center w-full">
                <span className="text-[10px] uppercase font-extrabold tracking-widest text-slate-500">
                  Cardápio Digital
                </span>
                <strong className="text-2xl font-black text-slate-900 tracking-tight my-0.5">
                  MESA {String(t.tableNumber).padStart(2, '0')}
                </strong>
                {t.label && (
                  <span className="text-xs text-slate-600 font-medium">
                    {t.label}
                  </span>
                )}
                <p className="text-[11px] text-slate-700 mt-1.5 max-w-[210px] leading-tight">
                  Escaneie para acessar o cardápio e fazer seu pedido.
                </p>
                <span className="text-[9px] uppercase tracking-wider text-slate-400 mt-2 font-mono">
                  Elozi · Conecte sua Mesa
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

interface IndividualQrModalProps {
  restaurant: RestaurantIdentity;
  table: AdminTable;
  onClose: () => void;
  onPrintSingle: (table: AdminTable) => void;
}

/**
 * Modal para visualização individual do QR Code, cópia do link seguro e download SVG.
 */
export function IndividualQrModal({
  restaurant,
  table,
  onClose,
  onPrintSingle,
}: IndividualQrModalProps) {
  const [copied, setCopied] = useState(false);
  const qrUrl = getTableQrCodeUrl(restaurant.slug, table.id);
  const svgId = `modal-qr-svg-${table.tableNumber}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(qrUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback manual se permissão clipboard for negada
      const input = document.getElementById('qr-copy-input') as HTMLInputElement | null;
      if (input) {
        input.select();
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      }
    }
  }

  function handleDownloadSvg() {
    downloadTableQrCodeSvg(svgId, restaurant.slug, table.tableNumber);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="individual-qr-title"
      className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 print:hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-800 rounded-3xl p-6 sm:p-7 max-w-md w-full shadow-2xl relative text-slate-900 dark:text-stone-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Botão Fechar (X) */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar modal"
          className="absolute top-5 right-5 p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-stone-200 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Cabeçalho */}
        <div className="mb-5 text-center">
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
            Cardápio de Mesa Seguro
          </span>
          <h2 id="individual-qr-title" className="text-2xl font-black text-slate-900 dark:text-white mt-1">
            Mesa {String(table.tableNumber).padStart(2, '0')}
          </h2>
          {table.label && (
            <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5 font-medium">
              {table.label}
            </p>
          )}
        </div>

        {/* Card Ilustrativo com QR Code SVG */}
        <div className="flex flex-col items-center bg-slate-50 dark:bg-stone-800/60 border border-slate-200 dark:border-stone-700 rounded-2xl p-5 mb-5 shadow-inner">
          <div className="p-3 bg-white rounded-xl shadow-xs border border-slate-200 inline-block mb-3">
            <QRCodeSVG
              id={svgId}
              value={qrUrl}
              size={190}
              level="H"
              includeMargin={false}
            />
          </div>
          <p className="text-xs text-center text-slate-600 dark:text-stone-300 max-w-[240px] leading-relaxed">
            Escaneie com a câmera do celular para acessar o cardápio e fazer pedidos.
          </p>
        </div>

        {/* Caixa de URL Segura */}
        <div className="mb-6 space-y-1.5">
          <label htmlFor="qr-copy-input" className="text-[11px] font-bold text-slate-500 dark:text-stone-400 block">
            Endereço Seguro do QR Code (UUID):
          </label>
          <div className="flex items-center gap-2">
            <input
              id="qr-copy-input"
              type="text"
              readOnly
              value={qrUrl}
              className="w-full text-xs font-mono px-3 py-2 bg-slate-100 dark:bg-stone-800 text-slate-700 dark:text-stone-200 border border-slate-200 dark:border-stone-700 rounded-xl select-all focus:outline-hidden"
            />
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="shrink-0 px-3 py-2 rounded-xl text-xs font-bold bg-slate-200 hover:bg-slate-300 dark:bg-stone-700 dark:hover:bg-stone-600 text-slate-800 dark:text-stone-100 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{copied ? 'Copiado!' : 'Copiar'}</span>
            </button>
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={handleDownloadSvg}
            className="w-full py-2.5 px-3 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-200 transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>Baixar SVG</span>
          </button>
          <button
            type="button"
            onClick={() => onPrintSingle(table)}
            className="w-full py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-black dark:bg-emerald-600 dark:hover:bg-emerald-700 text-white text-xs font-bold transition-colors inline-flex items-center justify-center gap-2 cursor-pointer shadow-xs"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            <span>Imprimir Mesa</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface BatchPrintPreviewModalProps {
  restaurant: RestaurantIdentity;
  printableTables: AdminTable[];
  totalTablesCount: number;
  onClose: () => void;
  onConfirmPrint: () => void;
}

/**
 * Modal de Pré-visualização antes da impressão em lote A4.
 */
export function BatchPrintPreviewModal({
  restaurant,
  printableTables,
  totalTablesCount,
  onClose,
  onConfirmPrint,
}: BatchPrintPreviewModalProps) {
  const excludedCount = totalTablesCount - printableTables.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-print-title"
      className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 print:hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-800 rounded-3xl p-6 sm:p-8 max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl relative text-slate-900 dark:text-stone-100">
        {/* Topo do Modal */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-stone-800 shrink-0">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 id="batch-print-title" className="text-xl font-black text-slate-900 dark:text-white">
                Impressão de QR Codes em Lote (A4)
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                {printableTables.length} {printableTables.length === 1 ? 'mesa ativa' : 'mesas ativas'}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-stone-400 mt-1">
              Cartões individuais formatados para suportes acrílicos e totens de mesa. Grade otimizada para folhas A4.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-stone-200 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Notificação de Exclusão de Cotas (se houver) */}
        {excludedCount > 0 && (
          <div className="my-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-xs flex items-center gap-2 shrink-0">
            <svg className="w-4 h-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              <strong>Filtro de Governança SaaS:</strong> {excludedCount}{' '}
              {excludedCount === 1 ? 'mesa foi excluída' : 'mesas foram excluídas'}{' '}
              por estarem inativas ou além da cota do plano contratado.
            </span>
          </div>
        )}

        {/* Área de Pré-visualização com Scroll */}
        <div className="flex-1 overflow-y-auto my-4 pr-1">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">
            Pré-visualização do Layout de Impressão:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-slate-50 dark:bg-stone-950/40 border border-slate-200 dark:border-stone-800 rounded-2xl">
            {printableTables.map((t) => {
              const qrUrl = getTableQrCodeUrl(restaurant.slug, t.id);

              return (
                <div
                  key={t.id}
                  className="border-2 border-dashed border-slate-300 dark:border-stone-700 rounded-2xl p-5 flex flex-col items-center justify-between text-center bg-white dark:bg-stone-900 shadow-xs"
                >
                  <div className="flex flex-col items-center gap-1 mb-2">
                    {restaurant.logo ? (
                      <img
                        src={restaurant.logo.url}
                        alt={restaurant.name}
                        className="h-8 max-w-[120px] object-contain"
                      />
                    ) : (
                      <span className="text-sm font-black text-slate-900 dark:text-white">
                        {restaurant.name}
                      </span>
                    )}
                  </div>

                  <div className="p-2.5 bg-white rounded-xl border border-slate-200 my-2 inline-block shadow-xs">
                    <QRCodeSVG
                      value={qrUrl}
                      size={130}
                      level="H"
                      includeMargin={false}
                    />
                  </div>

                  <div className="mt-2 flex flex-col items-center">
                    <span className="text-[9px] uppercase font-black tracking-widest text-slate-400">
                      Cardápio Digital
                    </span>
                    <strong className="text-lg font-black text-slate-900 dark:text-white my-0.5">
                      MESA {String(t.tableNumber).padStart(2, '0')}
                    </strong>
                    {t.label && (
                      <span className="text-[11px] text-slate-500 font-medium">
                        {t.label}
                      </span>
                    )}
                    <p className="text-[10px] text-slate-500 mt-1 max-w-[190px] leading-tight">
                      Escaneie para acessar o cardápio e fazer seu pedido.
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Rodapé com Ações */}
        <div className="pt-4 border-t border-slate-100 dark:border-stone-800 flex items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-400 dark:text-stone-500 hidden sm:block">
            Dica: Selecione "Salvar como PDF" ou sua impressora padrão na janela seguinte.
          </p>
          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={onConfirmPrint}
              className="px-6 py-2.5 rounded-xl bg-slate-900 hover:bg-black dark:bg-emerald-600 dark:hover:bg-emerald-700 text-white text-xs font-bold transition-all shadow-md inline-flex items-center gap-2 cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              <span>Imprimir Agora (A4)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
