-- 由 run.sh 執行（已套用全部 migration，並有一筆第一版留下的「舊資料」報名）
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: expected error "%" but succeeded: %', msg, sql;
exception when others then
  if sqlerrm not like 'FAIL:%' and sqlerrm ~ msg then
    raise notice 'ok - error "%"', msg;
  else
    raise exception 'FAIL: expected "%" got "%" for: %', msg, sqlerrm, sql;
  end if;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
set client_min_messages = notice;

-- ===== 第一版資料升級 =====
select pg_temp.check((select count(*) from competitions) = 1, '升級：建立預設比賽');
select pg_temp.check((select count(*) from categories where competition_id is null) = 0, '升級：舊組別歸入預設比賽');
select pg_temp.check((select payment_status from registrations where name = '舊資料') = 'unpaid', '升級：舊報名預設未繳費');
select pg_temp.check((select count(*) from storage.buckets where id = 'payment-proofs' and not public) = 1, '建立私人 bucket');

-- ===== 匿名規則 =====
select pg_temp.check(anonymize_name('王小明') = '王X明', '三個字');
select pg_temp.check(anonymize_name('王明') = '王X', '兩個字');
select pg_temp.check(anonymize_name('歐陽小明') = '歐XX明', '四個字');

-- ===== 測試資料 =====
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'owner@x.com'),
  ('00000000-0000-0000-0000-000000000002', 'user@x.com'),
  ('00000000-0000-0000-0000-000000000003', 'staff@x.com');
insert into admins (user_id) values ('00000000-0000-0000-0000-000000000001');
select pg_temp.check((select role from admins where user_id = '00000000-0000-0000-0000-000000000001') = 'owner', '既有管理員預設為 owner');
insert into competitions (slug, title, is_published, fee) values ('cup-a', 'A 盃', true, 800);
insert into competitions (slug, title, is_published) values ('draft', '草稿比賽', false);
insert into competitions (slug, title, is_published, registration_open) values ('closed', '已截止比賽', true, false);
insert into categories (competition_id, name, capacity) select id, '限額組', 2 from competitions where slug = 'cup-a';
insert into categories (competition_id, name, is_open) select id, '關閉組', false from competitions where slug = 'cup-a';
insert into categories (competition_id, name) select id, '限額組' from competitions where slug = 'draft';   -- 不同比賽可同名
insert into categories (competition_id, name) select id, '公開組' from competitions where slug = 'closed';
create temp table ids as select
  (select id from competitions where slug = 'cup-a') as cup,
  (select id from competitions where slug = 'draft') as draft,
  (select c.id from categories c join competitions p on p.id = c.competition_id where p.slug = 'cup-a' and c.name = '限額組') as cat_limit,
  (select c.id from categories c join competitions p on p.id = c.competition_id where p.slug = 'cup-a' and c.name = '關閉組') as cat_closed,
  (select c.id from categories c join competitions p on p.id = c.competition_id where p.slug = 'draft') as cat_draft,
  (select c.id from categories c join competitions p on p.id = c.competition_id where p.slug = 'closed') as cat_comp_closed;
grant select on ids to anon, authenticated;
select pg_temp.expect_error($$insert into competitions (slug, title) values ('Bad Slug', 'x')$$, 'check');
select pg_temp.expect_error($$insert into categories (competition_id, name) select cup, '限額組' from ids$$, 'duplicate key');

-- ===== 訪客 =====
set role anon;
select pg_temp.check((select array_agg(slug order by id) from competitions) = array['climbing-2026', 'cup-a', 'closed'], '訪客只看到已公開比賽');
select pg_temp.check((select count(*) from list_categories((select cup from ids))) = 2, '訪客可讀組別');
select pg_temp.check((select count(*) from list_categories((select draft from ids))) = 0, '未公開比賽的組別看不到');
select pg_temp.check((select count(*) from categories where competition_id = (select draft from ids)) = 0, '未公開比賽的組別（直接查表）看不到');

select pg_temp.check((register('王小明', '岩館A', (select cat_limit from ids)) ->> 'display_name') = '王X明', '報名成功');
select pg_temp.check((register('  李四 ', '', (select cat_limit from ids)) ->> 'display_name') = '李X', '報名會清理空白');
select pg_temp.expect_error($$select register('張三豐', '', (select cat_limit from ids))$$, '名額已滿');
select pg_temp.expect_error($$select register('張三豐', '', (select cat_closed from ids))$$, '組別目前不開放');
select pg_temp.expect_error($$select register('張三豐', '', (select cat_comp_closed from ids))$$, '比賽目前不開放');
select pg_temp.expect_error($$select register('張三豐', '', (select cat_draft from ids))$$, '找不到');
select pg_temp.expect_error($$select register('  ', '', (select cat_limit from ids))$$, '請填寫姓名');

select pg_temp.check((select array_agg(display_name || ':' || payment_status order by id)
                        from list_public_registrations((select cup from ids))) = array['王X明:unpaid', '李X:unpaid'],
                     '公開名單：匿名 + 未繳費');
select pg_temp.check((select count(*) from list_public_registrations((select draft from ids))) = 0, '未公開比賽名單看不到');

select pg_temp.check((select site_name from site_settings) = '攀岩比賽', '訪客可讀網站設定');
do $$ begin update site_settings set site_name = 'hack'; exception when insufficient_privilege then null; end $$;
select pg_temp.check((select site_name from site_settings) = '攀岩比賽', '訪客不能改網站設定');
select pg_temp.expect_error('select * from registrations', 'permission denied');
select pg_temp.expect_error('select * from payments', 'permission denied');
select pg_temp.expect_error($$insert into categories (competition_id, name) values (1, '駭客組')$$, 'row-level security|permission denied');
select pg_temp.expect_error($$insert into competitions (slug, title) values ('hack', 'x')$$, 'row-level security|permission denied');
select pg_temp.expect_error($$select review_payment(1, true)$$, 'permission denied');

-- 上傳截圖
create temp table reg as select (select id from list_public_registrations((select cup from ids)) where display_name = '王X明') as wang,
                                (select id from list_public_registrations((select cup from ids)) where display_name = '李X') as li;
grant select on reg to authenticated;
select pg_temp.check(can_upload_proof((select wang from reg) || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg'), '允許上傳到未繳費報名');
select pg_temp.check(not can_upload_proof((select wang from reg) || '/../x.jpg'), '拒絕奇怪路徑');
select pg_temp.check(not can_upload_proof('999999/0f8fad5b-d9cb-469f-a165-70867728950e.jpg'), '拒絕不存在的報名');
insert into storage.objects (bucket_id, name) select 'payment-proofs', wang || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' from reg;
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('payment-proofs', 'evil.jpg')$$, 'row-level security');
select pg_temp.check((select count(*) from storage.objects) = 0, '訪客無法讀取截圖');

-- 送出繳費資訊
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王大明', '12345', 800, current_date)$$, '姓名不符');
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王小明', '1234', 800, current_date)$$, '後五碼');
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王小明', '12345', 0, current_date)$$, '金額');
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王小明', '12345', 800, current_date + 10)$$, '未來');
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王小明', '12345', 800, current_date, '', (select li from reg) || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg')$$, '找不到上傳的截圖');
select submit_payment((select wang from reg), ' 王小明 ', '12345', 800, current_date, '已匯款', (select wang from reg) || '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg');
select pg_temp.check((select payment_status from list_public_registrations((select cup from ids)) where id = (select wang from reg)) = 'pending', '送出後變成審核中');
select pg_temp.expect_error($$select submit_payment((select wang from reg), '王小明', '12345', 800, current_date)$$, '已經送出過');
select pg_temp.check(not can_upload_proof((select wang from reg) || '/1f8fad5b-d9cb-469f-a165-70867728950e.jpg'), '審核中不能再上傳');
select submit_payment((select li from reg), '李四', '54321', 800, current_date);
reset role;

-- ===== 已登入但不是管理員 =====
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select pg_temp.check((select count(*) from registrations) = 0, '非管理員看不到報名資料');
select pg_temp.check((select count(*) from payments) = 0, '非管理員看不到繳費資料');
select pg_temp.check((select count(*) from storage.objects) = 0, '非管理員看不到截圖');
select pg_temp.check((select count(*) from competitions where slug = 'draft') = 0, '非管理員看不到未公開比賽');
select pg_temp.expect_error($$select review_payment(1, true)$$, '沒有權限');
select pg_temp.expect_error($$insert into admins values ('00000000-0000-0000-0000-000000000002')$$, 'row-level security|permission denied');

-- ===== 管理員 =====
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select pg_temp.check((select count(*) from competitions) = 4, '管理員看得到所有比賽');
select pg_temp.check((select count(*) from list_categories((select draft from ids))) = 1, '管理員看得到未公開比賽組別');
select pg_temp.check((select count(*) from registrations where name = '王小明') = 1, '管理員看得到真實姓名');
select pg_temp.check((select count(*) from storage.objects) = 1, '管理員看得到截圖');
select pg_temp.check((select account_last5 from payments where registration_id = (select wang from reg)) = '12345', '管理員看得到繳費資料');

select review_payment((select id from payments where registration_id = (select wang from reg)), true, '');
select pg_temp.check((select payment_status from registrations where id = (select wang from reg)) = 'paid', '確認收款 → 已繳費');
select review_payment((select id from payments where registration_id = (select li from reg)), false, '金額不符');
select pg_temp.check((select payment_status from registrations where id = (select li from reg)) = 'unpaid', '退回 → 未繳費');
select pg_temp.check((select admin_note from payments where registration_id = (select li from reg)) = '金額不符', '退回原因');
update registrations set payment_status = 'paid' where id = (select li from reg);
select pg_temp.check((select payment_status from registrations where id = (select li from reg)) = 'paid', '管理員可直接改已繳費（現場繳現金）');
select pg_temp.expect_error($$update registrations set payment_status = 'free' where id = 1$$, 'check');

update competitions set is_published = true where slug = 'draft';
select pg_temp.expect_error($$delete from competitions where slug = 'cup-a'$$, 'foreign key');
delete from registrations where id = (select li from reg);
select pg_temp.check((select count(*) from payments where registration_id = (select li from reg)) = 0, '刪除報名一併刪除繳費資料');

-- ===== 工作人員管理（owner）=====
select pg_temp.check(my_role() = 'owner', 'my_role = owner');
select pg_temp.expect_error($$select add_staff('nobody@x.com')$$, '找不到這個 Email');
select pg_temp.check(add_staff(' STAFF@x.com ') = '00000000-0000-0000-0000-000000000003', '依 Email 加入工作人員');
select pg_temp.check((select array_agg(email || ':' || role order by role) from list_staff()) = array['owner@x.com:owner', 'staff@x.com:staff'], '工作人員名單');
select pg_temp.expect_error($$select remove_staff('00000000-0000-0000-0000-000000000001')$$, '不能移除自己');
select pg_temp.expect_error($$select set_staff_role('00000000-0000-0000-0000-000000000001', 'staff')$$, '至少要保留一位管理員');
select pg_temp.check(my_role() = 'owner', '降級失敗後仍是 owner');
select pg_temp.expect_error($$select user_id_by_email('owner@x.com')$$, 'permission denied');

-- ===== 工作人員（staff）=====
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select pg_temp.check(is_admin() and not is_owner() and my_role() = 'staff', 'staff 身分');
update site_settings set site_name = '台北攀岩聯賽', home_intro = '## 歡迎';
select pg_temp.check((select site_name from site_settings) = '台北攀岩聯賽', 'staff 可改網站設定');
select pg_temp.expect_error($$insert into site_settings (id) values (2)$$, 'check|permission denied|row-level security');
select pg_temp.check((select count(*) from registrations) > 0, 'staff 看得到報名資料');
select pg_temp.check((select count(*) from list_staff()) = 2, 'staff 看得到工作人員名單');
insert into competitions (slug, title) values ('staff-made', 'staff 建的比賽');
update competitions set title = 'staff 改的比賽' where slug = 'staff-made';
select pg_temp.check((select title from competitions where slug = 'staff-made') = 'staff 改的比賽', 'staff 可新增、修改比賽');
delete from competitions where slug = 'staff-made';
select pg_temp.check((select count(*) from competitions where slug = 'staff-made') = 1, 'staff 不能刪除比賽');
select pg_temp.expect_error($$select add_staff('user@x.com')$$, '只有管理員');
select pg_temp.expect_error($$select remove_staff('00000000-0000-0000-0000-000000000001')$$, '只有管理員');
select pg_temp.expect_error($$select set_staff_role('00000000-0000-0000-0000-000000000003', 'owner')$$, '只有管理員');
do $$ begin update admins set role = 'owner'; exception when insufficient_privilege then null; end $$;
select pg_temp.check(my_role() = 'staff', 'staff 無法直接改自己的角色');

-- owner 移除 staff、刪除比賽
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
delete from competitions where slug = 'staff-made';
select pg_temp.check((select count(*) from competitions where slug = 'staff-made') = 0, 'owner 可刪除比賽');
select remove_staff('00000000-0000-0000-0000-000000000003');
select pg_temp.check((select count(*) from list_staff()) = 1, 'owner 可移除工作人員');
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select pg_temp.check(not is_admin() and my_role() is null, '被移除後失去權限');
reset role;

-- service_role（Netlify Function）可依 Email 查帳號
set role service_role;
select pg_temp.check(user_id_by_email('Owner@X.com') = '00000000-0000-0000-0000-000000000001', 'service_role 依 Email 查帳號');
reset role;

\echo 'ALL TESTS PASSED'
