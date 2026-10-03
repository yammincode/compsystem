'use strict';

const state = { categories: [], registrations: [], filter: 'all', search: '', editingReg: null };
const $ = (id) => document.getElementById(id);

function formatTime(utc) {
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  return isNaN(d) ? utc : d.toLocaleString('zh-TW', { hour12: false });
}

async function guard(box, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) return showLogin();
    showMsg(box, err.message, 'err');
  }
}

// ---------- 組別 ----------
function renderCategories() {
  const tbody = $('cat-list');
  if (!state.categories.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, '尚未建立任何組別')));
    return;
  }
  tbody.replaceChildren(...state.categories.map((c) => {
    const sort = el('input', { type: 'number', value: c.sort_order ?? 0, style: 'width:70px' });
    const name = el('input', { value: c.name, maxlength: 40 });
    const desc = el('input', { value: c.description, maxlength: 200 });
    const cap = el('input', { type: 'number', min: 1, value: c.capacity ?? '', placeholder: '不限', style: 'width:90px' });
    const open = el('input', { type: 'checkbox', checked: c.is_open });
    return el('tr', {},
      el('td', {}, sort), el('td', {}, name), el('td', {}, desc), el('td', {}, cap),
      el('td', {}, open),
      el('td', { class: 'num' }, c.count),
      el('td', {},
        el('button', { class: 'small secondary', onclick: () => guard($('cat-msg'), async () => {
          await api(`/api/admin/categories/${c.id}`, { method: 'PATCH', body: {
            name: name.value, description: desc.value, capacity: cap.value,
            is_open: open.checked, sort_order: Number(sort.value || 0),
          } });
          showMsg($('cat-msg'), `已儲存「${name.value}」`, 'ok');
          await load();
        }) }, '儲存'), ' ',
        el('button', { class: 'small danger', onclick: () => guard($('cat-msg'), async () => {
          if (!confirm(`確定刪除組別「${c.name}」？`)) return;
          await api(`/api/admin/categories/${c.id}`, { method: 'DELETE' });
          showMsg($('cat-msg'), `已刪除「${c.name}」`, 'ok');
          await load();
        }) }, '刪除'),
      ),
    );
  }));
}

$('cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('cat-msg'), async () => {
    await api('/api/admin/categories', { method: 'POST', body: {
      name: $('cat-name').value, description: $('cat-desc').value,
      capacity: $('cat-cap').value, sort_order: Number($('cat-sort').value || 0), is_open: true,
    } });
    showMsg($('cat-msg'), `已新增「${$('cat-name').value}」`, 'ok');
    e.target.reset();
    await load();
  });
});

// ---------- 報名資料 ----------
function renderTabs() {
  const mk = (key, label, count) => el('button', {
    type: 'button',
    class: state.filter === key ? 'active' : '',
    onclick: () => { state.filter = key; renderTabs(); renderRegistrations(); },
  }, label, ' ', el('span', { class: 'count' }, `(${count})`));
  $('tabs').replaceChildren(
    mk('all', '全部', state.registrations.length),
    ...state.categories.map((c) => mk(String(c.id), c.name, c.count)),
  );
}

function regRow(r, i) {
  if (state.editingReg === r.id) {
    const name = el('input', { value: r.name, maxlength: 30 });
    const team = el('input', { value: r.team, maxlength: 50 });
    const cat = el('select', {}, ...state.categories.map((c) =>
      el('option', { value: c.id, selected: c.id === r.category_id }, c.name)));
    return el('tr', {},
      el('td', { class: 'num' }, i + 1),
      el('td', {}, name), el('td', {}, '—'), el('td', {}, cat), el('td', {}, team),
      el('td', {}, formatTime(r.created_at)),
      el('td', {},
        el('button', { class: 'small', onclick: () => guard($('reg-msg'), async () => {
          await api(`/api/admin/registrations/${r.id}`, { method: 'PATCH',
            body: { name: name.value, team: team.value, category_id: cat.value } });
          state.editingReg = null;
          showMsg($('reg-msg'), '已更新報名資料', 'ok');
          await load();
        }) }, '儲存'), ' ',
        el('button', { class: 'small secondary', onclick: () => { state.editingReg = null; renderRegistrations(); } }, '取消'),
      ),
    );
  }
  return el('tr', {},
    el('td', { class: 'num' }, i + 1),
    el('td', {}, r.name),
    el('td', {}, r.display_name),
    el('td', {}, r.category_name),
    el('td', {}, r.team || '—'),
    el('td', {}, formatTime(r.created_at)),
    el('td', {},
      el('button', { class: 'small secondary', onclick: () => { state.editingReg = r.id; renderRegistrations(); } }, '編輯'), ' ',
      el('button', { class: 'small danger', onclick: () => guard($('reg-msg'), async () => {
        if (!confirm(`確定刪除 ${r.name}（${r.category_name}）的報名？`)) return;
        await api(`/api/admin/registrations/${r.id}`, { method: 'DELETE' });
        showMsg($('reg-msg'), `已刪除 ${r.name} 的報名`, 'ok');
        await load();
      }) }, '刪除'),
    ),
  );
}

function renderRegistrations() {
  const kw = state.search.trim().toLowerCase();
  const rows = state.registrations.filter((r) =>
    (state.filter === 'all' || String(r.category_id) === state.filter) &&
    (!kw || r.name.toLowerCase().includes(kw) || r.team.toLowerCase().includes(kw)));
  $('total').textContent = `共 ${rows.length} 人`;
  if (!rows.length) {
    $('reg-list').replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, '沒有符合的報名資料')));
    return;
  }
  $('reg-list').replaceChildren(...rows.map(regRow));
}

$('search').addEventListener('input', (e) => { state.search = e.target.value; renderRegistrations(); });

// ---------- 登入 / 載入 ----------
async function load() {
  const [categories, registrations] = await Promise.all([
    api('/api/admin/categories'),
    api('/api/admin/registrations'),
  ]);
  state.categories = categories;
  state.registrations = registrations;
  if (state.filter !== 'all' && !categories.some((c) => String(c.id) === state.filter)) state.filter = 'all';
  renderCategories();
  renderTabs();
  renderRegistrations();
}

function showLogin() {
  $('admin-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('password').focus();
}

async function showAdmin() {
  $('login-view').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  await guard($('reg-msg'), load);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    $('login-msg').className = 'msg';
    await showAdmin();
  } catch (err) {
    showMsg($('login-msg'), err.message, 'err');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

api('/api/admin/me').then(({ admin }) => (admin ? showAdmin() : showLogin())).catch(showLogin);
