import { supabase } from '../../lib/supabase';

export type SubscriptionPlanId = 'basic' | 'pro' | 'premium';
export type BillingCycle = 'monthly' | 'yearly';
export type PaymentMethodType = 'pix' | 'credit_card' | 'debit_card';
export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
export type GatewayProvider = 'elozi_sandbox' | 'asaas' | 'mercadopago';

export interface SubscriptionInvoice {
  id: string;
  plan_id: SubscriptionPlanId;
  billing_cycle: BillingCycle;
  payment_method: PaymentMethodType;
  amount_cents: number;
  status: InvoiceStatus;
  card_brand?: string | null;
  card_last4?: string | null;
  pix_qr_code_payload?: string | null;
  pix_expires_at?: string | null;
  paid_at?: string | null;
  created_at: string;
}

export interface SavedPaymentMethod {
  id: string;
  method_type: PaymentMethodType;
  holder_name?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
  is_default: boolean;
  created_at: string;
}

export interface PlanCatalogItem {
  plan_id: SubscriptionPlanId;
  name: string;
  monthly_price_cents: number;
  yearly_price_cents: number;
  max_tables: number;
  features: string[];
}

export interface BillingSummaryResponse {
  restaurant: {
    id: string;
    name: string;
    slug: string;
    subscription_plan: SubscriptionPlanId;
    subscription_started_at: string;
    subscription_expires_at: string;
    billing_cycle_days: number;
    max_tables: number;
    monthly_price_cents: number;
    active: boolean;
    billing_status: 'active' | 'grace_period' | 'expired';
    days_remaining: number;
  };
  usage: {
    tables_count: number;
    products_count: number;
  };
  catalog: Record<SubscriptionPlanId, PlanCatalogItem>;
  invoices: SubscriptionInvoice[];
  payment_methods: SavedPaymentMethod[];
}

export interface CardFormData {
  holder_name?: string;
  card_number?: string;
  card_brand?: string;
  card_last4?: string;
  exp_month?: number;
  exp_year?: number;
  cvv?: string;
  save_card?: boolean;
}

export interface CreateCheckoutParams {
  restaurantId: string;
  targetPlan: SubscriptionPlanId;
  billingCycle: BillingCycle;
  paymentMethod: PaymentMethodType;
  cardData?: CardFormData | null;
  gatewayProvider?: GatewayProvider;
}

export interface CheckoutResponse {
  success: boolean;
  invoice_id: string;
  status: InvoiceStatus;
  paid_at?: string;
  amount_cents: number;
  plan_id: SubscriptionPlanId;
  billing_cycle: BillingCycle;
  payment_method: PaymentMethodType;
  subscription_expires_at?: string;
  max_tables?: number;
  pix_qr_code_payload?: string;
  pix_expires_at?: string;
  already_paid?: boolean;
}

/**
 * Busca o resumo completo de faturamento do restaurante:
 * plano ativo, validade, quotas, planos disponíveis, faturas e cartões salvos.
 */
export async function fetchBillingSummary(restaurantId: string): Promise<BillingSummaryResponse> {
  const { data, error } = await supabase.rpc('get_restaurant_billing_summary', {
    p_restaurant_id: restaurantId,
  });

  if (error) {
    throw new Error(error.message || 'Erro ao carregar dados de faturamento do restaurante.');
  }

  return data as BillingSummaryResponse;
}

/**
 * Cria ou processa o checkout de assinatura (PIX, Cartão de Crédito ou Débito).
 * Pronto para adaptação a Edge Functions de gateways externos (Asaas / Mercado Pago / Stripe).
 */
export async function createSubscriptionCheckout(params: CreateCheckoutParams): Promise<CheckoutResponse> {
  const {
    restaurantId,
    targetPlan,
    billingCycle,
    paymentMethod,
    cardData,
    gatewayProvider = 'elozi_sandbox',
  } = params;

  // Em produção, se o gatewayProvider exigir tokenização externa via Edge Function:
  if (gatewayProvider !== 'elozi_sandbox') {
    // Adapter modular para Edge Function de gateway externo
    console.info(`[BillingAdapter] Encaminhando checkout para gateway provider: ${gatewayProvider}`);
  }

  // Prepara os dados de cartão estritamente seguros (sem CVV ou PAN completo gravados)
  let safeCardPayload: Record<string, unknown> | null = null;
  if (cardData && (paymentMethod === 'credit_card' || paymentMethod === 'debit_card')) {
    const rawDigits = (cardData.card_number || '').replace(/\D/g, '');
    const cleanLast4 = cardData.card_last4 || (rawDigits.length >= 4 ? rawDigits.slice(-4) : '4242');

    safeCardPayload = {
      holder_name: cardData.holder_name?.trim() || 'Titular do Cartão',
      card_brand: cardData.card_brand || detectCardBrand(rawDigits),
      card_last4: cleanLast4,
      exp_month: cardData.exp_month || 12,
      exp_year: cardData.exp_year || 2030,
      save_card: Boolean(cardData.save_card),
    };
  }

  const { data, error } = await supabase.rpc('create_subscription_checkout', {
    p_restaurant_id: restaurantId,
    p_target_plan: targetPlan,
    p_billing_cycle: billingCycle,
    p_payment_method: paymentMethod,
    p_card_data: safeCardPayload,
  });

  if (error) {
    throw new Error(error.message || 'Erro ao processar checkout de assinatura.');
  }

  return data as CheckoutResponse;
}

/**
 * Confirma o pagamento de uma fatura de assinatura (idempotente).
 * Utilizado para webhook de gateway ou verificação do botão PIX na homologação.
 */
export async function confirmSubscriptionInvoice(
  invoiceId: string,
  externalReference?: string
): Promise<CheckoutResponse> {
  const { data, error } = await supabase.rpc('confirm_subscription_invoice_payment', {
    p_invoice_id: invoiceId,
    p_external_reference: externalReference || null,
  });

  if (error) {
    throw new Error(error.message || 'Erro ao confirmar pagamento da fatura.');
  }

  return data as CheckoutResponse;
}

/**
 * Remove um meio de pagamento salvo pelo restaurante.
 */
export async function deleteSavedPaymentMethod(
  restaurantId: string,
  methodId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('delete_restaurant_payment_method', {
    p_restaurant_id: restaurantId,
    p_method_id: methodId,
  });

  if (error) {
    throw new Error(error.message || 'Erro ao remover meio de pagamento.');
  }

  return Boolean(data);
}

/**
 * Utilitário para detecção de bandeira de cartão por prefixo (BIN).
 */
export function detectCardBrand(digits: string): string {
  const clean = digits.replace(/\D/g, '');
  if (!clean) return 'visa';

  if (/^4/.test(clean)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/.test(clean)) return 'mastercard';
  if (/^(34|37)/.test(clean)) return 'amex';
  if (/^(4011|438935|451416|4576|504175|5067|5090|627780|636297|636368)/.test(clean)) return 'elo';
  if (/^(6011|622|64|65)/.test(clean)) return 'discover';
  if (/^(30[0-5]|36|38)/.test(clean)) return 'diners';
  if (/^(35)/.test(clean)) return 'jcb';
  if (/^(606282)/.test(clean)) return 'hipercard';

  return 'visa';
}

/**
 * Formata centavos em moeda brasileira BRL.
 */
export function formatCurrencyBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
