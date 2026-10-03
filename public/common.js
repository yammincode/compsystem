'use strict';

// ---------- Supabase ----------
const cfg = window.APP_CONFIG || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('main')?.prepend(el('div', { class: 'msg show err' },
      '尚未設定 Supabase：請設定 SUPABASE_URL 與 SUPABASE_ANON_KEY 後重新建置（見 README）。'));
  });
}
const sb = window.supabase.createClient(cfg.supabaseUrl || 'http://invalid.local', cfg.supabaseAnonKey || 'missing');

const PG_ERRORS = {
  '23505': '資料重複（名稱已存在或已報名過）',
  '23503': '這個組別已經有人報名，請先移除報名資料或改為「關閉報名」',
  '23514': '欄位內容不符合規定（請檢查字數或人數上限）',
  '42501': '沒有權限，請重新登入管理員',
};

// 把 Supabase 回傳的錯誤轉成中文訊息後丟出
function check({ data, error }) {
  if (error) {
    const err = new Error(PG_ERRORS[error.code] || error.message || '發生錯誤，請稍後再試');
    err.code = error.code;
    throw err;
  }
  return data;
}

// 與資料庫 anonymize_name() 相同的規則，只用來在表單上預覽匿名效果
function anonymizeName(name) {
  const chars = Array.from(String(name ?? '').trim());
  const n = chars.length;
  if (n <= 1) return chars.join('');
  if (n === 2) return chars[0] + 'X';
  return chars[0] + 'X'.repeat(n - 2) + chars[n - 1];
}

// 建立 DOM 元素；所有文字都用 textContent 放入，避免 XSS
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function showMsg(box, text, type) {
  box.textContent = text;
  box.className = `msg show ${type}`;
}

function categoryStatus(c) {
  if (!c.is_open) return { text: '已截止', cls: 'closed', available: false };
  if (c.capacity != null && c.count >= c.capacity) return { text: '已額滿', cls: 'full', available: false };
  const left = c.capacity != null ? `剩 ${c.capacity - c.count} 名` : '開放報名';
  return { text: left, cls: '', available: true };
}

function formatTime(ts) {
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString('zh-TW', { hour12: false });
}
