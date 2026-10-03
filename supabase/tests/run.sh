#!/usr/bin/env bash
# 用本機 PostgreSQL 測試 Supabase migration（需要 PostgreSQL 14+）
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${TEST_DB:-compsystem_test}"
dropdb --if-exists "$DB" 2>/dev/null
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
PGOPTIONS="-c client_min_messages=warning" psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stub.sql
PGOPTIONS="-c client_min_messages=warning" psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/*_init.sql
PGOPTIONS="-c client_min_messages=warning" psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/*_init.sql   # 確認可重複執行
psql -q -X -t -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/db_test.sql 2>&1 | grep -v "^\s*$" | sed "s/^psql:[^ ]* NOTICE:  //"
