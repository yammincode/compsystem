-- 第六版：系列賽 + 套票 + 組別年級範圍
-- 依序執行 init → competitions_payments → staff_roles → site_settings → minor_consent → 這一份。可重複執行。
--
-- 規則：
--   * 系列賽（series）把多場比賽串在一起，可設定套票價。
--   * 套票報名：一次為系列賽的每一場各建立一筆報名，並用 packages 綁在一起。
--   * 套票只要繳一次費：送出繳費資訊或審核時，同一套票的所有報名狀態一起變動；
--     繳費資料一律掛在套票的第一場（lead）報名底下，方便後台在同一處審核。
--   * 組別可設定年級範圍（1 = 國小一年級 … 12 = 高中三年級），前台依出生日期自動帶出組別。

-- =====================================================================
-- 系列賽
-- =====================================================================
create table if not exists public.series (
  id                   bigint generated always as identity primary key,
  slug                 text    not null unique
                         check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),
  title                text    not null check (char_length(title) between 1 and 80),
  tagline              text    not null default '' check (char_length(tagline) <= 200),
  intro                text    not null default '' check (char_length(intro) <= 20000),     -- Markdown
  package_fee          integer check (package_fee is null or package_fee >= 0),           -- 套票價（元）；null = 不賣套票
  package_open         boolean not null default true,
  payment_instructions text    not null default '' check (char_length(payment_instructions) <= 2000),
  is_published         boolean not null default false,
  created_at           timestamptz not null default now()
);

alter table public.competitions add column if not exists series_id bigint references public.series(id) on delete set null;
alter table public.competitions add column if not exists series_order integer not null default 0;
create index if not exists competitions_series_idx on public.competitions(series_id);

-- 組別年級範圍（null = 不限）
alter table public.categories add column if not exists grade_min integer;
alter table public.categories add column if not exists grade_max integer;
alter table public.categories drop constraint if exists categories_grade_check;
alter table public.categories add constraint categories_grade_check check (
  (grade_min is null or grade_min between 1 and 12) and
  (grade_max is null or grade_max between 1 and 12) and
  (grade_min is null or grade_max is null or grade_min <= grade_max));

-- =====================================================================
-- 套票
-- =====================================================================
create table if not exists public.packages (
  id                   bigint generated always as identity primary key,
  series_id            bigint not null references public.series(id) on delete restrict,
  lead_registration_id bigint references public.registrations(id) on delete set null,
  created_at           timestamptz not null default now()
);
alter table public.registrations add column if not exists package_id bigint references public.packages(id) on delete set null;
create index if not exists registrations_package_idx on public.registrations(package_id);

-- =====================================================================
-- 函式
-- =====================================================================
-- 組別：多回傳年級範圍
drop function if exists public.list_categories(bigint);
create function public.list_categories(p_competition_id bigint)
returns table (id bigint, name text, description text, capacity integer,
               is_open boolean, sort_order integer, count bigint,
               grade_min integer, grade_max integer)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.description, c.capacity, c.is_open, c.sort_order, count(r.id),
         c.grade_min, c.grade_max
    from public.categories c
    left join public.registrations r on r.category_id = c.id
   where c.competition_id = p_competition_id
     and public.competition_visible(p_competition_id)
   group by c.id
   order by c.sort_order, c.id;
$$;

-- 公開名單：多回傳是否為套票
drop function if exists public.list_public_registrations(bigint);
create function public.list_public_registrations(p_competition_id bigint)
returns table (id bigint, display_name text, team text, category_id bigint,
               category_name text, payment_status text, created_at timestamptz,
               is_package boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, public.anonymize_name(r.name), r.team, r.category_id, c.name,
         r.payment_status, r.created_at, r.package_id is not null
    from public.registrations r
    join public.categories c on c.id = r.category_id
   where c.competition_id = p_competition_id
     and public.competition_visible(p_competition_id)
   order by c.sort_order, c.id, r.id;
$$;

-- 套票報名：p_category_ids 為系列賽每一場各選一個組別
create or replace function public.register_package(
  p_series_id bigint, p_name text, p_team text, p_category_ids bigint[],
  p_birth_date date default null, p_guardian jsonb default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_series  public.series%rowtype;
  v_comp    record;
  v_cat_id  bigint;
  v_res     json;
  v_ids     bigint[] := '{}';
  v_minor   boolean := false;
  v_display text;
  v_pkg     bigint;
  v_n       integer := 0;
begin
  select * into v_series from public.series where id = p_series_id;
  if not found or not v_series.is_published then raise exception '找不到這個系列賽'; end if;
  if v_series.package_fee is null or not v_series.package_open then raise exception '這個系列賽目前不開放套票報名'; end if;
  if p_category_ids is null or cardinality(p_category_ids) = 0 then raise exception '請為每一場選擇組別'; end if;
  if cardinality(p_category_ids) <> (select count(distinct x) from unnest(p_category_ids) x) then
    raise exception '組別重複';
  end if;

  for v_comp in
    select id, title, is_published, registration_open
      from public.competitions where series_id = p_series_id
     order by series_order, event_date nulls last, id
  loop
    v_n := v_n + 1;
    if not v_comp.is_published or not v_comp.registration_open then
      raise exception '「%」目前不開放報名，無法購買套票', v_comp.title;
    end if;
    select c.id into v_cat_id from public.categories c
     where c.competition_id = v_comp.id and c.id = any(p_category_ids);
    if v_cat_id is null then raise exception '請選擇「%」的組別', v_comp.title; end if;

    v_res := public.register(p_name, p_team, v_cat_id, p_birth_date, p_guardian);
    v_ids := v_ids || (v_res ->> 'id')::bigint;
    v_minor := v_minor or coalesce((v_res ->> 'minor')::boolean, false);
    v_display := v_res ->> 'display_name';
  end loop;

  if v_n < 2 then raise exception '這個系列賽的比賽還沒設定好，無法購買套票'; end if;
  if cardinality(p_category_ids) <> v_n then raise exception '組別數量不符，請重新整理頁面'; end if;

  insert into public.packages (series_id, lead_registration_id)
  values (p_series_id, v_ids[1]) returning id into v_pkg;
  update public.registrations set package_id = v_pkg where id = any(v_ids);

  return json_build_object('package_id', v_pkg, 'lead_id', v_ids[1], 'registration_ids', to_json(v_ids),
                           'display_name', v_display, 'minor', v_minor, 'fee', v_series.package_fee);
end;
$$;

-- 送出繳費資訊：套票的任一筆都可送出，資料掛在第一場，整組變審核中
create or replace function public.submit_payment(
  p_registration_id bigint, p_full_name text, p_account_last5 text,
  p_amount integer, p_paid_on date, p_note text default '', p_proof_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reg  public.registrations%rowtype;
  v_name text := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_note text := btrim(coalesce(p_note, ''));
  v_proof text := nullif(btrim(coalesce(p_proof_path, '')), '');
  v_target bigint := p_registration_id;
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

  if v_reg.package_id is not null then
    select coalesce(lead_registration_id, p_registration_id) into v_target
      from public.packages where id = v_reg.package_id;
    update public.registrations set payment_status = 'pending'
     where package_id = v_reg.package_id and payment_status = 'unpaid';
  end if;

  insert into public.payments (registration_id, account_last5, amount, paid_on, note, proof_path)
  values (v_target, p_account_last5, p_amount, p_paid_on, v_note, v_proof);
  update public.registrations set payment_status = 'pending' where id = p_registration_id;
end;
$$;

-- 審核繳費：套票整組一起變動
create or replace function public.review_payment(p_payment_id bigint, p_approve boolean, p_admin_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_pay public.payments%rowtype;
  v_pkg bigint;
begin
  if not public.is_admin() then raise exception '沒有權限' using errcode = '42501'; end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then raise exception '找不到這筆繳費資料'; end if;

  update public.payments
     set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = left(btrim(coalesce(p_admin_note, '')), 500),
         reviewed_at = now()
   where id = p_payment_id;

  select package_id into v_pkg from public.registrations where id = v_pay.registration_id;
  update public.registrations
     set payment_status = case when p_approve then 'paid' else 'unpaid' end
   where id = v_pay.registration_id
      or (v_pkg is not null and package_id = v_pkg);
end;
$$;

-- =====================================================================
-- 權限與 RLS
-- =====================================================================
alter table public.series   enable row level security;
alter table public.packages enable row level security;

grant select on public.series to anon, authenticated;
grant insert, update, delete on public.series to authenticated;
revoke all on public.packages from anon;
grant select, insert, update, delete on public.packages to authenticated;

drop policy if exists "series: public read published" on public.series;
drop policy if exists "series: staff write"           on public.series;
drop policy if exists "series: staff update"          on public.series;
drop policy if exists "series: owner delete"          on public.series;
drop policy if exists "packages: staff all"           on public.packages;
create policy "series: public read published" on public.series
  for select using (is_published or public.is_admin());
create policy "series: staff write" on public.series
  for insert to authenticated with check (public.is_admin());
create policy "series: staff update" on public.series
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "series: owner delete" on public.series
  for delete to authenticated using (public.is_owner());
create policy "packages: staff all" on public.packages
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on function public.list_categories(bigint)           from public;
revoke all on function public.list_public_registrations(bigint) from public;
revoke all on function public.register_package(bigint, text, text, bigint[], date, jsonb) from public;
grant execute on function public.list_categories(bigint)           to anon, authenticated;
grant execute on function public.list_public_registrations(bigint) to anon, authenticated;
grant execute on function public.register_package(bigint, text, text, bigint[], date, jsonb) to anon, authenticated;
