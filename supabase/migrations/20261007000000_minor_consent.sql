-- 第五版：出生日期 + 未成年家長同意書（線上簽名）
-- 依序執行 init → competitions_payments → staff_roles → site_settings → 這一份。可重複執行。
--
-- 規則：
--   * 報名需填出生日期，以「比賽日期」（未設定則為報名當天）計算年齡。
--   * 未滿 18 歲必須由家長填寫姓名、關係並線上簽名，才能完成報名。
--   * 同意書內容每場比賽可在後台修改；簽署時會保存當下的全文。
--   * 生日、家長資料、簽名只有工作人員看得到。

alter table public.registrations add column if not exists birth_date date;

alter table public.competitions add column if not exists minor_consent text not null default $tpl$## 未成年參賽者家長（法定代理人）同意書

本人為參賽者之家長／法定代理人，已詳閱本次比賽簡章及相關規定，瞭解攀岩運動具有一定之風險，並同意本人之子女（受監護人）參加本次比賽：

1. 參賽者身體狀況良好，無不適合從事攀岩運動之疾病。
2. 參賽者將遵守主辦單位及現場工作人員之指示與安全規範。
3. 如因個人疏忽或未遵守規定而發生意外，將自行負責。
4. 同意主辦單位於比賽期間拍攝之照片、影片用於活動紀錄與宣傳。

（此為範本，請主辦單位依實際需求於後台修改。）$tpl$;
alter table public.competitions drop constraint if exists competitions_minor_consent_check;
alter table public.competitions add constraint competitions_minor_consent_check check (char_length(minor_consent) <= 20000);

create table if not exists public.guardian_consents (
  id              bigint generated always as identity primary key,
  registration_id bigint not null unique references public.registrations(id) on delete cascade,
  guardian_name   text   not null check (char_length(guardian_name) between 1 and 30),
  relationship    text   not null check (char_length(relationship) between 1 and 20),
  signature       text   not null check (signature like 'data:image/png;base64,%' and char_length(signature) <= 400000),
  consent_text    text   not null,             -- 簽署當下的同意書全文
  signed_at       timestamptz not null default now()
);

-- 以比賽日期計算的足歲
create or replace function public.age_on(p_birth date, p_ref date)
returns integer language sql immutable as $$
  select extract(year from age(p_ref, p_birth))::integer;
$$;

-- 報名（新增出生日期與家長同意書）
drop function if exists public.register(text, text, bigint);
drop function if exists public.register(text, text, bigint, date, jsonb);
create function public.register(
  p_name text, p_team text, p_category_id bigint,
  p_birth_date date default null, p_guardian jsonb default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_team  text := regexp_replace(btrim(coalesce(p_team, '')), '\s+', ' ', 'g');
  v_cat   public.categories%rowtype;
  v_comp  public.competitions%rowtype;
  v_count bigint;
  v_id    bigint;
  v_age   integer;
  v_g_name text;
  v_g_rel  text;
  v_g_sig  text;
begin
  if v_name = '' then raise exception '請填寫姓名'; end if;
  if char_length(v_name) > 30 then raise exception '姓名最多 30 個字'; end if;
  if char_length(v_team) > 50 then raise exception '所屬團體最多 50 個字'; end if;
  if p_birth_date is null then raise exception '請填寫出生日期'; end if;
  if p_birth_date > current_date then raise exception '出生日期不正確'; end if;

  -- 鎖住組別，避免同時報名超過名額
  select * into v_cat from public.categories where id = p_category_id for update;
  if not found then raise exception '找不到這個組別'; end if;
  select * into v_comp from public.competitions where id = v_cat.competition_id;
  if not v_comp.is_published then raise exception '找不到這個組別'; end if;
  if not v_comp.registration_open then raise exception '這場比賽目前不開放報名'; end if;
  if not v_cat.is_open then raise exception '這個組別目前不開放報名'; end if;

  v_age := public.age_on(p_birth_date, coalesce(v_comp.event_date, current_date));
  if v_age > 120 then raise exception '出生日期不正確'; end if;

  -- 未滿 18 歲：家長同意書
  if v_age < 18 then
    v_g_name := regexp_replace(btrim(coalesce(p_guardian ->> 'name', '')), '\s+', ' ', 'g');
    v_g_rel  := btrim(coalesce(p_guardian ->> 'relationship', ''));
    v_g_sig  := coalesce(p_guardian ->> 'signature', '');
    if p_guardian is null or v_g_name = '' then raise exception '未滿 18 歲需由家長填寫同意書（請填寫家長姓名）'; end if;
    if char_length(v_g_name) > 30 then raise exception '家長姓名最多 30 個字'; end if;
    if v_g_rel = '' or char_length(v_g_rel) > 20 then raise exception '請選擇與參賽者的關係'; end if;
    if v_g_sig not like 'data:image/png;base64,%' or char_length(v_g_sig) < 200 then raise exception '請家長在簽名欄簽名'; end if;
    if char_length(v_g_sig) > 400000 then raise exception '簽名檔太大，請清除後重新簽名'; end if;
    if coalesce((p_guardian ->> 'agreed')::boolean, false) is not true then raise exception '請勾選同意家長同意書'; end if;
  end if;

  if exists (select 1 from public.registrations
              where category_id = p_category_id and name = v_name and team = v_team) then
    raise exception '這位選手已經報名過這個組別了';
  end if;

  if v_cat.capacity is not null then
    select count(*) into v_count from public.registrations where category_id = p_category_id;
    if v_count >= v_cat.capacity then raise exception '這個組別名額已滿'; end if;
  end if;

  insert into public.registrations (name, team, category_id, birth_date)
  values (v_name, v_team, p_category_id, p_birth_date)
  returning id into v_id;

  if v_age < 18 then
    insert into public.guardian_consents (registration_id, guardian_name, relationship, signature, consent_text)
    values (v_id, v_g_name, v_g_rel, v_g_sig, v_comp.minor_consent);
  end if;

  return json_build_object('id', v_id, 'display_name', public.anonymize_name(v_name), 'minor', v_age < 18);
end;
$$;

-- ---------- 權限 ----------
alter table public.guardian_consents enable row level security;
revoke all on public.guardian_consents from anon;
grant select, insert, update, delete on public.guardian_consents to authenticated;

drop policy if exists "guardian_consents: staff all" on public.guardian_consents;
create policy "guardian_consents: staff all" on public.guardian_consents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on function public.register(text, text, bigint, date, jsonb) from public;
grant execute on function public.register(text, text, bigint, date, jsonb) to anon, authenticated;
grant execute on function public.age_on(date, date) to anon, authenticated;
