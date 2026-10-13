import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const BACKUP_BUCKET = "elozi-backups";
const MAX_BYTES = 32 * 1024 * 1024;


type BackupFile = {
  id: string;
  backup_id: string;
  source_kind: "storage" | "local";
  source_key: string;
  source_bucket: string | null;
  source_path: string | null;
  source_url: string | null;
  target_path: string;
  expected_bytes: number | null;
  byte_count: number | null;
  sha256: string | null;
  verified_at: string | null;
};

function sha256Hex(bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer).then((hash) =>
    Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("")
  );
}

function mediaType(path: string) {
  const extension = path.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm",
  };
  const type = extension ? types[extension] : undefined;
  if (!type) throw new Error("Formato de mídia não aceito no backup.");
  return type;
}

function validBytes(bytes: Uint8Array, type: string) {
  if (!bytes.length || bytes.length > MAX_BYTES) return false;
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (type === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === "image/jpeg") return starts([255, 216, 255]);
  if (type === "image/webp") return starts([82, 73, 70, 70]) &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (type === "image/avif") {
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp" || bytes.length < 16) return false;
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize < 16 || boxSize > bytes.length) return false;
    for (let i = 8; i + 4 <= boxSize; i += 4) {
      if (i === 12) continue;
      if (["avif", "avis"].includes(String.fromCharCode(...bytes.slice(i, i + 4)))) return true;
    }
    return false;
  }
  if (type === "video/mp4") return String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  if (type === "video/webm") return starts([0x1a, 0x45, 0xdf, 0xa3]);
  return false;
}

Deno.serve(async (request: Request) => {
  const allowedOrigins = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = allowedOrigins.includes(origin);
  const cors: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowedOrigin) cors["Access-Control-Allow-Origin"] = origin;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

  if (origin && !allowedOrigin) return reply(403, { error: "Origem não autorizada." });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });

  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, { error: "Entre com uma conta autorizada da Elozi." });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) throw new Error("Configuração do servidor indisponível.");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user || user.is_anonymous) return reply(401, { error: "Entre com uma conta autorizada da Elozi." });

    let body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, { error: "Informe a operação." });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8192) {
          await reader.cancel();
          return reply(413, { error: "Solicitação muito grande." });
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return reply(400, { error: "Solicitação inválida." }); }
    const actions = ["progress", "copy-storage", "local-upload", "verify-local", "finalize", "download", "recovery-check", "recover-storage", "recover-finish"];
    if (!body || typeof body.action !== "string" || !actions.includes(body.action) ||
      typeof body.backupId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.backupId)) {
      return reply(400, { error: "Operação de backup inválida." });
    }

    const { data: progress, error: accessError } = await userClient.rpc(
      "get_platform_backup_progress", { p_backup_id: body.backupId },
    );
    if (accessError || !progress) return reply(accessError?.code === "42501" ? 403 : 404, {
      error: accessError?.code === "42501" ? accessError.message : "Cópia não encontrada.",
    });
    if (!Array.isArray(progress.files)) throw new Error("Inventário inválido.");
    if (body.action === "progress") return reply(200, progress);
    if (body.action === "finalize" && progress.status === "ready") {
      return reply(200, { status: "ready", backupId: body.backupId, mediaCount: progress.files.length });
    }
    if (body.action !== "download" && !body.action.startsWith("recover") && (progress.status !== "snapshot_created" || !progress.initialized)) {
      return reply(409, { error: "Cópia não está em preparação." });
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (body.action.startsWith("recover")) {
      if (progress.status !== "ready") return reply(409, { error: "Selecione um backup concluído." });
      const { data: validation, error: validationError } = await userClient.rpc(
        "validate_platform_backup_recovery", { p_backup_id: body.backupId },
      );
      if (validationError || !validation) return reply(409, {
        error: validationError?.message || "Não foi possível validar a recuperação.",
      });
      if (body.action === "recovery-check") return reply(200, validation);
      if (body.confirmSlug !== validation.slug) return reply(400, { error: "Digite o endereço exato do restaurante para confirmar." });
      if (validation.sourceExists || validation.slugConflict) return reply(409, {
        error: "O restaurante ou seu endereço ainda existe. Nenhum dado será substituído.",
      });
      const readVerified = async (bucket: string, path: string, expectedHash: string, expectedSize?: number) => {
        const { data, error } = await service.storage.from(bucket).download(path);
        if (error || !data || data.size > MAX_BYTES || (expectedSize !== undefined && data.size !== expectedSize)) {
          throw new Error("Arquivo ausente ou tamanho divergente na recuperação.");
        }
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (await sha256Hex(bytes) !== expectedHash) throw new Error("Checksum divergente na recuperação. Nenhum dado foi recuperado.");
        return bytes;
      };
      const checkSource = (file: BackupFile) => {
        if (!file.source_bucket || !["menu-images", "menu-videos", "restaurant-images"].includes(file.source_bucket) ||
          !file.source_path?.startsWith(`${progress.restaurantId}/`) ||
          /(^|\/)\.{1,2}(\/|$)/.test(file.source_path)) {
          throw new Error("Caminho Storage fora do restaurante.");
        }
        if (file.source_url) {
          const source = new URL(file.source_url);
          if (source.origin !== new URL(supabaseUrl).origin || decodeURIComponent(source.pathname) !==
            `/storage/v1/object/public/${file.source_bucket}/${file.source_path}`) {
            throw new Error("Recuperação permitida somente no projeto Supabase original.");
          }
        }
      };
      if (body.action === "recover-storage") {
        const file = (progress.files as BackupFile[]).find((item) => item.id === body.fileId && item.source_kind === "storage");
        if (!file?.sha256 || !file.byte_count || !file.verified_at) return reply(404, { error: "Mídia Storage não pertence a esta cópia." });
        checkSource(file);
        const bytes = await readVerified(BACKUP_BUCKET, file.target_path, file.sha256, file.byte_count);
        const bucket = file.source_bucket!;
        const path = file.source_path!;
        const { data: exists, error: existsError } = await service.storage.from(bucket).exists(path);
        if (existsError) throw new Error("Não foi possível consultar o destino. Nenhum arquivo foi sobrescrito.");
        if (!exists) {
          const { error } = await service.storage.from(bucket).upload(path, bytes, { upsert: false, contentType: mediaType(path) });
          if (error) throw new Error("Não foi possível repor a mídia. Retome para conferir o envio.");
        }
        await readVerified(bucket, path, file.sha256, file.byte_count);
        return reply(200, { id: file.id, recovered: true });
      }
      // Todas as mídias e documentos são conferidos de novo antes do INSERT
      // atômico. Arquivos locais são repostos na pasta public pelo script e
      // conferidos pelo navegador; a Edge não escreve no servidor do front-end.
      await readVerified(BACKUP_BUCKET, progress.snapshotPath, progress.snapshotSha256);
      await readVerified(BACKUP_BUCKET, progress.manifestPath, progress.manifestSha256);
      for (const file of progress.files as BackupFile[]) {
        if (!file.sha256 || !file.byte_count || !file.verified_at) throw new Error("Inventário incompleto.");
        await readVerified(BACKUP_BUCKET, file.target_path, file.sha256, file.byte_count);
        if (file.source_kind === "storage") {
          checkSource(file);
          await readVerified(file.source_bucket!, file.source_path!, file.sha256, file.byte_count);
        }
      }
      const { data: recovered, error: recoveryError } = await service.rpc("complete_platform_backup_recovery", {
        p_backup_id: body.backupId, p_actor_id: user.id,
      });
      if (recoveryError || !recovered) return reply(409, { error: recoveryError?.message || "Não foi possível recuperar os dados." });
      return reply(200, recovered);
    }

    if (body.action === "download") {
      if (progress.status !== "ready") return reply(409, { error: "Conclua o backup antes de baixar." });
      const file = (progress.files as BackupFile[]).find((item) => item.id === body.fileId);
      const path = body.fileId === "snapshot" ? progress.snapshotPath :
        body.fileId === "manifest" ? progress.manifestPath : file?.target_path;
      const hash = body.fileId === "snapshot" ? progress.snapshotSha256 :
        body.fileId === "manifest" ? progress.manifestSha256 : file?.sha256;
      if (!path || !hash) return reply(404, { error: "Arquivo não pertence a esta cópia." });
      const { data, error } = await service.storage.from(BACKUP_BUCKET).createSignedUrl(path, 300);
      if (error || !data) throw new Error("Não foi possível preparar o download.");
      return reply(200, { url: data.signedUrl, sha256: hash });
    }

    if (body.action === "local-upload") {
      const file = (progress.files as BackupFile[]).find((item) =>
        item.id === body.fileId && item.source_kind === "local"
      );
      if (!file) return reply(404, { error: "Arquivo local não pertence a esta cópia." });
      if (file.verified_at) return reply(409, { error: "Este arquivo já foi verificado." });
      const type = mediaType(file.source_url || "");
      const { data: exists, error: existsError } = await service.storage.from(BACKUP_BUCKET).exists(file.target_path);
      if (existsError) throw new Error("Não foi possível consultar o destino da mídia.");
      if (exists) return reply(200, { exists: true, path: file.target_path, contentType: type });
      const { data, error } = await service.storage.from(BACKUP_BUCKET)
        .createSignedUploadUrl(file.target_path, { upsert: false });
      if (error || !data) throw new Error("Não foi possível preparar o envio protegido da mídia.");
      return reply(200, { path: file.target_path, token: data.token, contentType: type });
    }

    if (body.action === "copy-storage" || body.action === "verify-local") {
      const kind = body.action === "copy-storage" ? "storage" : "local";
      const file = (progress.files as BackupFile[]).find((item) =>
        item.id === body.fileId && item.source_kind === kind
      );
      if (!file) return reply(404, { error: "Arquivo não pertence a esta cópia." });
      if (file.verified_at) return reply(200, { id: file.id, verified: true, sha256: file.sha256, bytes: file.byte_count });

      const type = mediaType(file.source_path || file.source_url || "");
      let bytes: Uint8Array;
      if (kind === "storage") {
        if (!file.source_bucket || !file.source_path ||
          !file.source_path.startsWith(`${progress.restaurantId}/`)) {
          return reply(400, { error: "Origem Storage fora do restaurante." });
        }
        if (file.source_url) {
          const source = new URL(file.source_url);
          const project = new URL(supabaseUrl);
          const expectedSuffix = `/storage/v1/object/public/${file.source_bucket}/${file.source_path}`;
          if (source.origin !== project.origin || decodeURIComponent(source.pathname) !== expectedSuffix) {
            return reply(400, { error: "A referência da mídia não pertence ao Storage deste projeto." });
          }
        }
        const { data: source, error: sourceError } = await service.storage.from(file.source_bucket).download(file.source_path);
        if (sourceError || !source) throw new Error("Não foi possível baixar uma mídia original do Storage.");
        if (source.size > MAX_BYTES) throw new Error("Uma mídia original excede o limite de 32 MiB.");
        bytes = new Uint8Array(await source.arrayBuffer());
      } else {
        // O navegador envia os arquivos locais por URL assinada; aqui só se
        // aceita ler o objeto privado do caminho exclusivo desta cópia.
        const { data: uploaded, error: uploadError } = await service.storage.from(BACKUP_BUCKET).download(file.target_path);
        if (uploadError || !uploaded) return reply(409, { error: "Envie primeiro o arquivo local para o Storage privado." });
        if (uploaded.size > MAX_BYTES) throw new Error("Uma mídia local excede o limite de 32 MiB.");
        bytes = new Uint8Array(await uploaded.arrayBuffer());
      }

      if (!validBytes(bytes, type)) return reply(422, { error: "O conteúdo da mídia não corresponde ao formato declarado." });
      if (file.expected_bytes !== null && file.expected_bytes !== bytes.byteLength) {
        return reply(422, { error: "O tamanho recebido difere do original." });
      }
      const digest = await sha256Hex(bytes);
      if (kind === "local" && (body.sha256 !== digest || body.byteCount !== bytes.byteLength)) {
        return reply(422, { error: "A cópia local difere do arquivo lido no site. Cancele e gere outra cópia se o original mudou." });
      }

      if (kind === "storage") {
        const { data: existing } = await service.storage.from(BACKUP_BUCKET).download(file.target_path);
        if (existing) {
          if (existing.size !== bytes.byteLength || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== digest) {
            return reply(409, { error: "Já existe um arquivo diferente no destino; a cópia precisa ser reiniciada." });
          }
        } else {
          const { error: saveError } = await service.storage.from(BACKUP_BUCKET).upload(file.target_path, bytes, {
            contentType: type, upsert: false,
          });
          if (saveError) throw new Error("Não foi possível salvar a mídia no Storage privado.");
        }
        const { data: copied, error: copiedError } = await service.storage.from(BACKUP_BUCKET).download(file.target_path);
        if (copiedError || !copied || copied.size !== bytes.byteLength ||
          await sha256Hex(new Uint8Array(await copied.arrayBuffer())) !== digest) {
          throw new Error("A mídia copiada não passou na conferência de integridade.");
        }
      }

      const { error: recordError } = await service.rpc("record_platform_backup_file_verification", {
        p_file_id: file.id, p_sha256: digest, p_byte_count: bytes.byteLength,
      });
      if (recordError) throw new Error(recordError.message);
      return reply(200, { id: file.id, verified: true, sha256: digest, bytes: bytes.byteLength });
    }

    if (body.action === "finalize") {
      if ((progress.files as BackupFile[]).some((file) => !file.verified_at)) {
        return reply(409, { error: "Verifique todas as mídias antes de concluir." });
      }
      const { data: snapshot, error: snapshotError } = await userClient.rpc(
        "get_platform_backup_snapshot", { p_backup_id: body.backupId },
      );
      if (snapshotError || !snapshot) throw new Error("Não foi possível recuperar o snapshot da cópia.");
      const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot.snapshot, null, 2));
      const snapshotHash = await sha256Hex(snapshotBytes);
      const manifest = {
        format: "elozi-restaurant-backup", version: 1,
        backupId: progress.id, restaurantId: progress.restaurantId,
        restaurant: { name: progress.name, slug: progress.slug },
        createdAt: progress.createdAt, snapshotPath: progress.snapshotPath, snapshotSha256: snapshotHash,
        media: (progress.files as BackupFile[]).map((file) => ({
          id: file.id, sourceKind: file.source_kind, sourceKey: file.source_key,
          sourceBucket: file.source_bucket, sourcePath: file.source_path,
          sourceUrl: file.source_url, path: file.target_path,
          bytes: file.byte_count, sha256: file.sha256,
        })).sort((a, b) => a.id.localeCompare(b.id)),
        scope: { ...snapshot.snapshot.scope, mediaBytesIncluded: true },
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      const manifestHash = await sha256Hex(manifestBytes);

      if (snapshotBytes.byteLength > MAX_BYTES || manifestBytes.byteLength > MAX_BYTES) {
        return reply(413, { error: "Os documentos excedem o limite desta versão. Não foi concluído um backup parcial." });
      }
      for (const [path, bytes, hash] of [
        [progress.snapshotPath, snapshotBytes, snapshotHash],
        [progress.manifestPath, manifestBytes, manifestHash],
      ] as [string, Uint8Array, string][]) {
        const { data: existing } = await service.storage.from(BACKUP_BUCKET).download(path);
        if (existing) {
          if (await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== hash) {
            return reply(409, { error: "Um documento diferente já existe neste backup." });
          }
        } else {
          const { error } = await service.storage.from(BACKUP_BUCKET).upload(path, bytes, {
            contentType: "application/json", upsert: false,
          });
          if (error) throw new Error("Não foi possível salvar os documentos do backup.");
        }
        const { data: stored, error } = await service.storage.from(BACKUP_BUCKET).download(path);
        if (error || !stored || await sha256Hex(new Uint8Array(await stored.arrayBuffer())) !== hash) {
          throw new Error("Um documento do backup não passou na verificação.");
        }
      }

      const { error: sealError } = await service.rpc("seal_platform_restaurant_backup", {
        p_backup_id: body.backupId,
        p_snapshot_sha256: snapshotHash,
        p_manifest_sha256: manifestHash,
      });
      if (sealError) throw new Error(sealError.message);
      return reply(200, { status: "ready", backupId: body.backupId, mediaCount: manifest.media.length });
    }

    return reply(400, { error: "Operação inválida." });
  } catch (cause) {
    return reply(500, {
      error: cause instanceof Error ? cause.message : "Não foi possível processar o backup.",
    });
  }
});
