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

// ---------- 年齡 ----------
function todayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// 以 ref 日期計算足歲（與資料庫 age_on() 相同）
function ageOn(birth, ref = todayStr()) {
  if (!birth) return null;
  const [by, bm, bd] = birth.split('-').map(Number);
  const [ry, rm, rd] = ref.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

// ---------- 手寫簽名板 ----------
function createSignaturePad(canvas, { onChange } = {}) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let points = 0;
  let last = null;

  function setup() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    points = 0;
    onChange?.(false);
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    points += 1;
    if (points === 1) onChange?.(true);
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    setup,
    clear: setup,
    // 筆畫太少視為沒簽
    isEmpty: () => points < 8,
    // 輸出白底 PNG（寬 600px），檔案小、在深色模式也看得清楚
    toDataURL() {
      const out = document.createElement('canvas');
      out.width = 600;
      out.height = Math.round(600 * (canvas.height / canvas.width));
      const o = out.getContext('2d');
      o.fillStyle = '#fff';
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    },
  };
}

// ---------- 年級（台灣學制，9/1 前出生者早一年入學） ----------
// 比賽日期在 8 月以後算當年度學年，否則算前一年度。例：2026/11 → 115 學年度（2026 年 8 月起）
function schoolYearStart(ref = todayStr()) {
  const [y, m] = ref.split('-').map(Number);
  return m >= 8 ? y : y - 1;
}

// 以 ref 日期所在學年計算年級：1 = 國小一年級 … 12 = 高中三年級
function gradeOn(birth, ref = todayStr()) {
  if (!birth) return null;
  const [by, bm, bd] = birth.split('-').map(Number);
  const early = bm < 9 || (bm === 9 && bd <= 1);
  return schoolYearStart(ref) - by - 6 + (early ? 1 : 0);
}

function rocYear(ref = todayStr()) {
  return schoolYearStart(ref) - 1911;
}

function gradeLabel(g) {
  if (g == null) return '';
  if (g < 1) return '學齡前';
  if (g <= 6) return `國小 ${g} 年級`;
  if (g <= 9) return `國中 ${g - 6} 年級`;
  if (g <= 12) return `高中 ${g - 9} 年級`;
  return '高中畢業以上';
}

function gradeRangeLabel(min, max) {
  if (min == null && max == null) return '';
  const lo = Math.max(1, min ?? 1);
  const hi = Math.min(12, max ?? 12);
  const stage = (g) => (g <= 6 ? ['國小', g] : g <= 9 ? ['國中', g - 6] : ['高中', g - 9]);
  const [s1, n1] = stage(lo);
  const [s2, n2] = stage(hi);
  if (lo === hi) return `${s1} ${n1} 年級`;
  if (s1 === s2) return `${s1} ${n1}–${n2} 年級`;
  return `${s1} ${n1} 年級–${s2} ${n2} 年級`;
}

// 依年級找組別：只有一個符合時回傳該組別；多個符合（例如分男女組）回傳 null 並告知數量
function categoryForGrade(categories, grade, isAvailable = () => true) {
  if (grade == null) return { match: null, count: 0 };
  const hits = categories.filter((c) => (c.grade_min != null || c.grade_max != null)
    && grade >= (c.grade_min ?? 1) && grade <= (c.grade_max ?? 12) && isAvailable(c));
  return { match: hits.length === 1 ? hits[0] : null, count: hits.length };
}

// 頁首 logo（原岩：山形圖示）
function brandLogo() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 20 L10 6 L14 13 L17 9 L21 20 Z');
  svg.append(path);
  return el('span', { class: 'logo' }, svg);
}
document.querySelectorAll('header.site .brand').forEach((a) => a.prepend(brandLogo()));

// ---------- 繳費資訊對話框（比賽頁、系列賽頁共用） ----------
// 需要頁面上有 #pay-dialog 的 HTML。open(reg, { fullName, amount, instructions, label })
function createPayDialog({ onDone } = {}) {
  const dlg = document.getElementById('pay-dialog');
  const q = (id) => document.getElementById(id);
  let target = null;

  function open(reg, { fullName = '', amount = null, instructions = '', label = '' } = {}) {
    target = reg;
    q('pay-form').reset();
    q('pay-msg').className = 'msg';
    q('pay-submit').disabled = false;
    q('pay-who').replaceChildren('報名資料：', el('strong', {}, reg.display_name), `　${label || reg.category_name || ''}`,
      reg.is_package ? el('div', { class: 'muted' }, '套票只要繳一次，確認後所有場次都會變成已繳費。') : null);
    const instr = (instructions || '').trim();
    q('pay-instructions').textContent = instr ? `匯款方式：\n${instr}` : '';
    q('pay-instructions').classList.toggle('hidden', !instr);
    q('pay-name').value = fullName;
    q('pay-amount').value = amount ?? '';
    const local = todayStr();
    q('pay-date').value = local;
    q('pay-date').max = local;
    dlg.showModal();
    if (!fullName) q('pay-name').focus();
  }

  q('pay-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 點背景關閉

  q('pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = q('pay-submit');
    btn.disabled = true;
    btn.textContent = '送出中…';
    const reg = target;
    try {
      let proofPath = null;
      const file = q('pay-file').files[0];
      if (file) {
        btn.textContent = '上傳截圖中…';
        const { blob, ext, type } = await prepareUpload(file);
        proofPath = `${reg.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await sb.storage.from(PROOF_BUCKET).upload(proofPath, blob, { contentType: type });
        if (error) throw new Error(`截圖上傳失敗：${error.message}`);
      }
      check(await sb.rpc('submit_payment', {
        p_registration_id: reg.id,
        p_full_name: q('pay-name').value,
        p_account_last5: q('pay-last5').value.trim(),
        p_amount: Number(q('pay-amount').value),
        p_paid_on: q('pay-date').value,
        p_note: q('pay-note').value,
        p_proof_path: proofPath,
      }));
      dlg.close();
      await onDone?.(reg);
      alert(`已送出 ${reg.display_name} 的繳費資訊，工作人員確認後會改為「已繳費」。`);
    } catch (err) {
      showMsg(q('pay-msg'), err.message, 'err');
      btn.disabled = false;
    } finally {
      btn.textContent = '送出';
    }
  });

  return { open };
}

// ---------- 系列賽（首頁主視覺、系列賽頁共用） ----------
// 各站顏色：南港深青綠、明德酒紅、中壢石板藍、新店深藍綠、萬華紫；最後一站（決賽）用中和亮青
const STATION_COLORS = ['#066d6a', '#6d3540', '#304562', '#006382', '#6959b2'];
const stationColor = (i) => STATION_COLORS[i % STATION_COLORS.length];
const isFinalStation = (i, n) => n >= 3 && i === n - 1;
const SERIES_FIELDS = 'id, slug, title, tagline, intro, package_fee, package_open, payment_instructions, is_published';
const SERIES_COMP_FIELDS = 'id, slug, title, event_date, location, fee, registration_open, is_published, minor_consent, payment_instructions, series_id, series_order';

async function loadSeriesComps(seriesId) {
  return check(await sb.from('competitions').select(SERIES_COMP_FIELDS)
    .eq('series_id', seriesId)
    .order('series_order').order('event_date', { nullsFirst: false }).order('id'));
}

function packageInfo(series, comps) {
  const fees = comps.map((c) => c.fee).filter((f) => f != null);
  const singleTotal = fees.length === comps.length ? fees.reduce((a, b) => a + b, 0) : null;
  const sameFee = fees.length === comps.length && fees.every((f) => f === fees[0]) ? fees[0] : null;
  const available = series.package_fee != null && series.package_open && comps.length >= 2
    && comps.every((c) => c.registration_open);
  const saving = available && singleTotal != null ? singleTotal - series.package_fee : 0;
  return { available, fee: series.package_fee, singleTotal, sameFee, saving };
}

function stationLabel(i, n) {
  return isFinalStation(i, n) ? 'FINAL' : `STATION ${String(i + 1).padStart(2, '0')}`;
}

// 主視覺：左邊標題與按鈕，右邊各站一覽。onSeriesPage = 按鈕捲到本頁區塊
function renderSeriesHero(series, comps, { onSeriesPage = false } = {}) {
  const pkg = packageInfo(series, comps);
  const base = `/s/${series.slug}`;
  const anyOpen = comps.some((c) => c.registration_open);
  return el('section', { class: 'hero' },
    el('div', { class: 'inner' },
      el('div', { class: 'copy' },
        el('span', { class: 'pill' }, anyOpen ? '報名開放中' : '報名已截止'),
        el(onSeriesPage ? 'h1' : 'h2', { style: onSeriesPage ? '' : 'font-size:inherit;margin:0' },
          onSeriesPage ? series.title : el('a', { class: 'hero-title', href: base, style: 'color:inherit;text-decoration:none' }, series.title)),
        series.tagline ? el('p', { class: 'tag' }, series.tagline) : null,
        el('div', { class: 'cta' },
          pkg.available ? el('a', { class: 'btn on-hero', href: onSeriesPage ? '#register' : `${base}/register` },
            `${comps.length} 場套票 ${formatMoney(pkg.fee)}`) : null,
          el('a', { class: `btn ${pkg.available ? 'on-hero-outline' : 'on-hero'}`, href: onSeriesPage ? '#stations' : base },
            pkg.sameFee != null ? `報名單場 ${formatMoney(pkg.sameFee)}` : (onSeriesPage ? '選擇單場報名' : '查看賽程與報名'))),
        pkg.available && pkg.saving > 0 ? el('span', { class: 'deadline' }, `套票比單場分開報名省 ${formatMoney(pkg.saving)}`) : null),
      comps.length ? el('div', { class: 'stops' },
        el('div', { class: 'label' }, `${comps.length} 站一覽`),
        ...comps.map((c, i) => el('a', { class: 'stop-row', href: `/c/${c.slug}` },
          el('span', { class: 'dot', style: `background:${isFinalStation(i, comps.length) ? 'var(--bright)' : stationColor(i)}` }),
          el('span', { class: 'name' }, c.title),
          el('span', { class: 'when' }, c.event_date ? formatDate(c.event_date) : '日期待定')))) : null));
}
