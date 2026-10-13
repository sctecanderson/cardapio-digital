begin;

create table public.guest_confirmation_codes (
  guest_session_id uuid primary key references public.guest_sessions(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  constraint guest_confirmation_codes_expiration_check check (
    expires_at > created_at
    and expires_at <= created_at + interval '10 minutes'
  ),
  constraint guest_confirmation_codes_consumption_check check (
    consumed_at is null
    or (
      consumed_at >= created_at
      and consumed_at < expires_at
    )
  )
);

alter table
  public.guest_confirmation_codes enable row level security;

revoke all on table public.guest_confirmation_codes
from
  public,
  anon,
  authenticated;

grant
select
  on table public.guest_confirmation_codes to authenticated;

create policy guest_confirmation_codes_read_own on public.guest_confirmation_codes for
select
  to authenticated using (
    coalesce(
      (
        select
          (auth.jwt() ->> 'is_anonymous') :: boolean
      ),
      false
    )
    and exists (
      select
        1
      from
        public.guest_sessions as guest
      where
        guest.id = guest_confirmation_codes.guest_session_id
        and guest.user_id = (
          select
            auth.uid()
        )
        and guest.status = 'pending'
        and guest.expires_at > now()
    )
    and consumed_at is null
    and expires_at > now()
  );

commit;