import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTableContext } from '../tables/useTableContext';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { supabase } from '../../lib/supabase';
import {
    getWaiterRequestState,
    requestWaiter,
    cancelWaiterRequest,
} from './serviceRequests';
import type { WaiterRequestState } from './serviceRequests';
import { getGuestTabState } from './guestTab';
import { requestBill, getBillRequestState, cancelBillRequest } from './billRequests';
import type { BillRequest } from './billRequests';

export type ServiceActionType = 'waiter' | 'bill' | null;

interface ServiceActionPopupProps {
    isOpen: boolean;
    onClose: () => void;
    mode: ServiceActionType;
}

function formatElapsed(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function ServiceActionPopup({
    isOpen,
    onClose,
    mode,
}: ServiceActionPopupProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const { restaurantSlug = '' } = useParams();
    const table = useTableContext();
    const { restaurant } = useRestaurant();

    const tableNumber = table.status === 'unverified' ? Number(table.tableNumber) : 0;
    const tableLabel = table.status === 'unverified'
        ? `Mesa ${String(tableNumber).padStart(2, '0')}`
        : 'sua mesa';

    // Estados para o Garçom
    const [waiterState, setWaiterState] = useState<WaiterRequestState>({
        guestSessionId: null,
        request: null,
    });
    const [waiterBusy, setWaiterBusy] = useState(false);
    const [waiterError, setWaiterError] = useState('');
    const [waiterRateLimitSeconds, setWaiterRateLimitSeconds] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    // Estados para a Conta
    const [billRequest, setBillRequest] = useState<BillRequest | null>(null);
    const [tableTabId, setTableTabId] = useState<string | null>(null);
    const [tabStatus, setTabStatus] = useState<string | null>(null);
    const [includeServiceFee, setIncludeServiceFee] = useState<boolean | null>(null);
    const [billBusy, setBillBusy] = useState(false);
    const [billError, setBillError] = useState('');
    const [billRateLimitSeconds, setBillRateLimitSeconds] = useState<number | null>(null);
    const [confirmCancelBill, setConfirmCancelBill] = useState(false);

    // Controle do elemento <dialog> nativo
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (isOpen && !dialog.open) {
            dialog.showModal();
            setWaiterError('');
            setBillError('');
            setConfirmCancelBill(false);
            setIncludeServiceFee(null);
        } else if (!isOpen && dialog.open) {
            dialog.close();
        }
    }, [isOpen]);

    // Timer para atualizar o tempo decorrido e rate limits
    useEffect(() => {
        if (!isOpen) return;
        const interval = setInterval(() => {
            const current = Date.now();
            setNow(current);
            setWaiterRateLimitSeconds((prev) => (prev && prev > 1 ? prev - 1 : null));
            setBillRateLimitSeconds((prev) => (prev && prev > 1 ? prev - 1 : null));
        }, 1000);
        return () => clearInterval(interval);
    }, [isOpen]);

    // Carregar estado do Garçom ao abrir
    useEffect(() => {
        if (!isOpen || !restaurantSlug || table.status !== 'unverified') return;

        let disposed = false;
        async function fetchWaiter() {
            try {
                const res = await getWaiterRequestState(restaurantSlug, tableNumber);
                if (!disposed) {
                    setWaiterState(res);
                }
            } catch {
                // Silencia falha se não houver chamado registrado
            }
        }

        void fetchWaiter();

        // Escuta Realtime para chamados de garçom
        const channel = supabase
            .channel(`popup-waiter:${restaurantSlug}:${tableNumber}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'service_requests',
                },
                () => {
                    void fetchWaiter();
                },
            )
            .subscribe();

        return () => {
            disposed = true;
            void supabase.removeChannel(channel);
        };
    }, [isOpen, restaurantSlug, table.status, tableNumber]);

    // Carregar estado da Conta ao abrir
    useEffect(() => {
        if (!isOpen || mode !== 'bill' || !restaurantSlug || table.status !== 'unverified') return;

        let disposed = false;
        async function fetchTabAndBill() {
            try {
                const tabState = await getGuestTabState(restaurantSlug, tableNumber);
                if (disposed) return;

                if (tabState?.status === 'ready') {
                    setTableTabId(tabState.tab.id);
                    setTabStatus(tabState.tab.status);
                    const billState = await getBillRequestState(tabState.tab.id);
                    if (!disposed) {
                        setBillRequest(billState);
                    }
                } else {
                    setTableTabId(null);
                    setTabStatus(tabState?.status ?? null);
                    setBillRequest(null);
                }
            } catch {
                // Silencia falhas transitórias
            }
        }

        void fetchTabAndBill();
        return () => {
            disposed = true;
        };
    }, [isOpen, mode, restaurantSlug, table.status, tableNumber]);

    if (!mode) return null;

    // Ações do Garçom
    async function handleConfirmWaiter() {
        if (waiterBusy || (waiterRateLimitSeconds !== null && waiterRateLimitSeconds > 0)) return;
        setWaiterBusy(true);
        setWaiterError('');
        try {
            const res = await requestWaiter(restaurantSlug, tableNumber);
            if (res.status === 'rate_limited') {
                setWaiterRateLimitSeconds(res.retryAfterSeconds);
            } else if (res.status === 'created' || res.status === 'existing') {
                setWaiterState({
                    guestSessionId: res.guestSessionId,
                    request: res.request,
                });
            }
        } catch (err) {
            setWaiterError(err instanceof Error ? err.message : 'Não foi possível chamar o garçom.');
        } finally {
            setWaiterBusy(false);
        }
    }

    async function handleCancelWaiter() {
        if (waiterBusy) return;
        setWaiterBusy(true);
        setWaiterError('');
        try {
            await cancelWaiterRequest(restaurantSlug, tableNumber);
            setWaiterState({
                guestSessionId: null,
                request: null,
            });
        } catch (err) {
            setWaiterError(err instanceof Error ? err.message : 'Não foi possível cancelar o chamado.');
        } finally {
            setWaiterBusy(false);
        }
    }

    // Ações da Conta
    async function handleConfirmBill() {
        if (billBusy || (billRateLimitSeconds !== null && billRateLimitSeconds > 0)) return;
        setBillBusy(true);
        setBillError('');

        if (!tableTabId) {
            setBillBusy(false);
            setBillError(
                'Sua comanda ainda não está vinculada a esta mesa. Acesse a aba Comanda ou solicite a abertura de comanda com nossa equipe.',
            );
            return;
        }

        if (restaurant.serviceFeePercent > 0 && includeServiceFee === null) {
            setBillBusy(false);
            setBillError('Selecione se deseja incluir ou não a taxa de serviço antes de pedir a conta.');
            return;
        }

        try {
            const res = await requestBill(restaurantSlug, tableTabId, includeServiceFee ?? false);
            if (res.status === 'rate_limited') {
                setBillRateLimitSeconds(res.retryAfterSeconds);
            } else if (res.status === 'created' || res.status === 'existing') {
                setBillRequest(res.request);
            }
        } catch (err) {
            setBillError(err instanceof Error ? err.message : 'Não foi possível solicitar a conta.');
        } finally {
            setBillBusy(false);
        }
    }

    async function handleCancelBill() {
        if (billBusy || !tableTabId) return;
        setBillBusy(true);
        setBillError('');
        try {
            await cancelBillRequest(restaurantSlug, tableTabId);
            setBillRequest(null);
            setConfirmCancelBill(false);
        } catch (err) {
            setBillError(err instanceof Error ? err.message : 'Não foi possível cancelar o pedido de conta.');
        } finally {
            setBillBusy(false);
        }
    }

    const waiterRequest = waiterState.request;
    const isWaiterPending = waiterRequest?.status === 'pending';
    const isWaiterAttended = waiterRequest?.status === 'attended';

    const waiterElapsedSeconds = isWaiterPending && waiterRequest
        ? Math.max(0, Math.floor((now - Date.parse(waiterRequest.created_at)) / 1000))
        : 0;

    const isBillPending = billRequest?.status === 'pending';
    const billElapsedSeconds = isBillPending && billRequest
        ? Math.max(0, Math.floor((now - Date.parse(billRequest.created_at)) / 1000))
        : 0;

    return (
        <dialog
            ref={dialogRef}
            className="service-popup-dialog"
            aria-labelledby="service-popup-title"
            onClose={onClose}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="service-popup-card">
                {/* Drag handle superior */}
                <div className="service-popup-handle" aria-hidden="true" />

                {/* Botão de Fechar no canto superior direito */}
                <button
                    type="button"
                    className="service-popup-close-btn"
                    onClick={onClose}
                    aria-label="Fechar popup"
                >
                    ×
                </button>

                {/* =========================================================
                   MODAL GARÇOM: ESTADO 3 - CHAMADO ASSUMIDO
                   ========================================================= */}
                {mode === 'waiter' && isWaiterAttended && (
                    <div className="service-popup-body">
                        <div className="service-popup-icon-bubble">
                            {/* Ilustração do Garçom com bandeja/cloche */}
                            <svg viewBox="0 0 64 64" fill="none" className="service-popup-svg" aria-hidden="true">
                                <circle cx="30" cy="20" r="7.5" fill="#fcdcc5" stroke="#3d271d" strokeWidth="2.2" />
                                <path d="M22.5 17.5c1-4 5-6.5 8.5-6.5 4 0 7.5 2 7.5 5.5" stroke="#3d271d" strokeWidth="2.5" strokeLinecap="round" />
                                <path d="M19 46c0-8 4.5-14 11-14s11 6 11 14" fill="#b9472b" stroke="#3d271d" strokeWidth="2.2" />
                                <path d="M26.5 32l3.5 7 3.5-7" fill="#ffffff" stroke="#3d271d" strokeWidth="1.6" />
                                <path d="M28 33.5l4 2-4 2v-4zm4 0l-4 2 4 2v-4z" fill="#3d271d" />
                                <path d="M39 36c3 0 6.5-2 8.5-5.5" stroke="#3d271d" strokeWidth="2.2" strokeLinecap="round" />
                                <line x1="43" y1="30" x2="57" y2="30" stroke="#3d271d" strokeWidth="2.6" strokeLinecap="round" />
                                <path d="M45 30c0-5.5 3.8-9.5 5.5-9.5s5.5 4 5.5 9.5" fill="#e8ded5" stroke="#3d271d" strokeWidth="2.2" />
                                <circle cx="50.5" cy="19.5" r="1.5" fill="#3d271d" />
                            </svg>
                        </div>

                        <h2 id="service-popup-title" className="service-popup-title">
                            Chamado assumido
                        </h2>

                        <div className="service-popup-badge">
                            Em atendimento
                        </div>

                        <p className="service-popup-desc">
                            Um funcionário assumiu sua solicitação e está a caminho da {tableLabel}.
                        </p>

                        <div className="service-popup-actions single">
                            <button
                                type="button"
                                className="service-popup-btn solid"
                                onClick={onClose}
                            >
                                Continuar no cardápio
                            </button>
                        </div>
                    </div>
                )}

                {/* =========================================================
                   MODAL GARÇOM: ESTADO 2 - GARÇOM CHAMADO (PENDENTE)
                   ========================================================= */}
                {mode === 'waiter' && isWaiterPending && !isWaiterAttended && (
                    <div className="service-popup-body">
                        <div className="service-popup-icon-bubble vibrating">
                            {/* Sino vibrando com ondas sonoras */}
                            <svg viewBox="0 0 64 64" fill="none" className="service-popup-svg" aria-hidden="true">
                                <path d="M9 26c-2 3-2 8 0 11" stroke="#b9472b" strokeWidth="2.2" strokeLinecap="round" />
                                <path d="M4.5 22c-3.2 5-3.2 14 0 19" stroke="#b9472b" strokeWidth="2.2" strokeLinecap="round" />
                                <path d="M32 12c-8.8 0-16 7.2-16 16v12l-4 4v2h40v-2l-4-4V28c0-8.8-7.2-16-16-16z" fill="#fffaf5" stroke="#3d271d" strokeWidth="2.6" strokeLinejoin="round" />
                                <path d="M29 12V9a3 3 0 0 1 6 0v3" stroke="#3d271d" strokeWidth="2.6" strokeLinecap="round" />
                                <path d="M28 46a4 4 0 0 0 8 0" stroke="#3d271d" strokeWidth="2.6" strokeLinecap="round" />
                                <path d="M55 26c2 3 2 8 0 11" stroke="#b9472b" strokeWidth="2.2" strokeLinecap="round" />
                                <path d="M59.5 22c3.2 5 3.2 14 0 19" stroke="#b9472b" strokeWidth="2.2" strokeLinecap="round" />
                            </svg>
                        </div>

                        <h2 id="service-popup-title" className="service-popup-title">
                            Garçom chamado
                        </h2>

                        <div className="service-popup-badge">
                            Aguardando atendimento
                        </div>

                        <p className="service-popup-desc">
                            Sua solicitação foi registrada para a {tableLabel}.
                        </p>

                        <div className="service-popup-timer">
                            Tempo decorrido: {formatElapsed(waiterElapsedSeconds)}{' '}
                            <span aria-hidden="true">🕒</span>
                        </div>

                        {waiterError && (
                            <p role="alert" className="text-xs text-red-600 mt-2 px-2 text-center">
                                {waiterError}
                            </p>
                        )}

                        <div className="service-popup-actions single">
                            <button
                                type="button"
                                className="service-popup-btn solid"
                                onClick={onClose}
                            >
                                Continuar no cardápio
                            </button>

                            <button
                                type="button"
                                className="service-popup-link-btn"
                                disabled={waiterBusy}
                                onClick={() => void handleCancelWaiter()}
                            >
                                {waiterBusy ? 'Cancelando…' : 'Cancelar chamado'}
                            </button>
                        </div>
                    </div>
                )}

                {/* =========================================================
                   MODAL GARÇOM: ESTADO 1 - CHAMAR GARÇOM? (CONFIRMAÇÃO)
                   ========================================================= */}
                {mode === 'waiter' && !isWaiterPending && !isWaiterAttended && (
                    <div className="service-popup-body">
                        <div className="service-popup-icon-bubble">
                            {/* Sino estático */}
                            <svg viewBox="0 0 64 64" fill="none" className="service-popup-svg" aria-hidden="true">
                                <path d="M32 12c-8.8 0-16 7.2-16 16v12l-4 4v2h40v-2l-4-4V28c0-8.8-7.2-16-16-16z" fill="#fffaf5" stroke="#3d271d" strokeWidth="2.6" strokeLinejoin="round" />
                                <path d="M29 12V9a3 3 0 0 1 6 0v3" stroke="#3d271d" strokeWidth="2.6" strokeLinecap="round" />
                                <path d="M28 46a4 4 0 0 0 8 0" stroke="#3d271d" strokeWidth="2.6" strokeLinecap="round" />
                            </svg>
                        </div>

                        <h2 id="service-popup-title" className="service-popup-title">
                            Chamar garçom?
                        </h2>

                        <p className="service-popup-desc">
                            Sua solicitação será enviada à equipe para atender a {tableLabel}.
                        </p>

                        {waiterRateLimitSeconds !== null && waiterRateLimitSeconds > 0 && (
                            <p role="status" className="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg text-center">
                                Limite atingido. Aguarde {waiterRateLimitSeconds}s para chamar novamente.
                            </p>
                        )}

                        {waiterError && (
                            <p role="alert" className="text-xs text-red-600 px-2 text-center">
                                {waiterError}
                            </p>
                        )}

                        <div className="service-popup-actions dual">
                            <button
                                type="button"
                                className="service-popup-btn outline"
                                onClick={onClose}
                            >
                                Voltar
                            </button>

                            <button
                                type="button"
                                className="service-popup-btn solid"
                                disabled={waiterBusy || (waiterRateLimitSeconds !== null && waiterRateLimitSeconds > 0)}
                                onClick={() => void handleConfirmWaiter()}
                            >
                                {waiterBusy ? 'Enviando…' : 'Confirmar'}
                            </button>
                        </div>
                    </div>
                )}

                {/* =========================================================
                   MODAL PEDIR CONTA: ESTADO 4 (OU AGUARDANDO CONTA)
                   ========================================================= */}
                {mode === 'bill' && (
                    <div className="service-popup-body">
                        <div className="service-popup-icon-bubble">
                            {/* Ilustração de Recibo / Comprovante */}
                            <svg viewBox="0 0 64 64" fill="none" className="service-popup-svg" aria-hidden="true">
                                <path d="M20 12l2.8 2 2.8-2 2.8 2 2.8-2 2.8 2 2.8-2 2.8 2 2.8-2 2.8 2v38l-2.8-2-2.8 2-2.8-2-2.8 2-2.8-2-2.8 2-2.8-2-2.8 2-2.8-2-2.8 2V12z" fill="#fffdfa" stroke="#3d271d" strokeWidth="2.4" strokeLinejoin="round" />
                                <line x1="26" y1="22" x2="40" y2="22" stroke="#b9472b" strokeWidth="2.6" strokeLinecap="round" />
                                <line x1="26" y1="28" x2="36" y2="28" stroke="#3d271d" strokeWidth="2" strokeLinecap="round" />
                                <line x1="26" y1="33" x2="40" y2="33" stroke="#3d271d" strokeWidth="2" strokeLinecap="round" />
                                <line x1="26" y1="38" x2="34" y2="38" stroke="#3d271d" strokeWidth="2" strokeLinecap="round" />
                                <line x1="25" y1="42.5" x2="41" y2="42.5" stroke="#ddcfc2" strokeWidth="1.6" strokeDasharray="2.5 2.5" />
                                <line x1="26" y1="47" x2="40" y2="47" stroke="#b9472b" strokeWidth="2.6" strokeLinecap="round" />
                            </svg>
                        </div>

                        {isBillPending ? (
                            <>
                                <h2 id="service-popup-title" className="service-popup-title">
                                    Conta solicitada
                                </h2>
                                <div className="service-popup-badge">
                                    Aguardando atendimento
                                </div>
                                <p className="service-popup-desc">
                                    A equipe já recebeu a solicitação de fechamento da {tableLabel}.
                                </p>
                                <div className="service-popup-timer">
                                    Tempo decorrido: {formatElapsed(billElapsedSeconds)}{' '}
                                    <span aria-hidden="true">🕒</span>
                                </div>

                                {restaurant.serviceFeePercent > 0 && billRequest && (
                                    <p className="text-xs text-[#8c7867] mt-1 text-center font-medium">
                                        Taxa de serviço ({restaurant.serviceFeePercent}%):{' '}
                                        <strong className="text-[#3d271d]">
                                            {billRequest.include_service_fee ? 'Incluída' : 'Não incluída'}
                                        </strong>
                                    </p>
                                )}

                                {billError && (
                                    <p role="alert" className="text-xs text-red-600 mt-2 px-2 text-center">
                                        {billError}
                                    </p>
                                )}

                                {confirmCancelBill ? (
                                    <div className="mt-3 p-3 bg-amber-50 rounded-xl text-center">
                                        <p className="text-xs text-amber-900 font-medium">
                                            Atenção: cancelar este pedido afeta todos os clientes vinculados a esta comanda. Deseja cancelar mesmo assim?
                                        </p>
                                        <div className="mt-2 flex gap-2 justify-center">
                                            <button
                                                type="button"
                                                className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg font-medium"
                                                disabled={billBusy}
                                                onClick={() => void handleCancelBill()}
                                            >
                                                {billBusy ? 'Cancelando…' : 'Sim, cancelar'}
                                            </button>
                                            <button
                                                type="button"
                                                className="px-3 py-1.5 text-xs bg-white border border-black/10 rounded-lg"
                                                disabled={billBusy}
                                                onClick={() => setConfirmCancelBill(false)}
                                            >
                                                Voltar
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="service-popup-actions single">
                                        <button
                                            type="button"
                                            className="service-popup-btn solid"
                                            onClick={onClose}
                                        >
                                            Continuar no cardápio
                                        </button>
                                        <button
                                            type="button"
                                            className="service-popup-link-btn"
                                            onClick={() => setConfirmCancelBill(true)}
                                        >
                                            Cancelar pedido de conta
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <h2 id="service-popup-title" className="service-popup-title">
                                    Solicitar a conta?
                                </h2>
                                <p className="service-popup-desc">
                                    A equipe receberá sua solicitação para fechar e levar a conta da {tableLabel}.
                                </p>

                                {restaurant.serviceFeePercent > 0 && (
                                    <div className="mt-4 mb-2 space-y-2 text-left">
                                        <p className="text-xs font-semibold text-[#5c493a]">
                                            Taxa de serviço sugerida ({restaurant.serviceFeePercent}%):
                                        </p>
                                        <label className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${includeServiceFee === true ? 'border-[#b9472b] bg-[#fff6f2] font-semibold text-[#3d271d]' : 'border-[#ded5c8] bg-white text-[#5c493a]'}`}>
                                            <input
                                                type="radio"
                                                name="popup-service-fee"
                                                checked={includeServiceFee === true}
                                                onChange={() => setIncludeServiceFee(true)}
                                                className="accent-[#b9472b]"
                                            />
                                            <span>Incluir taxa sugerida (+{restaurant.serviceFeePercent}%)</span>
                                        </label>
                                        <label className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${includeServiceFee === false ? 'border-[#b9472b] bg-[#fff6f2] font-semibold text-[#3d271d]' : 'border-[#ded5c8] bg-white text-[#5c493a]'}`}>
                                            <input
                                                type="radio"
                                                name="popup-service-fee"
                                                checked={includeServiceFee === false}
                                                onChange={() => setIncludeServiceFee(false)}
                                                className="accent-[#b9472b]"
                                            />
                                            <span>Pagar apenas o consumo (sem taxa)</span>
                                        </label>
                                    </div>
                                )}

                                {billRateLimitSeconds !== null && billRateLimitSeconds > 0 && (
                                    <p role="status" className="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg text-center">
                                        Limite atingido. Aguarde {billRateLimitSeconds}s para solicitar novamente.
                                    </p>
                                )}

                                {billError && (
                                    <p role="alert" className="text-xs text-red-600 px-2 text-center">
                                        {billError}
                                    </p>
                                )}

                                <div className="service-popup-actions dual">
                                    <button
                                        type="button"
                                        className="service-popup-btn outline"
                                        onClick={onClose}
                                    >
                                        Voltar
                                    </button>
                                    <button
                                        type="button"
                                        className="service-popup-btn solid"
                                        disabled={billBusy || (billRateLimitSeconds !== null && billRateLimitSeconds > 0) || (restaurant.serviceFeePercent > 0 && includeServiceFee === null)}
                                        onClick={() => void handleConfirmBill()}
                                    >
                                        {billBusy ? 'Solicitando…' : 'Pedir Conta'}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </dialog>
    );
}
