begin;

do $$
declare
  target_table text := 'table_visits';
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'A publicação supabase_realtime não foi encontrada.';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = target_table
  ) then
    execute format('alter publication supabase_realtime add table public.%I', target_table);
  end if;
end;
$$;

commit;
