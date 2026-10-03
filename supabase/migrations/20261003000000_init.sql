-- 攀岩比賽報名系統：Supabase 資料庫
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可。
--
-- 安全設計：
--   * registrations（含真實姓名）只有管理員能直接讀寫。
--   * 一般訪客只能透過 list_public_registrations() 取得「匿名後」的名單，
--     並透過 register() 報名；真實姓名永遠不會傳到公開頁面。

-- ---------- 資料表 ----------
create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  name        text    not null unique check (char_length(name) between 1 and 40),
  description text    not null default '' check (char_length(description) <= 200),
  capacity    integer check (capacity is null or capacity > 0),   -- null = 不限人數
  is_open     boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.registrations (
  id          bigint generated always as identity primary key,
  name        text   not null check (char_length(name) between 1 and 30),  -- 真實姓名
  team        text   not null default '' check (char_length(team) <= 50),
  category_id bigint not null references public.categories(id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (category_id, name, team)
);
create index if not exists registrations_category_idx on public.registrations(category_id);

-- 管理員名單（對應 Supabase Auth 的使用者）
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- 函式 ----------
-- 姓名匿名：三個字 → 王X明；兩個字 → 王X；四字以上保留頭尾
create or replace function public.anonymize_name(full_name text)
returns text language sql immutable as $$
  select case
    when char_length(n) <= 1 then n
    when char_length(n) = 2 then left(n, 1) || 'X'
    else left(n, 1) || repeat('X', char_length(n) - 2) || right(n, 1)
  end
  from (select btrim(coalesce(full_name, '')) as n) s;
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 組別與目前報名人數（公開）
create or replace function public.list_categories()
returns table (id bigint, name text, description text, capacity integer,
               is_open boolean, sort_order integer, count bigint)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.description, c.capacity, c.is_open, c.sort_order,
         count(r.id)
    from public.categories c
    left join public.registrations r on r.category_id = c.id
   group by c.id
   order by c.sort_order, c.id;
$$;

-- 公開名單：只回傳匿名姓名
create or replace function public.list_public_registrations()
returns table (id bigint, display_name text, team text, category_id bigint,
               category_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, public.anonymize_name(r.name), r.team, r.category_id, c.name, r.created_at
    from public.registrations r
    join public.categories c on c.id = r.category_id
   order by c.sort_order, c.id, r.id;
$$;

-- 報名（公開）：檢查組別開放、名額、重複
create or replace function public.register(p_name text, p_team text, p_category_id bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_team text := regexp_replace(btrim(coalesce(p_team, '')), '\s+', ' ', 'g');
  v_cat  public.categories%rowtype;
  v_count bigint;
begin
  if v_name = '' then raise exception '請填寫姓名'; end if;
  if char_length(v_name) > 30 then raise exception '姓名最多 30 個字'; end if;
  if char_length(v_team) > 50 then raise exception '所屬團體最多 50 個字'; end if;

  -- 鎖住組別，避免同時報名超過名額
  select * into v_cat from public.categories where id = p_category_id for update;
  if not found then raise exception '找不到這個組別'; end if;
  if not v_cat.is_open then raise exception '這個組別目前不開放報名'; end if;

  if exists (select 1 from public.registrations
              where category_id = p_category_id and name = v_name and team = v_team) then
    raise exception '這位選手已經報名過這個組別了';
  end if;

  if v_cat.capacity is not null then
    select count(*) into v_count from public.registrations where category_id = p_category_id;
    if v_count >= v_cat.capacity then raise exception '這個組別名額已滿'; end if;
  end if;

  insert into public.registrations (name, team, category_id) values (v_name, v_team, p_category_id);
  return public.anonymize_name(v_name);
end;
$$;

-- ---------- 權限與 RLS ----------
alter table public.categories    enable row level security;
alter table public.registrations enable row level security;
alter table public.admins        enable row level security;

revoke all on public.registrations, public.admins from anon;
revoke all on function public.register(text, text, bigint)    from public;
revoke all on function public.list_categories()                from public;
revoke all on function public.list_public_registrations()      from public;
revoke all on function public.is_admin()                       from public;
grant execute on function public.register(text, text, bigint)  to anon, authenticated;
grant execute on function public.list_categories()             to anon, authenticated;
grant execute on function public.list_public_registrations()   to anon, authenticated;
grant execute on function public.is_admin()                    to authenticated;

drop policy if exists "categories: public read"  on public.categories;
drop policy if exists "categories: admin write"  on public.categories;
drop policy if exists "registrations: admin all" on public.registrations;
drop policy if exists "admins: read self"        on public.admins;

create policy "categories: public read" on public.categories
  for select using (true);
create policy "categories: admin write" on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "registrations: admin all" on public.registrations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins: read self" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- ---------- 預設組別（只在沒有任何組別時建立） ----------
insert into public.categories (name, description, sort_order)
select * from (values ('男子公開組', '', 1), ('女子公開組', '', 2), ('青少年組', '18 歲以下', 3)) v
where not exists (select 1 from public.categories);
