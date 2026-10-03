'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./lib/db');
const { anonymizeName } = require('./lib/anonymize');

const MAX_BODY = 64 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PAGES = {
  '/': 'index.html',
  '/admin': 'admin.html',
  '/results': 'results.html',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ db, adminPassword }) {
  const sessions = new Map(); // token -> expiresAt

  // ---------- helpers ----------
  function sendJson(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, '資料太大');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error();
      return data;
    } catch {
      throw new HttpError(400, '資料格式錯誤');
    }
  }

  function cleanText(value, { field, max, required = false }) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (required && !text) throw new HttpError(400, `請填寫${field}`);
    if (Array.from(text).length > max) throw new HttpError(400, `${field}最多 ${max} 個字`);
    return text;
  }

  function parseId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '無效的編號');
    return id;
  }

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function isAdmin(req) {
    const token = parseCookies(req).admin_session;
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) throw new HttpError(401, '請先登入管理員');
  }

  function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  // ---------- queries ----------
  const q = {
    categoriesWithCount: db.prepare(`
      SELECT c.id, c.name, c.description, c.capacity, c.is_open, c.sort_order,
             COUNT(r.id) AS count
        FROM categories c
        LEFT JOIN registrations r ON r.category_id = c.id
       GROUP BY c.id
       ORDER BY c.sort_order, c.id`),
    category: db.prepare('SELECT * FROM categories WHERE id = ?'),
    countInCategory: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE category_id = ?'),
    duplicate: db.prepare(
      'SELECT 1 FROM registrations WHERE category_id = ? AND name = ? AND team = ? AND id != ?'),
    registrations: db.prepare(`
      SELECT r.id, r.name, r.team, r.category_id, c.name AS category_name, r.created_at
        FROM registrations r
        JOIN categories c ON c.id = r.category_id
       ORDER BY c.sort_order, c.id, r.id`),
    insertReg: db.prepare('INSERT INTO registrations (name, team, category_id) VALUES (?, ?, ?)'),
    updateReg: db.prepare('UPDATE registrations SET name = ?, team = ?, category_id = ? WHERE id = ?'),
    deleteReg: db.prepare('DELETE FROM registrations WHERE id = ?'),
    registration: db.prepare('SELECT * FROM registrations WHERE id = ?'),
    insertCat: db.prepare(
      'INSERT INTO categories (name, description, capacity, is_open, sort_order) VALUES (?, ?, ?, ?, ?)'),
    updateCat: db.prepare(
      'UPDATE categories SET name = ?, description = ?, capacity = ?, is_open = ?, sort_order = ? WHERE id = ?'),
    deleteCat: db.prepare('DELETE FROM categories WHERE id = ?'),
  };

  function publicCategory(c) {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      capacity: c.capacity,
      is_open: !!c.is_open,
      count: c.count,
    };
  }

  function categoryInput(body, existing = {}) {
    const name = cleanText(body.name ?? existing.name, { field: '組別名稱', max: 40, required: true });
    const description = cleanText(body.description ?? existing.description, { field: '說明', max: 200 });
    let capacity = body.capacity === undefined ? existing.capacity ?? null : body.capacity;
    if (capacity === '' || capacity === null) capacity = null;
    else {
      capacity = Number(capacity);
      if (!Number.isInteger(capacity) || capacity < 1) throw new HttpError(400, '人數上限必須是正整數');
    }
    const isOpen = body.is_open === undefined ? (existing.is_open ?? 1) : (body.is_open ? 1 : 0);
    let sortOrder = body.sort_order === undefined ? existing.sort_order ?? 0 : Number(body.sort_order);
    if (!Number.isInteger(sortOrder)) throw new HttpError(400, '排序必須是整數');
    return [name, description, capacity, isOpen, sortOrder];
  }

  function registrationInput(body, existing = {}) {
    const name = cleanText(body.name ?? existing.name, { field: '姓名', max: 30, required: true });
    const team = cleanText(body.team ?? existing.team, { field: '所屬團體', max: 50 });
    const categoryId = parseId(body.category_id ?? existing.category_id);
    return { name, team, categoryId };
  }

  // 在交易內檢查組別狀態、名額與重複報名
  function checkRegistration({ name, team, categoryId }, { selfId = 0, enforceOpen }) {
    const category = q.category.get(categoryId);
    if (!category) throw new HttpError(400, '找不到這個組別');
    if (enforceOpen && !category.is_open) throw new HttpError(409, '這個組別目前不開放報名');
    if (q.duplicate.get(categoryId, name, team, selfId)) {
      throw new HttpError(409, '這位選手已經報名過這個組別了');
    }
    if (category.capacity != null) {
      const { n } = q.countInCategory.get(categoryId);
      const moving = selfId ? q.registration.get(selfId)?.category_id !== categoryId : true;
      if (moving && n >= category.capacity) throw new HttpError(409, '這個組別名額已滿');
    }
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止 CSV 公式注入
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // ---------- routes ----------
  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    let m;

    // ---- public ----
    if (pathname === '/api/categories' && method === 'GET') {
      return sendJson(res, 200, q.categoriesWithCount.all().map(publicCategory));
    }

    if (pathname === '/api/registrations' && method === 'GET') {
      // 公開名單：只回傳匿名後的姓名，真實姓名絕不離開伺服器
      const list = q.registrations.all().map((r) => ({
        id: r.id,
        display_name: anonymizeName(r.name),
        team: r.team,
        category_id: r.category_id,
        category_name: r.category_name,
        created_at: r.created_at,
      }));
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/registrations' && method === 'POST') {
      const input = registrationInput(await readJson(req));
      const id = transaction(() => {
        checkRegistration(input, { enforceOpen: true });
        return Number(q.insertReg.run(input.name, input.team, input.categoryId).lastInsertRowid);
      });
      return sendJson(res, 201, { id, display_name: anonymizeName(input.name) });
    }

    // ---- admin auth ----
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await readJson(req);
      if (!safeEqual(body.password ?? '', adminPassword)) {
        await new Promise((r) => setTimeout(r, 500));
        throw new HttpError(401, '密碼錯誤');
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      sessions.delete(parseCookies(req).admin_session);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
    }

    if (pathname === '/api/admin/me' && method === 'GET') {
      return sendJson(res, 200, { admin: isAdmin(req) });
    }

    // ---- admin (需登入) ----
    if (pathname.startsWith('/api/admin/')) requireAdmin(req);

    if (pathname === '/api/admin/categories' && method === 'GET') {
      const list = q.categoriesWithCount.all().map((c) => ({ ...publicCategory(c), sort_order: c.sort_order }));
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/admin/categories' && method === 'POST') {
      const values = categoryInput(await readJson(req));
      try {
        const info = q.insertCat.run(...values);
        return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new HttpError(409, '組別名稱重複');
        throw err;
      }
    }

    if ((m = pathname.match(/^\/api\/admin\/categories\/(\d+)$/))) {
      const id = parseId(m[1]);
      const existing = q.category.get(id);
      if (!existing) throw new HttpError(404, '找不到這個組別');

      if (method === 'PATCH') {
        const values = categoryInput(await readJson(req), existing);
        try {
          q.updateCat.run(...values, id);
        } catch (err) {
          if (/UNIQUE/.test(err.message)) throw new HttpError(409, '組別名稱重複');
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'DELETE') {
        if (q.countInCategory.get(id).n > 0) {
          throw new HttpError(409, '這個組別已經有人報名，請先移除報名資料或改為「關閉報名」');
        }
        q.deleteCat.run(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/admin/registrations' && method === 'GET') {
      const list = q.registrations.all().map((r) => ({ ...r, display_name: anonymizeName(r.name) }));
      return sendJson(res, 200, list);
    }

    if ((m = pathname.match(/^\/api\/admin\/registrations\/(\d+)$/))) {
      const id = parseId(m[1]);
      const existing = q.registration.get(id);
      if (!existing) throw new HttpError(404, '找不到這筆報名');

      if (method === 'PATCH') {
        const input = registrationInput(await readJson(req), existing);
        transaction(() => {
          checkRegistration(input, { selfId: id, enforceOpen: false });
          q.updateReg.run(input.name, input.team, input.categoryId, id);
        });
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'DELETE') {
        q.deleteReg.run(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/admin/export.csv' && method === 'GET') {
      const rows = [['編號', '組別', '姓名', '匿名顯示', '所屬團體', '報名時間(UTC)']];
      for (const r of q.registrations.all()) {
        rows.push([r.id, r.category_name, r.name, anonymizeName(r.name), r.team, r.created_at]);
      }
      const csv = '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="registrations.csv"',
        'Cache-Control': 'no-store',
      });
      return res.end(csv);
    }

    throw new HttpError(404, '找不到這個 API');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    const rel = PAGES[url.pathname] ?? url.pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('找不到頁面');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: '伺服器錯誤，請稍後再試' });
    }
  };
}

function seedDefaults(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n > 0) return;
  const insert = db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)');
  [
    ['男子公開組', '', 1],
    ['女子公開組', '', 2],
    ['青少年組', '18 歲以下', 3],
  ].forEach((row) => insert.run(...row));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'compsystem.db');
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(6).toString('hex');
    console.warn(`[警告] 未設定 ADMIN_PASSWORD，本次啟動的管理員密碼為：${adminPassword}`);
  }
  const db = openDb(dbFile);
  seedDefaults(db);
  http.createServer(createApp({ db, adminPassword })).listen(port, () => {
    console.log(`攀岩比賽報名系統已啟動： http://localhost:${port}`);
    console.log(`管理頁面： http://localhost:${port}/admin`);
  });
}

module.exports = { createApp, seedDefaults };
