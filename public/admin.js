'use strict';

const state = { categories: [], registrations: [], filter: 'all', search: '', editingReg: null };
const $ = (id) => document.getElementById(id);

async function guard(box, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === '42501' || err.code === 'PGRST301') return showLogin();
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
          check(await sb.from('categories').update({
            name: name.value.trim(), description: desc.value.trim(),
            capacity: cap.value ? Number(cap.value) : null,
            is_open: open.checked, sort_order: Number(sort.value || 0),
          }).eq('id', c.id));
          showMsg($('cat-msg'), `已儲存「${name.value}」`, 'ok');
          await load();
        }) }, '儲存'), ' ',
        el('button', { class: 'small danger', onclick: () => guard($('cat-msg'), async () => {
          if (!confirm(`確定刪除組別「${c.name}」？`)) return;
          check(await sb.from('categories').delete().eq('id', c.id));
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
    check(await sb.from('categories').insert({
      name: $('cat-name').value.trim(), description: $('cat-desc').value.trim(),
      capacity: $('cat-cap').value ? Number($('cat-cap').value) : null,
      sort_order: Number($('cat-sort').value || 0), is_open: true,
    }));
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
          if (!name.value.trim()) throw new Error('請填寫姓名');
          check(await sb.from('registrations').update({
            name: name.value.trim(), team: team.value.trim(), category_id: Number(cat.value),
          }).eq('id', r.id));
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
        check(await sb.from('registrations').delete().eq('id', r.id));
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
    sb.rpc('list_categories').then(check),
    sb.from('registrations')
      .select('id, name, team, category_id, created_at, categories(name, sort_order)')
      .then(check),
  ]);
  state.categories = categories;
  state.registrations = registrations
    .map((r) => ({
      ...r,
      category_name: r.categories?.name ?? '',
      sort: r.categories?.sort_order ?? 0,
      display_name: anonymizeName(r.name),
    }))
    .sort((a, b) => a.sort - b.sort || a.category_id - b.category_id || a.id - b.id);
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
    check(await sb.auth.signInWithPassword({ email: $('email').value, password: $('password').value }));
    $('password').value = '';
    if (!check(await sb.rpc('is_admin'))) {
      await sb.auth.signOut();
      throw new Error('這個帳號不是管理員');
    }
    $('login-msg').className = 'msg';
    await showAdmin();
  } catch (err) {
    if (/Invalid login/i.test(err.message)) err.message = 'Email 或密碼錯誤';
    showMsg($('login-msg'), err.message, 'err');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut().catch(() => {});
  showLogin();
});

// ---------- 匯出 CSV ----------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止 CSV 公式注入
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$('export-btn').addEventListener('click', () => {
  const rows = [['編號', '組別', '姓名', '匿名顯示', '所屬團體', '報名時間']];
  for (const r of state.registrations) {
    rows.push([r.id, r.category_name, r.name, r.display_name, r.team, formatTime(r.created_at)]);
  }
  const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `報名名單-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session && (await sb.rpc('is_admin')).data) showAdmin();
  else showLogin();
})().catch(showLogin);
