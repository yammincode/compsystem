'use strict';

// 與伺服器 lib/anonymize.js 相同的規則，只用來在表單上預覽匿名效果
function anonymizeName(name) {
  const chars = Array.from(String(name ?? '').trim());
  const n = chars.length;
  if (n <= 1) return chars.join('');
  if (n === 2) return chars[0] + 'X';
  return chars[0] + 'X'.repeat(n - 2) + chars[n - 1];
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `發生錯誤（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
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
