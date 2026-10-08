begin;

-- Contas autorizadas a administrar a plataforma Elozi.
create table public.platform_admins (
  user_id uuid primary key
    references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.platform_admins
  enable row level security;

-- O navegador não pode cadastrar ou promover administradores.
revoke all privileges
  on table public.platform_admins
  from public, anon, authenticated;

-- Consulta apenas a autorização da própria conta autenticada.
create function public.get_platform_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.platform_admins as administrator
      where administrator.user_id = auth.uid()
        and administrator.active = true
    );
$$;

revoke all
  on function public.get_platform_access()
  from public, anon, authenticated;

grant execute
  on function public.get_platform_access()
  to authenticated;

-- Verificação interna para as futuras operações da plataforma.
create function public.require_platform_admin()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta autorizada da Elozi.';
  end if;

  perform administrator.user_id
  from public.platform_admins as administrator
  where administrator.user_id = current_user_id
    and administrator.active = true
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Acesso exclusivo da administração da Elozi.';
  end if;

  return current_user_id;
end;
$$;

-- Esta função será chamada internamente pelas operações autorizadas.
revoke all
  on function public.require_platform_admin()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;