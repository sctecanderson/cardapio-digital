begin;

-- ============================================================================
-- ELOZI — BLOCO 6.3-D1
-- Publicação automática, filtros de conteúdo e curtidas em comentários
-- Timestamp da migration: 20261013100000_comment_auto_publish_filters_and_likes.sql
-- ============================================================================

-- ============================================================================
-- 1. TABELAS DE FILTROS DE CONTEÚDO (GLOBAIS DA PLATAFORMA E POR RESTAURANTE)
-- ============================================================================

-- Função utilitária para normalização determinística de texto (sem acentos, minúsculas, pontuação limpa)
create or replace function public.normalize_comment_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    regexp_replace(
      translate(
        lower(coalesce(p_text, '')),
        'áàâãäéèêëíìîïóòôõöúùûüçñýÿ',
        'aaaaaeeeeiiiiooooouuuucnyy'
      ),
      '[^a-z0-9]+', ' ', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$$;

revoke all on function public.normalize_comment_text(text) from public, anon, authenticated;
grant execute on function public.normalize_comment_text(text) to authenticated, anon;

-- Tabela global de termos ofensivos da plataforma (gerenciada exclusivamente por platform_admins)
create table if not exists public.platform_comment_restricted_terms (
  id uuid primary key default gen_random_uuid(),
  term text not null,
  normalized_term text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  constraint platform_comment_restricted_terms_unique_norm
    unique (normalized_term),
  constraint platform_comment_restricted_terms_check
    check (
      char_length(btrim(term)) between 2 and 60
      and term = btrim(term)
      and term !~ '[\x00-\x1F\x7F]'
    )
);

alter table public.platform_comment_restricted_terms enable row level security;
revoke all on public.platform_comment_restricted_terms from public, anon, authenticated;
grant select on public.platform_comment_restricted_terms to service_role;

-- Popula lista mínima inicial de termos estritamente abusivos/ofensivos da plataforma
insert into public.platform_comment_restricted_terms (term, normalized_term)
values
  ('merda', 'merda'),
  ('bosta', 'bosta'),
  ('caralho', 'caralho'),
  ('puta', 'puta'),
  ('porra', 'porra'),
  ('desgraca', 'desgraca'),
  ('vagabundo', 'vagabundo')
on conflict (normalized_term) do nothing;

-- Tabela de termos restritos configuráveis por restaurante (gerenciada por catalog_admin)
create table if not exists public.restaurant_comment_restricted_terms (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  term text not null,
  normalized_term text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint restaurant_comment_restricted_terms_restaurant_fk
    foreign key (restaurant_id)
    references public.restaurants(id)
    on delete cascade,
  constraint restaurant_comment_restricted_terms_unique_norm
    unique (restaurant_id, normalized_term),
  constraint restaurant_comment_restricted_terms_check
    check (
      char_length(btrim(term)) between 2 and 60
      and term = btrim(term)
      and term !~ '[\x00-\x1F\x7F]'
    )
);

create index if not exists restaurant_comment_restricted_terms_rest_idx
  on public.restaurant_comment_restricted_terms (restaurant_id);

alter table public.restaurant_comment_restricted_terms enable row level security;
revoke all on public.restaurant_comment_restricted_terms from public, anon, authenticated;
grant select on public.restaurant_comment_restricted_terms to service_role;

-- Função auxiliar interna para verificar se um texto contém termos restritos
create or replace function public.comment_contains_restricted_term(
  p_restaurant_id uuid,
  p_text text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  norm_comment text;
  padded_norm text;
  term_record record;
begin
  norm_comment := public.normalize_comment_text(p_text);
  if norm_comment = '' then
    return false;
  end if;
  padded_norm := ' ' || norm_comment || ' ';

  -- 1. Verifica termos da plataforma
  for term_record in
    select normalized_term
    from public.platform_comment_restricted_terms
    where active = true
  loop
    if position(' ' || term_record.normalized_term || ' ' in padded_norm) > 0 then
      return true;
    end if;
  end loop;

  -- 2. Verifica termos customizados do restaurante
  for term_record in
    select normalized_term
    from public.restaurant_comment_restricted_terms
    where restaurant_id = p_restaurant_id
  loop
    if position(' ' || term_record.normalized_term || ' ' in padded_norm) > 0 then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

revoke all on function public.comment_contains_restricted_term(uuid, text) from public, anon, authenticated;

-- ============================================================================
-- 2. TABELA DE CURTIDAS EM COMENTÁRIOS (JOINHAS REAIS COM ISOLAMENTO MULTI-TENANT)
-- ============================================================================

create table if not exists public.product_comment_likes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  comment_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint product_comment_likes_comment_fk
    foreign key (comment_id)
    references public.product_comments(id)
    on delete cascade,
  constraint product_comment_likes_restaurant_fk
    foreign key (restaurant_id)
    references public.restaurants(id)
    on delete cascade,
  constraint product_comment_likes_unique
    unique (comment_id, user_id)
);

create index if not exists product_comment_likes_comment_idx
  on public.product_comment_likes (comment_id);

create index if not exists product_comment_likes_user_restaurant_idx
  on public.product_comment_likes (user_id, restaurant_id);

alter table public.product_comment_likes enable row level security;
revoke all on public.product_comment_likes from public, anon, authenticated;
grant select on public.product_comment_likes to service_role;

-- Coluna materializada likes_count na tabela product_comments
alter table public.product_comments
  add column if not exists likes_count integer not null default 0;

alter table public.product_comments
  drop constraint if exists product_comments_likes_count_non_negative,
  add constraint product_comments_likes_count_non_negative
    check (likes_count >= 0);

-- Guarda matemática de likes_count em product_comments
create or replace function public.guard_product_comments_likes_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_likes integer;
begin
  if new.likes_count is distinct from old.likes_count then
    select count(*)::integer into actual_likes
    from public.product_comment_likes
    where comment_id = new.id;

    if new.likes_count is distinct from coalesce(actual_likes, 0) then
      raise exception using errcode = '42501',
        message = 'A contagem de curtidas do comentário é gerenciada automaticamente e deve corresponder às curtidas registradas.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_product_comments_likes_count() from public, anon, authenticated;

drop trigger if exists product_comments_guard_likes_count on public.product_comments;
create trigger product_comments_guard_likes_count
  before update of likes_count on public.product_comments
  for each row execute function public.guard_product_comments_likes_count();

-- Trigger de sincronização materializada para likes_count em product_comments
create or replace function public.sync_product_comment_likes_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform id from public.product_comments where id = new.comment_id for no key update;

    update public.product_comments
    set likes_count = (
      select count(*)::integer from public.product_comment_likes where comment_id = new.comment_id
    )
    where id = new.comment_id;
    return new;
  elsif tg_op = 'DELETE' then
    perform id from public.product_comments where id = old.comment_id for no key update;

    update public.product_comments
    set likes_count = (
      select count(*)::integer from public.product_comment_likes where comment_id = old.comment_id
    )
    where id = old.comment_id;
    return old;
  end if;
  return null;
end;
$$;

revoke all on function public.sync_product_comment_likes_count() from public, anon, authenticated;

drop trigger if exists product_comment_likes_counter_sync on public.product_comment_likes;
create trigger product_comment_likes_counter_sync
  after insert or delete on public.product_comment_likes
  for each row execute function public.sync_product_comment_likes_count();

-- Função de reconciliação de curtidas em comentários do restaurante (sem DDL)
create or replace function public.reconcile_restaurant_comment_likes_count(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_restaurant_id is null then
    raise exception using errcode = '22023', message = 'Informe o restaurante.';
  end if;

  perform id
  from public.product_comments
  where restaurant_id = p_restaurant_id
  order by id
  for no key update;

  update public.product_comments c
  set likes_count = coalesce((
    select count(*)::integer
    from public.product_comment_likes l
    where l.comment_id = c.id
  ), 0)
  where c.restaurant_id = p_restaurant_id
    and c.likes_count is distinct from coalesce((
      select count(*)::integer
      from public.product_comment_likes l
      where l.comment_id = c.id
    ), 0);
end;
$$;

revoke all on function public.reconcile_restaurant_comment_likes_count(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_restaurant_comment_likes_count(uuid) to service_role;

-- ============================================================================
-- 3. PUBLICAÇÃO AUTOMÁTICA EM create_product_comment COM DETECÇÃO DE FILTRO
-- ============================================================================

create or replace function public.create_product_comment(
  p_restaurant_slug text,
  p_product_id uuid,
  p_author_name text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  jwt_claims jsonb;
  is_anon_user boolean;
  target_restaurant_id uuid;
  target_product public.menu_products%rowtype;
  clean_author text;
  clean_body text;
  fingerprint text;
  pending_for_product integer;
  recent_window_count integer;
  inserted_comment public.product_comments%rowtype;
  has_restricted_content boolean := false;
  initial_status text;
  initial_moderated_at timestamptz := null;
  initial_moderated_by uuid := null;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception using errcode = '42501',
      message = 'Esta operação exige uma sessão de cliente.';
  end if;

  jwt_claims := coalesce(auth.jwt(), '{}'::jsonb);
  if jwt_claims ? 'is_anonymous' then
    is_anon_user := coalesce((jwt_claims->>'is_anonymous')::boolean, false);
  else
    select coalesce(u.is_anonymous, false) into is_anon_user
    from auth.users u
    where u.id = current_user_id;
  end if;

  if not coalesce(is_anon_user, false)
     or exists (select 1 from public.platform_admins pa where pa.user_id = current_user_id and pa.active)
     or exists (select 1 from public.restaurant_members rm where rm.user_id = current_user_id and rm.active) then
    raise exception using errcode = '42501',
      message = 'Apenas clientes anônimos podem enviar comentários públicos.';
  end if;

  if p_restaurant_slug is null or btrim(p_restaurant_slug) = '' or p_product_id is null then
    raise exception using errcode = '22023',
      message = 'Informe o restaurante e o produto.';
  end if;

  if p_author_name is null or p_author_name ~ '[\x00-\x1F\x7F]' then
    raise exception using errcode = '22023',
      message = 'Informe seu nome com 2 a 40 caracteres válidos.';
  end if;

  if p_body is null or p_body ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception using errcode = '22023',
      message = 'O comentário contém caracteres inválidos.';
  end if;

  clean_author := btrim(regexp_replace(p_author_name, '\s+', ' ', 'g'));
  clean_body := btrim(regexp_replace(p_body, '\s+', ' ', 'g'));

  if char_length(clean_author) not between 2 and 40 then
    raise exception using errcode = '22023',
      message = 'Informe seu nome com 2 a 40 caracteres.';
  end if;

  if char_length(clean_body) not between 3 and 280 then
    raise exception using errcode = '22023',
      message = 'O comentário deve ter entre 3 e 280 caracteres.';
  end if;

  fingerprint := md5(lower(clean_body));

  -- 1. Validar restaurante ativo e não arquivado
  select r.id into target_restaurant_id
  from public.restaurants r
  where r.slug = p_restaurant_slug
    and r.active = true
    and r.archived_at is null;

  if target_restaurant_id is null then
    raise exception using errcode = '22023',
      message = 'Restaurante indisponível.';
  end if;

  -- 2. Validar produto pertencente ao restaurante e disponível
  select * into target_product
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_restaurant_id;

  if target_product.id is null then
    raise exception using errcode = '22023',
      message = 'Produto não encontrado.';
  end if;

  if not target_product.available then
    raise exception using errcode = '22023',
      message = 'Este produto está temporariamente indisponível para comentários.';
  end if;

  -- 3. Locks transacionais por (usuário, produto) e (usuário, restaurante)
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat('comment_prod:', current_user_id::text, ':', p_product_id::text), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat('comment_rest:', current_user_id::text, ':', target_restaurant_id::text), 1)
  );

  -- 4. Cooldown por produto: 15 segundos entre envios no mesmo produto
  if exists (
    select 1
    from public.product_comments c
    where c.user_id = current_user_id
      and c.product_id = p_product_id
      and c.created_at >= clock_timestamp() - interval '15 seconds'
  ) then
    raise exception using errcode = '55000',
      message = 'Aguarde alguns segundos antes de enviar outro comentário neste prato.';
  end if;

  -- 5. Bloqueio de duplicata exata (mesmo texto normalizado nas últimas 24h no restaurante)
  if exists (
    select 1
    from public.product_comments c
    where c.user_id = current_user_id
      and c.restaurant_id = target_restaurant_id
      and c.content_fingerprint = fingerprint
      and c.status <> 'rejected'
      and c.created_at >= clock_timestamp() - interval '24 hours'
  ) then
    raise exception using errcode = '55000',
      message = 'Você já enviou este mesmo comentário recentemente.';
  end if;

  -- 6. Limite de comentários pendentes por usuário no mesmo produto (máx. 3)
  select count(*)::integer into pending_for_product
  from public.product_comments c
  where c.user_id = current_user_id
    and c.product_id = p_product_id
    and c.status = 'pending';

  if pending_for_product >= 3 then
    raise exception using errcode = '55000',
      message = 'Você já possui comentários aguardando avaliação neste prato.';
  end if;

  -- 7. Rate limit global por janela no restaurante (máx. 5 comentários a cada 10 minutos)
  select count(*)::integer into recent_window_count
  from public.product_comments c
  where c.user_id = current_user_id
    and c.restaurant_id = target_restaurant_id
    and c.created_at >= clock_timestamp() - interval '10 minutes';

  if recent_window_count >= 5 then
    raise exception using errcode = '55000',
      message = 'Muitos comentários enviados em sequência. Aguarde alguns minutos.';
  end if;

  -- 8. Confirmar estado do produto sob lock compartilhado antes de inserir
  select * into target_product
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_restaurant_id
  for key share;

  if target_product.id is null or not target_product.available then
    raise exception using errcode = '22023',
      message = 'Este produto está temporariamente indisponível para comentários.';
  end if;

  -- 9. Avaliação dos Filtros de Conteúdo:
  -- Se o nome do autor ou o corpo do comentário contiver termo restrito,
  -- o comentário nasce como 'pending' para moderação humana.
  -- Caso contrário, é aprovado automaticamente ('approved') e publicado imediatamente.
  has_restricted_content := public.comment_contains_restricted_term(target_restaurant_id, clean_author)
                         or public.comment_contains_restricted_term(target_restaurant_id, clean_body);

  if has_restricted_content then
    initial_status := 'pending';
    initial_moderated_at := null;
    initial_moderated_by := null;
  else
    initial_status := 'approved';
    initial_moderated_at := clock_timestamp();
    -- UUID especial determinístico para sinalizar aprovação automática pelo sistema
    initial_moderated_by := '00000000-0000-0000-0000-000000000001'::uuid;
  end if;

  insert into public.product_comments (
    restaurant_id,
    product_id,
    user_id,
    author_name,
    body,
    content_fingerprint,
    status,
    moderated_at,
    moderated_by
  ) values (
    target_restaurant_id,
    p_product_id,
    current_user_id,
    clean_author,
    clean_body,
    fingerprint,
    initial_status,
    initial_moderated_at,
    initial_moderated_by
  )
  returning * into inserted_comment;

  return jsonb_build_object(
    'id', inserted_comment.id,
    'productId', inserted_comment.product_id,
    'authorName', inserted_comment.author_name,
    'body', inserted_comment.body,
    'status', inserted_comment.status,
    'createdAt', inserted_comment.created_at,
    'likesCount', 0
  );
end;
$$;

revoke all on function public.create_product_comment(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_product_comment(text, uuid, text, text) to authenticated;

-- ============================================================================
-- 4. ATUALIZAÇÃO DA LEITURA PÚBLICA DE COMENTÁRIOS (INCLUIR likesCount)
-- ============================================================================

create or replace function public.get_public_product_comments(
  p_restaurant_slug text,
  p_product_id uuid,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  effective_limit integer;
  fetched_rows jsonb;
  items_json jsonb;
  has_more boolean := false;
  next_cursor jsonb := null;
  last_item jsonb;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023',
      message = 'Cursor de paginação incompleto.';
  end if;

  if p_restaurant_slug is null or p_product_id is null then
    return jsonb_build_object(
      'items', '[]'::jsonb,
      'hasMore', false,
      'nextCursor', null
    );
  end if;

  select r.id into target_restaurant_id
  from public.restaurants r
  where r.slug = p_restaurant_slug
    and r.active = true
    and r.archived_at is null;

  if target_restaurant_id is null then
    return jsonb_build_object(
      'items', '[]'::jsonb,
      'hasMore', false,
      'nextCursor', null
    );
  end if;

  if not exists (
    select 1
    from public.menu_products p
    join public.menu_categories c
      on c.id = p.category_id and c.restaurant_id = p.restaurant_id
    where p.id = p_product_id
      and p.restaurant_id = target_restaurant_id
      and c.active = true
  ) then
    return jsonb_build_object(
      'items', '[]'::jsonb,
      'hasMore', false,
      'nextCursor', null
    );
  end if;

  effective_limit := least(greatest(coalesce(p_limit, 15), 1), 30);

  select coalesce(jsonb_agg(row_obj), '[]'::jsonb) into fetched_rows
  from (
    select jsonb_build_object(
      'id', c.id,
      'productId', c.product_id,
      'authorName', c.author_name,
      'body', c.body,
      'createdAt', c.created_at,
      'likesCount', coalesce(c.likes_count, 0)
    ) as row_obj
    from public.product_comments c
    where c.restaurant_id = target_restaurant_id
      and c.product_id = p_product_id
      and c.status = 'approved'
      and (
        p_cursor_created_at is null
        or (c.created_at, c.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by c.created_at desc, c.id desc
    limit effective_limit + 1
  ) sub;

  if jsonb_array_length(fetched_rows) > effective_limit then
    has_more := true;
    select coalesce(jsonb_agg(elem), '[]'::jsonb) into items_json
    from (
      select elem
      from jsonb_array_elements(fetched_rows) with ordinality as t(elem, ord)
      where ord <= effective_limit
      order by ord
    ) limited;
    last_item := items_json->(effective_limit - 1);
    next_cursor := jsonb_build_object(
      'createdAt', last_item->>'createdAt',
      'id', last_item->>'id'
    );
  else
    items_json := fetched_rows;
  end if;

  return jsonb_build_object(
    'items', coalesce(items_json, '[]'::jsonb),
    'hasMore', has_more,
    'nextCursor', next_cursor
  );
end;
$$;

revoke all on function public.get_public_product_comments(text, uuid, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_public_product_comments(text, uuid, timestamptz, uuid, integer) to anon, authenticated;

-- ============================================================================
-- 5. RPCS PARA CURTIDAS EM COMENTÁRIOS (TOGGLE E CONSULTA DE CURTIDAS DO CLIENTE)
-- ============================================================================

create or replace function public.toggle_product_comment_like(
  p_restaurant_slug text,
  p_comment_id uuid,
  p_liked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_comment public.product_comments%rowtype;
  current_liked boolean;
  updated_likes_count integer;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception using errcode = '42501',
      message = 'Esta operação exige uma sessão de cliente.';
  end if;

  if p_restaurant_slug is null or p_comment_id is null or p_liked is null then
    raise exception using errcode = '22023',
      message = 'Informe o restaurante, o comentário e a ação de curtida.';
  end if;

  select r.id into target_restaurant_id
  from public.restaurants r
  where r.slug = p_restaurant_slug
    and r.active = true
    and r.archived_at is null;

  if target_restaurant_id is null then
    raise exception using errcode = '22023',
      message = 'Restaurante indisponível.';
  end if;

  select * into target_comment
  from public.product_comments
  where id = p_comment_id
    and restaurant_id = target_restaurant_id;

  if target_comment.id is null then
    raise exception using errcode = '22023',
      message = 'Comentário não encontrado.';
  end if;

  -- Comentários não aprovados não podem receber curtidas públicas
  if target_comment.status <> 'approved' then
    raise exception using errcode = '22023',
      message = 'Apenas comentários aprovados podem receber curtidas.';
  end if;

  -- Advisory lock determinístico por (usuário, comentário)
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat('comm_like:', current_user_id::text, ':', p_comment_id::text), 0)
  );

  select exists(
    select 1
    from public.product_comment_likes
    where comment_id = p_comment_id
      and user_id = current_user_id
  ) into current_liked;

  -- Idempotência: ação coincide com o estado atual
  if current_liked = p_liked then
    select likes_count into updated_likes_count
    from public.product_comments
    where id = p_comment_id;

    return jsonb_build_object(
      'commentId', p_comment_id,
      'liked', current_liked,
      'likesCount', coalesce(updated_likes_count, 0)
    );
  end if;

  if p_liked then
    insert into public.product_comment_likes (
      restaurant_id,
      comment_id,
      user_id
    ) values (
      target_restaurant_id,
      p_comment_id,
      current_user_id
    ) on conflict (comment_id, user_id) do nothing;
  else
    delete from public.product_comment_likes
    where comment_id = p_comment_id
      and user_id = current_user_id;
  end if;

  select likes_count into updated_likes_count
  from public.product_comments
  where id = p_comment_id;

  return jsonb_build_object(
    'commentId', p_comment_id,
    'liked', p_liked,
    'likesCount', coalesce(updated_likes_count, 0)
  );
end;
$$;

revoke all on function public.toggle_product_comment_like(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.toggle_product_comment_like(text, uuid, boolean) to authenticated;

-- Consulta pública das curtidas do próprio visitante nos comentários do restaurante
create or replace function public.get_my_product_comment_likes(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null or p_restaurant_slug is null then
    return '[]'::jsonb;
  end if;

  select id into target_restaurant_id
  from public.restaurants
  where slug = p_restaurant_slug
    and active = true
    and archived_at is null;

  if target_restaurant_id is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(l.comment_id order by l.created_at)
    from public.product_comment_likes l
    where l.restaurant_id = target_restaurant_id
      and l.user_id = current_user_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_my_product_comment_likes(text) from public, anon, authenticated;
grant execute on function public.get_my_product_comment_likes(text) to anon, authenticated;

-- ============================================================================
-- 6. RPCS ADMINISTRATIVAS (GESTÃO DE TERMOS E EXCLUSÃO DEFINITIVA DE COMENTÁRIOS)
-- ============================================================================

-- Listagem dos termos restritos do restaurante
create or replace function public.list_restaurant_comment_restricted_terms(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
begin
  target_restaurant_id := public.require_catalog_admin(p_restaurant_slug);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'term', t.term,
      'normalizedTerm', t.normalized_term,
      'createdAt', t.created_at
    ) order by t.term)
    from public.restaurant_comment_restricted_terms t
    where t.restaurant_id = target_restaurant_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_restaurant_comment_restricted_terms(text) from public, anon, authenticated;
grant execute on function public.list_restaurant_comment_restricted_terms(text) to authenticated;

-- Adição de termo restrito no restaurante
create or replace function public.add_restaurant_comment_restricted_term(
  p_restaurant_slug text,
  p_term text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  clean_term text;
  norm_term text;
  inserted_row public.restaurant_comment_restricted_terms%rowtype;
begin
  target_restaurant_id := public.require_catalog_admin(p_restaurant_slug);

  if p_term is null or p_term ~ '[\x00-\x1F\x7F]' then
    raise exception using errcode = '22023',
      message = 'Informe um termo válido com 2 a 60 caracteres.';
  end if;

  clean_term := btrim(regexp_replace(p_term, '\s+', ' ', 'g'));
  if char_length(clean_term) not between 2 and 60 then
    raise exception using errcode = '22023',
      message = 'O termo deve ter entre 2 e 60 caracteres.';
  end if;

  norm_term := public.normalize_comment_text(clean_term);
  if char_length(norm_term) < 2 then
    raise exception using errcode = '22023',
      message = 'O termo normalizado deve ter no mínimo 2 caracteres.';
  end if;

  insert into public.restaurant_comment_restricted_terms (
    restaurant_id,
    term,
    normalized_term
  ) values (
    target_restaurant_id,
    clean_term,
    norm_term
  )
  on conflict (restaurant_id, normalized_term) do nothing
  returning * into inserted_row;

  if inserted_row.id is null then
    select * into inserted_row
    from public.restaurant_comment_restricted_terms
    where restaurant_id = target_restaurant_id
      and normalized_term = norm_term;
  end if;

  return jsonb_build_object(
    'id', inserted_row.id,
    'term', inserted_row.term,
    'normalizedTerm', inserted_row.normalized_term,
    'createdAt', inserted_row.created_at
  );
end;
$$;

revoke all on function public.add_restaurant_comment_restricted_term(text, text) from public, anon, authenticated;
grant execute on function public.add_restaurant_comment_restricted_term(text, text) to authenticated;

-- Remoção de termo restrito do restaurante
create or replace function public.remove_restaurant_comment_restricted_term(
  p_restaurant_slug text,
  p_term_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  deleted_count integer;
begin
  target_restaurant_id := public.require_catalog_admin(p_restaurant_slug);

  if p_term_id is null then
    raise exception using errcode = '22023',
      message = 'Informe o termo a ser removido.';
  end if;

  delete from public.restaurant_comment_restricted_terms
  where id = p_term_id
    and restaurant_id = target_restaurant_id;

  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    raise exception using errcode = '42501',
      message = 'Termo restrito não encontrado neste restaurante.';
  end if;

  return jsonb_build_object('success', true, 'termId', p_term_id);
end;
$$;

revoke all on function public.remove_restaurant_comment_restricted_term(text, uuid) from public, anon, authenticated;
grant execute on function public.remove_restaurant_comment_restricted_term(text, uuid) to authenticated;

-- Atualização de list_admin_product_comments para incluir likesCount
create or replace function public.list_admin_product_comments(
  p_restaurant_slug text,
  p_status text default null,
  p_product_id uuid default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  effective_limit integer;
  fetched_rows jsonb;
  items_json jsonb;
  has_more boolean := false;
  next_cursor jsonb := null;
  last_item jsonb;
  counts_json jsonb;
begin
  target_restaurant_id := public.require_catalog_admin(p_restaurant_slug);

  if p_status is not null and p_status not in ('pending', 'approved', 'hidden', 'rejected') then
    raise exception using errcode = '22023',
      message = 'Filtro de status inválido.';
  end if;

  if p_product_id is not null and not exists (
    select 1 from public.menu_products p
    where p.id = p_product_id and p.restaurant_id = target_restaurant_id
  ) then
    raise exception using errcode = '22023',
      message = 'Produto não pertence a este restaurante.';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023',
      message = 'Cursor de paginação incompleto.';
  end if;

  effective_limit := least(greatest(coalesce(p_limit, 25), 1), 50);

  select coalesce(jsonb_agg(row_obj), '[]'::jsonb) into fetched_rows
  from (
    select jsonb_build_object(
      'id', c.id,
      'productId', c.product_id,
      'productName', p.name,
      'authorName', c.author_name,
      'body', c.body,
      'status', c.status,
      'createdAt', c.created_at,
      'moderatedAt', c.moderated_at,
      'moderatedBy', c.moderated_by,
      'likesCount', coalesce(c.likes_count, 0)
    ) as row_obj
    from public.product_comments c
    join public.menu_products p
      on p.id = c.product_id and p.restaurant_id = c.restaurant_id
    where c.restaurant_id = target_restaurant_id
      and (p_status is null or c.status = p_status)
      and (p_product_id is null or c.product_id = p_product_id)
      and (
        p_cursor_created_at is null
        or (c.created_at, c.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by c.created_at desc, c.id desc
    limit effective_limit + 1
  ) sub;

  if jsonb_array_length(fetched_rows) > effective_limit then
    has_more := true;
    select coalesce(jsonb_agg(elem), '[]'::jsonb) into items_json
    from (
      select elem
      from jsonb_array_elements(fetched_rows) with ordinality as t(elem, ord)
      where ord <= effective_limit
      order by ord
    ) limited;
    last_item := items_json->(effective_limit - 1);
    next_cursor := jsonb_build_object(
      'createdAt', last_item->>'createdAt',
      'id', last_item->>'id'
    );
  else
    items_json := fetched_rows;
  end if;

  select jsonb_build_object(
    'pending', coalesce(sum(case when c.status = 'pending' then 1 else 0 end), 0),
    'approved', coalesce(sum(case when c.status = 'approved' then 1 else 0 end), 0),
    'hidden', coalesce(sum(case when c.status = 'hidden' then 1 else 0 end), 0),
    'rejected', coalesce(sum(case when c.status = 'rejected' then 1 else 0 end), 0),
    'total', count(*)::integer
  ) into counts_json
  from public.product_comments c
  where c.restaurant_id = target_restaurant_id
    and (p_product_id is null or c.product_id = p_product_id);

  return jsonb_build_object(
    'items', coalesce(items_json, '[]'::jsonb),
    'hasMore', has_more,
    'nextCursor', next_cursor,
    'counts', counts_json
  );
end;
$$;

revoke all on function public.list_admin_product_comments(text, text, uuid, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_admin_product_comments(text, text, uuid, timestamptz, uuid, integer) to authenticated;

-- Exclusão definitiva de um comentário pelo administrador
create or replace function public.delete_admin_product_comment(
  p_restaurant_slug text,
  p_comment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  target_comment public.product_comments%rowtype;
  updated_comments_count integer;
begin
  target_restaurant_id := public.require_catalog_admin(p_restaurant_slug);

  if p_comment_id is null then
    raise exception using errcode = '22023',
      message = 'Informe o comentário a ser excluído.';
  end if;

  -- Lock ordenado: menu_products antes de product_comments para prevenir deadlocks
  select * into target_comment
  from public.product_comments
  where id = p_comment_id
    and restaurant_id = target_restaurant_id;

  if target_comment.id is null then
    raise exception using errcode = '42501',
      message = 'Comentário não encontrado neste restaurante.';
  end if;

  perform id
  from public.menu_products
  where id = target_comment.product_id
    and restaurant_id = target_restaurant_id
  for no key update;

  perform id
  from public.product_comments
  where id = p_comment_id
    and restaurant_id = target_restaurant_id
  for update;

  -- Exclui o comentário (FK cascade remove automaticamente as linhas de product_comment_likes)
  -- e aciona trigger product_comments_counter_sync se o comentário era 'approved'
  delete from public.product_comments
  where id = p_comment_id
    and restaurant_id = target_restaurant_id;

  select comments_count into updated_comments_count
  from public.menu_products
  where id = target_comment.product_id;

  return jsonb_build_object(
    'id', target_comment.id,
    'productId', target_comment.product_id,
    'deleted', true,
    'commentsCount', coalesce(updated_comments_count, 0)
  );
end;
$$;

revoke all on function public.delete_admin_product_comment(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_admin_product_comment(text, uuid) to authenticated;

-- ============================================================================
-- 7. BACKUPS v4: RETROCOMPATIBILIDADE COM v1, v2 E v3
-- Versões suportadas:
-- v1 (17 tabelas): Blocos 1-5
-- v2 (19 tabelas): Bloco 6.1 (adicionou product_likes e product_like_events)
-- v3 (20 tabelas): Bloco 6.3-A (adicionou product_comments)
-- v4 (22 tabelas): Bloco 6.3-D1 (adiciona restaurant_comment_restricted_terms e product_comment_likes)
-- ============================================================================

alter table public.platform_restaurant_backups
  drop constraint if exists platform_restaurant_backups_format_version_check;

alter table public.platform_restaurant_backups
  alter column format_version set default 4,
  add constraint platform_restaurant_backups_format_version_check
    check (format_version in (1, 2, 3, 4));

-- Geração de snapshot atualizada para formato v4
create or replace function public.create_platform_backup_snapshot(
  p_restaurant_id uuid,
  p_backup_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  restaurant public.restaurants%rowtype;
  existing public.platform_restaurant_backups%rowtype;
  tenant_tables constant text[] := array[
    'restaurant_tables', 'restaurant_members', 'table_visits',
    'guest_sessions', 'service_requests', 'service_request_guests',
    'table_tabs', 'table_tab_guests', 'menu_categories', 'menu_products',
    'table_tab_items', 'menu_media_cleanup',
    'restaurant_status_events', 'restaurant_archive_events',
    'product_likes', 'product_like_events', 'product_comments',
    'restaurant_comment_restricted_terms', 'product_comment_likes'
  ];
  table_name text;
  unknown_table text;
  rows_json jsonb;
  tables_json jsonb;
  objects_json jsonb;
  references_json jsonb;
  backup_time timestamptz := clock_timestamp();
begin
  actor_id := public.require_platform_admin();

  if p_restaurant_id is null or p_backup_id is null then
    raise exception using errcode = '22023', message = 'Informe o restaurante e o identificador do backup.';
  end if;

  select * into restaurant from public.restaurants
    where id = p_restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Restaurante não encontrado.';
  end if;
  if restaurant.active or restaurant.archived_at is null then
    raise exception using errcode = '55000',
      message = 'Arquive o restaurante antes de preparar esta cópia de recuperação.';
  end if;

  select * into existing from public.platform_restaurant_backups where id = p_backup_id;
  if found then
    if existing.source_restaurant_id <> p_restaurant_id then
      raise exception using errcode = '22023', message = 'Identificador de backup já utilizado.';
    end if;
    return jsonb_build_object('id', existing.id, 'status', existing.status,
      'restaurantId', existing.source_restaurant_id, 'createdAt', existing.created_at);
  end if;

  if exists (select 1 from public.platform_restaurant_backups
    where source_restaurant_id = p_restaurant_id and status = 'snapshot_created') then
    raise exception using errcode = '55000',
      message = 'Este restaurante já possui uma cópia em preparação. Retome ou cancele a anterior.';
  end if;

  select c.relname into unknown_table
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and a.attname = 'restaurant_id' and not a.attisdropped
    and not (c.relname = any(tenant_tables))
  order by c.relname limit 1;
  if unknown_table is not null then
    raise exception using errcode = '55000',
      message = 'Atualize o exportador de backup para incluir a tabela ' || unknown_table || '.';
  end if;

  tables_json := jsonb_build_object('restaurants', jsonb_build_array(to_jsonb(restaurant)));
  foreach table_name in array tenant_tables loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), ''[]''::jsonb) '
      || 'from public.%I t where t.restaurant_id = $1', table_name
    ) into rows_json using p_restaurant_id;
    tables_json := tables_json || jsonb_build_object(table_name, rows_json);
  end loop;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.guest_session_id), '[]'::jsonb)
    into rows_json
  from public.guest_confirmation_codes c
  join public.guest_sessions g on g.id = c.guest_session_id
  where g.restaurant_id = p_restaurant_id;
  tables_json := tables_json || jsonb_build_object('guest_confirmation_codes', rows_json);

  select coalesce(jsonb_agg(to_jsonb(l) order by l.member_id), '[]'::jsonb)
    into rows_json
  from public.staff_confirmation_limits l
  join public.restaurant_members m on m.id = l.member_id
  where m.restaurant_id = p_restaurant_id;
  tables_json := tables_json || jsonb_build_object('staff_confirmation_limits', rows_json);

  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', o.bucket_id, 'path', o.name,
    'metadata', o.metadata, 'createdAt', o.created_at, 'updatedAt', o.updated_at
  ) order by o.bucket_id, o.name), '[]'::jsonb) into objects_json
  from storage.objects o
  where o.bucket_id in ('menu-images', 'menu-videos', 'restaurant-images')
    and split_part(o.name, '/', 1) = p_restaurant_id::text;

  select coalesce(jsonb_agg(entry order by entry::text), '[]'::jsonb)
    into references_json
  from (
    select jsonb_build_object('kind', 'product_image', 'ownerId', p.id, 'media', i.value) as entry
    from public.menu_products p cross join lateral jsonb_array_elements(p.images) i
    where p.restaurant_id = p_restaurant_id
    union all
    select jsonb_build_object('kind', 'product_video', 'ownerId', p.id, 'media', p.video)
    from public.menu_products p where p.restaurant_id = p_restaurant_id and p.video is not null
    union all
    select jsonb_build_object('kind', 'restaurant_logo', 'ownerId', restaurant.id, 'media', restaurant.logo)
    where restaurant.logo is not null
    union all
    select jsonb_build_object('kind', 'restaurant_cover', 'ownerId', restaurant.id, 'media', restaurant.cover)
    where restaurant.cover is not null
  ) refs;

  insert into public.platform_restaurant_backups (
    id, source_restaurant_id, source_name, source_slug, format_version,
    created_by, created_at, snapshot, storage_inventory, media_references
  ) values (
    p_backup_id, restaurant.id, restaurant.name, restaurant.slug, 4,
    actor_id, backup_time,
    jsonb_build_object(
      'format', 'elozi-restaurant-snapshot', 'version', 4,
      'restaurantId', restaurant.id, 'capturedAt', backup_time, 'tables', tables_json,
      'scope', jsonb_build_object(
        'authUsersIncluded', false,
        'platformConfigurationIncluded', false,
        'globalGuestRateLimitsIncluded', false,
        'mediaBytesIncluded', false,
        'recoveryTarget', 'same-project-existing-auth-users'
      )
    ), objects_json, references_json
  );

  return jsonb_build_object('id', p_backup_id, 'status', 'snapshot_created',
    'restaurantId', restaurant.id, 'createdAt', backup_time,
    'storageObjectCount', jsonb_array_length(objects_json),
    'mediaReferenceCount', jsonb_array_length(references_json));
end;
$$;

revoke all on function public.create_platform_backup_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_platform_backup_snapshot(uuid, uuid) to authenticated, service_role;

-- Validação e staging de recuperação compatível com v1, v2, v3 e v4
create or replace function public.stage_platform_backup_recovery(p_backup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.platform_restaurant_backups%rowtype;
  names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events','product_comments',
    'restaurant_comment_restricted_terms','product_comment_likes'
  ];
  v3_names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events','product_comments'
  ];
  v2_names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events'
  ];
  v1_names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events'
  ];
  name text; columns_sql text; columns_json jsonb; rows_json jsonb;
  canonical jsonb; expected jsonb; unknown_name text; row_count bigint; total bigint := 0;
  fk record; target text; conditions text; nonnull text; has_invalid boolean;
  root public.restaurants%rowtype;
  snap_version text;
begin
  select * into b from public.platform_restaurant_backups where id = p_backup_id;
  if not found or b.status <> 'ready' then
    raise exception using errcode='55000', message='Selecione um backup concluído.';
  end if;

  snap_version := b.snapshot->>'version';

  if b.snapshot->>'format' <> 'elozi-restaurant-snapshot'
    or snap_version not in ('1', '2', '3', '4')
    or b.format_version::text <> snap_version
    or b.snapshot->>'restaurantId' <> b.source_restaurant_id::text then
    raise exception using errcode='22023', message='Formato ou versão do snapshot inválido.';
  end if;

  if snap_version = '1' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v1_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v1: %', unknown_name;
    end if;
    foreach name in array v1_names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  elsif snap_version = '2' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v2_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v2: %', unknown_name;
    end if;
    foreach name in array v2_names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  elsif snap_version = '3' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v3_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v3: %', unknown_name;
    end if;
    foreach name in array v3_names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  else
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot: %', unknown_name;
    end if;
    foreach name in array names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  end if;

  select c.relname into unknown_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='restaurant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind in ('r','p') and not (c.relname=any(names)) limit 1;
  if unknown_name is not null then
    raise exception 'Atualize a recuperação para a tabela: %', unknown_name;
  end if;

  foreach name in array names loop
    if snap_version = '1' and name in ('product_likes', 'product_like_events', 'product_comments', 'restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    elsif snap_version = '2' and name in ('product_comments', 'restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    elsif snap_version = '3' and name in ('restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    else
      rows_json := b.snapshot->'tables'->name;
    end if;

    if rows_json is null or jsonb_typeof(rows_json) <> 'array' then
      raise exception 'Tabela ausente ou inválida no snapshot: %', name;
    end if;

    if snap_version = '1' and name = 'menu_products' then
      if exists (
        select 1 from jsonb_array_elements(rows_json) as item
        where jsonb_typeof(item) = 'object' and ((item ? 'likes_count') or (item ? 'comments_count'))
      ) then
        raise exception 'Colunas incompatíveis em menu_products para snapshot v1.';
      end if;

      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object'
             then item || jsonb_build_object('likes_count', 0, 'comments_count', 0)
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    elsif snap_version = '2' and name = 'menu_products' then
      if exists (
        select 1 from jsonb_array_elements(rows_json) as item
        where jsonb_typeof(item) = 'object' and (item ? 'comments_count')
      ) then
        raise exception 'Colunas incompatíveis em menu_products para snapshot v2.';
      end if;

      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object'
             then item || jsonb_build_object('comments_count', 0)
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    end if;

    -- Em snapshots v1, v2 ou v3, a tabela product_comments (se existente) não tinha likes_count
    if snap_version in ('1', '2', '3') and name = 'product_comments' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object' and not (item ? 'likes_count')
             then item || jsonb_build_object('likes_count', 0)
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    end if;

    select string_agg(quote_ident(a.attname),',' order by a.attnum),
      jsonb_agg(a.attname order by a.attname)
      into columns_sql, columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid=('public.'||name)::regclass and a.attnum>0 and not a.attisdropped
        and a.attgenerated='' and a.attidentity='';

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

  -- Validar em staging que likes_count de cada produto corresponde exatamente aos likes do snapshot
  if exists (
    select 1
    from pg_temp.elozi_restore_menu_products p
    where p.likes_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_likes l
      where l.product_id = p.id
    ), 0)
  ) then
    raise exception 'Contagem de curtidas inconsistente com os registros de product_likes no snapshot.';
  end if;

  -- Validar em staging que comments_count de cada produto corresponde aos comentários aprovados do snapshot
  if exists (
    select 1
    from pg_temp.elozi_restore_menu_products p
    where p.comments_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_comments c
      where c.product_id = p.id
        and c.status = 'approved'
    ), 0)
  ) then
    raise exception 'Contagem de comentários inconsistente com os registros aprovados de product_comments no snapshot.';
  end if;

  -- Validar em staging que likes_count de cada comentário corresponde às curtidas do snapshot
  if exists (
    select 1
    from pg_temp.elozi_restore_product_comments c
    where c.likes_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_comment_likes l
      where l.comment_id = c.id
    ), 0)
  ) then
    raise exception 'Contagem de curtidas do comentário inconsistente com os registros de product_comment_likes no snapshot.';
  end if;

  select * into root from pg_temp.elozi_restore_restaurants;
  if root.id<>b.source_restaurant_id or root.active or root.archived_at is null then
    raise exception 'O restaurante recuperado precisa permanecer arquivado e inativo.';
  end if;

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
    'tableCount', case
      when snap_version = '1' then cardinality(v1_names)
      when snap_version = '2' then cardinality(v2_names)
      when snap_version = '3' then cardinality(v3_names)
      else cardinality(names)
    end,
    'rowCount',total,
    'sourceExists',exists(select 1 from public.restaurants where id=root.id),
    'slugConflict',exists(select 1 from public.restaurants where slug=root.slug and id<>root.id));
end;
$$;

revoke all on function public.stage_platform_backup_recovery(uuid) from public,anon,authenticated;

-- Conclusão de recuperação com as novas tabelas e triggers
create or replace function public.complete_platform_backup_recovery(p_backup_id uuid,p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  validation jsonb; name text; columns_sql text;
  names constant text[]:=array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events','product_comments',
    'restaurant_comment_restricted_terms','product_comment_likes'
  ];
  rid uuid; trigger_table text; trigger_name text;
begin
  perform user_id from public.platform_admins where user_id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Acesso exclusivo da administração da Elozi.'; end if;
  select source_restaurant_id into rid from public.platform_restaurant_backups where id=p_backup_id and status='ready' for share;
  if rid is null then raise exception 'Backup concluído não encontrado.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  if exists(select 1 from public.platform_backup_recoveries where backup_id=p_backup_id)
    and exists(select 1 from public.restaurants where id=rid) then
    return jsonb_build_object('restaurantId',rid,'alreadyRecovered',true);
  end if;
  validation:=public.stage_platform_backup_recovery(p_backup_id);
  if (validation->>'sourceExists')::boolean or (validation->>'slugConflict')::boolean then
    raise exception using errcode='55000',message='O restaurante ou seu endereço ainda existe. A recuperação não substitui dados.';
  end if;

  lock table public.table_tabs,public.table_tab_guests,public.table_tab_items,public.product_likes,public.product_comments,public.product_comment_likes,public.menu_products in access exclusive mode;
  for trigger_table,trigger_name in values
    ('table_tabs','table_tabs_validate_write'),
    ('table_tab_guests','table_tab_guests_validate_write'),
    ('table_tab_items','table_tab_items_validate_write'),
    ('product_likes','product_likes_counter_sync'),
    ('product_comments','product_comments_counter_sync'),
    ('product_comment_likes','product_comment_likes_counter_sync')
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
  alter table public.product_likes enable trigger product_likes_counter_sync;
  alter table public.product_comments enable trigger product_comments_counter_sync;
  alter table public.product_comment_likes enable trigger product_comment_likes_counter_sync;

  -- Reconciliação determinística dos contadores pós-recuperação (sem DDL de trigger)
  perform public.reconcile_restaurant_likes_count(rid);
  perform public.reconcile_restaurant_comments_count(rid);
  perform public.reconcile_restaurant_comment_likes_count(rid);

  insert into public.platform_backup_recoveries(backup_id,source_restaurant_id,recovered_by)
    values(p_backup_id,rid,p_actor_id)
    on conflict(backup_id) do update set recovered_at=now(),recovered_by=excluded.recovered_by;
  return validation || jsonb_build_object('recovered',true,'archived',true);
end;
$$;

revoke all on function public.complete_platform_backup_recovery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_platform_backup_recovery(uuid,uuid) to service_role;

-- ============================================================================
-- 8. CICLO DE VIDA: EXCLUSÃO DEFINITIVA E VERIFICAÇÃO DE BACKUP (v1, v2, v3 e v4)
-- ============================================================================

drop trigger if exists guard_platform_deletion on public.restaurant_comment_restricted_terms;
create trigger guard_platform_deletion
  before insert or update or delete on public.restaurant_comment_restricted_terms
  for each row execute function public.guard_platform_restaurant_deletion();

drop trigger if exists guard_platform_deletion on public.product_comment_likes;
create trigger guard_platform_deletion
  before insert or update or delete on public.product_comment_likes
  for each row execute function public.guard_platform_restaurant_deletion();

create or replace function public.check_platform_deletion_backup(p_restaurant_id uuid,p_backup_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
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

  perform public.stage_platform_backup_recovery(p_backup_id);

  if b.format_version = 1 then
    if exists(select 1 from public.product_likes where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_like_events where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_comments where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.restaurant_comment_restricted_terms where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_comment_likes where restaurant_id=p_restaurant_id) then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  elsif b.format_version = 2 then
    if exists(select 1 from public.product_comments where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.restaurant_comment_restricted_terms where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_comment_likes where restaurant_id=p_restaurant_id) then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  elsif b.format_version = 3 then
    if exists(select 1 from public.restaurant_comment_restricted_terms where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_comment_likes where restaurant_id=p_restaurant_id) then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  end if;

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
    elsif name='menu_products' and b.format_version = 1 then
      if exists(
        select 1 from public.menu_products
        where restaurant_id=p_restaurant_id
          and (likes_count <> 0 or comments_count <> 0)
      ) then
        raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
      end if;
      select coalesce(
        jsonb_agg((to_jsonb(t) - 'likes_count' - 'comments_count') order by (to_jsonb(t) - 'likes_count' - 'comments_count')::text),
        '[]'::jsonb
      ) into live_rows from public.menu_products t where restaurant_id=p_restaurant_id;
    elsif name='menu_products' and b.format_version = 2 then
      if exists(
        select 1 from public.menu_products
        where restaurant_id=p_restaurant_id
          and comments_count <> 0
      ) then
        raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
      end if;
      select coalesce(
        jsonb_agg((to_jsonb(t) - 'comments_count') order by (to_jsonb(t) - 'comments_count')::text),
        '[]'::jsonb
      ) into live_rows from public.menu_products t where restaurant_id=p_restaurant_id;
    elsif name='product_comments' and b.format_version in (1, 2, 3) then
      if exists(
        select 1 from public.product_comments
        where restaurant_id=p_restaurant_id
          and likes_count <> 0
      ) then
        raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
      end if;
      select coalesce(
        jsonb_agg((to_jsonb(t) - 'likes_count') order by (to_jsonb(t) - 'likes_count')::text),
        '[]'::jsonb
      ) into live_rows from public.product_comments t where restaurant_id=p_restaurant_id;
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

create or replace function public.delete_platform_restaurant_data(p_deletion_id uuid,p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
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

  delete from public.guest_confirmation_codes c using public.guest_sessions g where c.guest_session_id=g.id and g.restaurant_id=rid;
  delete from public.staff_confirmation_limits c using public.restaurant_members m where c.member_id=m.id and m.restaurant_id=rid;

  alter table public.product_likes disable trigger product_likes_counter_sync;
  alter table public.product_comments disable trigger product_comments_counter_sync;
  alter table public.product_comment_likes disable trigger product_comment_likes_counter_sync;

  delete from public.product_comment_likes where restaurant_id=rid;
  delete from public.restaurant_comment_restricted_terms where restaurant_id=rid;
  delete from public.product_like_events where restaurant_id=rid;
  delete from public.product_likes where restaurant_id=rid;
  delete from public.product_comments where restaurant_id=rid;

  alter table public.product_likes enable trigger product_likes_counter_sync;
  alter table public.product_comments enable trigger product_comments_counter_sync;
  alter table public.product_comment_likes enable trigger product_comment_likes_counter_sync;

  foreach name in array array['service_request_guests','service_requests','table_tab_items','table_tab_guests','table_tabs',
    'guest_sessions','table_visits','menu_products','menu_categories','menu_media_cleanup','restaurant_status_events',
    'restaurant_archive_events','restaurant_members','restaurant_tables'] loop
    execute format('delete from public.%I where restaurant_id=$1',name) using rid;
  end loop;
  delete from public.restaurants where id=rid;
  update public.platform_restaurant_deletions set status='media_cleanup',data_deleted_at=now() where id=j.id;
end;
$$;

revoke all on function public.delete_platform_restaurant_data(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_platform_restaurant_data(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
