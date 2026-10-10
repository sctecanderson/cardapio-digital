import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTableContext } from '../tables/useTableContext';
import { supabase } from '../../lib/supabase';
import {
    getWaiterRequestState,
    requestWaiter,
} from './serviceRequests';
import type { WaiterRequestState } from './serviceRequests';
import { getGuestTabState } from './guestTab';
import { requestBill, getBillRequestState } from './billRequests';
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
    const [now, setNow] = useState(Date.now());
    const [localCancelled, setLocalCancelled] = useState(false);

    // Estados para a Conta
    const [billRequest, setBillRequest] = useState<BillRequest | null>(null);
    const [tableTabId, setTableTabId] = useState<string | null>(null);
    const [billBusy, setBillBusy] = useState(false);

    // Controle do elemento <dialog> nativo
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (isOpen && !dialog.open) {
            dialog.showModal();
        } else if (!isOpen && dialog.open) {
            dialog.close();
        }
    }, [isOpen]);

    // Timer para atualizar o tempo decorrido
    useEffect(() => {
        if (!isOpen) return;
        const interval = setInterval(() => setNow(Date.now()), 1000);
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
                    if (res.request?.status === 'pending' || res.request?.status === 'attended') {
                        setLocalCancelled(false);
                    }
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
                    const billState = await getBillRequestState(tabState.tab.id);
                    if (!disposed) {
                        setBillRequest(billState);
                    }
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
        if (waiterBusy) return;
        setWaiterBusy(true);
        try {
            const res = await requestWaiter(restaurantSlug, tableNumber);
            if (res.status === 'created' || res.status === 'existing') {
                setWaiterState({
                    guestSessionId: res.guestSessionId,
                    request: res.request,
                });
                setLocalCancelled(false);
            }
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Não foi possível chamar o garçom.');
        } finally {
            setWaiterBusy(false);
        }
    }

    function handleCancelWaiter() {
        setLocalCancelled(true);
        setWaiterState((prev) => ({
            ...prev,
            request: null,
        }));
    }

    // Ações da Conta
    async function handleConfirmBill() {
        if (billBusy) return;
        setBillBusy(true);
        try {
            if (tableTabId) {
                const res = await requestBill(restaurantSlug, tableTabId);
                if (res.status === 'created' || res.status === 'existing') {
                    setBillRequest(res.request);
                }
            } else {
                // Se a mesa ainda não tem comanda associada, usa requestWaiter com fallback
                await requestWaiter(restaurantSlug, tableNumber);
            }
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Não foi possível solicitar a conta.');
        } finally {
            setBillBusy(false);
        }
    }

    const waiterRequest = waiterState.request;
    const isWaiterPending = !localCancelled && waiterRequest?.status === 'pending';
    const isWaiterAttended = !localCancelled && waiterRequest?.status === 'attended';

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
                                onClick={handleCancelWaiter}
                            >
                                Cancelar chamado
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
                                disabled={waiterBusy}
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
                                <div className="service-popup-actions single">
                                    <button
                                        type="button"
                                        className="service-popup-btn solid"
                                        onClick={onClose}
                                    >
                                        Continuar no cardápio
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <h2 id="service-popup-title" className="service-popup-title">
                                    Solicitar a conta?
                                </h2>
                                <p className="service-popup-desc">
                                    A equipe receberá sua solicitação para fechar e levar a conta da {tableLabel}.
                                </p>
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
                                        disabled={billBusy}
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
