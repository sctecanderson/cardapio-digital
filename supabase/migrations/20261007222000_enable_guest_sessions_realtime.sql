begin;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'guest_sessions'
  ) then
    alter publication supabase_realtime
      add table public.guest_sessions;
  end if;
end;
$$;

commit;