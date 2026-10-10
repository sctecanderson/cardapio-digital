begin;

-- Recuperação no mesmo projeto. Não exporta nem recria contas do Auth.
create table public.platform_backup_recoveries (
  backup_id uuid primary key references public.platform_restaurant_backups(id) on delete restrict,
  source_restaurant_id uuid not null,
  recovered_by uuid references auth.users(id) on delete set null,
  recovered_at timestamptz not null default now()
);
alter table public.platform_backup_recoveries enable row level security;
revoke all on public.platform_backup_recoveries from public, anon, authenticated;

-- Materializa uma cópia em tabelas temporárias, valida os CHECKs, índices,
-- colunas geradas e relacionamentos. Nenhuma tabela do restaurante é alterada.
create function public.stage_platform_backup_recovery(p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.platform_restaurant_backups%rowtype;
  names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events'
  ];
  name text; columns_sql text; columns_json jsonb; rows_json jsonb;
  canonical jsonb; expected jsonb; unknown_name text; row_count bigint; total bigint := 0;
  fk record; target text; conditions text; nonnull text; has_invalid boolean;
  root public.restaurants%rowtype;
begin
  select * into b from public.platform_restaurant_backups where id = p_backup_id;
  if not found or b.status <> 'ready' then
    raise exception using errcode='55000', message='Selecione um backup concluído.';
  end if;
  if b.snapshot->>'format' <> 'elozi-restaurant-snapshot'
    or b.snapshot->>'version' <> '1'
    or b.snapshot->>'restaurantId' <> b.source_restaurant_id::text then
    raise exception using errcode='22023', message='Formato do snapshot inválido.';
  end if;
  select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
    where not (key = any(names)) limit 1;
  if unknown_name is not null then
    raise exception 'Tabela não suportada no snapshot: %', unknown_name;
  end if;
  select c.relname into unknown_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='restaurant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind in ('r','p') and not (c.relname=any(names)) limit 1;
  if unknown_name is not null then
    raise exception 'Atualize a recuperação para a tabela: %', unknown_name;
  end if;
  foreach name in array names loop
    rows_json := b.snapshot->'tables'->name;
    if rows_json is null or jsonb_typeof(rows_json)<>'array' then
      raise exception 'Tabela ausente no snapshot: %', name;
    end if;
    select string_agg(quote_ident(a.attname),',' order by a.attnum),
      jsonb_agg(a.attname order by a.attname)
      into columns_sql, columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid=('public.'||name)::regclass and a.attnum>0 and not a.attisdropped
        and a.attgenerated='' and a.attidentity='';
    -- Inclui colunas geradas na comparação de formato, mas nunca no INSERT.
    select jsonb_agg(a.attname order by a.attname) into columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid=('public.'||name)::regclass and a.attnum>0 and not a.attisdropped;
    if exists(select 1 from jsonb_array_elements(rows_json) r
      where jsonb_typeof(r)<>'object' or
        (select jsonb_agg(k order by k) from jsonb_object_keys(r) k) is distinct from columns_json) then
      raise exception 'Colunas incompatíveis em %. Não é permitido omitir dados silenciosamente.', name;
    end if;
    execute format('drop table if exists pg_temp.%I', 'elozi_restore_'||name);
    execute format('create temporary table %I (like public.%I including all) on commit drop',
      'elozi_restore_'||name, name);
    execute format('insert into pg_temp.%I (%s) select %s from jsonb_populate_recordset(null::public.%I,$1)',
      'elozi_restore_'||name,columns_sql,columns_sql,name) using rows_json;
    get diagnostics row_count = row_count;
    total := total + row_count;
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb) from pg_temp.%I r',
      'elozi_restore_'||name) into canonical;
    select coalesce(jsonb_agg(r order by r::text),'[]'::jsonb) into expected from jsonb_array_elements(rows_json) r;
    if canonical is distinct from expected then
      raise exception 'Dados ou valores gerados incompatíveis em %.', name;
    end if;
    if name='restaurants' then
      if row_count<>1 then raise exception 'O snapshot deve conter um único restaurante.'; end if;
    elsif name not in ('guest_confirmation_codes','staff_confirmation_limits') then
      execute format('select exists(select 1 from pg_temp.%I where restaurant_id <> $1)',
        'elozi_restore_'||name) into has_invalid using b.source_restaurant_id;
      if has_invalid then raise exception 'Dados de outro restaurante em %.',name; end if;
    end if;
  end loop;
  select * into root from pg_temp.elozi_restore_restaurants;
  if root.id<>b.source_restaurant_id or root.active or root.archived_at is null then
    raise exception 'O restaurante recuperado precisa permanecer arquivado e inativo.';
  end if;
  -- LIKE não copia FKs. Valida todos explicitamente contra a cópia, nunca
  -- contra dados de outro restaurante. Auth permanece no projeto original.
  for fk in
    select c.*, sc.relname as source_name, tc.relname as target_name, tn.nspname as target_schema
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class sc on sc.oid=c.conrelid
    join pg_catalog.pg_namespace sn on sn.oid=sc.relnamespace
    join pg_catalog.pg_class tc on tc.oid=c.confrelid
    join pg_catalog.pg_namespace tn on tn.oid=tc.relnamespace
    where c.contype='f' and sn.nspname='public' and sc.relname=any(names)
  loop
    if fk.confmatchtype<>'s' then raise exception 'Tipo de relacionamento não suportado: %',fk.conname; end if;
    if fk.target_schema='public' and fk.target_name=any(names) then
      target:=format('pg_temp.%I','elozi_restore_'||fk.target_name);
    elsif fk.target_schema='auth' and fk.target_name='users' then
      target:='auth.users';
    else raise exception 'Relacionamento não suportado: %',fk.conname;
    end if;
    select string_agg(format('s.%I=t.%I',sa.attname,ta.attname),' and ' order by x.ord),
      string_agg(format('s.%I is not null',sa.attname),' and ' order by x.ord)
      into conditions,nonnull
      from unnest(fk.conkey,fk.confkey) with ordinality x(skey,tkey,ord)
      join pg_catalog.pg_attribute sa on sa.attrelid=fk.conrelid and sa.attnum=x.skey
      join pg_catalog.pg_attribute ta on ta.attrelid=fk.confrelid and ta.attnum=x.tkey;
    execute format('select exists(select 1 from pg_temp.%I s where %s and not exists(select 1 from %s t where %s))',
      'elozi_restore_'||fk.source_name,nonnull,target,conditions) into has_invalid;
    if has_invalid then
      raise exception 'Relacionamento ausente em %. Confira as contas do Auth e a integridade do backup.',fk.conname;
    end if;
  end loop;
  return jsonb_build_object('backupId',b.id,'restaurantId',root.id,'name',root.name,'slug',root.slug,
    'tableCount',cardinality(names),'rowCount',total,
    'sourceExists',exists(select 1 from public.restaurants where id=root.id),
    'slugConflict',exists(select 1 from public.restaurants where slug=root.slug and id<>root.id));
end;
$$;
revoke all on function public.stage_platform_backup_recovery(uuid) from public,anon,authenticated;

create function public.validate_platform_backup_recovery(p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.require_platform_admin();
  return public.stage_platform_backup_recovery(p_backup_id);
end;
$$;
revoke all on function public.validate_platform_backup_recovery(uuid) from public,anon,authenticated;
grant execute on function public.validate_platform_backup_recovery(uuid) to authenticated;

-- Somente a Edge Function pode concluir, após conferir os arquivos privados
-- e originais. Nunca acessível pelo SDK público, mesmo a um admin da plataforma.
create function public.complete_platform_backup_recovery(p_backup_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  validation jsonb; name text; columns_sql text;
  names constant text[]:=array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events'
  ];
  rid uuid; trigger_table text; trigger_name text;
begin
  perform user_id from public.platform_admins where user_id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Acesso exclusivo da administração da Elozi.'; end if;
  select source_restaurant_id into rid from public.platform_restaurant_backups where id=p_backup_id and status='ready' for share;
  if rid is null then raise exception 'Backup concluído não encontrado.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  -- Retry após resposta perdida só confirma uma recuperação já registrada.
  if exists(select 1 from public.platform_backup_recoveries where backup_id=p_backup_id)
    and exists(select 1 from public.restaurants where id=rid) then
    return jsonb_build_object('restaurantId',rid,'alreadyRecovered',true);
  end if;
  validation:=public.stage_platform_backup_recovery(p_backup_id);
  if (validation->>'sourceExists')::boolean or (validation->>'slugConflict')::boolean then
    raise exception using errcode='55000',message='O restaurante ou seu endereço ainda existe. A recuperação não substitui dados.';
  end if;
  -- As regras de atendimento normal rejeitam corretamente históricos fechados,
  -- códigos vencidos e preços antigos. Desabilita somente estas três regras
  -- dentro desta transação, com locks exclusivos. CHECKs e FKs continuam ativos.
  lock table public.table_tabs,public.table_tab_guests,public.table_tab_items in access exclusive mode;
  for trigger_table,trigger_name in values
    ('table_tabs','table_tabs_validate_write'),
    ('table_tab_guests','table_tab_guests_validate_write'),
    ('table_tab_items','table_tab_items_validate_write')
  loop
    if not exists(select 1 from pg_catalog.pg_trigger where tgrelid=('public.'||trigger_table)::regclass
      and tgname=trigger_name and tgenabled='O') then
      raise exception 'Confira a configuração do trigger % antes da recuperação.',trigger_name;
    end if;
    execute format('alter table public.%I disable trigger %I',trigger_table,trigger_name);
  end loop;
  foreach name in array names loop
    select string_agg(quote_ident(a.attname),',' order by a.attnum) into columns_sql
      from pg_catalog.pg_attribute a where a.attrelid=('public.'||name)::regclass
        and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attidentity='';
    execute format('insert into public.%I (%s) select %s from pg_temp.%I',
      name,columns_sql,columns_sql,'elozi_restore_'||name);
  end loop;
  alter table public.table_tabs enable trigger table_tabs_validate_write;
  alter table public.table_tab_guests enable trigger table_tab_guests_validate_write;
  alter table public.table_tab_items enable trigger table_tab_items_validate_write;
  insert into public.platform_backup_recoveries(backup_id,source_restaurant_id,recovered_by)
    values(p_backup_id,rid,p_actor_id)
    on conflict(backup_id) do update set recovered_at=now(),recovered_by=excluded.recovered_by;
  return validation || jsonb_build_object('recovered',true,'archived',true);
end;
$$;
revoke all on function public.complete_platform_backup_recovery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_platform_backup_recovery(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
