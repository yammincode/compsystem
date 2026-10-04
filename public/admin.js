'use strict';

const $ = (id) => document.getElementById(id);
const VIEWS = ['dashboard', 'regs', 'payments', 'settings', 'account'];
const ROLE_LABEL = { owner: '管理員', staff: '工作人員' };
const STORE_KEY = 'admin.compId';

const state = {
  user: null,
  role: null,
  competitions: [],
  compId: null,        // null = 新增比賽中
  categories: [],
  registrations: [],
  view: 'dashboard',
  catFilter: 'all',
  payFilter: '',
  search: '',
  payView: 'pending',
  missingBirth: false, // 補生日模式
  editing: null,       // 報名詳細對話框中的報名；{} = 代為報名
};

const isOwner = () => state.role === 'owner';
const currentComp = () => state.competitions.find((c) => c.id === state.compId) ?? null;

async function guard(box, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === '42501' || err.code === 'PGRST301' || /JWT/.test(err.message)) {
      showMsg(box, '登入已過期或沒有權限，請重新登入', 'err');
      return;
    }
    showMsg(box, err.message, 'err');
  }
}

function clearMsgs() {
  document.querySelectorAll('.msg').forEach((m) => { if (m.id !== 'login-msg') m.className = 'msg'; });
}

// 共用：關閉對話框按鈕、點背景關閉
document.querySelectorAll('dialog').forEach((d) => {
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

// =====================================================================
// 分頁（#dashboard、#regs …）
// =====================================================================
function showView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  if (state.compId == null && !['settings', 'account'].includes(view)) view = 'settings';
  state.view = view;
  document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  document.querySelectorAll('#bottom-nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'account') loadStaff();
}
window.addEventListener('hashchange', () => { showView(location.hash.slice(1)); window.scrollTo({ top: 0 }); });

// =====================================================================
// 比賽選擇與設定
// =====================================================================
function renderCompSelect() {
  const sel = $('comp-select');
  sel.replaceChildren(...state.competitions.map((c) =>
    el('option', { value: c.id }, `${c.title}${c.is_published ? '' : '（未公開）'}`)));
  if (state.compId == null) sel.prepend(el('option', { value: '' }, '（新增比賽中…）'));
  sel.value = state.compId ?? '';
}

$('comp-select').addEventListener('change', (e) => {
  if (e.target.value) selectComp(Number(e.target.value));
});

$('new-comp-btn').addEventListener('click', () => {
  state.compId = null;
  clearMsgs();
  renderCompSelect();
  fillCompForm();
  location.hash = '#settings';
  showView('settings');
  $('c-title').focus();
});

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
  $('c-consent').value = c?.minor_consent ?? DEFAULT_CONSENT;
  $('comp-save-btn').textContent = creating ? '建立比賽' : '儲存';
  $('cat-card').classList.toggle('hidden', creating);
  $('danger-card').classList.toggle('hidden', creating || !isOwner());
  $('brochure-preview').classList.add('hidden');
  $('brochure-preview-btn').textContent = '預覽簡章';
  $('consent-preview-btn').textContent = '預覽同意書';
  document.querySelectorAll('#bottom-nav a').forEach((a) => {
    a.style.visibility = creating && !['settings', 'account'].includes(a.dataset.view) ? 'hidden' : '';
  });
  updateSlugHint();
}

function updateSlugHint() {
  const v = $('c-slug').value.trim();
  $('c-slug-hint').textContent = v ? `比賽網址：${location.origin}/c/${v}` : '';
}
$('c-slug').addEventListener('input', updateSlugHint);

// 預覽簡章／同意書（共用同一個預覽框）
let previewing = null;
function togglePreview(kind) {
  const box = $('brochure-preview');
  const show = previewing !== kind;
  previewing = show ? kind : null;
  const text = kind === 'brochure' ? $('c-brochure').value || '（簡章是空的）' : $('c-consent').value || '（同意書是空的）';
  box.replaceChildren(renderMarkdown(text));
  box.classList.toggle('hidden', !show);
  $('brochure-preview-btn').textContent = previewing === 'brochure' ? '關閉預覽' : '預覽簡章';
  $('consent-preview-btn').textContent = previewing === 'consent' ? '關閉預覽' : '預覽同意書';
}
$('brochure-preview-btn').addEventListener('click', () => togglePreview('brochure'));
$('consent-preview-btn').addEventListener('click', () => togglePreview('consent'));

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
      minor_consent: $('c-consent').value.trim(),
    };
    if (state.compId == null) {
      const created = check(await sb.from('competitions').insert(row).select('id').single());
      state.compId = created.id;
      await loadCompetitions();
      showMsg($('comp-msg'), `已建立「${row.title}」，接著在下方新增組別吧！`, 'ok');
    } else {
      const old = currentComp();
      if (old.slug !== row.slug && !confirm(`網址代碼改成「${row.slug}」後，舊網址 /c/${old.slug} 會失效。確定嗎？`)) return;
      check(await sb.from('competitions').update(row).eq('id', state.compId).select('id').single());
      await loadCompetitions();
      showMsg($('comp-msg'), '已儲存', 'ok');
    }
  });
});

$('comp-delete-btn').addEventListener('click', () => guard($('comp-msg'), async () => {
  const c = currentComp();
  if (!c) return;
  if (state.registrations.length || state.categories.length) {
    throw new Error('請先刪除這場比賽的所有報名與組別，才能刪除比賽（或改為不公開）');
  }
  if (!confirm(`確定刪除比賽「${c.title}」？`)) return;
  const deleted = check(await sb.from('competitions').delete().eq('id', c.id).select('id'));
  if (!deleted.length) throw new Error('只有管理員可以刪除比賽');
  state.compId = null;
  await loadCompetitions();
  showMsg($('top-msg'), `已刪除「${c.title}」`, 'ok');
}));

// ---------- 組別 ----------
function renderCategories() {
  $('cat-list').replaceChildren(...state.categories.map((c) => {
    const name = el('input', { value: c.name, maxlength: 40, 'aria-label': '組別名稱' });
    const desc = el('input', { value: c.description, maxlength: 200, placeholder: '說明（選填）', 'aria-label': '說明' });
    const cap = el('input', { type: 'number', inputmode: 'numeric', min: 1, value: c.capacity ?? '', placeholder: '人數上限：不限', 'aria-label': '人數上限' });
    const sort = el('input', { type: 'number', inputmode: 'numeric', value: c.sort_order ?? 0, 'aria-label': '排序', title: '排序（數字小的在前）' });
    const open = el('input', { type: 'checkbox', checked: c.is_open });
    return el('div', { class: 'cat-edit' },
      el('div', { class: 'grid' }, name, desc,
        el('div', { class: 'grid', style: 'grid-template-columns:2fr 1fr' }, cap, sort)),
      el('div', { class: 'actions', style: 'margin-top:10px' },
        el('label', { class: 'check-row', style: 'margin:0;display:flex;align-items:center;gap:8px;font-weight:500' }, open, '開放報名'),
        el('span', { class: 'muted' }, `已報名 ${c.count}`),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'small secondary', onclick: () => guard($('cat-msg'), async () => {
          check(await sb.from('categories').update({
            name: name.value.trim(), description: desc.value.trim(),
            capacity: cap.value ? Number(cap.value) : null,
            is_open: open.checked, sort_order: Number(sort.value || 0),
          }).eq('id', c.id).select('id').single());
          showMsg($('cat-msg'), `已儲存「${name.value}」`, 'ok');
          await loadDetail();
        }) }, '儲存'),
        el('button', { type: 'button', class: 'small danger', onclick: () => guard($('cat-msg'), async () => {
          if (!confirm(`確定刪除組別「${c.name}」？`)) return;
          check(await sb.from('categories').delete().eq('id', c.id));
          showMsg($('cat-msg'), `已刪除「${c.name}」`, 'ok');
          await loadDetail();
        }) }, '刪除')),
    );
  }));
}

$('cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('cat-msg'), async () => {
    const maxSort = Math.max(0, ...state.categories.map((c) => c.sort_order ?? 0));
    check(await sb.from('categories').insert({
      competition_id: state.compId,
      name: $('cat-name').value.trim(), description: $('cat-desc').value.trim(),
      capacity: $('cat-cap').value ? Number($('cat-cap').value) : null,
      sort_order: maxSort + 1, is_open: true,
    }));
    showMsg($('cat-msg'), `已新增「${$('cat-name').value}」`, 'ok');
    e.target.reset();
    await loadDetail();
  });
});

// =====================================================================
// 總覽
// =====================================================================
function renderDashboard() {
  const c = currentComp();
  if (!c) return;
  const regs = state.registrations;
  const count = (s) => regs.filter((r) => r.payment_status === s).length;
  const income = regs.flatMap((r) => r.payments).filter((p) => p.status === 'approved').reduce((s, p) => s + p.amount, 0);
  const stat = (label, value, cls = '', href = null) => el(href ? 'a' : 'div', { class: `stat ${cls}`, href },
    el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));

  $('dash-title').textContent = c.title;
  $('view-site-link').href = `/c/${c.slug}`;
  $('site-url').value = `${location.origin}/c/${c.slug}`;
  $('stats').replaceChildren(
    stat('報名人數', regs.length, '', '#regs'),
    stat('已繳費', count('paid'), 'ok'),
    stat('待審核', count('pending'), count('pending') ? 'warn' : '', '#payments'),
    stat('未繳費', count('unpaid'), count('unpaid') ? 'err' : ''),
  );
  if (income) $('stats').append(stat('已確認收款', formatMoney(income), 'ok'));
  const noBirth = regs.filter((r) => !r.birth_date).length;
  if (noBirth) {
    const s = stat('缺出生日期', noBirth, 'warn', '#regs');
    s.addEventListener('click', () => { state.missingBirth = true; renderRegs(); });
    $('stats').append(s);
  }

  $('cat-stats').replaceChildren(...(state.categories.length ? state.categories.map((cat) => {
    const inCat = regs.filter((r) => r.category_id === cat.id);
    const paid = inCat.filter((r) => r.payment_status === 'paid').length;
    const pct = cat.capacity ? Math.min(100, (cat.count / cat.capacity) * 100) : 0;
    return el('div', { style: 'margin-bottom:14px' },
      el('div', { style: 'display:flex;gap:8px;align-items:baseline' },
        el('strong', { style: 'flex:1' }, cat.name, cat.is_open ? '' : ' 🔒'),
        el('span', { class: 'muted' }, cat.capacity ? `${cat.count} / ${cat.capacity} 人` : `${cat.count} 人`),
        el('span', { class: 'badge ok' }, `已繳 ${paid}`)),
      cat.capacity ? el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })) : null);
  }) : [el('p', { class: 'empty' }, '尚未設定組別，請到「比賽設定」新增')]));

  const recent = [...regs].sort((a, b) => b.id - a.id).slice(0, 5);
  $('recent').replaceChildren(...(recent.length ? recent.map(regItem) : [el('p', { class: 'empty' }, '還沒有人報名')]));
}

$('copy-url-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('site-url').value); $('copy-url-btn').textContent = '已複製 ✓'; }
  catch { $('site-url').select(); }
  setTimeout(() => { $('copy-url-btn').textContent = '複製'; }, 1500);
});

// =====================================================================
// 報名名單
// =====================================================================
// ---------- 年齡、家長同意書 ----------
const DEFAULT_CONSENT = `## 未成年參賽者家長（法定代理人）同意書

本人為參賽者之家長／法定代理人，已詳閱本次比賽簡章及相關規定，瞭解攀岩運動具有一定之風險，並同意本人之子女（受監護人）參加本次比賽：

1. 參賽者身體狀況良好，無不適合從事攀岩運動之疾病。
2. 參賽者將遵守主辦單位及現場工作人員之指示與安全規範。
3. 如因個人疏忽或未遵守規定而發生意外，將自行負責。
4. 同意主辦單位於比賽期間拍攝之照片、影片用於活動紀錄與宣傳。`;

const refDate = () => currentComp()?.event_date || todayStr();
const isMinorReg = (r) => r.age != null && r.age < 18;

function minorBadge(r) {
  if (!r.birth_date) return el('div', { style: 'margin-top:2px' }, el('span', { class: 'badge full' }, '缺生日'));
  if (!isMinorReg(r)) return null;
  return el('div', { style: 'margin-top:2px' },
    el('span', { class: 'badge full' }, `未成年 ${r.age} 歲`), ' ',
    r.consent ? el('span', { class: 'badge ok' }, '✓ 家長已簽') : el('span', { class: 'badge closed' }, '缺家長同意書'));
}

function updateRegAge() {
  const age = ageOn($('r-birth').value, refDate());
  $('r-age').textContent = age == null ? '' : `比賽當天 ${age} 歲${age < 18 ? '（未成年）' : ''}`;
}
$('r-birth').addEventListener('input', updateRegAge);

function renderConsentInfo(r) {
  const box = $('r-consent');
  const c = r.consent;
  if (!c && !isMinorReg(r)) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!c) {
    box.replaceChildren(el('strong', { style: 'color:var(--err)' }, '⚠ 未成年，尚未簽署家長同意書'),
      el('div', { class: 'muted' }, '可請家長於報到時簽署紙本同意書。'));
    return;
  }
  const detail = el('div');
  box.replaceChildren(
    el('div', { style: 'font-weight:700' }, '👪 家長同意書'),
    el('div', {}, `${c.guardian_name}（${c.relationship}）`),
    el('div', { class: 'muted' }, `簽署時間：${formatTime(c.signed_at)}`),
    detail,
    el('button', { type: 'button', class: 'small secondary', style: 'margin-top:8px', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const full = check(await sb.from('guardian_consents').select('signature, consent_text').eq('id', c.id).single());
        detail.replaceChildren(
          el('div', { class: 'k', style: 'margin-top:8px' }, '家長簽名'),
          el('img', { class: 'sig-img', src: full.signature, alt: '家長簽名' }),
          el('details', { style: 'margin-top:8px' },
            el('summary', {}, '簽署當下的同意書全文'),
            el('div', { class: 'consent-text', style: 'margin-top:8px' }, renderMarkdown(full.consent_text))));
        btn.remove();
      } catch (err) {
        btn.disabled = false;
        showMsg($('reg-msg'), err.message, 'err');
      }
    } }, '查看簽名與同意書'),
  );
}

function regItem(r) {
  return el('div', { class: 'reg-item', role: 'button', tabindex: 0, onclick: () => openReg(r),
    onkeydown: (e) => { if (e.key === 'Enter') openReg(r); } },
  el('div', { class: 'who' },
    el('div', { class: 'name' }, r.name, el('span', { class: 'muted', style: 'font-weight:400' }, `　${r.display_name}`)),
    el('div', { class: 'sub' }, [r.category_name, r.team, formatTime(r.created_at)].filter(Boolean).join('・')),
    minorBadge(r)),
  payBadge(r.payment_status),
  el('span', { class: 'chev' }, '›'));
}

function renderPaySeg() {
  const regs = state.registrations.filter((r) => state.catFilter === 'all' || String(r.category_id) === state.catFilter);
  const opts = [['', '全部'], ['unpaid', '未繳費'], ['pending', '審核中'], ['paid', '已繳費']];
  $('pay-seg').replaceChildren(...opts.map(([v, label]) => el('button', {
    type: 'button', class: `${state.payFilter === v ? 'active' : ''} ${v}`,
    onclick: () => { state.payFilter = v; renderRegs(); },
  }, label, ` ${v ? regs.filter((r) => r.payment_status === v).length : regs.length}`)));
}

function renderCatTabs() {
  const mk = (key, label, count) => el('button', {
    type: 'button', class: state.catFilter === key ? 'active' : '',
    onclick: () => { state.catFilter = key; renderRegs(); },
  }, label, ' ', el('span', { class: 'count' }, `(${count})`));
  $('cat-tabs').replaceChildren(
    mk('all', '全部組別', state.registrations.length),
    ...state.categories.map((c) => mk(String(c.id), c.name, c.count)),
  );
}

function filteredRegs() {
  const kw = state.search.trim().toLowerCase();
  return state.registrations.filter((r) =>
    (!state.missingBirth || !r.birth_date) &&
    (state.catFilter === 'all' || String(r.category_id) === state.catFilter) &&
    (!state.payFilter || r.payment_status === state.payFilter) &&
    (!kw || r.name.toLowerCase().includes(kw) || r.team.toLowerCase().includes(kw)));
}

function renderRegs() {
  renderPaySeg();
  renderCatTabs();
  const missing = state.registrations.filter((r) => !r.birth_date).length;
  const btn = $('missing-birth-btn');
  btn.classList.toggle('hidden', !missing && !state.missingBirth);
  btn.textContent = state.missingBirth ? '✕ 結束補生日' : `📅 補生日（${missing}）`;
  $('birth-mode-hint').classList.toggle('hidden', !state.missingBirth);

  const rows = filteredRegs();
  $('reg-total').textContent = `${rows.length} 筆`;
  $('reg-list').replaceChildren(...(rows.length
    ? rows.map(state.missingBirth ? birthRow : regItem)
    : [el('p', { class: 'empty' }, state.missingBirth ? '🎉 所有選手都有出生日期了' : '沒有符合的報名資料')]));
}

// 補生日模式：每一列直接填日期
function birthRow(r) {
  const input = el('input', { type: 'date', min: '1900-01-01', max: todayStr(), style: 'width:auto;flex:1 1 150px', 'aria-label': `${r.name} 的出生日期` });
  const hint = el('div', { class: 'muted', style: 'font-size:.85rem' });
  input.addEventListener('input', () => {
    const age = ageOn(input.value, refDate());
    hint.textContent = age == null ? '' : `比賽當天 ${age} 歲${age < 18 ? '・未成年' : ''}`;
  });
  const save = el('button', { type: 'button', class: 'small', onclick: () => guard($('reg-msg-inline'), async () => {
    if (!input.value) throw new Error(`請填寫 ${r.name} 的出生日期`);
    const age = ageOn(input.value, refDate());
    if (age < 0 || age > 120) throw new Error('出生日期不正確');
    save.disabled = true;
    check(await sb.from('registrations').update({ birth_date: input.value }).eq('id', r.id).select('id').single());
    showMsg($('reg-msg-inline'), `已儲存 ${r.name}：${input.value}（${age} 歲${age < 18 ? '，未成年，需補家長同意書' : ''}）`, 'ok');
    await loadDetail();
  }).finally(() => { save.disabled = false; }) }, '儲存');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  return el('div', { class: 'reg-item', style: 'cursor:default;flex-wrap:wrap' },
    el('div', { class: 'who', style: 'flex:1 1 160px' },
      el('div', { class: 'name' }, r.name),
      el('div', { class: 'sub' }, [r.category_name, r.team].filter(Boolean).join('・')),
      hint),
    input, save);
}

$('missing-birth-btn').addEventListener('click', () => {
  state.missingBirth = !state.missingBirth;
  $('reg-msg-inline').className = 'msg';
  renderRegs();
});

$('search').addEventListener('input', (e) => { state.search = e.target.value; renderRegs(); });

// ---------- 報名詳細 ----------
function openReg(r) {
  state.editing = r;
  const creating = !r.id;
  $('reg-msg').className = 'msg';
  $('reg-dlg-title').textContent = creating ? '代為報名' : r.name;
  $('r-name').value = r.name ?? '';
  $('r-team').value = r.team ?? '';
  $('r-birth').value = r.birth_date ?? '';
  updateRegAge();
  renderConsentInfo(r);
  $('r-cat').replaceChildren(...state.categories.map((c) =>
    el('option', { value: c.id, selected: c.id === r.category_id }, c.name + (c.is_open ? '' : '（已關閉）'))));
  $('r-anon').textContent = r.name ? `公開顯示：${anonymizeName(r.name)}` : '';
  $('r-pay-block').classList.toggle('hidden', creating);
  $('r-delete').classList.toggle('hidden', creating);
  $('r-save').textContent = creating ? '新增報名' : '儲存';
  $('r-meta').textContent = creating ? '工作人員代為報名不受「開放報名」與名額限制。' : `報名時間：${formatTime(r.created_at)}　編號 #${r.id}`;
  if (!creating) renderRegPayment(r);
  $('reg-dialog').showModal();
}

function renderRegPayment(r) {
  $('r-pay-seg').replaceChildren(...Object.entries(PAY_LABEL).map(([v, label]) => el('button', {
    type: 'button', class: `${r.payment_status === v ? 'active' : ''} ${v}`,
    onclick: () => guard($('reg-msg'), async () => {
      if (v === r.payment_status) return;
      if (r.payment_status === 'pending' && !confirm('這位選手有待審核的繳費資料，建議用下方的「確認收款／退回」。仍要直接修改嗎？')) return;
      check(await sb.from('registrations').update({ payment_status: v }).eq('id', r.id).select('id').single());
      await loadDetail();
      const fresh = state.registrations.find((x) => x.id === r.id);
      if (fresh) { state.editing = fresh; renderRegPayment(fresh); }
      showMsg($('reg-msg'), `已改為「${label}」`, 'ok');
    }),
  }, label)));
  const history = [...r.payments].sort((a, b) => b.id - a.id);
  $('r-history').replaceChildren(...(history.length
    ? history.map((p) => paymentCard(r, p, { compact: true }))
    : [el('p', { class: 'muted' }, '選手尚未送出繳費資訊')]));
}

$('r-name').addEventListener('input', () => {
  const v = $('r-name').value.trim();
  $('r-anon').textContent = v ? `公開顯示：${anonymizeName(v)}` : '';
});

$('reg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('reg-msg'), async () => {
    const r = state.editing;
    const row = {
      name: $('r-name').value.trim(), team: $('r-team').value.trim(), category_id: Number($('r-cat').value),
      birth_date: $('r-birth').value || null,
    };
    if (!row.name) throw new Error('請填寫姓名');
    if (!r.id) {
      check(await sb.from('registrations').insert(row));
      $('reg-dialog').close();
      showMsg($('top-msg'), `已新增 ${row.name} 的報名`, 'ok');
    } else {
      check(await sb.from('registrations').update(row).eq('id', r.id).select('id').single());
      showMsg($('reg-msg'), '已儲存', 'ok');
      $('reg-dlg-title').textContent = row.name;
    }
    await loadDetail();
  });
});

$('r-delete').addEventListener('click', () => guard($('reg-msg'), async () => {
  const r = state.editing;
  if (!confirm(`確定刪除 ${r.name}（${r.category_name}）的報名？繳費紀錄與截圖也會一併刪除。`)) return;
  const proofs = r.payments.map((p) => p.proof_path).filter(Boolean);
  check(await sb.from('registrations').delete().eq('id', r.id));
  if (proofs.length) await sb.storage.from(PROOF_BUCKET).remove(proofs);
  $('reg-dialog').close();
  showMsg($('top-msg'), `已刪除 ${r.name} 的報名`, 'ok');
  await loadDetail();
}));

$('add-reg-btn').addEventListener('click', () => {
  if (!state.categories.length) return showMsg($('top-msg'), '請先到「比賽設定」新增組別', 'err');
  openReg({ category_id: state.categories[0].id, payments: [] });
});

// ---------- 匯出 CSV ----------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止 CSV 公式注入
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$('export-btn').addEventListener('click', () => {
  const comp = currentComp();
  const rows = [['編號', '組別', '姓名', '匿名顯示', '所屬團體', '出生日期', '比賽當天年齡', '家長姓名', '家長關係', '同意書簽署時間',
    '繳費狀態', '帳號後五碼', '匯款金額', '匯款日期', '報名時間']];
  for (const r of state.registrations) {
    const p = [...r.payments].sort((a, b) => b.id - a.id)[0];
    rows.push([r.id, r.category_name, r.name, r.display_name, r.team, r.birth_date, r.age,
      r.consent?.guardian_name, r.consent?.relationship, r.consent ? formatTime(r.consent.signed_at) : '',
      PAY_LABEL[r.payment_status], p?.account_last5, p?.amount, p?.paid_on, formatTime(r.created_at)]);
  }
  const csv = '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `${comp?.title ?? '報名名單'}-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// =====================================================================
// 繳費審核
// =====================================================================
async function showProof(path, holder, btn) {
  btn.disabled = true;
  try {
    const { signedUrl } = check(await sb.storage.from(PROOF_BUCKET).createSignedUrl(path, 600));
    const isPdf = /\.pdf$/i.test(path);
    holder.replaceChildren(
      isPdf ? null : el('a', { href: signedUrl, target: '_blank', rel: 'noopener' }, el('img', { class: 'proof', src: signedUrl, alt: '匯款截圖' })),
      el('a', { href: signedUrl, target: '_blank', rel: 'noopener', class: 'btn secondary small' }, isPdf ? '開啟 PDF ↗' : '開新視窗看原圖 ↗'));
    btn.remove();
  } catch (err) {
    btn.disabled = false;
    holder.replaceChildren(el('span', { class: 'muted' }, `無法開啟截圖：${err.message}`));
  }
}

function paymentCard(r, p, { compact = false } = {}) {
  const STATUS = { pending: ['待審核', 'pending'], approved: ['已確認', 'paid'], rejected: ['已退回', 'unpaid'] };
  const fee = currentComp()?.fee;
  const proofHolder = el('div');
  const kv = (k, v, extra) => el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v, extra ?? null));
  return el('div', { class: 'pay-card' },
    el('div', { class: 'head' },
      el('div', { class: 'who' },
        compact ? null : el('div', { style: 'font-weight:700' }, r.name),
        compact ? null : el('div', { class: 'muted' }, [r.category_name, r.team].filter(Boolean).join('・'))),
      el('span', { class: `pay ${STATUS[p.status][1]}` }, STATUS[p.status][0])),
    el('div', { class: 'kv' },
      kv('帳號後五碼', p.account_last5),
      kv('金額', formatMoney(p.amount),
        fee != null && p.amount !== fee ? el('span', { class: 'badge closed', style: 'margin-left:6px' }, `應繳 ${fee}`) : null),
      kv('匯款日期', formatDate(p.paid_on)),
      kv('送出時間', formatTime(p.created_at))),
    p.note ? el('div', { style: 'margin-bottom:8px' }, el('div', { class: 'k' }, '選手備註'), el('div', { class: 'pre-wrap' }, p.note)) : null,
    p.admin_note ? el('div', { style: 'margin-bottom:8px' }, el('div', { class: 'k' }, '退回原因／備註'), el('div', { class: 'pre-wrap' }, p.admin_note)) : null,
    proofHolder,
    el('div', { class: 'actions', style: 'margin-top:8px' },
      p.proof_path
        ? el('button', { type: 'button', class: 'small secondary', onclick: (e) => showProof(p.proof_path, proofHolder, e.currentTarget) }, '🖼 查看截圖')
        : el('span', { class: 'muted' }, '沒有上傳截圖'),
      p.status === 'pending' ? [
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'small danger', onclick: () => review(p, false) }, '退回'),
        el('button', { type: 'button', class: 'small', onclick: () => review(p, true) }, '✓ 確認收款'),
      ] : null),
  );
}

function review(p, approve) {
  const box = $('reg-dialog').open ? $('reg-msg') : $('pay-msg');
  guard(box, async () => {
    let note = '';
    if (!approve) {
      note = prompt('退回原因（選手會變回「未繳費」，可重新填寫）：', '');
      if (note === null) return;
    }
    check(await sb.rpc('review_payment', { p_payment_id: p.id, p_approve: approve, p_admin_note: note }));
    await loadDetail();
    if ($('reg-dialog').open && state.editing?.id) {
      const fresh = state.registrations.find((x) => x.id === state.editing.id);
      if (fresh) { state.editing = fresh; renderRegPayment(fresh); }
    }
    showMsg(box, approve ? '已確認收款，狀態改為「已繳費」' : '已退回，狀態改回「未繳費」', 'ok');
  });
}

document.querySelectorAll('#payview-seg button').forEach((b) => b.addEventListener('click', () => {
  state.payView = b.dataset.v;
  document.querySelectorAll('#payview-seg button').forEach((x) => x.classList.toggle('active', x === b));
  renderPayments();
}));

function renderPayments() {
  const items = [];
  for (const r of state.registrations) {
    for (const p of r.payments) {
      if ((state.payView === 'pending') === (p.status === 'pending')) items.push([r, p]);
    }
  }
  items.sort((a, b) => (state.payView === 'pending' ? a[1].id - b[1].id : b[1].id - a[1].id));
  const pending = state.registrations.flatMap((r) => r.payments).filter((p) => p.status === 'pending').length;
  $('pending-dot').textContent = pending;
  $('pending-dot').classList.toggle('hidden', !pending);
  document.querySelector('#payview-seg [data-v=pending]').textContent = `待審核 ${pending}`;
  $('payment-list').replaceChildren(...(items.length
    ? items.map(([r, p]) => paymentCard(r, p))
    : [el('p', { class: 'empty card' }, state.payView === 'pending' ? '🎉 目前沒有待審核的繳費資料' : '還沒有處理過的繳費資料')]));
}

// =====================================================================
// 帳號、工作人員
// =====================================================================
$('pw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('pw-msg'), async () => {
    check(await sb.auth.updateUser({ password: $('new-pw').value }));
    $('new-pw').value = '';
    showMsg($('pw-msg'), '密碼已更新', 'ok');
  });
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut().catch(() => {});
  location.hash = '';
  location.reload();
});

async function staffApi(body) {
  const { data } = await sb.auth.getSession();
  const res = await fetch('/api/staff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out.error || `伺服器錯誤（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return out;
}

// ---------- 網站設定 ----------
async function loadSiteForm() {
  const site = await loadSite();
  $('site-name').value = site.site_name;
  $('site-home-title').value = site.home_title;
  $('site-home-intro').value = site.home_intro;
  $('site-footer').value = site.footer_text;
}

$('site-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard($('site-msg'), async () => {
    const row = {
      site_name: $('site-name').value.trim(),
      home_title: $('site-home-title').value.trim(),
      home_intro: $('site-home-intro').value.trim(),
      footer_text: $('site-footer').value.trim(),
      updated_at: new Date().toISOString(),
    };
    check(await sb.from('site_settings').update(row).eq('id', 1).select('id').single());
    sitePromise = null;
    document.querySelectorAll('[data-site-name]').forEach((n) => { n.textContent = row.site_name; });
    showMsg($('site-msg'), '已儲存網站設定', 'ok');
  });
});

async function loadStaff() {
  if (!state.user) return;
  loadSiteForm();
  $('my-info').replaceChildren(el('strong', {}, state.user.email), '　', el('span', { class: 'badge' }, ROLE_LABEL[state.role]));
  document.querySelectorAll('.owner-only').forEach((x) => x.classList.toggle('hidden', !isOwner()));
  await guard($('staff-msg'), async () => {
    const list = check(await sb.rpc('list_staff'));
    $('staff-list').replaceChildren(...list.map((s) => {
      const me = s.user_id === state.user.id;
      const roleSel = el('select', { style: 'width:auto', 'aria-label': '角色', disabled: !isOwner() || me },
        ...Object.entries(ROLE_LABEL).map(([v, label]) => el('option', { value: v, selected: v === s.role }, label)));
      roleSel.addEventListener('change', () => guard($('staff-msg'), async () => {
        check(await sb.rpc('set_staff_role', { p_user_id: s.user_id, p_role: roleSel.value }));
        showMsg($('staff-msg'), `${s.email} 已改為${ROLE_LABEL[roleSel.value]}`, 'ok');
        await loadStaff();
      }));
      return el('div', { class: 'staff-item' },
        el('div', { class: 'who' },
          el('div', { style: 'font-weight:600' }, s.email, me ? '（我）' : ''),
          el('div', { class: 'muted' }, s.last_sign_in_at ? `最後登入 ${formatTime(s.last_sign_in_at)}` : '尚未登入過')),
        roleSel,
        isOwner() && !me ? el('button', { type: 'button', class: 'small secondary', title: '重設密碼', onclick: () => guard($('staff-msg'), async () => {
          const pw = prompt(`為 ${s.email} 設定新密碼（至少 8 個字元）：`, '');
          if (!pw) return;
          await staffApi({ action: 'reset_password', user_id: s.user_id, password: pw });
          showMsg($('staff-msg'), `已重設 ${s.email} 的密碼，請轉告對方`, 'ok');
        }) }, '🔑') : null,
        isOwner() && !me ? el('button', { type: 'button', class: 'small danger', title: '移除', onclick: () => guard($('staff-msg'), async () => {
          if (!confirm(`確定移除 ${s.email}？對方將無法再登入後台。`)) return;
          try {
            await staffApi({ action: 'delete', user_id: s.user_id });
          } catch (err) {
            if (err.status !== 503 && err.status !== 404) throw err;
            check(await sb.rpc('remove_staff', { p_user_id: s.user_id })); // 未設定伺服器金鑰時：只移出名單
          }
          showMsg($('staff-msg'), `已移除 ${s.email}`, 'ok');
          await loadStaff();
        }) }, '✕') : null,
      );
    }));
  });
}

$('add-staff-btn').addEventListener('click', () => {
  $('staff-form').reset();
  $('s-msg').className = 'msg';
  $('staff-dialog').showModal();
});

$('staff-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('s-submit');
  btn.disabled = true;
  guard($('s-msg'), async () => {
    const email = $('s-email').value.trim();
    const role = $('s-role').value;
    let msg;
    try {
      const out = await staffApi({ action: 'create', email, password: $('s-pw').value, role });
      msg = out.created ? `已建立 ${email} 的帳號，請把 Email 和密碼告訴對方` : `${email} 已有帳號，已加入工作人員`;
    } catch (err) {
      // 尚未設定 Netlify Function 的金鑰：只能把「已存在的帳號」加入名單
      if (err.status !== 503 && err.status !== 404) throw err;
      try {
        check(await sb.rpc('add_staff', { p_email: email, p_role: role }));
      } catch (e2) {
        throw new Error(`${err.message}\n（目前只能加入已在 Supabase 建立的帳號：${e2.message}）`);
      }
      msg = `${email} 已加入工作人員`;
    }
    $('staff-dialog').close();
    showMsg($('staff-msg'), msg, 'ok');
    await loadStaff();
  }).finally(() => { btn.disabled = false; });
});

// =====================================================================
// 載入
// =====================================================================
async function loadDetail() {
  if (state.compId == null) return;
  const [categories, registrations] = await Promise.all([
    sb.rpc('list_categories', { p_competition_id: state.compId }).then(check),
    sb.from('registrations')
      .select(`id, name, team, category_id, payment_status, created_at, birth_date,
               categories!inner(name, sort_order, competition_id),
               guardian_consents(id, guardian_name, relationship, signed_at),
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
      consent: (Array.isArray(r.guardian_consents) ? r.guardian_consents[0] : r.guardian_consents) ?? null,
      age: ageOn(r.birth_date, refDate()),
    }))
    .sort((a, b) => a.sort - b.sort || a.category_id - b.category_id || a.id - b.id);
  if (state.catFilter !== 'all' && !categories.some((c) => String(c.id) === state.catFilter)) state.catFilter = 'all';
  renderDashboard();
  renderRegs();
  renderPayments();
  renderCategories();
}

async function selectComp(id) {
  state.compId = id;
  state.catFilter = 'all';
  state.payFilter = '';
  try { localStorage.setItem(STORE_KEY, String(id)); } catch { /* 無法儲存就算了 */ }
  clearMsgs();
  renderCompSelect();
  fillCompForm();
  await guard($('top-msg'), loadDetail);
  showView(state.view);
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
    showView('settings');
    return;
  }
  await selectComp(id);
}

// ---------- 登入 ----------
function showLogin() {
  $('app').classList.add('hidden');
  $('bottom-nav').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('me-label').textContent = '';
}

loadSite().then((site) => {
  document.querySelectorAll('[data-site-name]').forEach((n) => { n.textContent = site.site_name; });
  document.title = `${site.site_name}｜管理後台`;
});

async function enterApp(user, role) {
  state.user = user;
  state.role = role;
  $('me-label').textContent = ROLE_LABEL[role];
  $('login-view').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('bottom-nav').classList.remove('hidden');
  state.view = location.hash.slice(1) || 'dashboard';
  await guard($('top-msg'), loadCompetitions);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { user } = check(await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value }));
    $('password').value = '';
    const role = check(await sb.rpc('my_role'));
    if (!role) {
      await sb.auth.signOut();
      throw new Error('這個帳號不是工作人員，請聯絡管理員開通');
    }
    $('login-msg').className = 'msg';
    await enterApp(user, role);
  } catch (err) {
    if (/Invalid login/i.test(err.message)) err.message = 'Email 或密碼錯誤';
    showMsg($('login-msg'), err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  const { data } = await sb.auth.getSession();
  const role = data.session ? (await sb.rpc('my_role')).data : null;
  if (role) await enterApp(data.session.user, role);
  else showLogin();
})().catch(showLogin);
