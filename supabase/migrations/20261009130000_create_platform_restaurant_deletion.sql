begin;

-- Histórico fora do tenant: preservado junto aos backups após a exclusão.
create table public.platform_restaurant_deletions (
  id uuid primary key,
  source_restaurant_id uuid not null,
  source_name text not null,
  source_slug text not null,
  backup_id uuid not null references public.platform_restaurant_backups(id) on delete restrict,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  reason text not null check(char_length(btrim(reason)) between 3 and 500),
  status text not null default 'pending' check(status in ('pending','deleting_data','media_cleanup','completed','cancelled')),
  data_deleted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  worker_token uuid,
  worker_until timestamptz,
  check ((status in ('media_cleanup','completed'))=(data_deleted_at is not null)),
  check ((status='completed')=(completed_at is not null)),
  check ((status='cancelled')=(cancelled_at is not null))
);
create unique index platform_deletions_one_running on public.platform_restaurant_deletions(source_restaurant_id)
  where status in ('pending','deleting_data','media_cleanup');
create table public.platform_deletion_checks (
  deletion_id uuid not null references public.platform_restaurant_deletions(id) on delete restrict,
  file_key text not null,
  verified_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key(deletion_id,file_key)
);
alter table public.platform_restaurant_deletions enable row level security;
alter table public.platform_deletion_checks enable row level security;
revoke all on public.platform_restaurant_deletions,public.platform_deletion_checks from public,anon,authenticated;

-- Compara todos os registros e o inventário atual ao backup escolhido.
-- Não basta escolher uma cópia antiga que conste como concluída.
create function public.check_platform_deletion_backup(p_restaurant_id uuid,p_backup_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
  b public.platform_restaurant_backups%rowtype;
  r public.restaurants%rowtype;
  name text; live_rows jsonb; expected jsonb; inventory jsonb;
begin
  select * into r from public.restaurants where id=p_restaurant_id;
  if not found or r.active or r.archived_at is null then
    raise exception using errcode='55000',message='Arquive o restaurante antes de excluir definitivamente.';
  end if;
  select * into b from public.platform_restaurant_backups where id=p_backup_id;
  if not found or b.source_restaurant_id<>p_restaurant_id or b.status<>'ready' then
    raise exception using errcode='22023',message='Escolha um backup concluído deste restaurante.';
  end if;
  if exists(select 1 from public.platform_restaurant_backups where source_restaurant_id=p_restaurant_id and status='snapshot_created') then
    raise exception using errcode='55000',message='Conclua ou cancele o backup em preparação antes da exclusão.';
  end if;
  -- Reutiliza a validação de formato, tabelas novas, CHECKs, FKs e Auth.
  perform public.stage_platform_backup_recovery(p_backup_id);
  for name in select jsonb_object_keys(b.snapshot->'tables') loop
    if name='restaurants' then
      live_rows:=jsonb_build_array(to_jsonb(r));
    elsif name='guest_confirmation_codes' then
      select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text),'[]'::jsonb) into live_rows
        from public.guest_confirmation_codes c join public.guest_sessions g on g.id=c.guest_session_id
        where g.restaurant_id=p_restaurant_id;
    elsif name='staff_confirmation_limits' then
      select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text),'[]'::jsonb) into live_rows
        from public.staff_confirmation_limits c join public.restaurant_members m on m.id=c.member_id
        where m.restaurant_id=p_restaurant_id;
    else
      execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t where restaurant_id=$1',name)
        into live_rows using p_restaurant_id;
    end if;
    select coalesce(jsonb_agg(v order by v::text),'[]'::jsonb) into expected
      from jsonb_array_elements(b.snapshot->'tables'->name) v;
    if live_rows is distinct from expected then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'path',o.name,
    'metadata',o.metadata,'createdAt',o.created_at,'updatedAt',o.updated_at) order by o.bucket_id,o.name),'[]'::jsonb)
    into inventory from storage.objects o
    where o.bucket_id in ('menu-images','menu-videos','restaurant-images') and split_part(o.name,'/',1)=p_restaurant_id::text;
  if inventory is distinct from b.storage_inventory then
    raise exception using errcode='55000',message='As mídias mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
  end if;
end;
$$;
revoke all on function public.check_platform_deletion_backup(uuid,uuid) from public,anon,authenticated;

-- Congela escritas enquanto a exclusão autorizada é conferida. Durante a
-- transação privada deleting_data, só as exclusões internas são liberadas.
create function public.guard_platform_restaurant_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid; old_rid uuid; ids uuid[]; row_value jsonb; state text;
begin
  if tg_table_name='restaurants' then
    if tg_op<>'DELETE' then rid:=new.id; end if;
    if tg_op<>'INSERT' then old_rid:=old.id; end if;
  elsif tg_table_name='platform_restaurant_backups' then
    rid:=new.source_restaurant_id;
  elsif tg_table_name='guest_confirmation_codes' then
    row_value:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
    select restaurant_id into rid from public.guest_sessions where id=(row_value->>'guest_session_id')::uuid;
    if tg_op='UPDATE' then select restaurant_id into old_rid from public.guest_sessions where id=old.guest_session_id; end if;
  elsif tg_table_name='staff_confirmation_limits' then
    row_value:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
    select restaurant_id into rid from public.restaurant_members where id=(row_value->>'member_id')::uuid;
    if tg_op='UPDATE' then select restaurant_id into old_rid from public.restaurant_members where id=old.member_id; end if;
  else
    if tg_op<>'DELETE' then rid:=new.restaurant_id; end if;
    if tg_op<>'INSERT' then old_rid:=old.restaurant_id; end if;
  end if;
  ids:=array[rid,old_rid];
  for state in select status from public.platform_restaurant_deletions
    where source_restaurant_id=any(ids) and status in ('pending','deleting_data','media_cleanup') loop
    if state<>'deleting_data' or tg_op<>'DELETE' then
      raise exception using errcode='55000',message='Existe uma exclusão em andamento. Retome ou cancele a operação na plataforma antes de alterar este restaurante.';
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_platform_restaurant_deletion() from public,anon,authenticated;
do $$ declare name text; begin
  foreach name in array array['restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items','service_requests',
    'service_request_guests','guest_confirmation_codes','staff_confirmation_limits','menu_media_cleanup',
    'restaurant_status_events','restaurant_archive_events'] loop
    execute format('create trigger guard_platform_deletion before insert or update or delete on public.%I for each row execute function public.guard_platform_restaurant_deletion()',name);
  end loop;
end $$;
create trigger guard_platform_deletion before insert on public.platform_restaurant_backups
  for each row execute function public.guard_platform_restaurant_deletion();

-- Bloqueia também a reposição de arquivos pela função de recuperação enquanto
-- uma exclusão ainda estiver limpando os caminhos originais.
create or replace function public.validate_platform_backup_recovery(p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.require_platform_admin();
  if exists(select 1 from public.platform_restaurant_deletions d join public.platform_restaurant_backups b
    on b.source_restaurant_id=d.source_restaurant_id
    where b.id=p_backup_id and d.status in ('pending','deleting_data','media_cleanup')) then
    raise exception using errcode='55000',message='Conclua ou cancele a exclusão em andamento antes de recuperar o restaurante.';
  end if;
  return public.stage_platform_backup_recovery(p_backup_id);
end;
$$;

create function public.get_platform_restaurant_deletion(p_deletion_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; files jsonb; checks jsonb;
begin
  perform public.require_platform_admin();
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id;
  if not found then raise exception using errcode='22023',message='Exclusão não encontrada.'; end if;
  select coalesce(jsonb_agg(to_jsonb(f) order by f.id),'[]'::jsonb) into files
    from public.platform_backup_files f where f.backup_id=j.backup_id;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.file_key),'[]'::jsonb) into checks
    from public.platform_deletion_checks c where c.deletion_id=j.id;
  return to_jsonb(j)||jsonb_build_object('files',files,'checks',checks);
end;
$$;

create function public.list_platform_restaurant_deletions()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.require_platform_admin();
  return (select coalesce(jsonb_agg(to_jsonb(j) order by j.requested_at desc),'[]'::jsonb)
    from public.platform_restaurant_deletions j);
end;
$$;

create function public.start_platform_restaurant_deletion(
  p_id uuid,p_restaurant_id uuid,p_backup_id uuid,p_confirmation_name text,p_reason text,p_backup_saved boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; r public.restaurants%rowtype; j public.platform_restaurant_deletions%rowtype;
begin
  actor:=public.require_platform_admin();
  if p_id is null or p_restaurant_id is null or p_backup_id is null or p_backup_saved is distinct from true
    or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using errcode='22023',message='Confirme o backup salvo e informe um motivo de 3 a 500 caracteres.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text,0));
  select * into r from public.restaurants where id=p_restaurant_id for update;
  select * into j from public.platform_restaurant_deletions where id=p_id;
  if found then
    if j.source_restaurant_id<>p_restaurant_id or j.backup_id<>p_backup_id or j.source_name is distinct from btrim(p_confirmation_name)
      or j.reason<>btrim(p_reason) then raise exception using errcode='22023',message='Identificador já usado por outra solicitação.'; end if;
    return public.get_platform_restaurant_deletion(j.id);
  end if;
  if r.id is null or r.name is distinct from btrim(p_confirmation_name) then
    raise exception using errcode='22023',message='Digite o nome exato do restaurante para confirmar.';
  end if;
  if exists(select 1 from public.platform_restaurant_deletions where source_restaurant_id=r.id and status in ('pending','deleting_data','media_cleanup')) then
    raise exception using errcode='55000',message='Este restaurante já possui uma exclusão em andamento. Retome a operação.';
  end if;
  perform public.check_platform_deletion_backup(r.id,p_backup_id);
  insert into public.platform_restaurant_deletions(id,source_restaurant_id,source_name,source_slug,backup_id,requested_by,reason)
    values(p_id,r.id,r.name,r.slug,p_backup_id,actor,btrim(p_reason));
  return public.get_platform_restaurant_deletion(p_id);
end;
$$;

create function public.cancel_platform_restaurant_deletion(p_deletion_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; rid uuid;
begin
  perform public.require_platform_admin();
  select source_restaurant_id into rid from public.platform_restaurant_deletions where id=p_deletion_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if j.status='cancelled' then return; end if;
  if j.id is null or j.status<>'pending' then
    raise exception using errcode='55000',message='Os dados já foram removidos ou a operação não está pendente. A limpeza precisa ser concluída.';
  end if;
  update public.platform_restaurant_deletions set status='cancelled',cancelled_at=now() where id=j.id;
end;
$$;

-- Chamadas privadas: apenas a Edge Function, após verificar Auth + owner.
create function public.record_platform_deletion_check(p_deletion_id uuid,p_file_key text,p_sha256 text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; expected text;
begin
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if not found or j.status<>'pending' then raise exception 'A exclusão não está aguardando verificação.'; end if;
  if p_file_key in ('snapshot','manifest') then
    select case when p_file_key='snapshot' then snapshot_sha256 else manifest_sha256 end into expected
      from public.platform_restaurant_backups where id=j.backup_id and status='ready';
  else
    select sha256 into expected from public.platform_backup_files where backup_id=j.backup_id and id::text=p_file_key and verified_at is not null;
  end if;
  if expected is null or expected is distinct from p_sha256 then raise exception 'Checksum não pertence ao backup desta exclusão.'; end if;
  insert into public.platform_deletion_checks(deletion_id,file_key) values(j.id,p_file_key)
    on conflict(deletion_id,file_key) do update set verified_at=now();
end;
$$;

create function public.delete_platform_restaurant_data(p_deletion_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; rid uuid; name text;
begin
  perform user_id from public.platform_admins where user_id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Acesso exclusivo da administração da Elozi.'; end if;
  select source_restaurant_id into rid from public.platform_restaurant_deletions where id=p_deletion_id;
  if rid is null then raise exception 'Exclusão não encontrada.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  perform id from public.restaurants where id=rid for update;
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if j.status in ('media_cleanup','completed') then return; end if;
  if j.status<>'pending' then raise exception 'Exclusão cancelada ou indisponível.'; end if;
  if exists(
    select 1 from (select 'snapshot' as key union all select 'manifest' union all
      select id::text from public.platform_backup_files where backup_id=j.backup_id) expected
    where not exists(select 1 from public.platform_deletion_checks c where c.deletion_id=j.id
      and c.file_key=expected.key and c.verified_at>=now()-interval '15 minutes')
  ) then raise exception 'Confira novamente todos os arquivos do backup antes de excluir.'; end if;
  perform public.check_platform_deletion_backup(rid,j.backup_id);
  update public.platform_restaurant_deletions set status='deleting_data' where id=j.id;
  -- Ordem explícita de dependências. Sem CASCADE e sem excluir auth.users.
  delete from public.guest_confirmation_codes c using public.guest_sessions g where c.guest_session_id=g.id and g.restaurant_id=rid;
  delete from public.staff_confirmation_limits c using public.restaurant_members m where c.member_id=m.id and m.restaurant_id=rid;
  foreach name in array array['service_request_guests','service_requests','table_tab_items','table_tab_guests','table_tabs',
    'guest_sessions','table_visits','menu_products','menu_categories','menu_media_cleanup','restaurant_status_events',
    'restaurant_archive_events','restaurant_members','restaurant_tables'] loop
    execute format('delete from public.%I where restaurant_id=$1',name) using rid;
  end loop;
  delete from public.restaurants where id=rid;
  update public.platform_restaurant_deletions set status='media_cleanup',data_deleted_at=now() where id=j.id;
end;
$$;

create function public.claim_platform_deletion_worker(p_deletion_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; token uuid:=gen_random_uuid();
begin
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if j.id is null or j.status<>'media_cleanup' then raise exception 'A limpeza não está disponível.'; end if;
  if j.worker_token is not null and j.worker_until>now() then raise exception 'Outra limpeza está em andamento. Aguarde e retome.'; end if;
  update public.platform_restaurant_deletions set worker_token=token,worker_until=now()+interval '3 minutes' where id=j.id;
  return token;
end;
$$;
create function public.release_platform_deletion_worker(p_deletion_id uuid,p_token uuid)
returns void language sql security definer set search_path='' as $$
  update public.platform_restaurant_deletions set worker_token=null,worker_until=null
  where id=p_deletion_id and worker_token=p_token;
$$;

create function public.record_platform_deletion_media_removed(p_deletion_id uuid,p_file_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype; f public.platform_backup_files%rowtype;
begin
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if not found or j.status not in ('media_cleanup','completed') then raise exception 'Conclua a exclusão dos dados primeiro.'; end if;
  if p_token is null or j.worker_until is null or j.worker_token is distinct from p_token or j.worker_until<=now() then raise exception 'A reserva de limpeza expirou. Retome a operação.'; end if;
  select * into f from public.platform_backup_files where id=p_file_id and backup_id=j.backup_id and source_kind='storage';
  if not found then raise exception 'Mídia não pertence ao backup desta exclusão.'; end if;
  if exists(select 1 from storage.objects where bucket_id=f.source_bucket and name=f.source_path) then
    raise exception 'O Storage ainda registra esta mídia. Retome a limpeza.';
  end if;
  update public.platform_deletion_checks set removed_at=now() where deletion_id=j.id and file_key=f.id::text;
  if not found then raise exception 'A mídia não foi verificada antes da exclusão.'; end if;
end;
$$;

create function public.finish_platform_restaurant_deletion(p_deletion_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare j public.platform_restaurant_deletions%rowtype;
begin
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if j.status='completed' then return; end if;
  if j.id is null or j.status<>'media_cleanup' then raise exception 'Exclusão ainda não está em limpeza.'; end if;
  if j.worker_token is not null and j.worker_until>now() then raise exception 'Aguarde a limpeza em andamento antes de concluir.'; end if;
  if exists(select 1 from public.restaurants where id=j.source_restaurant_id) then raise exception 'Restaurante ainda existe.'; end if;
  if exists(select 1 from public.platform_backup_files f where f.backup_id=j.backup_id and f.source_kind='storage'
    and not exists(select 1 from public.platform_deletion_checks c where c.deletion_id=j.id and c.file_key=f.id::text and c.removed_at is not null))
    or exists(select 1 from storage.objects where bucket_id in ('menu-images','menu-videos','restaurant-images')
      and split_part(name,'/',1)=j.source_restaurant_id::text) then
    raise exception 'Ainda existem mídias pendentes. Retome a limpeza; arquivos inesperados precisam ser conferidos.';
  end if;
  update public.platform_restaurant_deletions set status='completed',completed_at=now() where id=j.id;
end;
$$;

revoke all on function public.get_platform_restaurant_deletion(uuid),public.list_platform_restaurant_deletions(),
 public.start_platform_restaurant_deletion(uuid,uuid,uuid,text,text,boolean),public.cancel_platform_restaurant_deletion(uuid)
 from public,anon,authenticated;
grant execute on function public.get_platform_restaurant_deletion(uuid),public.list_platform_restaurant_deletions(),
 public.start_platform_restaurant_deletion(uuid,uuid,uuid,text,text,boolean),public.cancel_platform_restaurant_deletion(uuid)
 to authenticated;
revoke all on function public.record_platform_deletion_check(uuid,text,text),public.delete_platform_restaurant_data(uuid,uuid),
 public.record_platform_deletion_media_removed(uuid,uuid,uuid),public.finish_platform_restaurant_deletion(uuid),
 public.claim_platform_deletion_worker(uuid),public.release_platform_deletion_worker(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.record_platform_deletion_check(uuid,text,text),public.delete_platform_restaurant_data(uuid,uuid),
 public.record_platform_deletion_media_removed(uuid,uuid,uuid),public.finish_platform_restaurant_deletion(uuid),
 public.claim_platform_deletion_worker(uuid),public.release_platform_deletion_worker(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
