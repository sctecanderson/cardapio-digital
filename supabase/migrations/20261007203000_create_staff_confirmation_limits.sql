begin;

create table public.staff_confirmation_limits (
  member_id uuid primary key
    references public.restaurant_members(id)
    on delete cascade,

  window_started_at timestamptz not null default now(),

  attempts integer not null default 0,

  constraint staff_confirmation_limits_attempts_check
    check (attempts between 0 and 10)
);

alter table public.staff_confirmation_limits
  enable row level security;

revoke all
on table public.staff_confirmation_limits
from public, anon, authenticated;

commit;