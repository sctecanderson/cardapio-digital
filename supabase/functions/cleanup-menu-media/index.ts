import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// Autenticação validada pelo Auth; a RPC verifica o administrador do restaurante.
// A chave privilegiada nunca é enviada ao navegador.
Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") || "";
  const allowed = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cors = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "null",
    "Access-Control-Allow-Headers":
      "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  function reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (origin && !allowed.includes(origin))
    return reply(403, { error: "Origem não autorizada." });
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, { error: "Entre como administrador." });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!url || !anonKey || !serviceKey)
      throw new Error("Configuração indisponível.");
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser(token);
    if (authError || !user || user.is_anonymous)
      return reply(401, { error: "Entre como administrador." });
    const body = await request.json();
    if (
      typeof body.slug !== "string" ||
      body.slug.length > 120 ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.slug)
    )
      return reply(400, { error: "Restaurante inválido." });
    const { data: batch, error } = await userClient.rpc(
      "claim_unused_menu_media",
      { p_slug: body.slug },
    );
    if (error)
      return reply(error.code === "42501" ? 403 : 400, {
        error: ["42501", "22023"].includes(error.code)
          ? error.message
          : "Não foi possível consultar as mídias.",
      });
    if (!batch || !Array.isArray(batch.jobs)) throw new Error("Lote inválido.");
    const service = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let deleted = 0,
      failed = 0;
    for (const job of batch.jobs.slice(0, 25)) {
      const { error: removeError } = await service.storage
        .from(job.bucket)
        .remove([job.path]);
      if (removeError) {
        failed++;
        continue;
      }
      const { error: finishError } = await service.rpc(
        "finish_menu_media_cleanup",
        { p_id: job.id },
      );
      if (finishError) {
        failed++;
        continue;
      }
      deleted++;
    }
    return reply(200, {
      marked: batch.marked,
      retained: batch.retained,
      deleted,
      failed,
    });
  } catch {
    return reply(500, {
      error:
        "Não foi possível concluir a limpeza. As reservas serão retomadas na próxima execução.",
    });
  }
});
