begin;

create function public.issue_guest_confirmation_code(p_guest_session_id uuid) returns public.guest_confirmation_codes language plpgsql security definer
set
    search_path = '' as $$ declare current_user_id uuid;

target_session public.guest_sessions%rowtype;

target_code public.guest_confirmation_codes%rowtype;

checked_restaurant_id uuid;

checked_table_id uuid;

checked_at timestamptz;

random_bytes bytea;

random_number integer;

generated_code text;

attempt integer;

begin current_user_id := auth.uid();

if current_user_id is null
or not coalesce(
    (auth.jwt() ->> 'is_anonymous') :: boolean,
    false
) then raise exception using errcode = '42501',
message = 'Esta operação exige uma sessão de cliente.';

end if;

select
    guest.* into target_session
from
    public.guest_sessions as guest
where
    guest.id = p_guest_session_id
    and guest.user_id = current_user_id;

if not found then raise exception using errcode = '42501',
message = 'Sessão de cliente indisponível.';

end if;

select
    restaurant.id into checked_restaurant_id
from
    public.restaurants as restaurant
where
    restaurant.id = target_session.restaurant_id
    and restaurant.active = true for share;

if checked_restaurant_id is null then raise exception using errcode = '22023',
message = 'Restaurante indisponível.';

end if;

select
    restaurant_table.id into checked_table_id
from
    public.restaurant_tables as restaurant_table
where
    restaurant_table.id = target_session.restaurant_table_id
    and restaurant_table.restaurant_id = checked_restaurant_id
    and restaurant_table.active = true for
update
;

if checked_table_id is null then raise exception using errcode = '22023',
message = 'Mesa inexistente ou indisponível.';

end if;

select
    guest.* into target_session
from
    public.guest_sessions as guest
where
    guest.id = p_guest_session_id
    and guest.user_id = current_user_id for
update
;

if not found then raise exception using errcode = '42501',
message = 'Sessão de cliente indisponível.';

end if;

checked_at := clock_timestamp();

if target_session.status <> 'pending'
or target_session.expires_at <= checked_at then raise exception using errcode = '22023',
message = 'Esta sessão não está aguardando confirmação ou expirou.';

end if;

select
    confirmation.* into target_code
from
    public.guest_confirmation_codes as confirmation
where
    confirmation.guest_session_id = target_session.id for
update
;

if found
and target_code.consumed_at is null
and target_code.expires_at > checked_at then return target_code;

end if;

for attempt in 1..20 loop random_bytes := extensions.gen_random_bytes(3);

random_number := get_byte(random_bytes, 0) * 65536 + get_byte(random_bytes, 1) * 256 + get_byte(random_bytes, 2);

-- Mantém a mesma probabilidade para todos os códigos.
if random_number >= 16000000 then continue;

end if;

generated_code := lpad(
    (random_number % 1000000) :: text,
    6,
    '0'
);

-- Evita códigos válidos iguais para clientes da mesma mesa.
if exists (
    select
        1
    from
        public.guest_confirmation_codes as confirmation
        join public.guest_sessions as guest on guest.id = confirmation.guest_session_id
    where
        guest.restaurant_table_id = checked_table_id
        and guest.id <> target_session.id
        and guest.status = 'pending'
        and guest.expires_at > checked_at
        and confirmation.code = generated_code
        and confirmation.consumed_at is null
        and confirmation.expires_at > checked_at
) then continue;

end if;

insert into
    public.guest_confirmation_codes (
        guest_session_id,
        code,
        created_at,
        expires_at,
        consumed_at
    )
values
    (
        target_session.id,
        generated_code,
        checked_at,
        least(
            checked_at + interval '10 minutes',
            target_session.expires_at
        ),
        null
    ) on conflict (guest_session_id) do
update
set
    code = excluded.code,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    consumed_at = null returning * into target_code;

return target_code;

end loop;

raise exception using errcode = '54000',
message = 'Não foi possível gerar o código. Tente novamente.';

end;

$$;

revoke all on function public.issue_guest_confirmation_code(uuid)
from
    public,
    anon,
    authenticated;

grant execute on function public.issue_guest_confirmation_code(uuid) to authenticated;

commit;