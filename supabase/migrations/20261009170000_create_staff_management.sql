begin;
-- Convites são credenciais temporárias, não dados de negócio recuperáveis.
-- Ficam fora dos snapshots e são apagados junto ao restaurante.
create table public.staff_invitations (
 id uuid primary key default gen_random_uuid(),
 source_restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 email text not null,
 role text not null check(role in ('admin','waiter')),
 token_hash text not null unique,
 status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default(now()+interval '48 hours'),
 accepted_by uuid references auth.users(id) on delete set null,
 accepted_at timestamptz
);
alter table public.staff_invitations enable row level security;
revoke all on public.staff_invitations from public,anon,authenticated;
create index staff_invitations_restaurant on public.staff_invitations(source_restaurant_id,created_at desc);

create function public.lock_staff_management(p_slug text) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 -- Ordem comum: restaurante, administrador, convite/membro.
 select id into rid from public.restaurants where slug=p_slug for update;
 return public.require_catalog_admin(p_slug);
end; $$;
revoke all on function public.lock_staff_management(text) from public,anon,authenticated;

create function public.get_staff_management(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; members jsonb; invites jsonb;
begin
 rid:=public.require_catalog_admin(p_slug);
 select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'userId',m.user_id,'email',u.email,
 'role',m.role,'active',m.active,'openVisits',(select count(*) from public.table_visits v where v.assigned_member_id=m.id and v.status='open')) order by u.email),'[]'::jsonb)
 into members from public.restaurant_members m join auth.users u on u.id=m.user_id where m.restaurant_id=rid;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'status',
 case when i.status='pending' and i.expires_at<=now() then 'expired' else i.status end,
 'expiresAt',i.expires_at) order by i.created_at desc),'[]'::jsonb) into invites
 from public.staff_invitations i where i.source_restaurant_id=rid;
 return jsonb_build_object('members',members,'invitations',invites);
end; $$;

create function public.create_staff_invitation(p_slug text,p_email text,p_role text,p_token text) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid; iid uuid; digest text; existing public.staff_invitations%rowtype; email_value text:=lower(btrim(p_email));
begin
 rid:=public.lock_staff_management(p_slug);
 if email_value is null or char_length(email_value)>254 or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 or p_role is null or p_role not in ('admin','waiter') or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
 raise exception using errcode='22023',message='Confira o e-mail e o perfil do convite.'; end if;
 digest:=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 select * into existing from public.staff_invitations where token_hash=digest;
 if found then
 if existing.source_restaurant_id=rid and existing.email=email_value and existing.role=p_role and existing.status='pending' and existing.expires_at>now() then return existing.id; end if;
 raise exception using errcode='22023',message='Gere um novo link para este convite.'; end if;
 if (select count(*) from public.staff_invitations where source_restaurant_id=rid and created_at>now()-interval '1 hour')>=20 then
 raise exception using errcode='55000',message='Limite de 20 convites por hora atingido. Aguarde para gerar novos links.'; end if;
 if exists(select 1 from public.restaurant_members m join auth.users u on u.id=m.user_id where m.restaurant_id=rid and lower(u.email)=email_value) then
 raise exception using errcode='22023',message='Essa conta já está vinculada. Altere o perfil ou reative pela lista da equipe.'; end if;
 update public.staff_invitations set status='revoked' where source_restaurant_id=rid and email=email_value and status='pending';
 insert into public.staff_invitations(source_restaurant_id,email,role,token_hash,created_by)
 values(rid,email_value,p_role,digest,auth.uid()) returning id into iid;
 return iid;
end; $$;

create function public.revoke_staff_invitation(p_slug text,p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 rid:=public.lock_staff_management(p_slug);
 update public.staff_invitations set status='revoked' where id=p_id and source_restaurant_id=rid and status='pending';
end; $$;

create function public.accept_staff_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare invitation public.staff_invitations%rowtype; r public.restaurants%rowtype; member public.restaurant_members%rowtype;
 uid uuid:=auth.uid(); email_value text; rid uuid;
begin
 if uid is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
 raise exception using errcode='42501',message='Entre com sua conta de funcionário para aceitar.'; end if;
 select lower(email) into email_value from auth.users where id=uid and email_confirmed_at is not null and not coalesce(is_anonymous,false);
 if email_value is null then raise exception using errcode='42501',message='Confirme seu e-mail antes de aceitar o convite.'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='Convite inválido.'; end if;
 select source_restaurant_id into rid from public.staff_invitations where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 select * into r from public.restaurants where id=rid for update;
 if not found or not r.active or r.archived_at is not null then raise exception using errcode='22023',message='Convite inválido ou restaurante indisponível.'; end if;
 select * into invitation from public.staff_invitations where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
 if invitation.email is distinct from email_value then raise exception using errcode='42501',message='Entre com o e-mail ao qual o administrador enviou este convite.'; end if;
 select * into member from public.restaurant_members where restaurant_id=rid and user_id=uid for update;
 if invitation.status='accepted' and invitation.accepted_by=uid and member.active then
 return jsonb_build_object('slug',r.slug,'role',member.role); end if;
 if invitation.status<>'pending' or invitation.expires_at<=now() then raise exception using errcode='22023',message='Convite vencido ou revogado. Solicite um novo link.'; end if;
 if not exists(select 1 from public.restaurant_members where restaurant_id=rid and user_id=invitation.created_by and role='admin' and active) then
 raise exception using errcode='42501',message='O responsável pelo convite não possui mais acesso de administrador. Solicite outro convite.'; end if;
 if member.id is not null and not member.active then raise exception using errcode='42501',message='Seu vínculo foi desativado. Peça ao administrador para reativá-lo.'; end if;
 if member.id is null then
 insert into public.restaurant_members(restaurant_id,user_id,role) values(rid,uid,invitation.role) returning * into member;
 end if;
 update public.staff_invitations set status='accepted',accepted_at=now(),accepted_by=uid where id=invitation.id;
 return jsonb_build_object('slug',r.slug,'role',member.role);
end; $$;

create function public.update_staff_member(p_slug text,p_id uuid,p_role text,p_active boolean,p_expected_role text,p_expected_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid; member public.restaurant_members%rowtype;
begin
 rid:=public.lock_staff_management(p_slug);
 if p_role is null or p_role not in ('admin','waiter') or p_active is null then raise exception using errcode='22023',message='Perfil inválido.'; end if;
 select * into member from public.restaurant_members where id=p_id and restaurant_id=rid for update;
 if not found then raise exception using errcode='22023',message='Funcionário não encontrado neste restaurante.'; end if;
 if member.role is distinct from p_expected_role or member.active is distinct from p_expected_active then
 raise exception using errcode='55000',message='O vínculo mudou. Atualize a equipe antes de tentar novamente.'; end if;
 if member.active and member.role='admin' and (not p_active or p_role<>'admin') and not exists(
 select 1 from public.restaurant_members where restaurant_id=rid and id<>member.id and active and role='admin') then
 raise exception using errcode='55000',message='Mantenha pelo menos um administrador ativo.'; end if;
 if not p_active and exists(select 1 from public.table_visits where assigned_member_id=member.id and status='open') then
 raise exception using errcode='55000',message='Transfira ou encerre os atendimentos deste funcionário antes de desativar.'; end if;
 update public.restaurant_members set role=p_role,active=p_active where id=member.id;
 if not p_active or p_role<>'admin' then
 update public.staff_invitations set status='revoked' where source_restaurant_id=rid and created_by=member.user_id and status='pending'; end if;
end; $$;

create function public.transfer_staff_visits(p_slug text,p_from uuid,p_to uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare rid uuid; total integer;
begin
 rid:=public.lock_staff_management(p_slug);
 if p_from is null or p_to is null or p_from=p_to or not exists(select 1 from public.restaurant_members where id=p_from and restaurant_id=rid)
 or not exists(select 1 from public.restaurant_members where id=p_to and restaurant_id=rid and active) then
 raise exception using errcode='22023',message='Escolha outro funcionário ativo deste restaurante.'; end if;
 update public.table_visits set assigned_member_id=p_to where restaurant_id=rid and assigned_member_id=p_from and status='open';
 get diagnostics total=row_count;
 return total;
end; $$;

create function public.revoke_unavailable_restaurant_invites() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not new.active or new.archived_at is not null then
 update public.staff_invitations set status='revoked' where source_restaurant_id=new.id and status='pending'; end if;
 return new;
end; $$;
revoke all on function public.revoke_unavailable_restaurant_invites() from public,anon,authenticated;
create trigger revoke_unavailable_invites after update of active,archived_at on public.restaurants
 for each row execute function public.revoke_unavailable_restaurant_invites();
revoke all on function public.get_staff_management(text),public.create_staff_invitation(text,text,text,text),
 public.revoke_staff_invitation(text,uuid),public.accept_staff_invitation(text),public.update_staff_member(text,uuid,text,boolean,text,boolean),
 public.transfer_staff_visits(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_staff_management(text),public.create_staff_invitation(text,text,text,text),
 public.revoke_staff_invitation(text,uuid),public.accept_staff_invitation(text),public.update_staff_member(text,uuid,text,boolean,text,boolean),
 public.transfer_staff_visits(text,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
