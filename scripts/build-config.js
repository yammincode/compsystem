'use strict';
// 由環境變數產生 public/config.js（Netlify 建置時會自動執行）
// SUPABASE_ANON_KEY 是公開金鑰，本來就會出現在前端；資料安全由資料庫的 RLS 把關。
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('請設定環境變數 SUPABASE_URL 與 SUPABASE_ANON_KEY');
  process.exit(1);
}
const out = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(out, `window.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2)};\n`);
console.log(`已產生 ${path.relative(process.cwd(), out)}`);
