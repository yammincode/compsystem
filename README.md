# 攀岩比賽報名系統

參賽者可在網站上選擇組別報名，公開名單會顯示 **匿名姓名、組別、所屬團體**。
未來第二個頁面（`/results`）會依組別轉為比賽成績系統，目前先放置「建置中」頁面。

- **前端**：純 HTML/JS，部署在 **Netlify**
- **資料庫與登入**：**Supabase**（PostgreSQL + Auth）

## 功能

### 公開頁面

| 頁面 | 路徑 | 說明 |
| --- | --- | --- |
| 比賽列表 | `/` | 所有公開的比賽 |
| 比賽簡章 | `/c/<比賽代碼>` | 日期、地點、報名費、簡章內容（Markdown）、組別與名額 |
| 報名 | `/c/<比賽代碼>/register` | 填寫姓名、組別、所屬團體；報名成功後可直接填寫繳費資訊 |
| 參加人員 | `/c/<比賽代碼>/participants` | 匿名姓名、組別、團體、繳費狀態；點「未繳費」可填寫繳費資訊 |
| 成績 | `/c/<比賽代碼>/results` | 預留給之後的成績系統 |

### 管理頁 `/admin`

- 切換比賽、新增比賽（每場比賽有自己的網址代碼，例如 `2026-spring`）
- 比賽設定：名稱、日期、地點、報名費、匯款方式、簡章、是否公開、是否開放報名
- 組別：新增／編輯／刪除、人數上限、開關報名
- 繳費審核：查看選手送出的帳號後五碼、金額、日期、截圖，按「確認收款」或「退回」
- 報名資料：真實姓名、直接修改繳費狀態（例如現場收現金）、繳費紀錄、編輯／刪除、匯出 CSV

### 繳費流程

```
未繳費 ──選手送出繳費資訊──▶ 審核中 ──管理員確認收款──▶ 已繳費
   ▲                           │
   └──────管理員退回────────────┘
```

- 選手送出時必須輸入**報名時的真實姓名**核對，避免別人代填。
- 匯款截圖存在 Supabase Storage 的**私人** bucket，只有管理員能查看。

### 姓名匿名規則

| 原始姓名 | 公開顯示 |
| --- | --- |
| 王小明（三個字） | 王X明 |
| 王明（兩個字） | 王X |
| 歐陽小明（四個字以上） | 歐XX明（保留頭尾） |

### 資料安全

真實姓名與匯款資料只存在 `registrations`、`payments` 資料表，透過 Supabase 的 RLS（Row Level Security）**只允許管理員讀取**。
一般訪客只能透過資料庫函式取得**已匿名**的名單、報名、送出繳費資訊；未公開的比賽訪客完全看不到。

### 其他規則
- 同一組別中「姓名 + 所屬團體」相同視為重複報名，會被拒絕。
- 組別可設人數上限，額滿或關閉報名的組別無法選擇。
- 已有人報名的組別不能刪除；有組別的比賽不能刪除（請改為不公開或關閉報名）。

---

## 部署步驟

### 1. 建立 Supabase 專案

1. 到 <https://supabase.com> 建立新專案。
2. 左側選 **SQL Editor** → **New query**，依序執行 `supabase/migrations/` 裡的檔案（每份整份貼上，按 **Run**）：
   1. [`20261003000000_init.sql`](supabase/migrations/20261003000000_init.sql)：報名資料表與權限
   2. [`20261004000000_competitions_payments.sql`](supabase/migrations/20261004000000_competitions_payments.sql)：多場比賽、繳費、截圖上傳

   > 已經上線過第一版的專案，只要執行第 2 份；原本的組別與報名會自動歸到一場「攀岩比賽」（網址代碼 `climbing-2026`），可在管理頁改名。
   > **不要**再重新執行第 1 份。
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

會檢查：第一版資料升級、匿名規則、報名檢查（名額、關閉、重複、未公開比賽）、繳費資訊送出與審核、截圖上傳權限、訪客與一般登入者讀不到真實姓名與匯款資料、管理員可讀寫。

## 專案結構

```
public/                         前端頁面（Netlify 發佈這個資料夾）
  index.html / index.js         比賽列表
  competition.html / .js        比賽頁（簡章、報名、參加人員、成績）
  admin.html / admin.js         管理頁
  common.js                     Supabase 連線與共用函式
scripts/build-config.js    由環境變數產生 public/config.js
supabase/migrations/       資料庫結構、權限、函式
supabase/tests/            資料庫測試
netlify.toml               Netlify 設定
```

## 之後的成績系統

`registrations` 已有每位選手的 `id` 與 `category_id`（組別屬於某場比賽），之後可新增 `results` 資料表
（例如 `registration_id`、`route`、`tops`、`zones`、`attempts`），並用類似 `list_public_registrations()`
的函式在 `/c/<比賽代碼>/results` 依組別公開匿名排名。
