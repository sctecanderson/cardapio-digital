begin;

-- ============================================================================
-- 1. TABELA public.platform_settings
-- ============================================================================
create table if not exists public.platform_settings (
  id text primary key default 'default' check (id = 'default'),
  platform_name text not null default 'Elozi',
  platform_subtitle text not null default 'Administração da Plataforma',
  platform_logo_url text,
  superadmin_name text not null default 'SuperAdmin',
  superadmin_avatar_url text,
  updated_at timestamptz not null default now()
);

-- Inserir registro padrão se ainda não existir
insert into public.platform_settings (
  id,
  platform_name,
  platform_subtitle,
  platform_logo_url,
  superadmin_name,
  superadmin_avatar_url,
  updated_at
)
values (
  'default',
  'Elozi',
  'Administração da Plataforma',
  null,
  'SuperAdmin',
  null,
  now()
)
on conflict (id) do nothing;

-- ============================================================================
-- 2. RLS EM public.platform_settings
-- ============================================================================
alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read
  on public.platform_settings
  for select
  to authenticated, anon
  using (true);

drop policy if exists platform_settings_write on public.platform_settings;
create policy platform_settings_write
  on public.platform_settings
  for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ============================================================================
-- 3. RPC public.get_platform_branding()
-- ============================================================================
create or replace function public.get_platform_branding()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings record;
begin
  select *
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    return jsonb_build_object(
      'platformName', 'Elozi',
      'platformSubtitle', 'Administração da Plataforma',
      'platformLogoUrl', null,
      'superadminName', 'SuperAdmin',
      'superadminAvatarUrl', null,
      'updatedAt', now()
    );
  end if;

  return jsonb_build_object(
    'platformName', v_settings.platform_name,
    'platformSubtitle', v_settings.platform_subtitle,
    'platformLogoUrl', v_settings.platform_logo_url,
    'superadminName', v_settings.superadmin_name,
    'superadminAvatarUrl', v_settings.superadmin_avatar_url,
    'updatedAt', v_settings.updated_at
  );
end;
$$;

revoke all on function public.get_platform_branding() from public, anon, authenticated;
grant execute on function public.get_platform_branding() to authenticated, anon;

-- ============================================================================
-- 4. RPC public.update_platform_branding(...)
-- ============================================================================
create or replace function public.update_platform_branding(
  p_platform_name text default null,
  p_platform_subtitle text default null,
  p_platform_logo_url text default null,
  p_superadmin_name text default null,
  p_superadmin_avatar_url text default null,
  p_clear_logo boolean default false,
  p_clear_avatar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current record;
  v_new_name text;
  v_new_subtitle text;
  v_new_logo text;
  v_new_admin_name text;
  v_new_admin_avatar text;
  v_updated record;
begin
  perform public.require_platform_admin();

  select * into v_current
  from public.platform_settings
  where id = 'default';

  v_new_name := coalesce(nullif(btrim(p_platform_name), ''), v_current.platform_name, 'Elozi');
  v_new_subtitle := coalesce(nullif(btrim(p_platform_subtitle), ''), v_current.platform_subtitle, 'Administração da Plataforma');

  if p_clear_logo then
    v_new_logo := null;
  elsif p_platform_logo_url is not null then
    v_new_logo := p_platform_logo_url;
  else
    v_new_logo := v_current.platform_logo_url;
  end if;

  v_new_admin_name := coalesce(nullif(btrim(p_superadmin_name), ''), v_current.superadmin_name, 'SuperAdmin');

  if p_clear_avatar then
    v_new_admin_avatar := null;
  elsif p_superadmin_avatar_url is not null then
    v_new_admin_avatar := p_superadmin_avatar_url;
  else
    v_new_admin_avatar := v_current.superadmin_avatar_url;
  end if;

  insert into public.platform_settings (
    id,
    platform_name,
    platform_subtitle,
    platform_logo_url,
    superadmin_name,
    superadmin_avatar_url,
    updated_at
  )
  values (
    'default',
    v_new_name,
    v_new_subtitle,
    v_new_logo,
    v_new_admin_name,
    v_new_admin_avatar,
    now()
  )
  on conflict (id) do update
  set
    platform_name = excluded.platform_name,
    platform_subtitle = excluded.platform_subtitle,
    platform_logo_url = excluded.platform_logo_url,
    superadmin_name = excluded.superadmin_name,
    superadmin_avatar_url = excluded.superadmin_avatar_url,
    updated_at = now()
  returning * into v_updated;

  return jsonb_build_object(
    'platformName', v_updated.platform_name,
    'platformSubtitle', v_updated.platform_subtitle,
    'platformLogoUrl', v_updated.platform_logo_url,
    'superadminName', v_updated.superadmin_name,
    'superadminAvatarUrl', v_updated.superadmin_avatar_url,
    'updatedAt', v_updated.updated_at
  );
end;
$$;

revoke all on function public.update_platform_branding(text, text, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_platform_branding(text, text, text, text, text, boolean, boolean) to authenticated;

commit;
