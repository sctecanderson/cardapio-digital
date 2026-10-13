begin;

create table public.guest_service_request_limits (
  user_id uuid primary key
    references auth.users(id) on delete cascade,

  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,

  constraint guest_service_request_limits_attempts_check
    check (attempts between 0 and 5)
);

alter table public.guest_service_request_limits
  enable row level security;

-- Somente as funções protegidas do servidor acessarão os contadores.
revoke all privileges
  on table public.guest_service_request_limits
  from public, anon, authenticated;

commit;