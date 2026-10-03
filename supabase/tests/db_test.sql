-- 執行方式：見 README「測試」
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: expected error "%" but succeeded: %', msg, sql;
exception when others then
  if sqlerrm !~ msg then
    raise exception 'FAIL: expected "%" got "%" for: %', msg, sqlerrm, sql;
  end if;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;
set client_min_messages = notice;

-- 匿名規則
select pg_temp.check(anonymize_name('王小明') = '王X明', '三個字');
select pg_temp.check(anonymize_name('王明') = '王X', '兩個字');
select pg_temp.check(anonymize_name('歐陽小明') = '歐XX明', '四個字');
select pg_temp.check(anonymize_name(' 明 ') = '明', '一個字');

insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
insert into admins values ('00000000-0000-0000-0000-000000000001');
insert into categories (name, capacity) values ('限額組', 2);
insert into categories (name, is_open) values ('關閉組', false);

-- ===== 訪客 =====
set role anon;
select pg_temp.check((select count(*) from list_categories()) = 5, '訪客可讀組別');
select pg_temp.check(register('王小明', '岩館A', (select id from categories where name = '限額組')) = '王X明', '報名成功');
select pg_temp.check(register('  李四 ', '', (select id from categories where name = '限額組')) = '李X', '報名會清理空白');
select pg_temp.expect_error($$select register('張三豐', '', (select id from categories where name = '限額組'))$$, '名額已滿');
select pg_temp.expect_error($$select register('張三豐', '', (select id from categories where name = '關閉組'))$$, '不開放');
select pg_temp.expect_error($$select register('  ', '', 1)$$, '請填寫姓名');
select pg_temp.expect_error($$select register('甲', '', 99999)$$, '找不到');
select pg_temp.check(register('王小明', '岩館A', 1) = '王X明', '同名可報其他組');
select pg_temp.expect_error($$select register('王小明', '岩館A', 1)$$, '已經報名過');

select pg_temp.check((select array_agg(display_name order by id) from list_public_registrations()) = array['王X明','李X','王X明'], '公開名單為匿名');
select pg_temp.check((select bool_and(count = case name when '限額組' then 2 when '男子公開組' then 1 else 0 end) from list_categories()), '人數統計');
select pg_temp.expect_error('select * from registrations', 'permission denied');
select pg_temp.expect_error($$insert into registrations (name, category_id) values ('x', 1)$$, 'permission denied');
select pg_temp.expect_error($$insert into categories (name) values ('駭客組')$$, 'row-level security|permission denied');
do $$ begin update categories set is_open = false; exception when insufficient_privilege then null; end $$;  -- 被 RLS 或權限擋下
select pg_temp.check((select count(*) from categories where is_open) = 4, '訪客無法修改組別');
select pg_temp.expect_error('select * from admins', 'permission denied');
reset role;

-- ===== 已登入但不是管理員 =====
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select pg_temp.check((select count(*) from registrations) = 0, '非管理員看不到報名資料');
select pg_temp.check(not is_admin(), '非管理員 is_admin = false');
select pg_temp.expect_error($$insert into categories (name) values ('駭客組')$$, 'row-level security|permission denied');
select pg_temp.expect_error($$insert into admins values ('00000000-0000-0000-0000-000000000002')$$, 'row-level security|permission denied');

-- ===== 管理員 =====
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select pg_temp.check(is_admin(), '管理員 is_admin = true');
select pg_temp.check((select count(*) from registrations where name = '王小明') = 2, '管理員看得到真實姓名');
insert into categories (name, capacity) values ('新組別', 10);
update registrations set team = '岩館B' where name = '李四';
select pg_temp.check((select team from registrations where name = '李四') = '岩館B', '管理員可編輯報名');
select pg_temp.expect_error($$delete from categories where name = '限額組'$$, 'foreign key');
delete from registrations where name = '李四';
select pg_temp.check((select count(*) from registrations) = 2, '管理員可刪除報名');
reset role;

\echo 'ALL TESTS PASSED'
