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
| 報名 | `/c/<比賽代碼>/register` | 填寫姓名、組別、出生日期、所屬團體；未滿 18 歲需家長線上簽署同意書；報名成功後可直接填寫繳費資訊 |
| 參加人員 | `/c/<比賽代碼>/participants` | 匿名姓名、組別、團體、繳費狀態；點「未繳費」可填寫繳費資訊 |
| 成績 | `/c/<比賽代碼>/results` | 預留給之後的成績系統 |

### 管理後台 `/admin`（手機、電腦都能用）

工作人員用 Email + 密碼登入（前台每一頁最下方都有「工作人員登入」連結）。手機版下方有分頁列，電腦版在左側。

| 分頁 | 內容 |
| --- | --- |
| 📊 總覽 | 報名人數、已繳費／待審核／未繳費、已確認收款金額、各組名額進度、最新報名、比賽網址 |
| 👥 報名 | 依繳費狀態、組別篩選與搜尋；點選手可編輯資料、改繳費狀態（現場收現金）、看繳費紀錄、刪除；「代為報名」；匯出 CSV |
| 💰 繳費 | 待審核的繳費資料（可直接看截圖），按「確認收款」或「退回」 |
| ⚙️ 比賽設定 | 比賽名稱、網址代碼、日期、地點、報名費、匯款方式、簡章、公開／開放報名、組別 |
| ☰ 更多 | 網站設定（網站名稱、首頁標題與說明、頁尾文字）；修改自己的密碼、登出；工作人員名單（管理員可新增、改角色、重設密碼、移除） |

上方可切換比賽或按「＋ 新比賽」。

#### 角色

| 角色 | 可以做的事 |
| --- | --- |
| 管理員 | 全部功能，包含管理工作人員帳號、刪除比賽 |
| 工作人員 | 修改比賽內容與組別、報名資料、審核繳費、查看統計 |

### 未成年家長同意書

- 報名時必填出生日期，以**比賽日期**計算年齡（未設定比賽日期則以報名當天計算）。
- 比賽當天未滿 18 歲，報名表會出現「家長同意書」：家長閱讀同意書、填寫姓名與關係、在手機螢幕上手寫簽名、勾選同意，才能送出。資料庫端也會再檢查一次。
- 同意書內容在後台「比賽設定 → 未成年家長同意書」修改，每場比賽各自一份；簽署時會保存當下的全文，之後修改不影響已簽的版本。
- 後台報名名單會標示「未成年」與「家長已簽／缺家長同意書」，點開可看簽名圖與同意書全文；CSV 也會匯出生日、年齡、家長資料。
- 出生日期、家長資料與簽名只有工作人員看得到，公開名單不會顯示。

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
   3. [`20261005000000_staff_roles.sql`](supabase/migrations/20261005000000_staff_roles.sql)：工作人員角色（管理員／工作人員）
   4. [`20261006000000_site_settings.sql`](supabase/migrations/20261006000000_site_settings.sql)：網站設定（網站名稱、首頁文字、頁尾）
   5. [`20261007000000_minor_consent.sql`](supabase/migrations/20261007000000_minor_consent.sql)：出生日期、未成年家長同意書（線上簽名）

   > 已經上線過的專案，只要執行還沒跑過的那幾份（**不要**再重新執行第 1 份）。
   > 第 2 份會把原本的組別與報名歸到一場「攀岩比賽」（網址代碼 `climbing-2026`）；第 3 份會把原本的管理員設為「管理員」角色。
3. **關閉公開註冊**（避免陌生人註冊帳號）：**Authentication → Sign In / Providers**，把 **Allow new users to sign up** 關掉。
4. **建立管理員帳號**：**Authentication → Users → Add user → Create new user**，輸入 Email 與密碼（勾選 Auto Confirm User）。
5. 把這個帳號設為管理員：回到 **SQL Editor** 執行（Email 換成你的）：
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
   之後要加其他管理員，重複步驟 4、5 即可。
6. 到 **Project Settings → API**（或 **Data API**／**API Keys**），記下：
   - **Project URL**（例：`https://xxxx.supabase.co`）
   - **anon public** key（或 **Publishable key**）
   - **service_role** key（或 **Secret key**）：只給 Netlify 伺服器端用，讓管理員能在後台直接建立工作人員帳號

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
   | `SUPABASE_SERVICE_ROLE_KEY` | 步驟 1-6 的 service_role／Secret key（**要勾選「Contains secret values」**） |

   `SUPABASE_SERVICE_ROLE_KEY` 只在伺服器端（`netlify/functions/staff.mjs`）使用，不會出現在網頁裡。
   沒有設定的話，後台仍可運作，只是新增工作人員時要先到 Supabase **Authentication → Users** 建立帳號，再到後台輸入 Email 加入。

4. 按 **Deploy**。完成後打開網址就能報名，管理頁在 `/admin`。

修改環境變數後需要 **Trigger deploy** 重新部署才會生效。

---

## 本機開發

需要 Node.js 18 以上。

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=你的anon_key npm run dev
# 開啟 http://localhost:3000
```

`npm run dev` 只有網頁，沒有 `/api/staff`（新增工作人員帳號）。要連同伺服器端功能一起測試，請用 [Netlify CLI](https://docs.netlify.com/cli/get-started/) 的 `netlify dev`。

## 測試

資料庫的權限與報名規則有自動化測試，用本機 PostgreSQL（14 以上）模擬 Supabase 環境執行：

```bash
npm run test:db
```

會檢查：工作人員角色權限、第一版資料升級、匿名規則、報名檢查（名額、關閉、重複、未公開比賽）、繳費資訊送出與審核、截圖上傳權限、訪客與一般登入者讀不到真實姓名與匯款資料、管理員可讀寫。

## 專案結構

```
public/                         前端頁面（Netlify 發佈這個資料夾）
  index.html / index.js         比賽列表
  competition.html / .js        比賽頁（簡章、報名、參加人員、成績）
  admin.html / admin.js         管理後台
  common.js                     Supabase 連線與共用函式
netlify/functions/staff.mjs     建立／重設密碼／刪除工作人員帳號（伺服器端）
scripts/build-config.js    由環境變數產生 public/config.js
supabase/migrations/       資料庫結構、權限、函式
supabase/tests/            資料庫測試
netlify.toml               Netlify 設定
```

## 之後的成績系統

`registrations` 已有每位選手的 `id` 與 `category_id`（組別屬於某場比賽），之後可新增 `results` 資料表
（例如 `registration_id`、`route`、`tops`、`zones`、`attempts`），並用類似 `list_public_registrations()`
的函式在 `/c/<比賽代碼>/results` 依組別公開匿名排名。
