import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const MAX_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type BackupFile = {
  id: string; source_kind: "local" | "storage"; source_bucket: string | null;
  source_path: string | null; target_path: string; sha256: string; byte_count: number;
};

async function hash(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    value => value.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") || "";
  const allowed = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") || "").split(",").map(s => s.trim()).filter(Boolean);
  const headers: Record<string, string> = {
    "Content-Type": "application/json", "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
  if (origin && !allowed.includes(origin)) return reply(403, { error: "Origem não autorizada." });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, { error: "Entre com uma conta autorizada da Elozi." });

  // Toda ação termina antes da reserva de três minutos do trabalhador. Cada
  // chamada externa tem timeout próprio; nenhuma remoção começa após o prazo.
  const deadline = AbortSignal.timeout(60_000);
  const boundedFetch: typeof fetch = (input, init = {}) => fetch(input, {
    ...init, signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]),
  });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) throw new Error("Configuração do servidor indisponível.");
    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: boundedFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await client.auth.getUser(token);
    if (authError || !user || user.is_anonymous) return reply(401, { error: "Entre com uma conta autorizada da Elozi." });
    let body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, { error: "Informe a operação." });
      const parts: Uint8Array[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 4096) { await reader.cancel(); return reply(413, { error: "Solicitação muito grande." }); }
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return reply(400, { error: "Solicitação inválida." }); }
    if (!body || !UUID.test(body.deletionId || "") ||
      !["verify-file", "delete-data", "remove-media", "finish"].includes(body.action)) {
      return reply(400, { error: "Operação inválida." });
    }

    // Esta RPC exige platform_admin ativo; não basta ser admin de restaurante.
    const { data: job, error: accessError } = await client.rpc("get_platform_restaurant_deletion", { p_deletion_id: body.deletionId });
    if (accessError || !job) return reply(accessError?.code === "42501" ? 403 : 404, {
      error: accessError?.code === "42501" ? accessError.message : "Exclusão não encontrada.",
    });
    if (job.status === "cancelled") return reply(409, { error: "Exclusão cancelada." });
    if (job.status === "completed") return reply(200, { status: "completed" });
    const service = createClient(url, serviceKey, {
      global: { fetch: boundedFetch }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = async (name: string, args: Record<string, unknown>) => {
      deadline.throwIfAborted();
      const { data, error } = await service.rpc(name, args);
      if (error) throw new Error(error.message);
      return data;
    };
    const verifiedBytes = async (bucket: string, path: string, sha: string, size?: number) => {
      deadline.throwIfAborted();
      const { data, error } = await service.storage.from(bucket).download(path);
      if (error || !data || data.size > MAX_BYTES || (size !== undefined && data.size !== size)) {
        throw new Error("Arquivo ausente ou tamanho divergente. A exclusão foi interrompida.");
      }
      if (await hash(new Uint8Array(await data.arrayBuffer())) !== sha) {
        throw new Error("Um arquivo diverge do backup. A exclusão foi interrompida.");
      }
    };

    if (body.action === "verify-file") {
      if (job.status !== "pending") return reply(409, { error: "A exclusão já passou da verificação." });
      const { data: backup, error } = await client.rpc("get_platform_backup_progress", { p_backup_id: job.backup_id });
      if (error || backup?.status !== "ready" || backup.restaurantId !== job.source_restaurant_id) {
        return reply(409, { error: "Backup concluído indisponível." });
      }
      const file = (job.files as BackupFile[]).find(f => f.id === body.fileKey);
      const path = body.fileKey === "snapshot" ? backup.snapshotPath : body.fileKey === "manifest" ? backup.manifestPath : file?.target_path;
      const sha = body.fileKey === "snapshot" ? backup.snapshotSha256 : body.fileKey === "manifest" ? backup.manifestSha256 : file?.sha256;
      if (!path || !sha) return reply(404, { error: "Arquivo não pertence à cópia desta exclusão." });
      await verifiedBytes("elozi-backups", path, sha, file?.byte_count);
      await rpc("record_platform_deletion_check", { p_deletion_id: job.id, p_file_key: body.fileKey, p_sha256: sha });
      return reply(200, { verified: true });
    }
    if (body.action === "delete-data") {
      await rpc("delete_platform_restaurant_data", { p_deletion_id: job.id, p_actor_id: user.id });
      return reply(200, { status: "media_cleanup" });
    }
    if (body.action === "remove-media") {
      if (job.status !== "media_cleanup") return reply(409, { error: "Os dados precisam ser excluídos primeiro." });
      const file = (job.files as BackupFile[]).find(f => f.id === body.fileId && f.source_kind === "storage");
      if (!file?.source_bucket || !file.source_path ||
        !["menu-images", "menu-videos", "restaurant-images"].includes(file.source_bucket) ||
        !file.source_path.startsWith(`${job.source_restaurant_id}/`) || /(^|\/)\.{1,2}(\/|$)/.test(file.source_path)) {
        return reply(404, { error: "Mídia não pertence ao restaurante desta exclusão." });
      }
      const lease = await rpc("claim_platform_deletion_worker", { p_deletion_id: job.id });
      try {
        // Confere a cópia preservada antes de remover cada original.
        await verifiedBytes("elozi-backups", file.target_path, file.sha256, file.byte_count);
        const { data: exists, error: existsError } = await service.storage.from(file.source_bucket).exists(file.source_path);
        if (existsError) throw new Error("Não foi possível consultar a mídia. Retome a limpeza.");
        if (exists) {
          await verifiedBytes(file.source_bucket, file.source_path, file.sha256, file.byte_count);
          deadline.throwIfAborted();
          const { error } = await service.storage.from(file.source_bucket).remove([file.source_path]);
          if (error) throw new Error("Não foi possível remover a mídia. Retome a limpeza.");
        }
        await rpc("record_platform_deletion_media_removed", { p_deletion_id: job.id, p_file_id: file.id, p_token: lease });
      } finally {
        // Se a conexão caiu, a reserva expira e permite retomar após 3 minutos.
        await rpc("release_platform_deletion_worker", { p_deletion_id: job.id, p_token: lease }).catch(() => undefined);
      }
      return reply(200, { removed: true });
    }
    await rpc("finish_platform_restaurant_deletion", { p_deletion_id: job.id });
    return reply(200, { status: "completed" });
  } catch (cause) {
    return reply(409, { error: cause instanceof Error ? cause.message : "Não foi possível concluir. Atualize e retome a operação." });
  }
});
