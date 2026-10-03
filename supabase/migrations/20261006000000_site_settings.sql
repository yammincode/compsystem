-- 第四版：網站設定（網站名稱、首頁標題與說明、頁尾）
-- 依序執行 init → competitions_payments → staff_roles → 這一份。可重複執行。

create table if not exists public.site_settings (
  id          integer primary key default 1 check (id = 1),     -- 只有一筆
  site_name   text not null default '攀岩比賽' check (char_length(site_name) between 1 and 40),
  home_title  text not null default '比賽列表' check (char_length(home_title) between 1 and 80),
  home_intro  text not null default '選擇比賽查看簡章、報名與參加人員。' check (char_length(home_intro) <= 5000),  -- Markdown
  footer_text text not null default '' check (char_length(footer_text) <= 2000),                              -- Markdown
  updated_at  timestamptz not null default now()
);
insert into public.site_settings (id) values (1) on conflict (id) do nothing;

alter table public.site_settings enable row level security;
grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;

drop policy if exists "site_settings: public read" on public.site_settings;
drop policy if exists "site_settings: staff update" on public.site_settings;
create policy "site_settings: public read" on public.site_settings
  for select using (true);
create policy "site_settings: staff update" on public.site_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
