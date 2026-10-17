import { createClient } from "npm:@supabase/supabase-js@2.117.3";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, asaas-access-token",
      },
    });
  }

  try {
    const EXPECTED_TOKEN = Deno.env.get("ASAAS_WEBHOOK_TOKEN");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // 1. Validação do Token de Segurança do Webhook do Asaas
    if (EXPECTED_TOKEN) {
      const receivedToken = req.headers.get("asaas-access-token");
      if (receivedToken !== EXPECTED_TOKEN) {
        console.warn("[AsaasWebhook] Tentativa de acesso com token inválido.");
        return new Response(JSON.stringify({ error: "Token de webhook não autorizado." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("[AsaasWebhook] Variáveis do Supabase ausentes.");
      return new Response(JSON.stringify({ error: "Ambiente Supabase não configurado." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json();
    const event = body.event;
    const payment = body.payment;

    console.info(`[AsaasWebhook] Evento recebido: ${event} para payment: ${payment?.id}`);

    // Eventos de baixa / confirmação de pagamento
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
      const asaasPaymentId = payment?.id;
      let invoiceId = payment?.externalReference;

      if (!invoiceId && asaasPaymentId) {
        const { data: invRow } = await adminClient
          .from("subscription_invoices")
          .select("id")
          .eq("external_reference", asaasPaymentId)
          .maybeSingle();

        if (invRow) {
          invoiceId = invRow.id;
        }
      }

      if (invoiceId) {
        console.info(`[AsaasWebhook] Confirmando pagamento da fatura ${invoiceId}...`);
        const { data: confirmResult, error: confirmErr } = await adminClient.rpc(
          "confirm_subscription_invoice_payment",
          {
            p_invoice_id: invoiceId,
            p_external_reference: asaasPaymentId || `asaas_pay_${invoiceId}`,
          }
        );

        if (confirmErr) {
          console.error(`[AsaasWebhook] Erro ao confirmar fatura ${invoiceId}:`, confirmErr);
          return new Response(JSON.stringify({ error: confirmErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        console.info(`[AsaasWebhook] Fatura ${invoiceId} confirmada com sucesso:`, confirmResult);
      } else {
        console.warn(`[AsaasWebhook] Nenhuma fatura local correspondente para o pagamento ${asaasPaymentId}.`);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Erro interno no webhook";
    console.error("[AsaasWebhook] Exceção:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
