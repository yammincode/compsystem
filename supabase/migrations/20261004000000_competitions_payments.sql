-- 第二版：多場比賽 + 繳費狀態 / 繳費資訊上傳
-- 已經執行過 20261003000000_init.sql 的專案，只要再執行這一份。
-- 新專案請依序執行 init → 這一份。可重複執行。
--
-- 安全設計（延續第一版）：
--   * registrations / payments（含真實姓名、匯款資料）只有管理員能直接讀寫。
--   * 訪客透過函式取得匿名名單、報名、送出繳費資訊（需輸入真實姓名核對）。
--   * 匯款截圖存在私人 Storage bucket，訪客只能上傳、不能讀取；管理員才能查看。

-- =====================================================================
-- 比賽
-- =====================================================================
create table if not exists public.competitions (
  id                   bigint generated always as identity primary key,
  slug                 text    not null unique
                         check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),   -- 網址代碼
  title                text    not null check (char_length(title) between 1 and 80),
  event_date           date,
  location             text    not null default '' check (char_length(location) <= 120),
  fee                  integer check (fee is null or fee >= 0),                    -- 報名費（元）
  payment_instructions text    not null default '' check (char_length(payment_instructions) <= 2000),
  brochure             text    not null default '' check (char_length(brochure) <= 50000), -- 簡章（Markdown）
  is_published         boolean not null default false,
  registration_open    boolean not null default true,
  created_at           timestamptz not null default now()
);

-- 組別歸屬到比賽；既有組別歸入一場預設比賽
alter table public.categories
  add column if not exists competition_id bigint references public.competitions(id) on delete restrict;

do $$
declare v_id bigint;
begin
  if exists (select 1 from public.categories where competition_id is null) then
    insert into public.competitions (slug, title, is_published)
    values ('climbing-2026', '攀岩比賽', true)
    on conflict (slug) do nothing;
    select id into v_id from public.competitions where slug = 'climbing-2026';
    update public.categories set competition_id = v_id where competition_id is null;
  end if;
end $$;

alter table public.categories alter column competition_id set not null;
alter table public.categories drop constraint if exists categories_name_key;     -- 組別名稱改為「同一場比賽內」不重複
create unique index if not exists categories_competition_name_key on public.categories(competition_id, name);
create index if not exists categories_competition_idx on public.categories(competition_id);

-- =====================================================================
-- 繳費
-- =====================================================================
alter table public.registrations
  add column if not exists payment_status text not null default 'unpaid';
alter table public.registrations drop constraint if exists registrations_payment_status_check;
alter table public.registrations
  add constraint registrations_payment_status_check check (payment_status in ('unpaid', 'pending', 'paid'));

create table if not exists public.payments (
  id              bigint generated always as identity primary key,
  registration_id bigint  not null references public.registrations(id) on delete cascade,
  account_last5   text    not null check (account_last5 ~ '^[0-9]{5}$'),
  amount          integer not null check (amount > 0),
  paid_on         date    not null,
  note            text    not null default '' check (char_length(note) <= 500),
  proof_path      text,                                   -- Storage 裡的截圖路徑
  status          text    not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_note      text    not null default '' check (char_length(admin_note) <= 500),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz
);
create index if not exists payments_registration_idx on public.payments(registration_id);

-- 匯款截圖：私人 bucket，5MB 以內的圖片或 PDF
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- =====================================================================
-- 函式
-- =====================================================================
drop function if exists public.list_categories();
drop function if exists public.list_public_registrations();
drop function if exists public.register(text, text, bigint);

-- 比賽是否對目前使用者可見（已公開，或是管理員）
create or replace function public.competition_visible(p_competition_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.competitions
                  where id = p_competition_id and (is_published or public.is_admin()));
$$;

create or replace function public.list_categories(p_competition_id bigint)
returns table (id bigint, name text, description text, capacity integer,
               is_open boolean, sort_order integer, count bigint)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.description, c.capacity, c.is_open, c.sort_order, count(r.id)
    from public.categories c
    left join public.registrations r on r.category_id = c.id
   where c.competition_id = p_competition_id
     and public.competition_visible(p_competition_id)
   group by c.id
   order by c.sort_order, c.id;
$$;

-- 公開名單：匿名姓名 + 繳費狀態
create or replace function public.list_public_registrations(p_competition_id bigint)
returns table (id bigint, display_name text, team text, category_id bigint,
               category_name text, payment_status text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, public.anonymize_name(r.name), r.team, r.category_id, c.name,
         r.payment_status, r.created_at
    from public.registrations r
    join public.categories c on c.id = r.category_id
   where c.competition_id = p_competition_id
     and public.competition_visible(p_competition_id)
   order by c.sort_order, c.id, r.id;
$$;

-- 報名：檢查比賽與組別是否開放、名額、重複
create or replace function public.register(p_name text, p_team text, p_category_id bigint)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_team  text := regexp_replace(btrim(coalesce(p_team, '')), '\s+', ' ', 'g');
  v_cat   public.categories%rowtype;
  v_comp  public.competitions%rowtype;
  v_count bigint;
  v_id    bigint;
begin
  if v_name = '' then raise exception '請填寫姓名'; end if;
  if char_length(v_name) > 30 then raise exception '姓名最多 30 個字'; end if;
  if char_length(v_team) > 50 then raise exception '所屬團體最多 50 個字'; end if;

  -- 鎖住組別，避免同時報名超過名額
  select * into v_cat from public.categories where id = p_category_id for update;
  if not found then raise exception '找不到這個組別'; end if;
  select * into v_comp from public.competitions where id = v_cat.competition_id;
  if not v_comp.is_published then raise exception '找不到這個組別'; end if;
  if not v_comp.registration_open then raise exception '這場比賽目前不開放報名'; end if;
  if not v_cat.is_open then raise exception '這個組別目前不開放報名'; end if;

  if exists (select 1 from public.registrations
              where category_id = p_category_id and name = v_name and team = v_team) then
    raise exception '這位選手已經報名過這個組別了';
  end if;

  if v_cat.capacity is not null then
    select count(*) into v_count from public.registrations where category_id = p_category_id;
    if v_count >= v_cat.capacity then raise exception '這個組別名額已滿'; end if;
  end if;

  insert into public.registrations (name, team, category_id)
  values (v_name, v_team, p_category_id)
  returning id into v_id;
  return json_build_object('id', v_id, 'display_name', public.anonymize_name(v_name));
end;
$$;

-- 上傳截圖的路徑檢查：<報名編號>/<uuid>.<副檔名>，且該報名尚未繳費
create or replace function public.can_upload_proof(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_path ~ '^[0-9]{1,18}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif|pdf)$'
     and exists (select 1 from public.registrations
                  where id = split_part(p_path, '/', 1)::bigint and payment_status = 'unpaid');
$$;

-- 選手送出繳費資訊（需輸入報名時的真實姓名核對）
create or replace function public.submit_payment(
  p_registration_id bigint, p_full_name text, p_account_last5 text,
  p_amount integer, p_paid_on date, p_note text default '', p_proof_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reg  public.registrations%rowtype;
  v_name text := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_note text := btrim(coalesce(p_note, ''));
  v_proof text := nullif(btrim(coalesce(p_proof_path, '')), '');
begin
  select r.* into v_reg from public.registrations r
    join public.categories c on c.id = r.category_id
   where r.id = p_registration_id and public.competition_visible(c.competition_id)
   for update of r;
  if not found then raise exception '找不到這筆報名'; end if;
  if v_reg.name <> v_name then raise exception '姓名不符，請輸入報名時填寫的真實姓名'; end if;
  if v_reg.payment_status = 'pending' then raise exception '已經送出過繳費資訊，請等待管理員確認'; end if;
  if v_reg.payment_status = 'paid' then raise exception '這筆報名已經完成繳費'; end if;

  if coalesce(p_account_last5, '') !~ '^[0-9]{5}$' then raise exception '帳號後五碼必須是 5 位數字'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '請填寫正確的金額'; end if;
  if p_paid_on is null then raise exception '請填寫匯款日期'; end if;
  if p_paid_on > current_date + 1 then raise exception '匯款日期不能是未來的日期'; end if;
  if char_length(v_note) > 500 then raise exception '備註最多 500 個字'; end if;

  if v_proof is not null then
    if split_part(v_proof, '/', 1) <> p_registration_id::text
       or not exists (select 1 from storage.objects
                       where bucket_id = 'payment-proofs' and name = v_proof) then
      raise exception '找不到上傳的截圖，請重新上傳';
    end if;
  end if;

  insert into public.payments (registration_id, account_last5, amount, paid_on, note, proof_path)
  values (p_registration_id, p_account_last5, p_amount, p_paid_on, v_note, v_proof);
  update public.registrations set payment_status = 'pending' where id = p_registration_id;
end;
$$;

-- 管理員審核繳費
create or replace function public.review_payment(p_payment_id bigint, p_approve boolean, p_admin_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_pay public.payments%rowtype;
begin
  if not public.is_admin() then raise exception '沒有權限' using errcode = '42501'; end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then raise exception '找不到這筆繳費資料'; end if;

  update public.payments
     set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = left(btrim(coalesce(p_admin_note, '')), 500),
         reviewed_at = now()
   where id = p_payment_id;
  update public.registrations
     set payment_status = case when p_approve then 'paid' else 'unpaid' end
   where id = v_pay.registration_id;
end;
$$;

-- =====================================================================
-- 權限與 RLS
-- =====================================================================
alter table public.competitions enable row level security;
alter table public.payments     enable row level security;

revoke all on public.payments from anon;
grant select on public.competitions to anon, authenticated;
grant insert, update, delete on public.competitions to authenticated;
grant select, insert, update, delete on public.payments to authenticated;

revoke all on function public.competition_visible(bigint)            from public;
revoke all on function public.list_categories(bigint)                from public;
revoke all on function public.list_public_registrations(bigint)      from public;
revoke all on function public.register(text, text, bigint)           from public;
revoke all on function public.can_upload_proof(text)                 from public;
revoke all on function public.submit_payment(bigint, text, text, integer, date, text, text) from public;
revoke all on function public.review_payment(bigint, boolean, text)  from public;
-- RLS 規則裡會呼叫 is_admin()，訪客也需要執行權限（對訪客一律回傳 false）
grant execute on function public.is_admin()                          to anon, authenticated;
grant execute on function public.competition_visible(bigint)         to anon, authenticated;
grant execute on function public.list_categories(bigint)             to anon, authenticated;
grant execute on function public.list_public_registrations(bigint)   to anon, authenticated;
grant execute on function public.register(text, text, bigint)        to anon, authenticated;
grant execute on function public.can_upload_proof(text)              to anon, authenticated;
grant execute on function public.submit_payment(bigint, text, text, integer, date, text, text) to anon, authenticated;
grant execute on function public.review_payment(bigint, boolean, text) to authenticated;

drop policy if exists "competitions: public read published" on public.competitions;
drop policy if exists "competitions: admin write"           on public.competitions;
drop policy if exists "categories: public read"             on public.categories;
drop policy if exists "payments: admin all"                 on public.payments;

create policy "competitions: public read published" on public.competitions
  for select using (is_published or public.is_admin());
create policy "competitions: admin write" on public.competitions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "categories: public read" on public.categories
  for select using (public.competition_visible(competition_id));
create policy "payments: admin all" on public.payments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Storage：訪客只能上傳到「未繳費報名」的資料夾；只有管理員能查看與刪除
drop policy if exists "payment-proofs: upload" on storage.objects;
drop policy if exists "payment-proofs: admin read" on storage.objects;
drop policy if exists "payment-proofs: admin delete" on storage.objects;

create policy "payment-proofs: upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs' and public.can_upload_proof(name));
create policy "payment-proofs: admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());
create policy "payment-proofs: admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());
