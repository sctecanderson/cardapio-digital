begin;
alter table public.restaurants
 add column logo jsonb,
 add column cover jsonb,
 add column theme_primary text not null default '#B9472B',
 add column theme_background text not null default '#FFF8EF',
 add column theme_text text not null default '#2B1D17',
 add column description text not null default '',
 add column address text not null default '',
 add column phone text not null default '',
 add column opening_hours text not null default '',
 add column revision integer not null default 1,
 add constraint restaurants_theme_format check(theme_primary ~ '^#[0-9A-Fa-f]{6}$' and theme_background ~ '^#[0-9A-Fa-f]{6}$' and theme_text ~ '^#[0-9A-Fa-f]{6}$');
update public.restaurants set theme_primary='#8B252A',theme_text='#25201D' where slug='brasa';
create trigger restaurants_revision before update on public.restaurants
 for each row execute function public.bump_catalog_revision();
alter table public.restaurant_tables add column label text not null default '', add column revision integer not null default 1;
create trigger restaurant_tables_revision before update on public.restaurant_tables
 for each row execute function public.bump_catalog_revision();

-- Apenas informações públicas são armazenadas em restaurants.
create function public.get_public_restaurant(p_slug text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'slug',r.slug,'name',r.name,'subtitle',coalesce(r.subtitle,''),
 'logo',r.logo,'cover',r.cover,'theme',jsonb_build_object('primary',r.theme_primary,'background',r.theme_background,'text',r.theme_text),
 'description',r.description,'address',r.address,'phone',r.phone,'openingHours',r.opening_hours,'revision',r.revision)
 from public.restaurants r where r.slug=p_slug and r.active;
$$;
revoke all on function public.get_public_restaurant(text) from public,anon,authenticated;
grant execute on function public.get_public_restaurant(text) to anon,authenticated;

create function public.hex_luminance(p_hex text) returns numeric language plpgsql immutable set search_path='' as $$
declare b bytea; c numeric; result numeric:=0; i integer;
begin
 if p_hex is null or p_hex !~ '^#[0-9A-Fa-f]{6}$' then return null; end if;
 b:=decode(substring(p_hex from 2),'hex');
 for i in 0..2 loop
 c:=get_byte(b,i)::numeric/255;
 c:=case when c<=0.04045 then c/12.92 else power((c+0.055)/1.055,2.4) end;
 result:=result+c*(case i when 0 then 0.2126 when 1 then 0.7152 else 0.0722 end);
 end loop;
 return result;
end; $$;
revoke all on function public.hex_luminance(text) from public,anon,authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('restaurant-images','restaurant-images',true,2097152,array['image/webp'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create function public.can_manage_restaurant_media(p_name text) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
 and p_name ~ '^[0-9a-f-]{36}/identity/[0-9a-f-]{36}\.webp$'
 and exists(select 1 from public.restaurant_members m join public.restaurants r on r.id=m.restaurant_id
 where m.user_id=auth.uid() and m.active and m.role='admin' and r.active and r.id::text=split_part(p_name,'/',1));
$$;
revoke all on function public.can_manage_restaurant_media(text) from public,anon,authenticated;
grant execute on function public.can_manage_restaurant_media(text) to authenticated;
create policy restaurant_images_upload_admin on storage.objects for insert to authenticated
 with check(bucket_id='restaurant-images' and public.can_manage_restaurant_media(name));
create policy restaurant_images_read_admin on storage.objects for select to authenticated
 using(bucket_id='restaurant-images' and public.can_manage_restaurant_media(name));

create function public.save_restaurant_identity(p_slug text,p_revision integer,p_values jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; old_row public.restaurants%rowtype; v public.restaurants%rowtype; field text; media jsonb; old_media jsonb; path text; primary_l numeric; text_l numeric; bg_l numeric;
begin
 rid:=public.require_catalog_admin(p_slug);
 select * into old_row from public.restaurants where id=rid for update;
 if p_revision is distinct from old_row.revision then raise exception using errcode='40001',message='A identidade foi alterada. Recarregue antes de editar novamente.'; end if;
 select * into v from jsonb_populate_record(null::public.restaurants,p_values);
 if v.name is null or char_length(btrim(v.name)) not between 1 and 120
 or v.subtitle is null or char_length(v.subtitle)>120
 or v.description is null or char_length(v.description)>1000
 or v.address is null or char_length(v.address)>300
 or v.phone is null or char_length(v.phone)>40
 or v.opening_hours is null or char_length(v.opening_hours)>500 then
 raise exception using errcode='22023',message='Confira os dados e os limites dos campos.'; end if;
 primary_l:=public.hex_luminance(v.theme_primary); bg_l:=public.hex_luminance(v.theme_background); text_l:=public.hex_luminance(v.theme_text);
 if primary_l is null or bg_l is null or text_l is null or 1.05/(primary_l+0.05)<4.5
 or (greatest(bg_l,text_l)+0.05)/(least(bg_l,text_l)+0.05)<4.5 or 1.05/(text_l+0.05)<4.5 then
 raise exception using errcode='22023',message='Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.'; end if;
 foreach field in array array['logo','cover'] loop
 if not(p_values ? field) then raise exception using errcode='22023',message='Informe logo e capa.'; end if;
 media:=p_values->field;old_media:=case field when 'logo' then old_row.logo else old_row.cover end;
 if media is not null and media<>'null'::jsonb then
 path:=media->>'storagePath';
 if jsonb_typeof(media) is distinct from 'object' or path is null
 or path !~ ('^'||rid::text||'/identity/[0-9a-f-]{36}\.webp$')
 or jsonb_typeof(media->'url') is distinct from 'string'
 or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
 or right(media->>'url',char_length(path)+1)<>'/'||path then
 raise exception using errcode='22023',message='Envie logo e capa pelo painel deste restaurante.'; end if;
 perform id from storage.objects where bucket_id='restaurant-images' and name=path for share;
 if not found then raise exception using errcode='22023',message='A imagem ainda não foi enviada.'; end if;
 media:=jsonb_build_object('url',media->>'url','storagePath',path);
 end if;
 if field='logo' then v.logo:=nullif(media,'null'::jsonb); else v.cover:=nullif(media,'null'::jsonb); end if;
 end loop;
 update public.restaurants set name=btrim(v.name),subtitle=btrim(v.subtitle),description=btrim(v.description),
 address=btrim(v.address),phone=btrim(v.phone),opening_hours=btrim(v.opening_hours),
 theme_primary=upper(v.theme_primary),theme_background=upper(v.theme_background),theme_text=upper(v.theme_text),logo=v.logo,cover=v.cover where id=rid;
 return public.get_public_restaurant(p_slug);
end; $$;
revoke all on function public.save_restaurant_identity(text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_restaurant_identity(text,integer,jsonb) to authenticated;

create function public.get_admin_tables(p_slug text) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 rid:=public.require_catalog_admin(p_slug);
 return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'tableNumber',t.table_number,'label',t.label,'active',t.active,'revision',t.revision,
 'visitId',v.id,'tabCount',(select count(*) from public.table_tabs tab where tab.table_visit_id=v.id and tab.status='open'),
 'totalInCents',coalesce((select sum(i.line_total_in_cents) from public.table_tab_items i where i.table_visit_id=v.id and i.status='active'),0),
 'billPending',exists(select 1 from public.service_requests sr where sr.table_visit_id=v.id and sr.request_type='bill' and sr.status='pending')) order by t.table_number)
 from public.restaurant_tables t left join public.table_visits v on v.restaurant_table_id=t.id and v.status='open' where t.restaurant_id=rid),'[]'::jsonb);
end; $$;
create function public.save_restaurant_table(p_slug text,p_id uuid,p_revision integer,p_number integer,p_label text,p_active boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid; old_row public.restaurant_tables%rowtype;
begin
 rid:=public.require_catalog_admin(p_slug);
 if p_id is null or p_revision is null or p_revision<0 or p_number is null or p_number not between 1 and 999
 or p_label is null or char_length(btrim(p_label))>80 or p_active is null then
 raise exception using errcode='22023',message='Informe mesa de 1 a 999 e identificação de até 80 caracteres.'; end if;
 select * into old_row from public.restaurant_tables where id=p_id for update;
 if found then
 if old_row.restaurant_id<>rid then raise exception using errcode='42501',message='Mesa de outro restaurante.'; end if;
 if old_row.revision<>p_revision then raise exception using errcode='40001',message='Mesa alterada. Recarregue antes de editar.'; end if;
 if not p_active and exists(select 1 from public.table_visits v where v.restaurant_table_id=p_id and v.status='open') then
 raise exception using errcode='22023',message='Encerre o atendimento antes de desativar esta mesa.'; end if;
 if p_number<>old_row.table_number and exists(select 1 from public.table_visits v where v.restaurant_table_id=p_id) then
 raise exception using errcode='22023',message='Uma mesa com histórico mantém seu número. Edite a identificação ou cadastre outra mesa.'; end if;
 update public.restaurant_tables set table_number=p_number,label=btrim(p_label),active=p_active where id=p_id;
 else
 if p_revision<>0 then raise exception using errcode='22023',message='Mesa não encontrada.'; end if;
 insert into public.restaurant_tables(id,restaurant_id,table_number,label,active) values(p_id,rid,p_number,btrim(p_label),p_active);
 end if;
 return p_id;
exception when unique_violation then raise exception using errcode='22023',message='Já existe uma mesa com este número, inclusive entre as desativadas.';
end; $$;
revoke all on function public.get_admin_tables(text) from public,anon,authenticated;
revoke all on function public.save_restaurant_table(text,uuid,integer,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.get_admin_tables(text) to authenticated;
grant execute on function public.save_restaurant_table(text,uuid,integer,integer,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
