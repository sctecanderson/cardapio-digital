begin;

create function public.get_guest_session(
    p_restaurant_slug text,
    p_table_number integer
) returns public.guest_sessions language sql stable security definer
set
    search_path = '' as $$
select
    guest.*
from
    public.guest_sessions as guest
    join public.restaurants as restaurant on restaurant.id = guest.restaurant_id
    join public.restaurant_tables as restaurant_table on restaurant_table.id = guest.restaurant_table_id
    and restaurant_table.restaurant_id = guest.restaurant_id
where
    guest.user_id = auth.uid()
    and coalesce(
        (auth.jwt() ->> 'is_anonymous') :: boolean,
        false
    )
    and restaurant.slug = p_restaurant_slug
    and restaurant.active = true
    and restaurant_table.table_number = p_table_number
    and restaurant_table.active = true
    and guest.status in ('pending', 'active')
    and guest.expires_at > now()
    and (
        guest.status = 'pending'
        or exists (
            select
                1
            from
                public.table_visits as visit
            where
                visit.id = guest.table_visit_id
                and visit.restaurant_id = guest.restaurant_id
                and visit.restaurant_table_id = guest.restaurant_table_id
                and visit.status = 'open'
        )
    )
order by
    guest.created_at desc
limit
    1;

$$;

revoke all on function public.get_guest_session(text, integer)
from
    public,
    anon,
    authenticated;

grant execute on function public.get_guest_session(text, integer) to authenticated;

commit;