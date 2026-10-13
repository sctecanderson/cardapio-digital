begin;

-- Arquivos públicos do cardápio. A escrita permanece restrita ao administrador.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
 ('menu-images','menu-images',true,2097152,array['image/webp']),
 ('menu-videos','menu-videos',true,12582912,array['video/mp4','video/webm'])
on conflict(id) do update set public=true,
 file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function public.can_manage_menu_media(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
select auth.uid() is not null
 and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
 and p_name ~ '^[0-9a-f-]{36}/products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|mp4|webm)$'
 and exists (
  select 1 from public.restaurant_members m join public.restaurants r on r.id=m.restaurant_id
  where m.user_id=auth.uid() and m.active and m.role='admin' and r.active
    and r.id::text=split_part(p_name,'/',1)
 );
$$;
revoke all on function public.can_manage_menu_media(text) from public,anon,authenticated;
grant execute on function public.can_manage_menu_media(text) to authenticated;

create policy menu_images_upload_admin on storage.objects for insert to authenticated
 with check(bucket_id='menu-images' and name ~ '\.webp$' and public.can_manage_menu_media(name));
create policy menu_videos_upload_admin on storage.objects for insert to authenticated
 with check(bucket_id='menu-videos' and name ~ '\.(mp4|webm)$' and public.can_manage_menu_media(name));
-- SELECT permite verificar um envio cuja resposta foi perdida e repetir sem duplicar arquivos.
create policy menu_media_read_admin on storage.objects for select to authenticated
 using(bucket_id in ('menu-images','menu-videos') and public.can_manage_menu_media(name));

-- Cadastro e metadados são confirmados juntos. Arquivos são enviados antes, pela API Storage.
create function public.save_menu_product_with_media(
 p_slug text,p_id uuid,p_revision integer,p_values jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 rid uuid; target public.menu_products%rowtype;
 image jsonb; normalized jsonb:='[]'::jsonb; seen text[]:=array[]::text[];
 image_id text; image_url text; image_alt text; object_path text; image_order integer:=0;
 cover_id text; video jsonb; normalized_video jsonb; video_url text; video_mime text;
 video_duration numeric;
begin
 rid:=public.require_catalog_admin(p_slug);
 -- A função anterior já aplica autorização, limites de campos e proteção de versão.
 perform public.save_menu_product(p_slug,p_id,p_revision,p_values);
 select * into target from public.menu_products where id=p_id and restaurant_id=rid for update;
 if not found then raise exception using errcode='22023',message='Produto não encontrado.'; end if;
 if not (p_values ? 'images') then
   raise exception using errcode='22023',message='Informe a galeria do produto.';
 end if;
 if jsonb_typeof(p_values->'images') is distinct from 'array' then
   raise exception using errcode='22023',message='Galeria inválida.';
 end if;
 if jsonb_array_length(p_values->'images')>6 then
   raise exception using errcode='22023',message='Use no máximo 6 fotos por produto.';
 end if;
 for image in select value from jsonb_array_elements(p_values->'images') loop
   image_id:=image->>'id'; image_url:=image->>'url'; image_alt:=image->>'alt';
   object_path:=image->>'storagePath';
   if jsonb_typeof(image) is distinct from 'object'
      or jsonb_typeof(image->'id') is distinct from 'string'
      or jsonb_typeof(image->'url') is distinct from 'string'
      or jsonb_typeof(image->'alt') is distinct from 'string'
      or char_length(image_id) not between 1 and 100 or image_id=any(seen)
      or char_length(image_url) not between 1 and 2048
      or char_length(btrim(image_alt)) not between 1 and 240 then
     raise exception using errcode='22023',message='Confira a identificação e a descrição das fotos.';
   end if;
   if object_path is not null then
     if image_id !~ '^[0-9a-f-]{36}$'
       or object_path<>rid::text||'/products/'||p_id::text||'/'||image_id||'.webp'
       or image_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/menu-images/'
       or right(image_url,char_length(object_path)+1)<>'/'||object_path then
       raise exception using errcode='22023',message='Foto fora do armazenamento deste produto.';
     end if;
     perform id from storage.objects where bucket_id='menu-images' and name=object_path for share;
     if not found then raise exception using errcode='22023',message='A foto ainda não foi enviada. Tente salvar novamente.'; end if;
   elsif not exists (
     select 1 from jsonb_array_elements(target.images) old_image
     where old_image->>'id'=image_id and old_image->>'url'=image_url
   ) then
     raise exception using errcode='22023',message='Envie a nova foto pelo formulário.';
   end if;
   seen:=array_append(seen,image_id);image_order:=image_order+1;
   normalized:=normalized||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
     'id',image_id,'url',image_url,'alt',btrim(image_alt),'sortOrder',image_order,'storagePath',object_path)));
 end loop;
 cover_id:=p_values->>'cover_image_id';
 if image_order=0 then
   if cover_id is not null and cover_id<>'' then raise exception using errcode='22023',message='A capa não pertence à galeria.'; end if;
   cover_id:=null;
 elsif cover_id is null or not (cover_id=any(seen)) then
   raise exception using errcode='22023',message='Escolha uma foto de capa.';
 end if;
 if not (p_values ? 'video') then raise exception using errcode='22023',message='Informe o estado do vídeo.'; end if;
 video:=p_values->'video';
 if video is not null and video<>'null'::jsonb then
   video_url:=video->>'url';video_mime:=video->>'mimeType';object_path:=video->>'storagePath';
   if jsonb_typeof(video) is distinct from 'object'
     or jsonb_typeof(video->'url') is distinct from 'string'
     or jsonb_typeof(video->'mimeType') is distinct from 'string'
     or video_mime not in ('video/mp4','video/webm') or char_length(video_url) not between 1 and 2048 then
     raise exception using errcode='22023',message='Vídeo inválido. Use MP4 ou WebM.';
   end if;
   if object_path is not null then
     if object_path !~ ('^'||rid::text||'/products/'||p_id::text||'/[0-9a-f-]{36}\.'||case when video_mime='video/mp4' then 'mp4' else 'webm' end||'$')
       or video_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/menu-videos/'
       or right(video_url,char_length(object_path)+1)<>'/'||object_path
       or jsonb_typeof(video->'durationSeconds') is distinct from 'number' then
       raise exception using errcode='22023',message='Vídeo fora do armazenamento deste produto.';
     end if;
     video_duration:=(video->>'durationSeconds')::numeric;
     if video_duration<=0 or video_duration>30 then
       raise exception using errcode='22023',message='O vídeo deve ter até 30 segundos.';
     end if;
     perform id from storage.objects where bucket_id='menu-videos' and name=object_path for share;
     if not found then raise exception using errcode='22023',message='O vídeo ainda não foi enviado. Tente salvar novamente.'; end if;
     normalized_video:=jsonb_build_object('url',video_url,'mimeType',video_mime,'storagePath',object_path,'durationSeconds',video_duration);
   elsif target.video is null or target.video->>'url' is distinct from video_url
     or target.video->>'mimeType' is distinct from video_mime then
     raise exception using errcode='22023',message='Envie o novo vídeo pelo formulário.';
   else
     normalized_video:=target.video;
   end if;
   if image_order=0 then raise exception using errcode='22023',message='Adicione uma foto de capa para o vídeo do Explorar.'; end if;
 end if;
 if target.images is distinct from normalized or target.cover_image_id is distinct from cover_id
   or target.video is distinct from normalized_video then
   update public.menu_products set images=normalized,cover_image_id=cover_id,video=normalized_video where id=p_id;
 end if;
 return p_id;
end;
$$;
revoke all on function public.save_menu_product_with_media(text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_menu_product_with_media(text,uuid,integer,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
