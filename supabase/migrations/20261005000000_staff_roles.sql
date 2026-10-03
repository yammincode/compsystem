-- 第三版：工作人員帳號與角色
-- 依序執行 init → competitions_payments → 這一份。可重複執行。
--
-- 角色：
--   owner（管理員）：全部功能，包含管理工作人員帳號、刪除比賽
--   staff（工作人員）：修改比賽內容、組別、報名資料、審核繳費
-- 原本 admins 表裡的帳號都會成為 owner。

alter table public.admins add column if not exists role text not null default 'owner';
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('owner', 'staff'));
alter table public.admins add column if not exists created_at timestamptz not null default now();

-- 至少要保留一位管理員（owner），避免把自己鎖在外面
create or replace function public.admins_keep_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.admins where role = 'owner') then
    raise exception '至少要保留一位管理員';
  end if;
  return null;
end;
$$;
drop trigger if exists admins_keep_owner on public.admins;
create constraint trigger admins_keep_owner
  after update or delete on public.admins
  deferrable initially immediate
  for each row execute function public.admins_keep_owner();

-- ---------- 函式 ----------
create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid() and role = 'owner');
$$;

-- 目前登入者的角色（不是工作人員則為 null）
create or replace function public.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.admins where user_id = auth.uid();
$$;

-- 工作人員名單（工作人員都看得到）
create or replace function public.list_staff()
returns table (user_id uuid, email text, role text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '沒有權限' using errcode = '42501'; end if;
  return query
    select a.user_id, u.email::text, a.role, a.created_at, u.last_sign_in_at
      from public.admins a
      join auth.users u on u.id = a.user_id
     order by (a.role = 'owner') desc, a.created_at;
end;
$$;

-- 把已存在的帳號（Supabase Authentication 裡的使用者）加為工作人員，或修改角色
create or replace function public.add_staff(p_email text, p_role text default 'staff')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception '只有管理員可以管理工作人員' using errcode = '42501'; end if;
  if p_role not in ('owner', 'staff') then raise exception '角色不正確'; end if;
  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then raise exception '找不到這個 Email 的帳號'; end if;
  insert into public.admins (user_id, role) values (v_id, p_role)
  on conflict (user_id) do update set role = excluded.role;
  return v_id;
end;
$$;

create or replace function public.set_staff_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner() then raise exception '只有管理員可以管理工作人員' using errcode = '42501'; end if;
  if p_role not in ('owner', 'staff') then raise exception '角色不正確'; end if;
  update public.admins set role = p_role where user_id = p_user_id;
  if not found then raise exception '找不到這位工作人員'; end if;
end;
$$;

create or replace function public.remove_staff(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner() then raise exception '只有管理員可以管理工作人員' using errcode = '42501'; end if;
  if p_user_id = auth.uid() then raise exception '不能移除自己'; end if;
  delete from public.admins where user_id = p_user_id;
end;
$$;

-- 給伺服器端（Netlify Function，使用 service_role）用：依 Email 找帳號
create or replace function public.user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(btrim(p_email));
$$;

-- ---------- 權限 ----------
revoke all on function public.is_owner()                      from public;
revoke all on function public.my_role()                       from public;
revoke all on function public.list_staff()                    from public;
revoke all on function public.add_staff(text, text)           from public;
revoke all on function public.set_staff_role(uuid, text)      from public;
revoke all on function public.remove_staff(uuid)              from public;
revoke all on function public.user_id_by_email(text)          from public, anon, authenticated;
grant execute on function public.is_owner()                   to anon, authenticated;
grant execute on function public.my_role()                    to anon, authenticated;
grant execute on function public.list_staff()                 to authenticated;
grant execute on function public.add_staff(text, text)        to authenticated;
grant execute on function public.set_staff_role(uuid, text)   to authenticated;
grant execute on function public.remove_staff(uuid)           to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.user_id_by_email(text) to service_role;
  end if;
end $$;

-- 刪除比賽只限管理員；新增、修改給所有工作人員
drop policy if exists "competitions: admin write"  on public.competitions;
drop policy if exists "competitions: staff insert" on public.competitions;
drop policy if exists "competitions: staff update" on public.competitions;
drop policy if exists "competitions: owner delete" on public.competitions;
create policy "competitions: staff insert" on public.competitions
  for insert to authenticated with check (public.is_admin());
create policy "competitions: staff update" on public.competitions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "competitions: owner delete" on public.competitions
  for delete to authenticated using (public.is_owner());
