begin;

create function public.start_guest_session(
    p_restaurant_slug text,
    p_table_number integer
) returns public.guest_sessions language plpgsql security definer
set
    search_path = '' as $$ declare current_user_id uuid;

target_restaurant_id uuid;

target_table_id uuid;

target_session public.guest_sessions%rowtype;

checked_at timestamptz;

begin current_user_id := auth.uid();

if current_user_id is null
or not coalesce(
    (auth.jwt() ->> 'is_anonymous') :: boolean,
    false
) then raise exception using errcode = '42501',
message = 'Esta operação exige uma sessão de cliente.';

end if;

if p_table_number is null
or p_table_number < 1
or p_table_number > 999 then raise exception using errcode = '22023',
message = 'Informe um número de mesa válido.';

end if;

select
    restaurant.id into target_restaurant_id
from
    public.restaurants as restaurant
where
    restaurant.slug = p_restaurant_slug
    and restaurant.active = true for share;

if target_restaurant_id is null then raise exception using errcode = '22023',
message = 'Restaurante indisponível.';

end if;

select
    restaurant_table.id into target_table_id
from
    public.restaurant_tables as restaurant_table
where
    restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and restaurant_table.active = true for
update
;

if target_table_id is null then raise exception using errcode = '22023',
message = 'Mesa inexistente ou indisponível.';

end if;

checked_at := clock_timestamp();

update
    public.guest_sessions as guest
set
    status = 'expired'
where
    guest.user_id = current_user_id
    and guest.restaurant_table_id = target_table_id
    and guest.status in ('pending', 'active')
    and guest.expires_at <= checked_at;

update
    public.guest_sessions as guest
set
    status = 'revoked'
where
    guest.user_id = current_user_id
    and guest.restaurant_table_id = target_table_id
    and guest.status = 'active'
    and not exists (
        select
            1
        from
            public.table_visits as visit
        where
            visit.id = guest.table_visit_id
            and visit.restaurant_id = guest.restaurant_id
            and visit.restaurant_table_id = guest.restaurant_table_id
            and visit.status = 'open'
    );

select
    guest.* into target_session
from
    public.guest_sessions as guest
where
    guest.user_id = current_user_id
    and guest.restaurant_table_id = target_table_id
    and guest.status in ('pending', 'active')
    and guest.expires_at > checked_at for
update
;

if found then return target_session;

end if;

insert into
    public.guest_sessions (
        restaurant_id,
        restaurant_table_id,
        user_id,
        status
    )
values
    (
        target_restaurant_id,
        target_table_id,
        current_user_id,
        'pending'
    ) returning * into target_session;

return target_session;

end;

$$;

revoke all on function public.start_guest_session(text, integer)
from
    public,
    anon,
    authenticated;

grant execute on function public.start_guest_session(text, integer) to authenticated;

commit;