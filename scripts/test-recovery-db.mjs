process.on('uncaughtException',e=>{console.error(e.message,e.where||'');process.exit(1)});
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.PGLITE_MODULE) throw new Error('Informe PGLITE_MODULE apontando para @electric-sql/pglite/dist/index.js instalado em uma pasta de testes separada.');
const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE)).href);
import { readdir,readFile } from 'node:fs/promises';
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create publication supabase_realtime; create schema auth; create schema storage; create schema extensions;
create table auth.users(id uuid primary key,is_anonymous boolean default false);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function extensions.gen_random_bytes(integer) returns bytea language sql as $$ select decode(repeat('00',$1),'hex') $$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz default now(), unique(bucket_id,name));
alter table storage.objects enable row level security;
`);
const root=resolve(import.meta.dirname,'..');
for(const name of (await readdir(root+'/supabase/migrations')).sort()){
 try{ if(name==='20261008141500_create_table_tab_consumption.sql') await db.exec(await readFile(root+'/supabase/seeds/demo_restaurants.sql','utf8')); await db.exec(await readFile(root+'/supabase/migrations/'+name,'utf8')); }
 catch(e){console.error(name,e.message); process.exit(1)}
}
console.log('All migrations compiled.');
const q=async(sql,params=[]) => (await db.query(sql,params)).rows;
const assert=(await import('node:assert/strict')).default;
const actor='10000000-0000-4000-8000-000000000001';
const guestUser='10000000-0000-4000-8000-000000000002';
const bid='20000000-0000-4000-8000-000000000001';
const mid='30000000-0000-4000-8000-000000000001';
const vid='40000000-0000-4000-8000-000000000001';
const gid='50000000-0000-4000-8000-000000000001';
const tid='60000000-0000-4000-8000-000000000001';
const item='70000000-0000-4000-8000-000000000001';
const [{id:rid}]=await q("select id from public.restaurants where slug='noma'");
const [{id:tableId}]=await q('select id from public.restaurant_tables where restaurant_id=$1 limit 1',[rid]);
const [{id:pid}]=await q('select id from public.menu_products where restaurant_id=$1 limit 1',[rid]);
await db.exec(`insert into auth.users(id) values('${actor}'),('${guestUser}');
insert into public.platform_admins(user_id) values('${actor}');
select set_config('request.jwt.claim.sub','${actor}',false);
insert into public.restaurant_members(id,restaurant_id,user_id,role) values('${mid}','${rid}','${actor}','admin');
insert into public.table_visits(id,restaurant_id,restaurant_table_id,assigned_member_id,status,opened_at,closed_at)
values('${vid}','${rid}','${tableId}','${mid}','closed',now()-interval '3 days',now()-interval '2 days');
insert into public.guest_sessions(id,restaurant_id,restaurant_table_id,user_id,table_visit_id,confirmed_by_member_id,confirmed_at,status,created_at,expires_at)
values('${gid}','${rid}','${tableId}','${guestUser}','${vid}','${mid}',now()-interval '3 days','expired',now()-interval '3 days',now()-interval '2 days');
begin;
alter table public.table_tabs disable trigger table_tabs_validate_write;
alter table public.table_tab_guests disable trigger table_tab_guests_validate_write;
alter table public.table_tab_items disable trigger table_tab_items_validate_write;
insert into public.table_tabs(id,restaurant_id,restaurant_table_id,table_visit_id,label,status,created_by_member_id,created_at,closed_by_member_id,closed_at)
values('${tid}','${rid}','${tableId}','${vid}','Histórico','closed','${mid}',now()-interval '3 days','${mid}',now()-interval '2 days');
insert into public.table_tab_guests(guest_session_id,table_tab_id,table_visit_id,restaurant_id,restaurant_table_id,linked_by_member_id)
values('${gid}','${tid}','${vid}','${rid}','${tableId}','${mid}');
insert into public.table_tab_items(id,restaurant_id,restaurant_table_id,table_visit_id,table_tab_id,product_id,product_name,unit_price_in_cents,quantity,added_by_member_id,created_at,status,cancelled_by_member_id,cancelled_at,cancellation_reason)
values('${item}','${rid}','${tableId}','${vid}','${tid}','${pid}','Nome histórico',1234,3,'${mid}',now()-interval '3 days','cancelled','${mid}',now()-interval '2 days','Teste histórico');
alter table public.table_tabs enable trigger table_tabs_validate_write;
alter table public.table_tab_guests enable trigger table_tab_guests_validate_write;
alter table public.table_tab_items enable trigger table_tab_items_validate_write;
commit;
update public.restaurants set active=false,archived_at=now() where id='${rid}';
select public.create_platform_backup_snapshot('${rid}','${bid}');
update public.platform_restaurant_backups set status='ready',files_initialized_at=now(),completed_at=now(),snapshot_sha256=repeat('a',64),manifest_sha256=repeat('b',64) where id='${bid}';`);
await q("select set_config('request.jwt.claim.sub',$1,false)",[guestUser]);
await assert.rejects(q('select public.validate_platform_backup_recovery($1)',[bid]),/Acesso exclusivo/);
await q("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
const val=await q('select public.validate_platform_backup_recovery($1) result',[bid]);
assert.equal(val[0].result.sourceExists,true);
assert.equal(val[0].result.tableCount,22);
console.log('PASS preflight including closed tabs, expired guests, historical cancelled consumption.');
await assert.rejects(q('select public.complete_platform_backup_recovery($1,$2)',[bid,actor]),/ainda existe/);
await db.exec('set role authenticated');
await assert.rejects(q('select public.complete_platform_backup_recovery($1,$2)',[bid,actor]),/permission denied/);
await q('select public.validate_platform_backup_recovery($1)',[bid]);
await db.exec('reset role');
const original=(await q('select snapshot from public.platform_restaurant_backups where id=$1',[bid]))[0].snapshot;
const corrupt=structuredClone(original);
corrupt.tables.table_tab_items[0].line_total_in_cents=1;
await q('update public.platform_restaurant_backups set snapshot=$2 where id=$1',[bid,corrupt]);
await assert.rejects(q('select public.validate_platform_backup_recovery($1)',[bid]),/valores gerados/);
corrupt.tables.table_tab_items[0].line_total_in_cents=3702;
corrupt.tables.guest_sessions[0].user_id='99999999-9999-4999-8999-999999999999';
await q('update public.platform_restaurant_backups set snapshot=$2 where id=$1',[bid,corrupt]);
await assert.rejects(q('select public.validate_platform_backup_recovery($1)',[bid]),/Relacionamento ausente/);
await q('update public.platform_restaurant_backups set snapshot=$2 where id=$1',[bid,original]);
await db.exec('create table public.unknown_tenant_table(restaurant_id uuid)');
await assert.rejects(q('select public.validate_platform_backup_recovery($1)',[bid]),/Atualize a recuperação/);
await db.exec('drop table public.unknown_tenant_table');
const tables=['restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products','product_likes','product_like_events','product_comments','restaurant_comment_restricted_terms','product_comment_likes','table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items','service_requests','service_request_guests','guest_confirmation_codes','staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events'];
await db.exec('begin');
for(const name of ['product_comment_likes','restaurant_comment_restricted_terms','product_comments','product_like_events','product_likes','service_request_guests','service_requests','table_tab_items','table_tab_guests','table_tabs','guest_confirmation_codes','guest_sessions','staff_confirmation_limits','table_visits','menu_products','menu_categories','menu_media_cleanup','restaurant_status_events','restaurant_archive_events','restaurant_members','restaurant_tables']){
 const where=name==='guest_confirmation_codes'?`guest_session_id='${gid}'`:name==='staff_confirmation_limits'?`member_id='${mid}'`:`restaurant_id='${rid}'`;
 await db.exec(`delete from public.${name} where ${where}`);
}
await db.exec(`delete from public.restaurants where id='${rid}';commit;`);
assert.equal((await q('select public.validate_platform_backup_recovery($1) result',[bid]))[0].result.sourceExists,false);
const [{id:brasaId}]=await q("select id from public.restaurants where slug='brasa'");
await q('insert into public.restaurant_members(id,restaurant_id,user_id,role) values($1,$2,$3,$4)',[mid,brasaId,actor,'admin']);
await assert.rejects(q('select public.complete_platform_backup_recovery($1,$2)',[bid,actor]),/duplicate key/);
assert.equal((await q('select count(*)::int n from public.restaurants where id=$1',[rid]))[0].n,0);
assert.equal((await q("select count(*)::int n from pg_trigger where tgname in ('table_tabs_validate_write','table_tab_guests_validate_write','table_tab_items_validate_write') and tgenabled='O'"))[0].n,3);
await q('delete from public.restaurant_members where id=$1',[mid]);
console.log('PASS failed import rolls back every row and restores trigger configuration.');
const recovered=await q('select public.complete_platform_backup_recovery($1,$2) result',[bid,actor]);
assert.equal(recovered[0].result.archived,true);
for(const name of tables){
 const where=name==='restaurants'?`id='${rid}'`:name==='guest_confirmation_codes'?`guest_session_id='${gid}'`:name==='staff_confirmation_limits'?`member_id='${mid}'`:`restaurant_id='${rid}'`;
 const [{rows}]=await q(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from public.${name} t where ${where}`);
 assert.deepEqual(rows,[...original.tables[name]].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
assert.equal((await q('select active,archived_at from public.restaurants where id=$1',[rid]))[0].active,false);
assert.equal((await q("select count(*)::int n from public.restaurants where slug='brasa'"))[0].n,1);
assert.equal((await q('select count(*)::int n from auth.users'))[0].n,2);
assert.equal((await q('select public.complete_platform_backup_recovery($1,$2) result',[bid,actor]))[0].result.alreadyRecovered,true);
assert.equal((await q("select count(*)::int n from pg_trigger where tgname in ('table_tabs_validate_write','table_tab_guests_validate_write','table_tab_items_validate_write') and tgenabled='O'"))[0].n,3);
console.log('PASS full same-project data roundtrip, generated total, user preservation, tenant isolation and retry.');

await db.close();
