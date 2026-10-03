#!/usr/bin/env bash
# 用本機 PostgreSQL 測試 Supabase migration（需要 PostgreSQL 14+）
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${TEST_DB:-compsystem_test}"
export PGOPTIONS="-c client_min_messages=warning"
run() { psql -q -X -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

dropdb --if-exists "$DB" 2>/dev/null
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT

run -f supabase/tests/supabase_stub.sql
run -f supabase/migrations/20261003000000_init.sql
# 模擬第一版上線後已有的報名資料
run -c "insert into public.registrations (name, team, category_id) values ('舊資料', '', 1)"
run -f supabase/migrations/20261004000000_competitions_payments.sql
run -f supabase/migrations/20261005000000_staff_roles.sql
run -f supabase/migrations/20261006000000_site_settings.sql
# migration 必須可重複執行
run -f supabase/migrations/20261004000000_competitions_payments.sql
run -f supabase/migrations/20261005000000_staff_roles.sql
run -f supabase/migrations/20261006000000_site_settings.sql

PGOPTIONS="-c client_min_messages=notice" psql -q -X -t -v ON_ERROR_STOP=1 -d "$DB" \
  -f supabase/tests/db_test.sql 2>&1 | grep -v "^\s*$" | sed "s/^psql:[^ ]* NOTICE:  //"
exit "${PIPESTATUS[0]}"
