-- ============================================================================
-- ELOZI — BLOCO 18: PERSISTÊNCIA DO menu_theme E SINCRONIZAÇÃO DE RPCs
-- ============================================================================

-- 1. ADICIONAR COLUNA menu_theme EM public.restaurants
alter table public.restaurants
add column if not exists menu_theme text not null default 'classic'
check (menu_theme in ('classic', 'takeat_premium'));

-- 2. ATUALIZAR get_public_restaurant COM menuTheme e menu_theme
create or replace function public.get_public_restaurant(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'slug', r.slug,
    'name', r.name,
    'subtitle', coalesce(r.subtitle, ''),
    'logo', r.logo,
    'cover', r.cover,
    'theme', jsonb_build_object(
      'primary', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
      'background', r.theme_background,
      'text', r.theme_text
    ),
    'brandPrimaryColor', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'brand_primary_color', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'headerNameColor', coalesce(r.header_name_color, '#1c1917'),
    'header_name_color', coalesce(r.header_name_color, '#1c1917'),
    'headerSubtitleColor', coalesce(r.header_subtitle_color, '#57534e'),
    'header_subtitle_color', coalesce(r.header_subtitle_color, '#57534e'),
    'menuTheme', coalesce(r.menu_theme, 'classic'),
    'menu_theme', coalesce(r.menu_theme, 'classic'),
    'description', r.description,
    'address', r.address,
    'phone', r.phone,
    'openingHours', r.opening_hours,
    'revision', r.revision,
    'serviceFeePercent', r.service_fee_percent,
    'timezone', r.timezone,
    'googleReviewUrl', r.google_review_url,
    'subscriptionPlan', r.subscription_plan,
    'subscription_plan', r.subscription_plan,
    'maxTables', coalesce(r.max_tables, 10),
    'max_tables', coalesce(r.max_tables, 10),
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at,
    'billingStatus', public.get_restaurant_billing_status(r.subscription_expires_at),
    'billing_status', public.get_restaurant_billing_status(r.subscription_expires_at)
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- 3. ATUALIZAR save_restaurant_identity COM VALIDAÇÃO E PERSISTÊNCIA DE menu_theme
create or replace function public.save_restaurant_identity(
  p_slug text,
  p_revision integer,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurants%rowtype;
  v public.restaurants%rowtype;
  field text;
  media jsonb;
  path text;
  primary_l numeric;
  text_l numeric;
  bg_l numeric;
  v_fee numeric;
  v_tz text;
  v_google_url text;
  v_brand_primary text;
  v_header_name text;
  v_header_sub text;
  v_menu_theme text;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into old_row from public.restaurants where id = rid for update;
  if p_revision is distinct from old_row.revision then
    raise exception using errcode = '40001', message = 'A identidade foi alterada. Recarregue antes de editar novamente.';
  end if;
  select * into v from jsonb_populate_record(null::public.restaurants, p_values);
  if v.name is null or char_length(btrim(v.name)) not between 1 and 120
  or v.subtitle is null or char_length(v.subtitle) > 120
  or v.description is null or char_length(v.description) > 1000
  or v.address is null or char_length(v.address) > 300
  or v.phone is null or char_length(v.phone) > 40
  or v.opening_hours is null or char_length(v.opening_hours) > 500 then
    raise exception using errcode = '22023', message = 'Confira os dados e os limites dos campos.';
  end if;

  if p_values ? 'service_fee_percent' then
    v_fee := (p_values->>'service_fee_percent')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 30 then
      raise exception using errcode = '22023', message = 'A taxa de serviço deve estar entre 0% e 30%.';
    end if;
  else
    v_fee := old_row.service_fee_percent;
  end if;

  if p_values ? 'timezone' then
    v_tz := btrim(p_values->>'timezone');
    if v_tz is null or length(v_tz) = 0 then
      raise exception using errcode = '22023', message = 'Informe um fuso horário válido.';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_tz
    ) then
      raise exception using errcode = '22023', message = 'Fuso horário não reconhecido pelo sistema.';
    end if;
  else
    v_tz := old_row.timezone;
  end if;

  if p_values ? 'google_review_url' then
    v_google_url := nullif(btrim(p_values->>'google_review_url'), '');
    if v_google_url is not null then
      if char_length(v_google_url) not between 10 and 500
      or v_google_url !~* '^https://([a-z0-9-]+\.)*(google\.(com|com\.br)|g\.page|goo\.gl)/' then
        raise exception using errcode = '22023', message = 'Informe um link válido do Perfil da Empresa no Google (ex: https://g.page/r/.../review ou https://maps.app.goo.gl/...).';
      end if;
    end if;
  else
    v_google_url := old_row.google_review_url;
  end if;

  -- Processamento das cores da paleta
  v_brand_primary := coalesce(
    nullif(btrim(p_values->>'brand_primary_color'), ''),
    nullif(btrim(p_values->>'brandPrimaryColor'), ''),
    v.theme_primary,
    old_row.brand_primary_color,
    '#EA580C'
  );
  if v_brand_primary !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor primária da marca inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_name := coalesce(
    nullif(btrim(p_values->>'header_name_color'), ''),
    nullif(btrim(p_values->>'headerNameColor'), ''),
    old_row.header_name_color,
    '#1C1917'
  );
  if v_header_name !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do nome do restaurante inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_sub := coalesce(
    nullif(btrim(p_values->>'header_subtitle_color'), ''),
    nullif(btrim(p_values->>'headerSubtitleColor'), ''),
    old_row.header_subtitle_color,
    '#57534E'
  );
  if v_header_sub !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do complemento inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  -- Extração e validação do layout do cardápio (menu_theme)
  v_menu_theme := coalesce(
    nullif(btrim(p_values->>'menu_theme'), ''),
    nullif(btrim(p_values->>'menuTheme'), ''),
    'classic'
  );
  if v_menu_theme not in ('classic', 'takeat_premium') then
    raise exception using errcode = '22023', message = 'INVALID_MENU_THEME';
  end if;

  primary_l := public.hex_luminance(v_brand_primary);
  bg_l := public.hex_luminance(v.theme_background);
  text_l := public.hex_luminance(v.theme_text);
  if primary_l is null or bg_l is null or text_l is null or 1.05 / (primary_l + 0.05) < 4.5
  or (greatest(bg_l, text_l) + 0.05) / (least(bg_l, text_l) + 0.05) < 4.5 or 1.05 / (text_l + 0.05) < 4.5 then
    raise exception using errcode = '22023', message = 'Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.';
  end if;

  foreach field in array array['logo', 'cover'] loop
    if not (p_values ? field) then
      raise exception using errcode = '22023', message = 'Informe logo e capa.';
    end if;
    media := p_values->field;
    if media is not null and media <> 'null'::jsonb then
      path := media->>'storagePath';
      if jsonb_typeof(media) is distinct from 'object' or path is null
      or path !~ ('^' || rid::text || '/identity/[0-9a-f-]{36}\.webp$')
      or jsonb_typeof(media->'url') is distinct from 'string'
      or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
      or right(media->>'url', char_length(path) + 1) <> '/' || path then
        raise exception using errcode = '22023', message = 'Envie logo e capa pelo painel deste restaurante.';
      end if;
      perform id from storage.objects where bucket_id = 'restaurant-images' and name = path for share;
      if not found then
        raise exception using errcode = '22023', message = 'A imagem ainda não foi enviada.';
      end if;
      media := jsonb_build_object('url', media->>'url', 'storagePath', path);
    end if;
    if field = 'logo' then v.logo := nullif(media, 'null'::jsonb); else v.cover := nullif(media, 'null'::jsonb); end if;
  end loop;

  update public.restaurants set
    name = btrim(v.name),
    subtitle = btrim(v.subtitle),
    description = btrim(v.description),
    address = btrim(v.address),
    phone = btrim(v.phone),
    opening_hours = btrim(v.opening_hours),
    theme_primary = upper(v_brand_primary),
    theme_background = upper(v.theme_background),
    theme_text = upper(v.theme_text),
    brand_primary_color = upper(v_brand_primary),
    header_name_color = upper(v_header_name),
    header_subtitle_color = upper(v_header_sub),
    menu_theme = v_menu_theme,
    logo = v.logo,
    cover = v.cover,
    service_fee_percent = v_fee,
    timezone = v_tz,
    google_review_url = v_google_url
  where id = rid;

  return public.get_public_restaurant(p_slug);
end;
$$;

revoke all on function public.save_restaurant_identity(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_restaurant_identity(text, integer, jsonb) to authenticated;
