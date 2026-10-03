'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  competitions: [],
  compId: null,       // 目前選擇的比賽；null = 新增模式
  categories: [],
  registrations: [],
  filter: 'all',
  payFilter: '',
  search: '',
  editingReg: null,
};
const STORE_KEY = 'admin.compId';

async function guard(box, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === '42501' || err.code === 'PGRST301') return showLogin();
    showMsg(box, err.message, 'err');
  }
}

const currentComp = () => state.competitions.find((c) => c.id === state.compId) ?? null;

// =====================================================================
// 比賽
// =====================================================================
function renderCompSelect() {
  const sel = $('comp-select');
  sel.replaceChildren(...state.competitions.map((c) =>
    el('option', { value: c.id }, `${c.title}${c.is_published ? '' : '（未公開）'}`)));
  if (state.compId == null) sel.prepend(el('option', { value: '' }, '（新增中的比賽）'));
  sel.value = state.compId ?? '';
}

function fillCompForm() {
  const c = currentComp();
  const creating = !c;
  $('comp-form-title').textContent = creating ? '新增比賽' : '比賽設定';
  $('c-title').value = c?.title ?? '';
  $('c-slug').value = c?.slug ?? '';
  $('c-date').value = c?.event_date ?? '';
  $('c-location').value = c?.location ?? '';
  $('c-fee').value = c?.fee ?? '';
  $('c-published').checked = c?.is_published ?? false;
  $('c-open').checked = c?.registration_open ?? true;
  $('c-payment').value = c?.payment_instructions ?? '';
  $('c-brochure').value = c?.brochure ?? '';
  $('comp-save-btn').textContent = creating ? '建立比賽' : '儲存比賽設定';
  $('comp-delete-btn').classList.toggle('hidden', creating);
  $('comp-detail').classList.toggle('hidden', creating);
  $('view-comp-link').classList.toggle('hidden', creating);
  if (c) $('view-comp-link').href = `/c/${c.slug}`;
  $('brochure-preview').classList.add('hidden');
  updateSlugHint();
}

function updateSlugHint() {
  const v = $('c-slug').value.trim();
  $('c-slug-hint').textContent = v ? `比賽網址：${location.origin}/c/${v}` : '';
}
$('c-slug').addEventListener('input', updateSlugHint);

$('comp-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  selectComp(Number(e.target.value));
});

$('new-comp-btn').addEventListener('click', () => {
  state.compId = null;
  renderCompSelect();
  fillCompForm();
  $('comp-msg').className = 'msg';
  $('c-title').focus();
});

$('brochure-preview-btn').addEventListener('click', () => {
  const box = $('brochure-preview');
  const show = box.classList.contains('hidden');
  box.replaceChildren(renderMarkdown($('c-brochure').value || '（簡章是空的）'));
  box.classList.toggle('hidden', !show);
  $('brochure-preview-btn').textContent = show ? '關閉預覽' : '預覽簡章';
});

$('comp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('comp-msg'), async () => {
    const row = {
      title: $('c-title').value.trim(),
      slug: $('c-slug').value.trim().toLowerCase(),
      event_date: $('c-date').value || null,
      location: $('c-location').value.trim(),
      fee: $('c-fee').value === '' ? null : Number($('c-fee').value),
      is_published: $('c-published').checked,
      registration_open: $('c-open').checked,
      payment_instructions: $('c-payment').value.trim(),
      brochure: $('c-brochure').value,
    };
    if (state.compId == null) {
      const created = check(await sb.from('competitions').insert(row).select('id').single());
      state.compId = created.id;
      showMsg($('comp-msg'), `已建立「${row.title}」，接著設定組別吧！`, 'ok');
    } else {
      const old = currentComp();
      if (old.slug !== row.slug && !confirm(`網址代碼改成「${row.slug}」後，舊網址 /c/${old.slug} 會失效。確定嗎？`)) return;
      check(await sb.from('competitions').update(row).eq('id', state.compId).select('id').single());
      showMsg($('comp-msg'), '已儲存比賽設定', 'ok');
    }
    await loadCompetitions();
  });
});

$('comp-delete-btn').addEventListener('click', () => guard($('comp-msg'), async () => {
  const c = currentComp();
  if (!c) return;
  if (state.registrations.length || state.categories.length) {
    throw new Error('請先刪除這場比賽的所有報名與組別，才能刪除比賽（或改為不公開）');
  }
  if (!confirm(`確定刪除比賽「${c.title}」？`)) return;
  check(await sb.from('competitions').delete().eq('id', c.id));
  state.compId = null;
  await loadCompetitions();
  showMsg($('top-msg'), `已刪除「${c.title}」`, 'ok');
}));

// =====================================================================
// 組別
// =====================================================================
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
          }).eq('id', c.id).select('id').single());
          showMsg($('cat-msg'), `已儲存「${name.value}」`, 'ok');
          await loadDetail();
        }) }, '儲存'), ' ',
        el('button', { class: 'small danger', onclick: () => guard($('cat-msg'), async () => {
          if (!confirm(`確定刪除組別「${c.name}」？`)) return;
          check(await sb.from('categories').delete().eq('id', c.id));
          showMsg($('cat-msg'), `已刪除「${c.name}」`, 'ok');
          await loadDetail();
        }) }, '刪除'),
      ),
    );
  }));
}

$('cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('cat-msg'), async () => {
    check(await sb.from('categories').insert({
      competition_id: state.compId,
      name: $('cat-name').value.trim(), description: $('cat-desc').value.trim(),
      capacity: $('cat-cap').value ? Number($('cat-cap').value) : null,
      sort_order: Number($('cat-sort').value || 0), is_open: true,
    }));
    showMsg($('cat-msg'), `已新增「${$('cat-name').value}」`, 'ok');
    e.target.reset();
    await loadDetail();
  });
});

// =====================================================================
// 繳費
// =====================================================================
async function openProof(path) {
  const win = window.open('', '_blank');
  try {
    const { signedUrl } = check(await sb.storage.from(PROOF_BUCKET).createSignedUrl(path, 600));
    if (win) win.location = signedUrl; else location.href = signedUrl;
  } catch (err) {
    win?.close();
    showMsg($('pay-msg'), `無法開啟截圖：${err.message}`, 'err');
  }
}

function paymentCard(r, p, { actions }) {
  const STATUS = { pending: '待審核', approved: '已確認', rejected: '已退回' };
  return el('div', { class: 'pay-card' },
    el('div', { class: 'row' },
      el('strong', {}, r.name), el('span', {}, r.category_name), r.team ? el('span', { class: 'preview' }, r.team) : null,
      el('span', { class: 'spacer', style: 'flex:1' }),
      el('span', { class: `pay ${p.status === 'approved' ? 'paid' : p.status === 'rejected' ? 'unpaid' : 'pending'}` }, STATUS[p.status])),
    el('div', { class: 'row' },
      el('div', {}, el('div', { class: 'k' }, '帳號後五碼'), el('strong', {}, p.account_last5)),
      el('div', {}, el('div', { class: 'k' }, '金額'), el('strong', {}, formatMoney(p.amount)),
        currentComp()?.fee != null && p.amount !== currentComp().fee
          ? el('span', { class: 'badge closed', style: 'margin-left:6px' }, `報名費 ${currentComp().fee}`) : null),
      el('div', {}, el('div', { class: 'k' }, '匯款日期'), el('strong', {}, formatDate(p.paid_on))),
      el('div', {}, el('div', { class: 'k' }, '送出時間'), el('span', {}, formatTime(p.created_at)))),
    p.note ? el('div', { class: 'row' }, el('div', {}, el('div', { class: 'k' }, '選手備註'), el('div', { class: 'pre-wrap' }, p.note))) : null,
    p.admin_note ? el('div', { class: 'row' }, el('div', {}, el('div', { class: 'k' }, '管理員備註'), el('div', { class: 'pre-wrap' }, p.admin_note))) : null,
    el('div', { class: 'actions', style: 'margin-top:8px' },
      p.proof_path
        ? el('button', { class: 'small secondary', onclick: () => openProof(p.proof_path) }, '查看截圖 ↗')
        : el('span', { class: 'preview' }, '（沒有上傳截圖）'),
      actions ? [
        el('span', { style: 'flex:1' }),
        el('button', { class: 'small', onclick: () => review(p, true) }, '✓ 確認收款'),
        el('button', { class: 'small danger', onclick: () => review(p, false) }, '退回'),
      ] : null),
  );
}

function review(p, approve) {
  guard($('pay-msg'), async () => {
    let note = '';
    if (!approve) {
      note = prompt('退回原因（選手狀態會變回「未繳費」，可重新填寫）：', '');
      if (note === null) return;
    }
    check(await sb.rpc('review_payment', { p_payment_id: p.id, p_approve: approve, p_admin_note: note }));
    showMsg($('pay-msg'), approve ? '已確認收款，狀態改為「已繳費」' : '已退回，狀態改回「未繳費」', 'ok');
    await loadDetail();
  });
}

function renderPending() {
  const items = [];
  for (const r of state.registrations) {
    for (const p of r.payments) if (p.status === 'pending') items.push([r, p]);
  }
  $('pending-count').textContent = items.length ? `${items.length} 筆待審核` : '';
  $('pending-count').classList.toggle('hidden', !items.length);
  $('pending-list').replaceChildren(...(items.length
    ? items.map(([r, p]) => paymentCard(r, p, { actions: true }))
    : [el('p', { class: 'empty' }, '目前沒有待審核的繳費資料')]));
}

function openHistory(r) {
  $('history-title').textContent = `${r.name} 的繳費紀錄`;
  $('history-list').replaceChildren(...(r.payments.length
    ? [...r.payments].sort((a, b) => b.id - a.id).map((p) => paymentCard(r, p, { actions: p.status === 'pending' }))
    : [el('p', { class: 'empty' }, '選手尚未送出繳費資訊')]));
  $('history-dialog').showModal();
}
$('history-close').addEventListener('click', () => $('history-dialog').close());

// =====================================================================
// 報名資料
// =====================================================================
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

function paySelect(r) {
  const sel = el('select', { style: 'width:auto;padding:4px 8px', class: '' },
    ...Object.entries(PAY_LABEL).map(([v, label]) => el('option', { value: v, selected: v === r.payment_status }, label)));
  sel.addEventListener('change', () => guard($('reg-msg'), async () => {
    if (r.payment_status === 'pending' && !confirm('這位選手有待審核的繳費資料，建議到「繳費審核」處理。仍要直接修改狀態嗎？')) {
      sel.value = r.payment_status;
      return;
    }
    check(await sb.from('registrations').update({ payment_status: sel.value }).eq('id', r.id).select('id').single());
    showMsg($('reg-msg'), `${r.name}：已改為「${PAY_LABEL[sel.value]}」`, 'ok');
    await loadDetail();
  }));
  return sel;
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
      el('td', {}, payBadge(r.payment_status)),
      el('td', {}, formatTime(r.created_at)),
      el('td', {},
        el('button', { class: 'small', onclick: () => guard($('reg-msg'), async () => {
          if (!name.value.trim()) throw new Error('請填寫姓名');
          check(await sb.from('registrations').update({
            name: name.value.trim(), team: team.value.trim(), category_id: Number(cat.value),
          }).eq('id', r.id).select('id').single());
          state.editingReg = null;
          showMsg($('reg-msg'), '已更新報名資料', 'ok');
          await loadDetail();
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
    el('td', {}, paySelect(r), ' ',
      el('button', { class: 'small secondary', title: '繳費紀錄', onclick: () => openHistory(r) },
        `紀錄${r.payments.length ? ` (${r.payments.length})` : ''}`)),
    el('td', {}, formatTime(r.created_at)),
    el('td', {},
      el('button', { class: 'small secondary', onclick: () => { state.editingReg = r.id; renderRegistrations(); } }, '編輯'), ' ',
      el('button', { class: 'small danger', onclick: () => guard($('reg-msg'), async () => {
        if (!confirm(`確定刪除 ${r.name}（${r.category_name}）的報名？繳費紀錄與截圖也會一併刪除。`)) return;
        const proofs = r.payments.map((p) => p.proof_path).filter(Boolean);
        check(await sb.from('registrations').delete().eq('id', r.id));
        if (proofs.length) await sb.storage.from(PROOF_BUCKET).remove(proofs);
        showMsg($('reg-msg'), `已刪除 ${r.name} 的報名`, 'ok');
        await loadDetail();
      }) }, '刪除'),
    ),
  );
}

function filteredRegistrations() {
  const kw = state.search.trim().toLowerCase();
  return state.registrations.filter((r) =>
    (state.filter === 'all' || String(r.category_id) === state.filter) &&
    (!state.payFilter || r.payment_status === state.payFilter) &&
    (!kw || r.name.toLowerCase().includes(kw) || r.team.toLowerCase().includes(kw)));
}

function renderRegistrations() {
  const rows = filteredRegistrations();
  const paid = rows.filter((r) => r.payment_status === 'paid').length;
  $('total').textContent = `共 ${rows.length} 人，已繳費 ${paid} 人`;
  if (!rows.length) {
    $('reg-list').replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'empty' }, '沒有符合的報名資料')));
    return;
  }
  $('reg-list').replaceChildren(...rows.map(regRow));
}

$('search').addEventListener('input', (e) => { state.search = e.target.value; renderRegistrations(); });
$('pay-filter').addEventListener('change', (e) => { state.payFilter = e.target.value; renderRegistrations(); });

// ---------- 匯出 CSV ----------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止 CSV 公式注入
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$('export-btn').addEventListener('click', () => {
  const comp = currentComp();
  const rows = [['編號', '組別', '姓名', '匿名顯示', '所屬團體', '繳費狀態', '帳號後五碼', '匯款金額', '匯款日期', '報名時間']];
  for (const r of state.registrations) {
    const p = [...r.payments].sort((a, b) => b.id - a.id)[0];
    rows.push([r.id, r.category_name, r.name, r.display_name, r.team, PAY_LABEL[r.payment_status],
      p?.account_last5, p?.amount, p?.paid_on, formatTime(r.created_at)]);
  }
  const csv = '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `${comp?.title ?? '報名名單'}-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// =====================================================================
// 載入
// =====================================================================
async function loadDetail() {
  if (state.compId == null) return;
  const [categories, registrations] = await Promise.all([
    sb.rpc('list_categories', { p_competition_id: state.compId }).then(check),
    sb.from('registrations')
      .select(`id, name, team, category_id, payment_status, created_at,
               categories!inner(name, sort_order, competition_id),
               payments(id, account_last5, amount, paid_on, note, proof_path, status, admin_note, created_at)`)
      .eq('categories.competition_id', state.compId)
      .then(check),
  ]);
  state.categories = categories;
  state.registrations = registrations
    .map((r) => ({
      ...r,
      category_name: r.categories?.name ?? '',
      sort: r.categories?.sort_order ?? 0,
      display_name: anonymizeName(r.name),
      payments: r.payments ?? [],
    }))
    .sort((a, b) => a.sort - b.sort || a.category_id - b.category_id || a.id - b.id);
  if (state.filter !== 'all' && !categories.some((c) => String(c.id) === state.filter)) state.filter = 'all';
  renderCategories();
  renderPending();
  renderTabs();
  renderRegistrations();
}

async function selectComp(id) {
  state.compId = id;
  state.filter = 'all';
  state.editingReg = null;
  try { localStorage.setItem(STORE_KEY, String(id)); } catch { /* 無法儲存就算了 */ }
  renderCompSelect();
  fillCompForm();
  for (const id of ['comp-msg', 'cat-msg', 'pay-msg', 'reg-msg', 'top-msg']) $(id).className = 'msg';
  await guard($('reg-msg'), loadDetail);
}

async function loadCompetitions() {
  state.competitions = check(await sb.from('competitions').select('*')
    .order('event_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false }));
  let id = state.compId;
  if (id == null || !state.competitions.some((c) => c.id === id)) {
    let saved = null;
    try { saved = Number(localStorage.getItem(STORE_KEY)); } catch { /* ignore */ }
    id = state.competitions.some((c) => c.id === saved) ? saved : state.competitions[0]?.id ?? null;
  }
  if (id == null) {
    state.compId = null;
    renderCompSelect();
    fillCompForm();
    return;
  }
  await selectComp(id);
}

// ---------- 登入 ----------
function showLogin() {
  $('admin-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('email').focus();
}

async function showAdmin() {
  $('login-view').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  await guard($('top-msg'), loadCompetitions);
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

(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session && (await sb.rpc('is_admin')).data) showAdmin();
  else showLogin();
})().catch(showLogin);
