# 攀岩比賽報名系統

參賽者可在網站上選擇組別報名，公開名單會顯示 **匿名姓名、組別、所屬團體**。
未來第二個頁面（`/results`）會依組別轉為比賽成績系統，目前先放置「建置中」頁面。

- **前端**：純 HTML/JS，部署在 **Netlify**
- **資料庫與登入**：**Supabase**（PostgreSQL + Auth）

## 功能

| 頁面 | 路徑 | 說明 |
| --- | --- | --- |
| 報名頁 | `/` | 填寫姓名、選擇組別、填寫所屬團體（選填）；下方為公開報名名單，可依組別篩選、搜尋 |
| 比賽成績 | `/results` | 預留給之後的成績系統 |
| 管理頁 | `/admin` | 管理員登入後可新增／編輯／刪除組別、設定人數上限、開關報名；查看真實姓名、編輯／刪除報名、匯出 CSV |

### 姓名匿名規則

| 原始姓名 | 公開顯示 |
| --- | --- |
| 王小明（三個字） | 王X明 |
| 王明（兩個字） | 王X |
| 歐陽小明（四個字以上） | 歐XX明（保留頭尾） |

### 資料安全

真實姓名只存在 `registrations` 資料表，這張表透過 Supabase 的 RLS（Row Level Security）**只允許管理員讀取**。
一般訪客只能呼叫兩個資料庫函式：

- `list_public_registrations()`：回傳 **已匿名** 的名單
- `register()`：報名（會檢查組別是否開放、名額、重複報名）

所以就算有人直接用 API 金鑰查資料庫，也拿不到真實姓名。

### 其他規則
- 同一組別中「姓名 + 所屬團體」相同視為重複報名，會被拒絕。
- 組別可設人數上限，額滿或關閉報名的組別無法選擇。
- 已有人報名的組別不能刪除（請改為關閉報名）。

---

## 部署步驟

### 1. 建立 Supabase 專案

1. 到 <https://supabase.com> 建立新專案。
2. 左側選 **SQL Editor** → **New query**，把 [`supabase/migrations/20261003000000_init.sql`](supabase/migrations/20261003000000_init.sql) 整份貼上，按 **Run**。
   會建立資料表、權限設定，以及三個範例組別（男子公開組、女子公開組、青少年組）。
3. **關閉公開註冊**（避免陌生人註冊帳號）：**Authentication → Sign In / Providers**，把 **Allow new users to sign up** 關掉。
4. **建立管理員帳號**：**Authentication → Users → Add user → Create new user**，輸入 Email 與密碼（勾選 Auto Confirm User）。
5. 把這個帳號設為管理員：回到 **SQL Editor** 執行（Email 換成你的）：
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
   之後要加其他管理員，重複步驟 4、5 即可。
6. 到 **Project Settings → API**（或 **Data API**），記下：
   - **Project URL**（例：`https://xxxx.supabase.co`）
   - **anon public** key

> anon key 是公開金鑰，本來就會出現在網頁裡；資料安全由上面的 RLS 規則保護。
> **千萬不要**把 `service_role` key 放到 Netlify 或前端。

### 2. 部署到 Netlify

1. 到 <https://app.netlify.com> → **Add new site → Import an existing project**，選這個 GitHub repo。
2. 建置設定會自動讀取 `netlify.toml`（Build command：`npm run build`，Publish directory：`public`），不用改。
3. **Site configuration → Environment variables** 新增：

   | Key | Value |
   | --- | --- |
   | `SUPABASE_URL` | 步驟 1-6 的 Project URL |
   | `SUPABASE_ANON_KEY` | 步驟 1-6 的 anon public key |

4. 按 **Deploy**。完成後打開網址就能報名，管理頁在 `/admin`。

修改環境變數後需要 **Trigger deploy** 重新部署才會生效。

---

## 本機開發

需要 Node.js 18 以上。

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=你的anon_key npm run dev
# 開啟 http://localhost:3000
```

## 測試

資料庫的權限與報名規則有自動化測試，用本機 PostgreSQL（14 以上）模擬 Supabase 環境執行：

```bash
npm run test:db
```

會檢查：匿名規則、報名檢查（名額、關閉、重複）、訪客讀不到真實姓名、訪客與一般登入者不能修改組別、管理員可讀寫。

## 專案結構

```
public/                    前端頁面（Netlify 發佈這個資料夾）
  index.html / index.js    報名頁
  admin.html / admin.js    管理頁
  results.html             比賽成績（預留）
  common.js                Supabase 連線與共用函式
scripts/build-config.js    由環境變數產生 public/config.js
supabase/migrations/       資料庫結構、權限、函式
supabase/tests/            資料庫測試
netlify.toml               Netlify 設定
```

## 之後的成績系統

`registrations` 已有每位選手的 `id` 與 `category_id`，之後可新增 `results` 資料表
（例如 `registration_id`、`route`、`tops`、`zones`、`attempts`），並用類似 `list_public_registrations()`
的函式在 `/results` 依組別公開匿名排名。
