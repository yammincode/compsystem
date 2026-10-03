'use strict';

// 網址：/c/<比賽代碼>/<分頁>
const TABS = ['info', 'register', 'participants', 'results'];
const [, , slug = '', tabFromUrl = ''] = location.pathname.split('/');
const $ = (id) => document.getElementById(id);

const state = {
  comp: null,
  categories: [],
  registrations: [],
  tab: 'info',
  filter: 'all',
  search: '',
  payTarget: null, // { id, display_name, category_name }
  lastRegistered: null,
};

// ---------- 分頁切換 ----------
function tabUrl(tab) {
  return `/c/${slug}${tab === 'info' ? '' : `/${tab}`}`;
}

function updateCta() {
  // 手機底部「我要報名」：報名中、且不在報名頁時顯示
  const show = !!state.comp?.registration_open && state.tab !== 'register';
  $('cta-bar').classList.toggle('hidden', !show);
  document.body.classList.toggle('has-cta', show);
}

function showTab(tab, push = true) {
  if (!TABS.includes(tab)) tab = 'info';
  state.tab = tab;
  document.querySelectorAll('section.tab').forEach((s) => s.classList.toggle('hidden', s.dataset.tab !== tab));
  document.querySelectorAll('#subnav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (push && location.pathname !== tabUrl(tab)) history.pushState({ tab }, '', tabUrl(tab));
  updateCta();
}

document.querySelectorAll('#subnav a, [data-goto]').forEach((a) => {
  const tab = a.dataset.tab || a.dataset.goto;
  a.href = tabUrl(tab);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    showTab(tab);
    window.scrollTo({ top: 0 });
  });
});
window.addEventListener('popstate', () => showTab(location.pathname.split('/')[3] || 'info', false));

// ---------- 比賽簡章 ----------
function renderInfo() {
  const c = state.comp;
  document.title = `${c.title}｜攀岩比賽`;
  $('comp-title').textContent = c.title;
  $('comp-meta').replaceChildren(...[
    c.is_published ? null : el('span', { class: 'badge full' }, '未公開（僅工作人員可見）'),
    c.registration_open ? el('span', { class: 'badge' }, '報名中') : el('span', { class: 'badge closed' }, '報名截止'),
    c.event_date ? el('span', {}, `📅 ${formatDate(c.event_date)}`) : null,
    c.location ? el('span', {}, `📍 ${c.location}`) : null,
  ].filter(Boolean));

  const item = (label, value) => el('div', { class: 'item' },
    el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
  const paid = state.registrations.filter((r) => r.payment_status === 'paid').length;
  $('info-grid').replaceChildren(
    item('比賽日期', formatDate(c.event_date) || '未定'),
    item('地點', c.location || '未定'),
    item('報名費', c.fee != null ? formatMoney(c.fee) : '未定'),
    item('報名人數', `${state.registrations.length} 人（已繳費 ${paid}）`),
  );

  $('brochure-card').classList.toggle('hidden', !c.brochure.trim());
  $('brochure').replaceChildren(renderMarkdown(c.brochure));

  $('info-cats').replaceChildren(...(state.categories.length
    ? state.categories.map((cat) => {
      const s = categoryStatus(cat, c.registration_open);
      return el('li', {},
        el('div', { class: 'who' },
          el('div', { style: 'font-weight:600' }, cat.name),
          cat.description ? el('div', { class: 'muted' }, cat.description) : null),
        el('span', { class: 'muted' }, cat.capacity != null ? `${cat.count}/${cat.capacity}` : `${cat.count} 人`),
        el('span', { class: `badge ${s.cls}` }, s.text));
    })
    : [el('li', { class: 'empty' }, '尚未設定組別')]));
}

$('share-btn').addEventListener('click', async () => {
  const url = `${location.origin}/c/${slug}`;
  const title = state.comp?.title ?? document.title;
  try {
    if (navigator.share) await navigator.share({ title, text: `${title} 報名中！`, url });
    else { await navigator.clipboard.writeText(url); alert('已複製比賽網址'); }
  } catch { /* 使用者取消分享 */ }
});

// ---------- 報名 ----------
const nameInput = $('name');
const categorySelect = $('category');
const teamInput = $('team');

function renderCategorySelect() {
  const current = categorySelect.value;
  categorySelect.replaceChildren(el('option', { value: '' },
    state.comp.registration_open ? '請選擇組別' : '這場比賽目前不開放報名'));
  for (const c of state.categories) {
    const s = categoryStatus(c, state.comp.registration_open);
    const label = c.description ? `${c.name}（${c.description}）` : c.name;
    categorySelect.append(el('option', { value: c.id, disabled: !s.available },
      s.available ? label : `${label} — ${s.text}`));
  }
  if ([...categorySelect.options].some((o) => o.value === current && !o.disabled)) categorySelect.value = current;
  $('submit-btn').disabled = !state.comp.registration_open;
}

nameInput.addEventListener('input', () => {
  const v = nameInput.value.trim();
  $('preview').replaceChildren(...(v ? ['名單上會顯示為：', el('strong', {}, anonymizeName(v))] : []));
});

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = '送出中…';
  $('form-msg').className = 'msg';
  try {
    if (!categorySelect.value) throw new Error('請選擇組別');
    const name = nameInput.value;
    const result = check(await sb.rpc('register', {
      p_name: name, p_team: teamInput.value, p_category_id: Number(categorySelect.value),
    }));
    const cat = state.categories.find((c) => String(c.id) === categorySelect.value);
    state.lastRegistered = { id: result.id, display_name: result.display_name, category_name: cat?.name ?? '', fullName: name.trim() };

    $('reg-done-text').replaceChildren(el('strong', {}, result.display_name), ` 已報名「${cat?.name ?? ''}」`,
      state.comp.fee ? `，報名費 ${formatMoney(state.comp.fee)}。` : '。');
    const instr = state.comp.payment_instructions.trim();
    $('reg-done-pay').textContent = instr ? `匯款方式：\n${instr}` : '';
    $('reg-done-pay').classList.toggle('hidden', !instr);
    $('reg-card').classList.add('hidden');
    $('reg-done').classList.remove('hidden');
    window.scrollTo({ top: 0 });
    nameInput.value = '';
    $('preview').replaceChildren();
    await load();
  } catch (err) {
    showMsg($('form-msg'), err.message, 'err');
    load().catch(() => {});
  } finally {
    btn.textContent = '送出報名';
    btn.disabled = !state.comp.registration_open;
  }
});

$('reg-again-btn').addEventListener('click', () => {
  $('reg-done').classList.add('hidden');
  $('reg-card').classList.remove('hidden');
  nameInput.focus();
});

$('pay-now-btn').addEventListener('click', () => {
  if (state.lastRegistered) openPayDialog(state.lastRegistered, state.lastRegistered.fullName);
});

// ---------- 參加人員 ----------
function renderTabs() {
  const mk = (key, label, count) => el('button', {
    type: 'button',
    class: state.filter === key ? 'active' : '',
    onclick: () => { state.filter = key; renderTabs(); renderList(); },
  }, label, ' ', el('span', { class: 'count' }, `(${count})`));
  $('tabs').replaceChildren(
    mk('all', '全部', state.registrations.length),
    ...state.categories.map((c) => mk(String(c.id), c.name, c.count)),
  );
}

function renderList() {
  const kw = state.search.trim().toLowerCase();
  const rows = state.registrations.filter((r) =>
    (state.filter === 'all' || String(r.category_id) === state.filter) &&
    (!kw || r.display_name.toLowerCase().includes(kw) || r.team.toLowerCase().includes(kw)));

  $('total').textContent = `${rows.length} 人`;
  if (!rows.length) {
    $('list').replaceChildren(el('li', { class: 'empty', style: 'display:block' }, '目前還沒有報名資料'));
    return;
  }
  $('list').replaceChildren(...rows.map((r, i) => el('li', {},
    el('span', { class: 'no' }, i + 1),
    el('div', { class: 'who' },
      el('div', { class: 'name' }, r.display_name),
      el('div', { class: 'sub' }, [r.category_name, r.team].filter(Boolean).join('・'))),
    el('div', { class: 'end' }, r.payment_status === 'unpaid'
      ? el('button', { type: 'button', class: 'pay unpaid', onclick: () => openPayDialog(r) }, '未繳費 ✎')
      : payBadge(r.payment_status)),
  )));
}

$('search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });

// ---------- 繳費資訊 ----------
const dlg = $('pay-dialog');

function openPayDialog(reg, fullName = '') {
  state.payTarget = reg;
  $('pay-form').reset();
  $('pay-msg').className = 'msg';
  $('pay-submit').disabled = false;
  $('pay-who').replaceChildren('報名資料：', el('strong', {}, reg.display_name), `　${reg.category_name}`);
  const instr = state.comp.payment_instructions.trim();
  $('pay-instructions').textContent = instr ? `匯款方式：\n${instr}` : '';
  $('pay-instructions').classList.toggle('hidden', !instr);
  $('pay-name').value = fullName;
  $('pay-amount').value = state.comp.fee ?? '';
  const today = new Date();
  const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('pay-date').value = local;
  $('pay-date').max = local;
  dlg.showModal();
  if (!fullName) $('pay-name').focus();
}

$('pay-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 點背景關閉

$('pay-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('pay-submit');
  btn.disabled = true;
  btn.textContent = '送出中…';
  const reg = state.payTarget;
  try {
    let proofPath = null;
    const file = $('pay-file').files[0];
    if (file) {
      btn.textContent = '上傳截圖中…';
      const { blob, ext, type } = await prepareUpload(file);
      proofPath = `${reg.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from(PROOF_BUCKET).upload(proofPath, blob, { contentType: type });
      if (error) throw new Error(`截圖上傳失敗：${error.message}`);
    }
    check(await sb.rpc('submit_payment', {
      p_registration_id: reg.id,
      p_full_name: $('pay-name').value,
      p_account_last5: $('pay-last5').value.trim(),
      p_amount: Number($('pay-amount').value),
      p_paid_on: $('pay-date').value,
      p_note: $('pay-note').value,
      p_proof_path: proofPath,
    }));
    dlg.close();
    $('reg-done').classList.add('hidden');
    $('reg-card').classList.remove('hidden');
    showTab('participants');
    await load();
    alert(`已送出 ${reg.display_name} 的繳費資訊，工作人員確認後會改為「已繳費」。`);
  } catch (err) {
    showMsg($('pay-msg'), err.message, 'err');
    btn.disabled = false;
  } finally {
    btn.textContent = '送出';
  }
});

// ---------- 載入 ----------
async function load() {
  if (!state.comp) {
    state.comp = check(await sb.from('competitions')
      .select('id, slug, title, event_date, location, fee, payment_instructions, brochure, is_published, registration_open')
      .eq('slug', slug).maybeSingle());
    if (!state.comp) {
      $('comp-title').textContent = '';
      $('subnav').classList.add('hidden');
      document.querySelectorAll('section.tab').forEach((s) => s.classList.add('hidden'));
      $('not-found').classList.remove('hidden');
      return false;
    }
  }
  const [categories, registrations] = await Promise.all([
    sb.rpc('list_categories', { p_competition_id: state.comp.id }).then(check),
    sb.rpc('list_public_registrations', { p_competition_id: state.comp.id }).then(check),
  ]);
  state.categories = categories;
  state.registrations = registrations;
  if (state.filter !== 'all' && !categories.some((c) => String(c.id) === state.filter)) state.filter = 'all';
  renderInfo();
  renderCategorySelect();
  renderTabs();
  renderList();
  updateCta();
  return true;
}

load()
  .then((ok) => { if (ok) showTab(tabFromUrl || 'info', false); })
  .catch((err) => {
    $('comp-title').textContent = '';
    document.querySelector('main').prepend(el('div', { class: 'msg show err' }, `無法載入資料：${err.message}`));
  });
