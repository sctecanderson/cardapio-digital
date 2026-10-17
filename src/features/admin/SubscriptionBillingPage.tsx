import { useEffect, useState, useTransition } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  fetchBillingSummary,
  createSubscriptionCheckout,
  confirmSubscriptionInvoice,
  deleteSavedPaymentMethod,
  formatCurrencyBRL,
  detectCardBrand,
  type BillingSummaryResponse,
  type SubscriptionPlanId,
  type BillingCycle,
  type PaymentMethodType,
  type SubscriptionInvoice,
  type SavedPaymentMethod,
} from '../billing/billingService';

function formatCpfCnpj(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 14);
  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function formatCep(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 8);
  return digits.replace(/(\d{5})(\d{1,3})/, '$1-$2');
}

export function SubscriptionBillingPage() {
  const { restaurant: r } = useRestaurant();
  const [data, setData] = useState<BillingSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [, startTransition] = useTransition();

  // Estado do Modal de Checkout
  const [checkoutModal, setCheckoutModal] = useState<{
    open: boolean;
    planId: SubscriptionPlanId;
    cycle: BillingCycle;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<PaymentMethodType>('pix');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [pixPending, setPixPending] = useState<{
    invoiceId: string;
    payload: string;
    expiresAt: string;
    amountCents: number;
    planId: SubscriptionPlanId;
    image?: string;
  } | null>(null);
  const [copiedPix, setCopiedPix] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState<{
    invoiceId: string;
    planId: SubscriptionPlanId;
    expiresAt: string;
    maxTables: number;
  } | null>(null);

  // Dados do Pagador (Obrigatório Asaas)
  const [payerCpfCnpj, setPayerCpfCnpj] = useState('');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [payerPostalCode, setPayerPostalCode] = useState('');
  const [payerAddressNumber, setPayerAddressNumber] = useState('');

  // Formulário de Cartão
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExp, setCardExp] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [saveCard, setSaveCard] = useState(true);
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string>('new');

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetchBillingSummary(r.id);
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao buscar dados de faturamento.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [r.id]);

  const handleOpenCheckout = (planId: SubscriptionPlanId, selectedCycle: BillingCycle) => {
    setPixPending(null);
    setCheckoutSuccess(null);
    setCardNumber('');
    setCardHolder('');
    setCardExp('');
    setCardCvv('');
    setPayerCpfCnpj('');
    setPayerPostalCode('');
    setPayerAddressNumber('');
    setPayerPhone('');
    setPayerName('');
    setSelectedSavedCardId('new');
    setActiveTab('pix');
    setCheckoutModal({
      open: true,
      planId,
      cycle: selectedCycle,
    });
  };

  const handleCloseCheckout = () => {
    setCheckoutModal(null);
    setPixPending(null);
    setCheckoutSuccess(null);
    void loadData();
  };

  // Listener Realtime: detecção automática de pagamento do PIX via Webhook Asaas
  useEffect(() => {
    if (!pixPending?.invoiceId) return;

    const channel = supabase
      .channel(`inv-status-${pixPending.invoiceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'subscription_invoices',
          filter: `id=eq.${pixPending.invoiceId}`,
        },
        (payload) => {
          const updated = payload.new as { status?: string; plan_id?: SubscriptionPlanId; max_tables?: number };
          if (updated?.status === 'paid') {
            setCheckoutSuccess({
              invoiceId: pixPending.invoiceId,
              planId: updated.plan_id || pixPending.planId,
              expiresAt: '',
              maxTables: updated.max_tables || 10,
            });
            setPixPending(null);
            setFeedback({
              type: 'success',
              message: 'Pagamento PIX confirmado com sucesso via Asaas! Seu plano foi ativado.',
            });
            void loadData();
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [pixPending?.invoiceId]);

  const handleProcessPix = async () => {
    if (!checkoutModal) return;
    try {
      setCheckoutBusy(true);
      setFeedback(null);

      const cleanCpfCnpj = payerCpfCnpj.replace(/\D/g, '');
      if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
        throw new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido para emitir o PIX no Asaas.');
      }

      const res = await createSubscriptionCheckout({
        restaurantId: r.id,
        targetPlan: checkoutModal.planId,
        billingCycle: checkoutModal.cycle,
        paymentMethod: 'pix',
        payerInfo: {
          cpfCnpj: cleanCpfCnpj,
          name: payerName.trim() || currentRest.name,
          phone: payerPhone.replace(/\D/g, ''),
        },
      });

      if (res.pix_qr_code_payload) {
        setPixPending({
          invoiceId: res.invoice_id,
          payload: res.pix_qr_code_payload,
          expiresAt: res.pix_expires_at || '',
          amountCents: res.amount_cents,
          planId: checkoutModal.planId,
          image: res.pix_qr_code_image,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao gerar cobrança PIX.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleVerifyPixPayment = async (invoiceId: string) => {
    try {
      setCheckingPayment(true);
      const res = await confirmSubscriptionInvoice(invoiceId);
      if (res.status === 'paid') {
        setCheckoutSuccess({
          invoiceId: res.invoice_id,
          planId: res.plan_id,
          expiresAt: res.subscription_expires_at || '',
          maxTables: res.max_tables || 10,
        });
        setPixPending(null);
        void loadData();
      } else {
        setFeedback({
          type: 'error',
          message: 'Pagamento ainda não confirmado. Caso já tenha pago, aguarde alguns instantes.',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao validar fatura.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckingPayment(false);
    }
  };

  const handleProcessCardPayment = async (methodType: 'credit_card' | 'debit_card') => {
    if (!checkoutModal) return;

    try {
      setCheckoutBusy(true);
      setFeedback(null);

      const cleanCpfCnpj = payerCpfCnpj.replace(/\D/g, '');
      if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
        throw new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) do titular do cartão para o Asaas.');
      }

      let cardDataPayload: {
        holder_name?: string;
        card_number?: string;
        card_brand?: string;
        card_last4?: string;
        exp_month?: number;
        exp_year?: number;
        cvv?: string;
        save_card?: boolean;
      } | null = null;

      if (selectedSavedCardId !== 'new') {
        const saved = data?.payment_methods.find((pm) => pm.id === selectedSavedCardId);
        if (saved) {
          cardDataPayload = {
            holder_name: saved.holder_name || '',
            card_brand: saved.card_brand || '',
            card_last4: saved.card_last4 || '',
            exp_month: saved.exp_month || 12,
            exp_year: saved.exp_year || 2030,
            save_card: false,
          };
        }
      } else {
        const rawNum = cardNumber.replace(/\D/g, '');
        if (rawNum.length < 13) {
          throw new Error('Informe um número de cartão válido.');
        }
        if (!cardHolder.trim()) {
          throw new Error('Informe o nome do titular como impresso no cartão.');
        }
        const expParts = cardExp.split('/');
        const expM = parseInt(expParts[0] || '0', 10);
        let expY = parseInt(expParts[1] || '0', 10);
        if (expY < 100) expY += 2000;
        if (expM < 1 || expM > 12 || expY < 2025) {
          throw new Error('Data de validade do cartão inválida (MM/AA).');
        }
        if (cardCvv.length < 3) {
          throw new Error('Código de segurança (CVV) inválido.');
        }

        cardDataPayload = {
          holder_name: cardHolder.trim(),
          card_number: rawNum,
          card_brand: detectCardBrand(rawNum),
          card_last4: rawNum.slice(-4),
          exp_month: expM,
          exp_year: expY,
          cvv: cardCvv,
          save_card: saveCard,
        };
      }

      const res = await createSubscriptionCheckout({
        restaurantId: r.id,
        targetPlan: checkoutModal.planId,
        billingCycle: checkoutModal.cycle,
        paymentMethod: methodType,
        cardData: cardDataPayload,
        payerInfo: {
          cpfCnpj: cleanCpfCnpj,
          name: payerName.trim() || cardHolder.trim(),
          postalCode: payerPostalCode.replace(/\D/g, ''),
          addressNumber: payerAddressNumber.trim() || '1',
          phone: payerPhone.replace(/\D/g, ''),
        },
      });

      if (res.status === 'paid') {
        setCheckoutSuccess({
          invoiceId: res.invoice_id,
          planId: res.plan_id,
          expiresAt: res.subscription_expires_at || '',
          maxTables: res.max_tables || 10,
        });
        void loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao processar pagamento com cartão.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleDeleteCard = async (methodId: string) => {
    if (!window.confirm('Deseja realmente remover este cartão salvo?')) return;
    try {
      await deleteSavedPaymentMethod(r.id, methodId);
      setFeedback({ type: 'success', message: 'Cartão removido com sucesso.' });
      void loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao remover cartão.';
      setFeedback({ type: 'error', message: msg });
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPix(true);
      setTimeout(() => setCopiedPix(false), 2500);
    } catch {
      // fallback
    }
  };

  const formatCardInput = (val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 16);
    return digits.replace(/(\d{4})/g, '$1 ').trim();
  };

  const formatExpInput = (val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 4);
    if (digits.length >= 3) {
      return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    return digits;
  };

  if (loading && !data) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
        <p>Carregando dados de faturamento e planos do restaurante…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: '32px' }}>
        <div style={{ padding: '16px', background: '#fee2e2', color: '#991b1b', borderRadius: '12px' }}>
          <strong>Falha ao carregar informações:</strong> {error || 'Dados indisponíveis.'}
        </div>
      </div>
    );
  }

  const { restaurant: currentRest, usage, catalog, invoices, payment_methods: savedCards } = data;
  const currentPlan = catalog[currentRest.subscription_plan] || catalog.basic;
  const tablesUsagePercent = Math.min(100, Math.round((usage.tables_count / currentRest.max_tables) * 100));

  const planTitles: Record<SubscriptionPlanId, string> = {
    basic: 'Plano Básico',
    pro: 'Plano Profissional',
    premium: 'Plano Premium Enterprise',
  };

  const statusBadges: Record<string, { label: string; bg: string; color: string }> = {
    active: { label: 'Assinatura Ativa', bg: '#dcfce7', color: '#166534' },
    grace_period: { label: 'Em Período de Tolerância', bg: '#fef3c7', color: '#92400e' },
    expired: { label: 'Assinatura Vencida', bg: '#fee2e2', color: '#991b1b' },
  };

  const currentStatusBadge = statusBadges[currentRest.billing_status] || statusBadges.active;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '1180px', margin: '0 auto' }}>
      {/* Cabeçalho da Página */}
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
          <span>Administração</span>
          <span>/</span>
          <span style={{ color: 'var(--color-text-main)', fontWeight: 600 }}>Assinatura & Planos</span>
        </div>
        <h1 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: 'var(--color-text-main)' }}>
          Faturamento & Gestão de Planos SaaS
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Controle o ciclo de renovação, faça upgrades imediatos e pague via PIX ou Cartão sem intermediários.
        </p>
      </header>

      {/* Banner de Feedback Global */}
      {feedback && (
        <div
          role="alert"
          style={{
            padding: '14px 18px',
            borderRadius: '10px',
            background: feedback.type === 'success' ? '#dcfce7' : '#fee2e2',
            color: feedback.type === 'success' ? '#166534' : '#991b1b',
            border: `1px solid ${feedback.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            fontSize: '14px',
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
          1. RESUMO DO PLANO ATUAL & QUOTAS
          ========================================================================= */}
      <section
        style={{
          background: 'var(--color-surface, #ffffff)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px', borderBottom: '1px solid var(--color-border, #e2e8f0)', paddingBottom: '20px', marginBottom: '20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <span
                style={{
                  background: currentStatusBadge.bg,
                  color: currentStatusBadge.color,
                  padding: '4px 10px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 700,
                }}
              >
                {currentStatusBadge.label}
              </span>
              <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
                Ciclo de {currentRest.billing_cycle_days} dias
              </span>
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--color-text-main)' }}>
              {planTitles[currentRest.subscription_plan]}
            </h2>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => handleOpenCheckout(currentRest.subscription_plan, currentRest.billing_cycle_days > 100 ? 'yearly' : 'monthly')}
              className="admin-button primary"
              style={{
                background: '#dc2626',
                color: '#ffffff',
                border: '1px solid #dc2626',
                padding: '10px 20px',
                borderRadius: '10px',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Renovar Ciclo Agora
            </button>
            <a
              href="#grade-planos"
              className="admin-button"
              style={{
                border: '1px solid var(--color-border, #cbd5e1)',
                padding: '10px 18px',
                borderRadius: '10px',
                fontWeight: 600,
                fontSize: '14px',
                color: 'var(--color-text-main)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Fazer Upgrade de Plano
            </a>
          </div>
        </div>

        {/* Métricas e Validade */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
          {/* Card Validade */}
          <div style={{ padding: '16px', background: 'var(--color-bg-subtle, #f8fafc)', borderRadius: '12px', border: '1px solid var(--color-border, #e2e8f0)' }}>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 600 }}>PRÓXIMO VENCIMENTO</span>
            <p style={{ margin: '6px 0 2px', fontSize: '18px', fontWeight: 800, color: 'var(--color-text-main)' }}>
              {new Date(currentRest.subscription_expires_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}
            </p>
            <span style={{ fontSize: '12.5px', color: currentRest.days_remaining <= 5 ? '#dc2626' : 'var(--color-text-muted)', fontWeight: currentRest.days_remaining <= 5 ? 700 : 500 }}>
              {currentRest.days_remaining > 0 ? `${currentRest.days_remaining} dias restantes` : 'Assinatura vencida'}
            </span>
          </div>

          {/* Card Quota de Mesas */}
          <div style={{ padding: '16px', background: 'var(--color-bg-subtle, #f8fafc)', borderRadius: '12px', border: '1px solid var(--color-border, #e2e8f0)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 600 }}>CAPACIDADE DE MESAS</span>
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--color-text-main)' }}>
                {usage.tables_count} / {currentRest.max_tables}
              </span>
            </div>
            {/* Barra de Progresso */}
            <div style={{ width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '4px', margin: '10px 0 6px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${tablesUsagePercent}%`,
                  height: '100%',
                  background: tablesUsagePercent > 85 ? '#dc2626' : '#2563eb',
                  borderRadius: '4px',
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
              {tablesUsagePercent}% do limite contratado utilizado
            </span>
          </div>

          {/* Card Produtos e Cardápio */}
          <div style={{ padding: '16px', background: 'var(--color-bg-subtle, #f8fafc)', borderRadius: '12px', border: '1px solid var(--color-border, #e2e8f0)' }}>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 600 }}>PRODUTOS NO CARDÁPIO</span>
            <p style={{ margin: '6px 0 2px', fontSize: '18px', fontWeight: 800, color: 'var(--color-text-main)' }}>
              {usage.products_count} itens
            </p>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
              Catálogo ilimitado em todos os planos
            </span>
          </div>
        </div>
      </section>

      {/* =========================================================================
          2. GRADE DE MUDANÇA DE PLANO COM ALTERNADOR MENSAL / ANUAL
          ========================================================================= */}
      <section id="grade-planos">
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '24px', fontWeight: 800, margin: '0 0 8px', color: 'var(--color-text-main)' }}>
            Planos & Upgrades Oficiais Elozi
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', maxWidth: '600px', margin: '0 auto 18px' }}>
            Aumente a capacidade de atendimento, ative a cozinha em tempo real (KDS) e desbloqueie inteligência operacional.
          </p>

          {/* Alternador Mensal / Anual */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: 'var(--color-bg-subtle, #f1f5f9)',
              padding: '4px',
              borderRadius: '24px',
              border: '1px solid var(--color-border, #e2e8f0)',
              gap: '4px',
            }}
          >
            <button
              type="button"
              onClick={() => startTransition(() => setCycle('monthly'))}
              style={{
                border: 'none',
                padding: '8px 18px',
                borderRadius: '20px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
                background: cycle === 'monthly' ? 'var(--color-surface, #ffffff)' : 'transparent',
                color: cycle === 'monthly' ? '#dc2626' : 'var(--color-text-muted)',
                boxShadow: cycle === 'monthly' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              Faturamento Mensal
            </button>
            <button
              type="button"
              onClick={() => startTransition(() => setCycle('yearly'))}
              style={{
                border: 'none',
                padding: '8px 18px',
                borderRadius: '20px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
                background: cycle === 'yearly' ? 'var(--color-surface, #ffffff)' : 'transparent',
                color: cycle === 'yearly' ? '#dc2626' : 'var(--color-text-muted)',
                boxShadow: cycle === 'yearly' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>Faturamento Anual</span>
              <span
                style={{
                  background: '#16a34a',
                  color: '#ffffff',
                  fontSize: '10px',
                  fontWeight: 800,
                  padding: '2px 6px',
                  borderRadius: '10px',
                  textTransform: 'uppercase',
                }}
              >
                2 Meses Grátis
              </span>
            </button>
          </div>
        </div>

        {/* Cards dos 3 Planos */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
          {(['basic', 'pro', 'premium'] as SubscriptionPlanId[]).map((planId) => {
            const p = catalog[planId];
            if (!p) return null;
            const isCurrent = currentRest.subscription_plan === planId;
            const isFeatured = planId === 'pro';
            const priceCents = cycle === 'yearly' ? p.yearly_price_cents : p.monthly_price_cents;

            return (
              <div
                key={planId}
                style={{
                  background: 'var(--color-surface, #ffffff)',
                  border: isFeatured ? '2px solid #dc2626' : '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: '18px',
                  padding: '28px',
                  display: 'flex',
                  flexDirection: 'column',
                  position: 'relative',
                  boxShadow: isFeatured ? '0 8px 24px rgba(220, 38, 38, 0.1)' : '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                {isFeatured && (
                  <span
                    style={{
                      position: 'absolute',
                      top: '-12px',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      background: '#dc2626',
                      color: '#ffffff',
                      padding: '3px 12px',
                      borderRadius: '12px',
                      fontSize: '11px',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Mais Escolhido
                  </span>
                )}

                <h3 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 8px', color: 'var(--color-text-main)' }}>
                  {p.name}
                </h3>

                <div style={{ margin: '14px 0 20px' }}>
                  <span style={{ fontSize: '32px', fontWeight: 900, color: 'var(--color-text-main)' }}>
                    {formatCurrencyBRL(priceCents)}
                  </span>
                  <span style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginLeft: '6px' }}>
                    /{cycle === 'yearly' ? 'ano' : 'mês'}
                  </span>
                </div>

                <div style={{ flex: 1, marginBottom: '24px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: '12px' }}>
                    Recursos inclusos:
                  </p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <li style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--color-text-main)' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <strong>Até {p.max_tables} mesas simultâneas</strong>
                    </li>
                    {p.features.map((feat, idx) => (
                      <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'var(--color-text-main)' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => handleOpenCheckout(planId, cycle)}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '10px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    background: isCurrent ? 'var(--color-bg-subtle, #f1f5f9)' : '#dc2626',
                    color: isCurrent ? 'var(--color-text-main)' : '#ffffff',
                    border: isCurrent ? '1px solid var(--color-border, #cbd5e1)' : '1px solid #dc2626',
                  }}
                >
                  {isCurrent ? 'Plano Atual (Renovar)' : 'Selecionar Plano'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* =========================================================================
          3. HISTÓRICO DE FATURAS E COBRANÇAS
          ========================================================================= */}
      <section
        style={{
          background: 'var(--color-surface, #ffffff)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <h2 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 16px', color: 'var(--color-text-main)' }}>
          Histórico de Faturas & Recibos
        </h2>

        {invoices.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--color-text-muted)' }}>
            Nenhuma cobrança registrada até o momento.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border, #e2e8f0)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Data</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Plano</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Ciclo</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Forma</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Valor</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '12px 10px', fontWeight: 600, textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const statusStyles: Record<string, { label: string; bg: string; color: string }> = {
                    paid: { label: 'Pago', bg: '#dcfce7', color: '#166534' },
                    pending: { label: 'Pendente', bg: '#fef3c7', color: '#92400e' },
                    failed: { label: 'Falhou', bg: '#fee2e2', color: '#991b1b' },
                    expired: { label: 'Expirado', bg: '#f3f4f6', color: '#6b7280' },
                    refunded: { label: 'Estornado', bg: '#f3e8ff', color: '#6b21a8' },
                  };
                  const badge = statusStyles[inv.status] || statusStyles.pending;

                  return (
                    <tr key={inv.id} style={{ borderBottom: '1px solid var(--color-border, #f1f5f9)', color: 'var(--color-text-main)' }}>
                      <td style={{ padding: '14px 10px' }}>
                        {new Date(inv.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ padding: '14px 10px', fontWeight: 700 }}>
                        {planTitles[inv.plan_id] || inv.plan_id}
                      </td>
                      <td style={{ padding: '14px 10px', textTransform: 'capitalize' }}>
                        {inv.billing_cycle === 'yearly' ? 'Anual' : 'Mensal'}
                      </td>
                      <td style={{ padding: '14px 10px' }}>
                        <span style={{ textTransform: 'uppercase', fontSize: '12px', fontWeight: 600 }}>
                          {inv.payment_method === 'pix' ? 'PIX' : inv.payment_method === 'credit_card' ? `Crédito •••• ${inv.card_last4 || ''}` : `Débito •••• ${inv.card_last4 || ''}`}
                        </span>
                      </td>
                      <td style={{ padding: '14px 10px', fontWeight: 800 }}>
                        {formatCurrencyBRL(inv.amount_cents)}
                      </td>
                      <td style={{ padding: '14px 10px' }}>
                        <span style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 700, background: badge.bg, color: badge.color }}>
                          {badge.label}
                        </span>
                      </td>
                      <td style={{ padding: '14px 10px', textAlign: 'right' }}>
                        {inv.status === 'pending' && inv.pix_qr_code_payload && (
                          <button
                            type="button"
                            onClick={() => {
                              setPixPending({
                                invoiceId: inv.id,
                                payload: inv.pix_qr_code_payload || '',
                                expiresAt: inv.pix_expires_at || '',
                                amountCents: inv.amount_cents,
                                planId: inv.plan_id,
                              });
                              setCheckoutModal({
                                open: true,
                                planId: inv.plan_id,
                                cycle: inv.billing_cycle,
                              });
                            }}
                            style={{
                              background: '#2563eb',
                              color: '#ffffff',
                              border: 'none',
                              padding: '6px 12px',
                              borderRadius: '6px',
                              fontSize: '12px',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Ver PIX QR Code
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* =========================================================================
          4. GERENCIADOR DE CARTÕES SALVOS
          ========================================================================= */}
      <section
        style={{
          background: 'var(--color-surface, #ffffff)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <h2 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 16px', color: 'var(--color-text-main)' }}>
          Cartões Salvos para Cobrança Automática
        </h2>

        {savedCards.length === 0 ? (
          <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--color-text-muted)' }}>
            Nenhum cartão salvo. Você pode salvar um cartão durante o próximo pagamento com cartão de crédito.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
            {savedCards.map((card) => (
              <div
                key={card.id}
                style={{
                  border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: '12px',
                  padding: '16px',
                  background: 'var(--color-bg-subtle, #f8fafc)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="20" height="14" x="2" y="5" rx="2" />
                      <line x1="2" x2="22" y1="10" y2="10" />
                    </svg>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--color-text-main)' }}>
                      •••• {card.card_last4}
                    </span>
                    <span style={{ textTransform: 'uppercase', fontSize: '11px', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                      {card.card_brand || 'Cartão'}
                    </span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', display: 'block', marginTop: '4px' }}>
                    Validade: {String(card.exp_month).padStart(2, '0')}/{card.exp_year}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => void handleDeleteCard(card.id)}
                  title="Remover cartão"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#dc2626',
                    cursor: 'pointer',
                    padding: '6px',
                    borderRadius: '6px',
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* =========================================================================
          MODAL DE CHECKOUT TRANSPARENTE (PIX, CRÉDITO E DÉBITO)
          ========================================================================= */}
      {checkoutModal?.open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
          }}
        >
          <div
            style={{
              background: 'var(--color-surface, #ffffff)',
              borderRadius: '20px',
              maxWidth: '540px',
              width: '100%',
              padding: '28px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.25)',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            {/* Cabeçalho do Modal */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 4px', color: 'var(--color-text-main)' }}>
                  Checkout Seguro de Assinatura
                </h3>
                <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--color-text-muted)' }}>
                  {planTitles[checkoutModal.planId]} • Ciclo {checkoutModal.cycle === 'yearly' ? 'Anual' : 'Mensal'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseCheckout}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '20px',
                  color: 'var(--color-text-muted)',
                  padding: '4px',
                }}
              >
                ✕
              </button>
            </div>

            {/* Sucesso no Pagamento */}
            {checkoutSuccess ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    background: '#dcfce7',
                    color: '#16a34a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                  }}
                >
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h4 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 8px', color: 'var(--color-text-main)' }}>
                  Pagamento Confirmado com Sucesso!
                </h4>
                <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', margin: '0 0 20px' }}>
                  Sua assinatura do <strong>{planTitles[checkoutSuccess.planId]}</strong> foi ativada.
                  Sua capacidade agora é de <strong>{checkoutSuccess.maxTables} mesas simultâneas</strong>.
                </p>
                <button
                  type="button"
                  onClick={handleCloseCheckout}
                  style={{
                    background: '#dc2626',
                    color: '#ffffff',
                    border: 'none',
                    padding: '12px 28px',
                    borderRadius: '10px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Voltar ao Painel
                </button>
              </div>
            ) : pixPending ? (
              /* Tela de Pagamento PIX com QR Code */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
                  {pixPending.image ? (
                    <img src={pixPending.image} alt="QR Code PIX Asaas" style={{ width: '200px', height: '200px', display: 'block' }} />
                  ) : (
                    <QRCodeSVG value={pixPending.payload} size={200} level="M" />
                  )}
                </div>

                <div>
                  <span style={{ fontSize: '22px', fontWeight: 900, color: 'var(--color-text-main)' }}>
                    {formatCurrencyBRL(pixPending.amountCents)}
                  </span>
                  <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: 'var(--color-text-muted)' }}>
                    Escaneie o QR Code no aplicativo do seu banco ou use o código Copia e Cola.
                  </p>
                </div>

                {/* Campo Copia e Cola */}
                <div style={{ width: '100%' }}>
                  <div
                    style={{
                      display: 'flex',
                      background: 'var(--color-bg-subtle, #f8fafc)',
                      border: '1px solid var(--color-border, #cbd5e1)',
                      borderRadius: '10px',
                      padding: '8px 12px',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <input
                      type="text"
                      readOnly
                      value={pixPending.payload}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        flex: 1,
                        color: 'var(--color-text-main)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void copyToClipboard(pixPending.payload)}
                      style={{
                        background: copiedPix ? '#16a34a' : '#2563eb',
                        color: '#ffffff',
                        border: 'none',
                        padding: '6px 14px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {copiedPix ? 'Copiado!' : 'Copiar'}
                    </button>
                  </div>
                </div>

                {/* Botão de Verificação Imediata */}
                <button
                  type="button"
                  disabled={checkingPayment}
                  onClick={() => void handleVerifyPixPayment(pixPending.invoiceId)}
                  style={{
                    width: '100%',
                    background: '#16a34a',
                    color: '#ffffff',
                    border: 'none',
                    padding: '12px',
                    borderRadius: '10px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {checkingPayment ? 'Verificando pagamento…' : 'Já realizei o pagamento (Confirmar)'}
                </button>
              </div>
            ) : (
              /* Formulário com as 3 Abas: PIX, Crédito, Débito */
              <>
                {/* Abas */}
                <div
                  style={{
                    display: 'flex',
                    borderBottom: '1px solid var(--color-border, #e2e8f0)',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setActiveTab('pix')}
                    style={{
                      flex: 1,
                      padding: '10px 8px',
                      border: 'none',
                      borderBottom: activeTab === 'pix' ? '3px solid #dc2626' : '3px solid transparent',
                      background: 'transparent',
                      color: activeTab === 'pix' ? '#dc2626' : 'var(--color-text-muted)',
                      fontWeight: activeTab === 'pix' ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      fontSize: '13.5px',
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    <span>PIX Instantâneo</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('credit_card')}
                    style={{
                      flex: 1,
                      padding: '10px 8px',
                      border: 'none',
                      borderBottom: activeTab === 'credit_card' ? '3px solid #dc2626' : '3px solid transparent',
                      background: 'transparent',
                      color: activeTab === 'credit_card' ? '#dc2626' : 'var(--color-text-muted)',
                      fontWeight: activeTab === 'credit_card' ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      fontSize: '13.5px',
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="20" height="14" x="2" y="5" rx="2" />
                      <line x1="2" x2="22" y1="10" y2="10" />
                    </svg>
                    <span>Cartão de Crédito</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('debit_card')}
                    style={{
                      flex: 1,
                      padding: '10px 8px',
                      border: 'none',
                      borderBottom: activeTab === 'debit_card' ? '3px solid #dc2626' : '3px solid transparent',
                      background: 'transparent',
                      color: activeTab === 'debit_card' ? '#dc2626' : 'var(--color-text-muted)',
                      fontWeight: activeTab === 'debit_card' ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      fontSize: '13.5px',
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="20" height="14" x="2" y="5" rx="2" />
                      <line x1="2" x2="22" y1="10" y2="10" />
                      <circle cx="7" cy="15" r="1" />
                    </svg>
                    <span>Cartão de Débito</span>
                  </button>
                </div>

                {/* Conteúdo da Aba PIX */}
                {activeTab === 'pix' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ padding: '16px', background: 'var(--color-bg-subtle, #f8fafc)', borderRadius: '12px', border: '1px solid var(--color-border, #e2e8f0)' }}>
                      <p style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 700, color: 'var(--color-text-main)' }}>
                        Liberação Imediata via Asaas & Banco Central
                      </p>
                      <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                        Ao clicar no botão abaixo, geraremos um QR Code exclusivo para sua empresa. A compensação é feita em segundos e a liberação é 100% automática.
                      </p>
                    </div>

                    {/* CPF/CNPJ do Pagador (Obrigatório Asaas) */}
                    <div>
                      <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                        CPF ou CNPJ do titular / empresa: *
                      </label>
                      <input
                        type="text"
                        placeholder="000.000.000-00 ou 00.000.000/0000-00"
                        value={payerCpfCnpj}
                        onChange={(e) => setPayerCpfCnpj(formatCpfCnpj(e.target.value))}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--color-border, #cbd5e1)',
                          fontSize: '14px',
                          background: 'var(--color-surface, #ffffff)',
                          color: 'var(--color-text-main)',
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      disabled={checkoutBusy}
                      onClick={() => void handleProcessPix()}
                      style={{
                        background: '#dc2626',
                        color: '#ffffff',
                        border: 'none',
                        padding: '14px',
                        borderRadius: '10px',
                        fontSize: '14.5px',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {checkoutBusy ? 'Gerando QR Code PIX…' : 'Gerar PIX e Pagar Agora'}
                    </button>
                  </div>
                )}

                {/* Conteúdo da Aba Cartão de Crédito e Débito */}
                {(activeTab === 'credit_card' || activeTab === 'debit_card') && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {/* Seletor de Cartão Salvo */}
                    {savedCards.length > 0 && (
                      <div>
                        <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '6px' }}>
                          Cartão para pagamento:
                        </label>
                        <select
                          value={selectedSavedCardId}
                          onChange={(e) => setSelectedSavedCardId(e.target.value)}
                          style={{
                            width: '100%',
                            padding: '10px 12px',
                            borderRadius: '8px',
                            border: '1px solid var(--color-border, #cbd5e1)',
                            fontSize: '13.5px',
                            background: 'var(--color-surface, #ffffff)',
                            color: 'var(--color-text-main)',
                          }}
                        >
                          <option value="new">+ Usar um novo cartão</option>
                          {savedCards.map((sc) => (
                            <option key={sc.id} value={sc.id}>
                              {sc.card_brand?.toUpperCase()} •••• {sc.card_last4} (Exp: {sc.exp_month}/{sc.exp_year})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {selectedSavedCardId === 'new' && (
                      <>
                        {/* CPF ou CNPJ do Titular */}
                        <div>
                          <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                            CPF ou CNPJ do titular do cartão: *
                          </label>
                          <input
                            type="text"
                            placeholder="000.000.000-00 ou 00.000.000/0000-00"
                            value={payerCpfCnpj}
                            onChange={(e) => setPayerCpfCnpj(formatCpfCnpj(e.target.value))}
                            style={{
                              width: '100%',
                              padding: '10px 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--color-border, #cbd5e1)',
                              fontSize: '14px',
                              background: 'var(--color-surface, #ffffff)',
                              color: 'var(--color-text-main)',
                            }}
                          />
                        </div>

                        {/* Número do Cartão */}
                        <div>
                          <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                            Número do Cartão:
                          </label>
                          <input
                            type="text"
                            placeholder="0000 0000 0000 0000"
                            value={cardNumber}
                            onChange={(e) => setCardNumber(formatCardInput(e.target.value))}
                            style={{
                              width: '100%',
                              padding: '10px 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--color-border, #cbd5e1)',
                              fontSize: '14px',
                              background: 'var(--color-surface, #ffffff)',
                              color: 'var(--color-text-main)',
                            }}
                          />
                        </div>

                        {/* Nome do Titular */}
                        <div>
                          <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                            Nome impresso no Cartão:
                          </label>
                          <input
                            type="text"
                            placeholder="NOME COMO NO CARTAO"
                            value={cardHolder}
                            onChange={(e) => setCardHolder(e.target.value.toUpperCase())}
                            style={{
                              width: '100%',
                              padding: '10px 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--color-border, #cbd5e1)',
                              fontSize: '14px',
                              background: 'var(--color-surface, #ffffff)',
                              color: 'var(--color-text-main)',
                            }}
                          />
                        </div>

                        {/* Validade e CVV */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                          <div>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                              Validade (MM/AA):
                            </label>
                            <input
                              type="text"
                              placeholder="MM/AA"
                              value={cardExp}
                              onChange={(e) => setCardExp(formatExpInput(e.target.value))}
                              style={{
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border, #cbd5e1)',
                                fontSize: '14px',
                                background: 'var(--color-surface, #ffffff)',
                                color: 'var(--color-text-main)',
                              }}
                            />
                          </div>

                          <div>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                              CVV:
                            </label>
                            <input
                              type="password"
                              maxLength={4}
                              placeholder="123"
                              value={cardCvv}
                              onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, ''))}
                              style={{
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border, #cbd5e1)',
                                fontSize: '14px',
                                background: 'var(--color-surface, #ffffff)',
                                color: 'var(--color-text-main)',
                              }}
                            />
                          </div>
                        </div>

                        {/* Endereço de Cobrança: CEP e Número */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                          <div>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                              CEP de cobrança:
                            </label>
                            <input
                              type="text"
                              placeholder="00000-000"
                              value={payerPostalCode}
                              onChange={(e) => setPayerPostalCode(formatCep(e.target.value))}
                              style={{
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border, #cbd5e1)',
                                fontSize: '14px',
                                background: 'var(--color-surface, #ffffff)',
                                color: 'var(--color-text-main)',
                              }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>
                              Número do endereço:
                            </label>
                            <input
                              type="text"
                              placeholder="Ex: 100"
                              value={payerAddressNumber}
                              onChange={(e) => setPayerAddressNumber(e.target.value)}
                              style={{
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border, #cbd5e1)',
                                fontSize: '14px',
                                background: 'var(--color-surface, #ffffff)',
                                color: 'var(--color-text-main)',
                              }}
                            />
                          </div>
                        </div>

                        {/* Checkbox Salvar Cartão */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', color: 'var(--color-text-main)' }}>
                          <input
                            type="checkbox"
                            checked={saveCard}
                            onChange={(e) => setSaveCard(e.target.checked)}
                          />
                          <span>Salvar cartão para futuras renovações da assinatura</span>
                        </label>
                      </>
                    )}

                    <button
                      type="button"
                      disabled={checkoutBusy}
                      onClick={() => void handleProcessCardPayment(activeTab as 'credit_card' | 'debit_card')}
                      style={{
                        background: '#dc2626',
                        color: '#ffffff',
                        border: 'none',
                        padding: '14px',
                        borderRadius: '10px',
                        fontSize: '14.5px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        marginTop: '8px',
                      }}
                    >
                      {checkoutBusy ? 'Processando transação…' : `Pagar e Ativar Plano Agora`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
