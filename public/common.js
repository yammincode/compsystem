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
const PROOF_BUCKET = 'payment-proofs';

const PG_ERRORS = {
  '23505': '資料重複（名稱或網址代碼已存在，或已報名過）',
  '23503': '還有相關資料，無法刪除（請先刪除底下的報名或組別，或改為關閉）',
  '23514': '欄位內容不符合規定（請檢查字數、格式或數字）',
  '42501': '沒有權限，請重新登入管理員',
  'PGRST116': '找不到資料或沒有權限，請重新整理頁面或重新登入',
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

function categoryStatus(c, competitionOpen = true) {
  if (!competitionOpen || !c.is_open) return { text: '已截止', cls: 'closed', available: false };
  if (c.capacity != null && c.count >= c.capacity) return { text: '已額滿', cls: 'full', available: false };
  const left = c.capacity != null ? `剩 ${c.capacity - c.count} 名` : '開放報名';
  return { text: left, cls: '', available: true };
}

const PAY_LABEL = { unpaid: '未繳費', pending: '審核中', paid: '已繳費' };
function payBadge(status) {
  return el('span', { class: `pay ${status}` }, PAY_LABEL[status] ?? status);
}

function formatTime(ts) {
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString('zh-TW', { hour12: false });
}

function formatDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).split('-').map(Number);
  const wd = '日一二三四五六'[new Date(y, m - 1, day).getDay()];
  return `${y}/${m}/${day}（${wd}）`;
}

function formatMoney(n) {
  return n == null ? '' : `NT$ ${Number(n).toLocaleString('zh-TW')}`;
}

// 簡章：Markdown → 過濾後的安全 HTML
function renderMarkdown(text) {
  const div = el('div', { class: 'prose' });
  if (window.marked && window.DOMPurify) {
    div.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? ''), { breaks: true }));
    div.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  } else {
    div.classList.add('pre-wrap');
    div.textContent = text ?? '';
  }
  return div;
}

// 手機照片通常很大：可解碼的圖片縮到 2000px 內轉 JPEG；其他檔案原樣上傳
async function prepareUpload(file) {
  const MAX = 5 * 1024 * 1024;
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const canvas = el('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (blob && blob.size < file.size) return { blob, ext: 'jpg', type: 'image/jpeg' };
    } catch { /* 無法解碼就用原檔 */ }
  }
  if (file.size > MAX) throw new Error('檔案太大，請小於 5MB');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const allowed = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };
  if (!allowed[ext]) throw new Error('只接受 JPG、PNG、WEBP、HEIC 圖片或 PDF');
  return { blob: file, ext, type: file.type || allowed[ext] };
}

// ---------- 網站設定（網站名稱、首頁文字、頁尾） ----------
const SITE_DEFAULTS = { site_name: '攀岩比賽', home_title: '比賽列表', home_intro: '選擇比賽查看簡章、報名與參加人員。', footer_text: '' };
let sitePromise = null;
function loadSite() {
  sitePromise ??= sb.from('site_settings').select('site_name, home_title, home_intro, footer_text').maybeSingle()
    .then(({ data }) => ({ ...SITE_DEFAULTS, ...(data ?? {}) }))
    .catch(() => ({ ...SITE_DEFAULTS }));
  return sitePromise;
}

// 前台共用：頁首名稱、頁尾（含工作人員登入入口）
async function applySite() {
  const site = await loadSite();
  document.querySelectorAll('[data-site-name]').forEach((n) => { n.textContent = site.site_name; });
  const footer = el('footer', { class: 'site-footer' },
    site.footer_text.trim() ? renderMarkdown(site.footer_text) : null,
    el('div', { class: 'footer-links' },
      el('span', {}, `© ${new Date().getFullYear()} ${site.site_name}`),
      el('a', { href: '/admin' }, '工作人員登入')));
  document.querySelector('footer.site-footer')?.remove();
  document.body.append(footer);
  return site;
}
