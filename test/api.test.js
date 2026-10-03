'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../lib/db');
const { createApp } = require('../server');

async function startServer() {
  const db = openDb(':memory:');
  const server = http.createServer(createApp({ db, adminPassword: 'secret' }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { server, call };
}

test('報名流程與匿名名單', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());

  // 未登入不能管理
  assert.equal((await call('POST', '/api/admin/categories', { name: 'A' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret' })).status, 200);

  const { data: { id: catId } } = await call('POST', '/api/admin/categories', { name: '男子組', capacity: 2 });
  const { data: { id: closedId } } = await call('POST', '/api/admin/categories', { name: '關閉組', is_open: false });
  assert.equal((await call('POST', '/api/admin/categories', { name: '男子組' })).status, 409);

  let r = await call('POST', '/api/registrations', { name: '王小明', team: '岩館A', category_id: catId });
  assert.equal(r.status, 201);
  assert.equal(r.data.display_name, '王X明');

  // 重複報名
  r = await call('POST', '/api/registrations', { name: '王小明', team: '岩館A', category_id: catId });
  assert.equal(r.status, 409);

  r = await call('POST', '/api/registrations', { name: '李四', team: '', category_id: catId });
  assert.equal(r.status, 201);

  // 名額已滿
  r = await call('POST', '/api/registrations', { name: '張三豐', category_id: catId });
  assert.equal(r.status, 409);

  // 關閉的組別
  r = await call('POST', '/api/registrations', { name: '張三豐', category_id: closedId });
  assert.equal(r.status, 409);

  // 缺姓名
  r = await call('POST', '/api/registrations', { name: '  ', category_id: catId });
  assert.equal(r.status, 400);

  // 公開名單不會洩漏真實姓名
  r = await call('GET', '/api/registrations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((x) => x.display_name), ['王X明', '李X']);
  assert.ok(!JSON.stringify(r.data).includes('王小明'));
  assert.ok(r.data.every((x) => !('name' in x)));
  assert.equal(r.data[0].team, '岩館A');
  assert.equal(r.data[0].category_name, '男子組');

  // 管理員看得到真實姓名
  r = await call('GET', '/api/admin/registrations');
  assert.deepEqual(r.data.map((x) => x.name), ['王小明', '李四']);

  // 有人報名的組別不能刪
  assert.equal((await call('DELETE', `/api/admin/categories/${catId}`)).status, 409);

  // CSV 匯出
  r = await call('GET', '/api/admin/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.data, /王小明/);

  // 登出後無法存取
  await call('POST', '/api/admin/logout');
  assert.equal((await call('GET', '/api/admin/registrations')).status, 401);
});

test('靜態頁面與路徑穿越防護', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  for (const p of ['/', '/admin', '/results']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js']) {
    const r = await call('GET', p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!String(r.data).includes('createApp'), p);
  }
});
