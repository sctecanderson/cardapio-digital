import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RequestBody {
  restaurantId: string;
  targetPlan: "basic" | "pro" | "premium";
  billingCycle: "monthly" | "yearly";
  paymentMethod: "pix" | "credit_card" | "debit_card";
  cardData?: {
    holder_name?: string;
    card_number?: string;
    card_brand?: string;
    card_last4?: string;
    exp_month?: number;
    exp_year?: number;
    cvv?: string;
    save_card?: boolean;
  } | null;
  payerInfo?: {
    cpfCnpj: string;
    name?: string;
    email?: string;
    phone?: string;
    postalCode?: string;
    addressNumber?: string;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");
    const ASAAS_BASE_URL = (Deno.env.get("ASAAS_API_BASE_URL") || "https://api.asaas.com/v3").replace(/\/+$/, "");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!ASAAS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Chave ASAAS_API_KEY não configurada nos segredos do Supabase." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return new Response(
        JSON.stringify({ error: "Ambiente Supabase incompleto na Edge Function." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Autenticação do Usuário
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Cabeçalho de autorização ausente." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Sessão inválida ou expirada." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body: RequestBody = await req.json();
    const { restaurantId, targetPlan, billingCycle, paymentMethod, cardData, payerInfo } = body;

    if (!restaurantId || !targetPlan || !billingCycle || !paymentMethod) {
      return new Response(
        JSON.stringify({ error: "Parâmetros de checkout incompletos." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Validação de Permissão (Membro Admin ou Plataforma Admin)
    const { data: memberData } = await adminClient
      .from("restaurant_members")
      .select("id, role, active")
      .eq("restaurant_id", restaurantId)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    const isPlatformAdmin = user.email?.toLowerCase().includes("superadmin") || false;

    if ((!memberData || memberData.role !== "admin") && !isPlatformAdmin) {
      return new Response(
        JSON.stringify({ error: "Apenas administradores do restaurante podem contratar planos." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Validação do CPF / CNPJ do Pagador (Obrigatório Asaas)
    const rawCpfCnpj = (payerInfo?.cpfCnpj || "").replace(/\D/g, "");
    if (rawCpfCnpj.length !== 11 && rawCpfCnpj.length !== 14) {
      return new Response(
        JSON.stringify({ error: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido para o Asaas." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Carrega Restaurante e Configurações de Preço
    const { data: restaurant, error: restErr } = await adminClient
      .from("restaurants")
      .select("id, name, slug, subscription_plan")
      .eq("id", restaurantId)
      .single();

    if (restErr || !restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurante não encontrado." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: settings } = await adminClient
      .from("platform_settings")
      .select("basic_price_cents, pro_price_cents, premium_price_cents, basic_max_tables, pro_max_tables, premium_max_tables")
      .eq("id", "default")
      .maybeSingle();

    let unitPriceCents = 9900;
    if (targetPlan === "basic") unitPriceCents = settings?.basic_price_cents ?? 9900;
    else if (targetPlan === "pro") unitPriceCents = settings?.pro_price_cents ?? 14900;
    else if (targetPlan === "premium") unitPriceCents = settings?.premium_price_cents ?? 19900;

    const amountCents = billingCycle === "yearly" ? unitPriceCents * 10 : unitPriceCents;
    const valueInReais = Number((amountCents / 100).toFixed(2));
    const todayYMD = new Date().toISOString().split("T")[0];

    // 5. Integração com Asaas: Localizar ou Criar Cliente
    const asaasHeaders = {
      "Content-Type": "application/json",
      "access_token": ASAAS_API_KEY,
      "User-Agent": "EloziSaaS/1.0",
    };

    let customerId: string | null = null;
    const findCustomerRes = await fetch(`${ASAAS_BASE_URL}/customers?cpfCnpj=${rawCpfCnpj}`, {
      headers: asaasHeaders,
    });

    if (findCustomerRes.ok) {
      const custData = await findCustomerRes.json();
      if (custData.data && custData.data.length > 0) {
        customerId = custData.data[0].id;
      }
    }

    if (!customerId) {
      const customerPayload = {
        name: payerInfo?.name?.trim() || restaurant.name || "Cliente Elozi",
        cpfCnpj: rawCpfCnpj,
        email: payerInfo?.email?.trim() || user.email || `${restaurant.slug}@elozi.com.br`,
        mobilePhone: (payerInfo?.phone || "").replace(/\D/g, "") || undefined,
        notificationDisabled: true,
      };

      const createCustRes = await fetch(`${ASAAS_BASE_URL}/customers`, {
        method: "POST",
        headers: asaasHeaders,
        body: JSON.stringify(customerPayload),
      });

      const createCustData = await createCustRes.json();
      if (!createCustRes.ok || !createCustData.id) {
        const errorDesc = createCustData.errors?.[0]?.description || "Erro ao cadastrar cliente no Asaas.";
        return new Response(
          JSON.stringify({ error: errorDesc }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      customerId = createCustData.id;
    }

    // 6. Registrar fatura pendente localmente
    const invoiceId = crypto.randomUUID();
    const { error: invoiceInsertErr } = await adminClient.from("subscription_invoices").insert({
      id: invoiceId,
      restaurant_id: restaurantId,
      plan_id: targetPlan,
      billing_cycle: billingCycle,
      payment_method: paymentMethod,
      amount_cents: amountCents,
      status: "pending",
      created_by: user.id,
    });

    if (invoiceInsertErr) {
      return new Response(
        JSON.stringify({ error: "Erro ao registrar fatura no banco: " + invoiceInsertErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Fluxo PIX no Asaas
    if (paymentMethod === "pix") {
      const paymentPayload = {
        customer: customerId,
        billingType: "PIX",
        value: valueInReais,
        dueDate: todayYMD,
        description: `Elozi SaaS - Assinatura Plano ${targetPlan.toUpperCase()} (${billingCycle === "yearly" ? "Anual" : "Mensal"})`,
        externalReference: invoiceId,
      };

      const paymentRes = await fetch(`${ASAAS_BASE_URL}/payments`, {
        method: "POST",
        headers: asaasHeaders,
        body: JSON.stringify(paymentPayload),
      });

      const paymentData = await paymentRes.json();
      if (!paymentRes.ok || !paymentData.id) {
        const errorDesc = paymentData.errors?.[0]?.description || "Erro ao emitir cobrança PIX no Asaas.";
        await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoiceId);
        return new Response(
          JSON.stringify({ error: errorDesc }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const asaasPaymentId = paymentData.id;

      // Buscar QR Code PIX
      const qrRes = await fetch(`${ASAAS_BASE_URL}/payments/${asaasPaymentId}/pixQrCode`, {
        headers: asaasHeaders,
      });

      const qrData = await qrRes.json();
      if (!qrRes.ok || !qrData.payload) {
        return new Response(
          JSON.stringify({ error: "Falha ao obter QR Code PIX do Asaas." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      await adminClient
        .from("subscription_invoices")
        .update({
          external_reference: asaasPaymentId,
          pix_qr_code_payload: qrData.payload,
          pix_expires_at: qrData.expirationDate || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
        .eq("id", invoiceId);

      return new Response(
        JSON.stringify({
          success: true,
          invoice_id: invoiceId,
          status: "pending",
          amount_cents: amountCents,
          plan_id: targetPlan,
          billing_cycle: billingCycle,
          payment_method: "pix",
          pix_qr_code_payload: qrData.payload,
          pix_qr_code_image: qrData.encodedImage ? `data:image/png;base64,${qrData.encodedImage}` : undefined,
          pix_expires_at: qrData.expirationDate,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 8. Fluxo Cartão de Crédito / Débito no Asaas
    if (paymentMethod === "credit_card" || paymentMethod === "debit_card") {
      if (!cardData || !cardData.card_number || !cardData.holder_name || !cardData.cvv) {
        return new Response(
          JSON.stringify({ error: "Dados do cartão incompletos." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawCardNum = cardData.card_number.replace(/\D/g, "");
      const cleanPostal = (payerInfo?.postalCode || "88350736").replace(/\D/g, "");
      const cleanPhone = (payerInfo?.phone || "47920013755").replace(/\D/g, "");
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";

      const cardPaymentPayload = {
        customer: customerId,
        billingType: paymentMethod === "debit_card" ? "DEBIT_CARD" : "CREDIT_CARD",
        value: valueInReais,
        dueDate: todayYMD,
        description: `Elozi SaaS - Assinatura Plano ${targetPlan.toUpperCase()} (${billingCycle === "yearly" ? "Anual" : "Mensal"})`,
        externalReference: invoiceId,
        creditCard: {
          holderName: cardData.holder_name.trim(),
          number: rawCardNum,
          expiryMonth: String(cardData.exp_month || 12).padStart(2, "0"),
          expiryYear: String(cardData.exp_year || 2030),
          ccv: cardData.cvv.trim(),
        },
        creditCardHolderInfo: {
          name: payerInfo?.name?.trim() || cardData.holder_name.trim(),
          email: payerInfo?.email?.trim() || user.email || `${restaurant.slug}@elozi.com.br`,
          cpfCnpj: rawCpfCnpj,
          postalCode: cleanPostal.length === 8 ? cleanPostal : "88350736",
          addressNumber: payerInfo?.addressNumber?.trim() || "45",
          phone: cleanPhone.length >= 10 ? cleanPhone : "47920013755",
        },
        remoteIp: clientIp,
      };

      const cardRes = await fetch(`${ASAAS_BASE_URL}/payments`, {
        method: "POST",
        headers: asaasHeaders,
        body: JSON.stringify(cardPaymentPayload),
      });

      const cardResData = await cardRes.json();
      if (!cardRes.ok || !cardResData.id) {
        const errorDesc = cardResData.errors?.[0]?.description || "Cartão recusado pela operadora.";
        await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoiceId);
        return new Response(
          JSON.stringify({ error: errorDesc }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const asaasPaymentId = cardResData.id;
      const paymentStatus = cardResData.status;

      if (paymentStatus === "CONFIRMED" || paymentStatus === "RECEIVED") {
        // Baixa automática imediata via RPC idempotente
        const { data: confirmResult, error: confirmErr } = await adminClient.rpc(
          "confirm_subscription_invoice_payment",
          {
            p_invoice_id: invoiceId,
            p_external_reference: asaasPaymentId,
          }
        );

        if (confirmErr) {
          return new Response(
            JSON.stringify({ error: "Erro ao confirmar assinatura no banco: " + confirmErr.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Salvar cartão tokenizado se solicitado
        if (cardData.save_card) {
          await adminClient.from("restaurant_payment_methods").insert({
            restaurant_id: restaurantId,
            method_type: paymentMethod,
            holder_name: cardData.holder_name.trim(),
            card_brand: cardResData.creditCard?.creditCardBrand || cardData.card_brand || "mastercard",
            card_last4: rawCardNum.slice(-4),
            exp_month: cardData.exp_month || 12,
            exp_year: cardData.exp_year || 2030,
            gateway_token: cardResData.creditCard?.creditCardToken || asaasPaymentId,
            is_default: true,
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            invoice_id: invoiceId,
            status: "paid",
            paid_at: new Date().toISOString(),
            amount_cents: amountCents,
            plan_id: targetPlan,
            billing_cycle: billingCycle,
            payment_method: paymentMethod,
            subscription_expires_at: confirmResult?.subscription_expires_at,
            max_tables: confirmResult?.max_tables,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } else {
        await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoiceId);
        return new Response(
          JSON.stringify({ error: `Transação não autorizada (Status Asaas: ${paymentStatus}).` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: "Meio de pagamento não suportado." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno no servidor de pagamentos.";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
