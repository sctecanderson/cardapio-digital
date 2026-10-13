begin;

-- Os bytes serão enviados/copiados pela Edge Function na próxima etapa.
-- Este bucket nunca deve ser tornado público.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('elozi-backups', 'elozi-backups', false, 33554432, array[
  'application/json', 'application/octet-stream',
  'image/png', 'image/jpeg', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm'
])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Uma política permissiva futura em outro recurso não pode abrir os backups.
-- O servidor usa service_role; links assinados serão emitidos após autorização.
create policy elozi_backups_no_direct_client_access
on storage.objects as restrictive for all to anon, authenticated
using (bucket_id <> 'elozi-backups')
with check (bucket_id <> 'elozi-backups');

alter table public.platform_restaurant_backups
  drop constraint platform_restaurant_backups_status_check;
alter table public.platform_restaurant_backups
  add constraint platform_restaurant_backups_status_check
    check (status in ('snapshot_created', 'ready', 'cancelled')),
  add column files_initialized_at timestamptz,
  add column completed_at timestamptz,
  add column snapshot_sha256 text,
  add column manifest_sha256 text,
  add constraint platform_restaurant_backups_completion_check check (
    (status = 'ready' and completed_at is not null and files_initialized_at is not null
      and snapshot_sha256 is not null and snapshot_sha256 ~ '^[0-9a-f]{64}$'
      and manifest_sha256 is not null and manifest_sha256 ~ '^[0-9a-f]{64}$')
    or
    (status <> 'ready' and completed_at is null
      and snapshot_sha256 is null and manifest_sha256 is null)
  );

create table public.platform_backup_files (
  id uuid primary key default gen_random_uuid(),
  backup_id uuid not null references public.platform_restaurant_backups(id) on delete restrict,
  source_kind text not null check (source_kind in ('storage', 'local')),
  source_key text not null,
  source_bucket text,
  source_path text,
  source_url text,
  target_path text generated always as
    (backup_id::text || '/media/' || id::text) stored,
  expected_bytes bigint check (expected_bytes between 1 and 33554432),
  byte_count bigint check (byte_count between 1 and 33554432),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz,
  unique (backup_id, source_key),
  unique (target_path),
  check (
    (source_kind = 'storage' and source_bucket is not null
      and source_bucket in ('menu-images', 'menu-videos', 'restaurant-images')
      and source_path is not null)
    or (source_kind = 'local' and source_bucket is null and source_path is null
      and source_url is not null)
  ),
  check (
    (verified_at is null and byte_count is null and sha256 is null)
    or (verified_at is not null and byte_count is not null and sha256 is not null)
  )
);

alter table public.platform_backup_files enable row level security;
revoke all on public.platform_backup_files from public, anon, authenticated;
grant select on public.platform_backup_files to service_role;

create function public.prepare_platform_backup_files(p_backup_id uuid)
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  b public.platform_restaurant_backups%rowtype;
  item jsonb;
  ref jsonb;
  bucket text;
  path text;
  url text;
  size_text text;
  size_bytes bigint;
  total integer;
begin
  perform public.require_platform_admin();
  select * into b from public.platform_restaurant_backups where id = p_backup_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Cópia não encontrada.';
  end if;
  if b.status <> 'snapshot_created' then
    raise exception using errcode = '55000', message = 'Esta cópia não está em preparação.';
  end if;
  if b.files_initialized_at is not null then
    select count(*)::integer into total from public.platform_backup_files where backup_id = b.id;
    return total;
  end if;

  for item in select value from jsonb_array_elements(b.storage_inventory) loop
    bucket := item->>'bucket';
    path := item->>'path';
    if bucket is null or bucket not in ('menu-images', 'menu-videos', 'restaurant-images')
      or path is null or split_part(path, '/', 1) <> b.source_restaurant_id::text then
      raise exception using errcode = '22023', message = 'Inventário de mídia fora do restaurante.';
    end if;
    size_text := item->'metadata'->>'size';
    size_bytes := null;
    if size_text is not null then
      if size_text !~ '^[0-9]{1,12}$' then
        raise exception using errcode = '22023', message = 'Tamanho de arquivo inválido no inventário.';
      end if;
      size_bytes := size_text::bigint;
      if size_bytes not between 1 and 33554432 then
        raise exception using errcode = '22023',
          message = 'Esta versão aceita arquivos de até 32 MiB, não vazios. Arquivo: ' || path;
      end if;
    end if;
    insert into public.platform_backup_files
      (backup_id, source_kind, source_key, source_bucket, source_path, expected_bytes)
    values (b.id, 'storage', 'storage:' || bucket || ':' || path, bucket, path, size_bytes);
  end loop;

  for ref in select value from jsonb_array_elements(b.media_references) loop
    path := ref->'media'->>'storagePath';
    url := ref->'media'->>'url';
    if url is null or url = '' then
      raise exception using errcode = '22023', message = 'Há uma mídia sem endereço no catálogo.';
    end if;
    if path is not null then
      bucket := case ref->>'kind'
        when 'product_image' then 'menu-images'
        when 'product_video' then 'menu-videos'
        when 'restaurant_logo' then 'restaurant-images'
        when 'restaurant_cover' then 'restaurant-images'
        else null end;
      if bucket is null or not exists (
        select 1 from public.platform_backup_files f
        where f.backup_id = b.id and f.source_bucket = bucket and f.source_path = path
      ) then
        raise exception using errcode = '22023',
          message = 'Mídia referenciada não encontrada no Storage deste restaurante: ' || path;
      end if;
      -- Preservar URL também permite ao servidor conferir a origem do projeto.
      if exists (select 1 from public.platform_backup_files f
        where f.backup_id = b.id and f.source_bucket = bucket and f.source_path = path
          and f.source_url is not null and f.source_url <> url) then
        raise exception using errcode = '22023', message = 'O mesmo arquivo possui endereços divergentes.';
      end if;
      update public.platform_backup_files f set source_url = url
        where f.backup_id = b.id and f.source_bucket = bucket and f.source_path = path;
    elsif url ~ '^/(images|videos)/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|avif|mp4|webm)$'
      and url !~ '(^|/)\.{1,2}(/|$)' then
      insert into public.platform_backup_files (backup_id, source_kind, source_key, source_url)
      values (b.id, 'local', 'local:' || url, url)
      on conflict (backup_id, source_key) do nothing;
    else
      raise exception using errcode = '22023',
        message = 'Mídia externa ou caminho não suportado. Importe o arquivo pelo painel antes de gerar o backup: ' || left(url, 160);
    end if;
  end loop;

  update public.platform_restaurant_backups set files_initialized_at = clock_timestamp() where id = b.id;
  select count(*)::integer into total from public.platform_backup_files where backup_id = b.id;
  return total;
end;
$$;

-- Início atômico: se houver referência inválida, não deixa uma cópia nova
-- pendente bloqueando o restaurante. Repetir o mesmo UUID é seguro.
create function public.start_platform_restaurant_backup(p_restaurant_id uuid, p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare result jsonb; total integer;
begin
  result := public.create_platform_backup_snapshot(p_restaurant_id, p_backup_id);
  if result->>'status' = 'snapshot_created' then
    total := public.prepare_platform_backup_files(p_backup_id);
    result := result || jsonb_build_object('fileCount', total);
  end if;
  return result;
end;
$$;

create function public.get_platform_backup_progress(p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform public.require_platform_admin();
  select jsonb_build_object(
    'id', b.id, 'restaurantId', b.source_restaurant_id,
    'name', b.source_name, 'slug', b.source_slug, 'status', b.status,
    'createdAt', b.created_at, 'completedAt', b.completed_at,
    'initialized', b.files_initialized_at is not null,
    'snapshotPath', b.id::text || '/snapshot.json',
    'manifestPath', b.id::text || '/manifest.json',
    'snapshotSha256', b.snapshot_sha256, 'manifestSha256', b.manifest_sha256,
    'files', coalesce((select jsonb_agg(to_jsonb(f) order by f.source_key)
      from public.platform_backup_files f where f.backup_id = b.id), '[]'::jsonb)
  ) into result from public.platform_restaurant_backups b where b.id = p_backup_id;
  if result is null then
    raise exception using errcode = '22023', message = 'Cópia não encontrada.';
  end if;
  return result;
end;
$$;

create function public.list_platform_restaurant_backups(p_restaurant_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.source_name, 'slug', b.source_slug,
    'status', b.status, 'createdAt', b.created_at, 'completedAt', b.completed_at,
    'fileCount', (select count(*) from public.platform_backup_files f where f.backup_id = b.id),
    'verifiedCount', (select count(*) from public.platform_backup_files f where f.backup_id = b.id and f.verified_at is not null)
  ) order by b.created_at desc, b.id) from public.platform_restaurant_backups b
    where b.source_restaurant_id = p_restaurant_id), '[]'::jsonb);
end;
$$;

-- Somente o backend, após baixar e calcular o SHA-256 dos bytes, pode confirmar.
-- O navegador NÃO tem permissão para informar que um arquivo foi verificado.
create function public.record_platform_backup_file_verification(
  p_file_id uuid, p_sha256 text, p_byte_count bigint
)
returns void language plpgsql security definer set search_path = ''
as $$
declare f public.platform_backup_files%rowtype; b public.platform_restaurant_backups%rowtype;
begin
  select b0.* into b from public.platform_restaurant_backups b0
    join public.platform_backup_files f0 on f0.backup_id = b0.id
    where f0.id = p_file_id for update of b0;
  if not found or b.status <> 'snapshot_created' or b.files_initialized_at is null then
    raise exception using errcode = '55000', message = 'Cópia indisponível para verificação.';
  end if;
  select * into f from public.platform_backup_files where id = p_file_id for update;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_byte_count is null or p_byte_count not between 1 and 33554432
    or (f.expected_bytes is not null and p_byte_count <> f.expected_bytes) then
    raise exception using errcode = '22023', message = 'Tamanho ou checksum de mídia inválido.';
  end if;
  if f.verified_at is not null then
    if f.sha256 <> p_sha256 or f.byte_count <> p_byte_count then
      raise exception using errcode = '55000', message = 'Uma mídia verificada não pode ser substituída.';
    end if;
    return;
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id = 'elozi-backups' and o.name = f.target_path
      and o.metadata->>'size' = p_byte_count::text) then
    raise exception using errcode = '55000', message = 'O arquivo de backup não foi encontrado com o tamanho esperado.';
  end if;
  update public.platform_backup_files set
    sha256 = p_sha256, byte_count = p_byte_count, verified_at = clock_timestamp()
    where id = p_file_id;
end;
$$;

-- O backend deve verificar os bytes dos dois JSONs antes de chamar esta RPC.
create function public.seal_platform_restaurant_backup(
  p_backup_id uuid, p_snapshot_sha256 text, p_manifest_sha256 text
)
returns void language plpgsql security definer set search_path = ''
as $$
declare b public.platform_restaurant_backups%rowtype;
begin
  select * into b from public.platform_restaurant_backups where id = p_backup_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Cópia não encontrada.';
  end if;
  if p_snapshot_sha256 is null or p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Checksums dos documentos inválidos.';
  end if;
  if b.status = 'ready' and b.snapshot_sha256 = p_snapshot_sha256
    and b.manifest_sha256 = p_manifest_sha256 then return; end if;
  if b.status <> 'snapshot_created' or b.files_initialized_at is null then
    raise exception using errcode = '55000', message = 'Cópia indisponível para conclusão.';
  end if;
  if exists (select 1 from public.platform_backup_files f
    where f.backup_id = b.id and f.verified_at is null) then
    raise exception using errcode = '55000', message = 'Existem arquivos sem verificação.';
  end if;
  if exists (select 1 from public.platform_backup_files f
    where f.backup_id = b.id and not exists (
      select 1 from storage.objects o where o.bucket_id = 'elozi-backups'
        and o.name = f.target_path and o.metadata->>'size' = f.byte_count::text
    )) then
    raise exception using errcode = '55000', message = 'Uma mídia verificada está ausente ou mudou de tamanho.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'elozi-backups'
    and name = b.id::text || '/snapshot.json')
    or not exists (select 1 from storage.objects where bucket_id = 'elozi-backups'
    and name = b.id::text || '/manifest.json') then
    raise exception using errcode = '55000', message = 'Os documentos do backup ainda não foram armazenados.';
  end if;
  update public.platform_restaurant_backups set status = 'ready',
    completed_at = clock_timestamp(), snapshot_sha256 = p_snapshot_sha256,
    manifest_sha256 = p_manifest_sha256 where id = b.id;
end;
$$;

revoke all on function public.prepare_platform_backup_files(uuid),
  public.start_platform_restaurant_backup(uuid, uuid),
  public.get_platform_backup_progress(uuid),
  public.list_platform_restaurant_backups(uuid),
  public.record_platform_backup_file_verification(uuid, text, bigint),
  public.seal_platform_restaurant_backup(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.prepare_platform_backup_files(uuid),
  public.start_platform_restaurant_backup(uuid, uuid),
  public.get_platform_backup_progress(uuid),
  public.list_platform_restaurant_backups(uuid)
to authenticated;

grant execute on function public.record_platform_backup_file_verification(uuid, text, bigint),
  public.seal_platform_restaurant_backup(uuid, text, text)
to service_role;

notify pgrst, 'reload schema';
commit;
