'use strict';

const state = { categories: [], registrations: [], filter: 'all', search: '' };

const form = document.getElementById('reg-form');
const nameInput = document.getElementById('name');
const categorySelect = document.getElementById('category');
const teamInput = document.getElementById('team');
const submitBtn = document.getElementById('submit-btn');
const formMsg = document.getElementById('form-msg');
const preview = document.getElementById('preview');

function renderCategorySelect() {
  const current = categorySelect.value;
  categorySelect.replaceChildren(el('option', { value: '' }, '請選擇組別'));
  for (const c of state.categories) {
    const s = categoryStatus(c);
    const label = c.description ? `${c.name}（${c.description}）` : c.name;
    categorySelect.append(el('option', { value: c.id, disabled: !s.available },
      s.available ? label : `${label} — ${s.text}`));
  }
  if ([...categorySelect.options].some((o) => o.value === current && !o.disabled)) {
    categorySelect.value = current;
  }
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  const mk = (key, label, count) => el('button', {
    type: 'button',
    class: state.filter === key ? 'active' : '',
    onclick: () => { state.filter = key; renderTabs(); renderList(); },
  }, label, ' ', el('span', { class: 'count' }, `(${count})`));

  tabs.replaceChildren(
    mk('all', '全部', state.registrations.length),
    ...state.categories.map((c) => mk(String(c.id), c.name, c.count)),
  );
}

function renderList() {
  const tbody = document.getElementById('list');
  const kw = state.search.trim().toLowerCase();
  const rows = state.registrations.filter((r) =>
    (state.filter === 'all' || String(r.category_id) === state.filter) &&
    (!kw || r.display_name.toLowerCase().includes(kw) || r.team.toLowerCase().includes(kw)));

  document.getElementById('total').textContent = `共 ${rows.length} 人`;
  if (!rows.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'empty' }, '目前還沒有報名資料')));
    return;
  }
  tbody.replaceChildren(...rows.map((r, i) => el('tr', {},
    el('td', { class: 'num' }, i + 1),
    el('td', {}, r.display_name),
    el('td', {}, r.category_name),
    el('td', {}, r.team || '—'),
  )));
}

async function load() {
  const [categories, registrations] = await Promise.all([
    api('/api/categories'),
    api('/api/registrations'),
  ]);
  state.categories = categories;
  state.registrations = registrations;
  if (state.filter !== 'all' && !categories.some((c) => String(c.id) === state.filter)) state.filter = 'all';
  renderCategorySelect();
  renderTabs();
  renderList();
}

nameInput.addEventListener('input', () => {
  const v = nameInput.value.trim();
  preview.replaceChildren(...(v ? ['名單上會顯示為：', el('strong', {}, anonymizeName(v))] : []));
});

document.getElementById('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  formMsg.className = 'msg';
  try {
    const result = await api('/api/registrations', {
      method: 'POST',
      body: { name: nameInput.value, team: teamInput.value, category_id: categorySelect.value },
    });
    const cat = categorySelect.options[categorySelect.selectedIndex]?.text ?? '';
    showMsg(formMsg, `報名成功！${result.display_name} 已加入「${cat}」。`, 'ok');
    nameInput.value = '';
    preview.replaceChildren();
    await load();
  } catch (err) {
    showMsg(formMsg, err.message, 'err');
    load().catch(() => {});
  } finally {
    submitBtn.disabled = false;
  }
});

load().catch((err) => showMsg(formMsg, `無法載入資料：${err.message}`, 'err'));
