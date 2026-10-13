begin;
create table public.menu_media_cleanup (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id),
 bucket_id text not null check(bucket_id in ('menu-images','menu-videos','restaurant-images')),
 object_path text not null,
 first_unreferenced_at timestamptz not null default now(),
 claimed_at timestamptz,
 deleted_at timestamptz,
 unique(bucket_id,object_path)
);
alter table public.menu_media_cleanup enable row level security;
revoke all on public.menu_media_cleanup from public,anon,authenticated;

create function public.menu_media_is_referenced(p_bucket text,p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.menu_products p where
 (p_bucket='menu-images' and exists(select 1 from jsonb_array_elements(p.images) i where i->>'storagePath'=p_path or right(i->>'url',char_length(p_path)+1)='/'||p_path))
 or (p_bucket='menu-videos' and (p.video->>'storagePath'=p_path or right(p.video->>'url',char_length(p_path)+1)='/'||p_path)))
 or exists(select 1 from public.restaurants r where p_bucket='restaurant-images' and
 (r.logo->>'storagePath'=p_path or r.cover->>'storagePath'=p_path or right(r.logo->>'url',char_length(p_path)+1)='/'||p_path or right(r.cover->>'url',char_length(p_path)+1)='/'||p_path));
$$;
revoke all on function public.menu_media_is_referenced(text,text) from public,anon,authenticated;

-- A mesma trava serializa o registro de novas referências e a coleta de mídias.
-- Um arquivo já reservado para exclusão não pode ser anexado a um novo cadastro.
create function public.guard_retired_menu_media() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid; reference jsonb; refs jsonb; bucket text;
begin
 if tg_table_name='restaurants' then rid:=new.id; else rid:=new.restaurant_id; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
 if tg_table_name='restaurants' then
 refs:=jsonb_build_array(new.logo,new.cover);bucket:='restaurant-images';
 else refs:=new.images;bucket:='menu-images'; end if;
 for reference in select value from jsonb_array_elements(refs) loop
 if exists(select 1 from public.menu_media_cleanup c where c.bucket_id=bucket and c.claimed_at is not null and
 (reference->>'storagePath'=c.object_path or right(reference->>'url',char_length(c.object_path)+1)='/'||c.object_path)) then
 raise exception using errcode='22023',message='Esta imagem entrou em limpeza. Envie o arquivo novamente.'; end if;
 delete from public.menu_media_cleanup c where c.bucket_id=bucket and c.claimed_at is null and
 (reference->>'storagePath'=c.object_path or right(reference->>'url',char_length(c.object_path)+1)='/'||c.object_path);
 end loop;
 if tg_table_name='menu_products' then
 if exists(select 1 from public.menu_media_cleanup c where c.bucket_id='menu-videos' and c.claimed_at is not null and
 (new.video->>'storagePath'=c.object_path or right(new.video->>'url',char_length(c.object_path)+1)='/'||c.object_path)) then
 raise exception using errcode='22023',message='Este vídeo entrou em limpeza. Envie o arquivo novamente.'; end if;
 delete from public.menu_media_cleanup c where c.bucket_id='menu-videos' and c.claimed_at is null and
 (new.video->>'storagePath'=c.object_path or right(new.video->>'url',char_length(c.object_path)+1)='/'||c.object_path);
 end if;
 return new;
end; $$;
revoke all on function public.guard_retired_menu_media() from public,anon,authenticated;
create trigger menu_products_media_retirement before insert or update of images,video on public.menu_products for each row execute function public.guard_retired_menu_media();
create trigger restaurants_media_retirement before update of logo,cover on public.restaurants for each row execute function public.guard_retired_menu_media();

create function public.claim_unused_menu_media(p_slug text) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; marked integer; jobs jsonb; job record;
begin
 rid:=public.require_catalog_admin(p_slug);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
 -- Registra no máximo 200 arquivos por execução. Nenhum arquivo Storage é apagado por SQL.
 insert into public.menu_media_cleanup(restaurant_id,bucket_id,object_path)
 select rid,o.bucket_id,o.name from storage.objects o where o.bucket_id in ('menu-images','menu-videos','restaurant-images')
 and split_part(o.name,'/',1)=rid::text
 and (o.name ~ ('^'||rid::text||'/products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|mp4|webm)$')
 or o.name ~ ('^'||rid::text||'/identity/[0-9a-f-]{36}\.webp$'))
 and not public.menu_media_is_referenced(o.bucket_id,o.name)
 and not exists(select 1 from public.menu_media_cleanup c where c.bucket_id=o.bucket_id and c.object_path=o.name)
 order by o.created_at,o.name limit 200 on conflict do nothing;
 get diagnostics marked=row_count;
 delete from public.menu_media_cleanup c where c.restaurant_id=rid and c.claimed_at is null and public.menu_media_is_referenced(c.bucket_id,c.object_path);
 -- Revalida após o período de retenção. Reservas impedem reuso durante a chamada HTTP.
 for job in select c.id from public.menu_media_cleanup c where c.restaurant_id=rid and c.deleted_at is null
 and (c.claimed_at is not null or c.first_unreferenced_at<now()-interval '7 days')
 and not public.menu_media_is_referenced(c.bucket_id,c.object_path)
 order by c.first_unreferenced_at,c.id limit 25 for update loop
 update public.menu_media_cleanup set claimed_at=coalesce(claimed_at,now()) where id=job.id;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'bucket',c.bucket_id,'path',c.object_path) order by c.first_unreferenced_at),'[]'::jsonb)
 into jobs from (select * from public.menu_media_cleanup where restaurant_id=rid and claimed_at is not null and deleted_at is null order by first_unreferenced_at,id limit 25) c;
 return jsonb_build_object('marked',marked,'retained',(select count(*) from public.menu_media_cleanup where restaurant_id=rid and claimed_at is null),'jobs',jobs);
end; $$;
revoke all on function public.claim_unused_menu_media(text) from public,anon,authenticated;
grant execute on function public.claim_unused_menu_media(text) to authenticated;
create function public.finish_menu_media_cleanup(p_id uuid) returns void language sql security definer set search_path='' as $$
 update public.menu_media_cleanup set deleted_at=now() where id=p_id and claimed_at is not null;
$$;
revoke all on function public.finish_menu_media_cleanup(uuid) from public,anon,authenticated;
grant execute on function public.finish_menu_media_cleanup(uuid) to service_role;

create function public.menu_media_path_available(p_bucket text,p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from public.menu_media_cleanup c where c.bucket_id=p_bucket and c.object_path=p_path and c.claimed_at is not null);
$$;
revoke all on function public.menu_media_path_available(text,text) from public,anon,authenticated;
grant execute on function public.menu_media_path_available(text,text) to authenticated;
create policy menu_media_retired_no_reupload on storage.objects as restrictive for insert to authenticated
 with check(bucket_id not in ('menu-images','menu-videos','restaurant-images') or public.menu_media_path_available(bucket_id,name));
notify pgrst,'reload schema';
commit;
