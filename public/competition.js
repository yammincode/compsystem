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
  series: null,
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
  loadSite().then((site) => { document.title = `${c.title}｜${site.site_name}`; });
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
          (cat.grade_min != null || cat.grade_max != null || cat.description)
            ? el('div', { class: 'muted' }, [gradeRangeLabel(cat.grade_min, cat.grade_max), cat.description].filter(Boolean).join('・')) : null),
        el('span', { class: 'muted' }, cat.capacity != null ? `${cat.count}/${cat.capacity}` : `${cat.count} 人`),
        el('span', { class: `badge ${s.cls}` }, s.text));
    })
    : [el('li', { class: 'empty' }, '尚未設定組別')]));
}

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
    const range = gradeRangeLabel(c.grade_min, c.grade_max);
    const extra = [range, c.description].filter(Boolean).join('，');
    const label = extra ? `${c.name}（${extra}）` : c.name;
    categorySelect.append(el('option', { value: c.id, disabled: !s.available },
      s.available ? label : `${label} — ${s.text}`));
  }
  if ([...categorySelect.options].some((o) => o.value === current && !o.disabled)) categorySelect.value = current;
  $('submit-btn').disabled = !state.comp.registration_open;
}

// 這場屬於系列賽且有套票：提示改買套票
function renderSeriesBanner() {
  document.querySelectorAll('.series-banner').forEach((b) => b.remove());
  const se = state.series;
  if (!se) return;
  const comps = state.seriesComps ?? [];
  const pkg = packageInfo(se, comps);
  const mk = () => el('div', { class: 'banner series-banner' },
    el('span', {}, `這場是「${se.title}」的其中一站。`,
      pkg.available ? el('strong', {}, ` ${comps.length} 場套票 ${formatMoney(pkg.fee)}${pkg.saving > 0 ? `，省 ${formatMoney(pkg.saving)}` : ''}`) : null),
    el('span', { class: 'spacer' }),
    el('a', { class: 'btn small', href: pkg.available ? `/s/${se.slug}/register` : `/s/${se.slug}` },
      pkg.available ? '改買套票' : '看系列賽'));
  document.querySelector('section.tab[data-tab="info"]').prepend(mk());
  document.querySelector('section.tab[data-tab="register"]').prepend(mk());
}

// 依出生日期（比賽當天所在學年）自動選組別
let catAutoPicked = false;
categorySelect.addEventListener('change', () => { catAutoPicked = false; });
function autoPickCategory() {
  const ref = refDate();
  const grade = birthInput.value ? gradeOn(birthInput.value, ref) : null;
  if (grade == null) return null;
  const { match, count } = categoryForGrade(state.categories, grade,
    (c) => categoryStatus(c, state.comp.registration_open).available);
  if (match && (!categorySelect.value || catAutoPicked)) {
    categorySelect.value = String(match.id);
    catAutoPicked = true;
  }
  const label = `${rocYear(ref)} 學年度 ${gradeLabel(grade)}`;
  if (match && catAutoPicked) return `${label}，已自動選「${match.name}」（跳級或晚讀可自行更改）`;
  if (count > 1) return `${label}，有多個組別符合，請自行選擇`;
  return state.categories.some((c) => c.grade_min != null || c.grade_max != null) ? label : null;
}

// ---------- 出生日期、家長同意書 ----------
const birthInput = $('birth');
const sigPad = createSignaturePad($('sig-pad'), {
  onChange: (hasInk) => $('sig-hint').classList.toggle('hidden', hasInk),
});
birthInput.max = todayStr();
let consentShown = false;

function refDate() {
  return state.comp?.event_date || todayStr();
}

function isMinor() {
  const age = ageOn(birthInput.value, refDate());
  return age != null && age < 18;
}

function updateConsent() {
  const age = ageOn(birthInput.value, refDate());
  const minor = age != null && age < 18;
  const valid = age != null && age >= 0 && age <= 120;
  const gradeNote = valid ? autoPickCategory() : null;
  $('age-hint').replaceChildren(...(!birthInput.value ? [] : !valid ? ['出生日期不正確'] : [
    state.comp?.event_date ? `比賽當天 ${age} 歲` : `${age} 歲`,
    minor ? el('strong', { style: 'color:var(--err)' }, '・未滿 18 歲，需家長同意書（請往下填寫）') : null,
    gradeNote ? el('div', { class: 'grade-hint' }, gradeNote) : null,
  ].filter(Boolean)));
  $('consent-box').classList.toggle('hidden', !(minor && valid));
  if (minor && valid && !consentShown) {
    consentShown = true;
    $('consent-text').replaceChildren(renderMarkdown(state.comp.minor_consent || '（主辦單位尚未提供同意書內容）'));
    requestAnimationFrame(() => sigPad.setup()); // 顯示後才知道簽名欄大小
  }
}
birthInput.addEventListener('change', updateConsent);
birthInput.addEventListener('input', updateConsent);
$('sig-clear').addEventListener('click', () => sigPad.clear());

function resetConsent() {
  consentShown = false;
  catAutoPicked = false;
  $('g-name').value = '';
  $('g-rel').value = '';
  $('g-agree').checked = false;
  $('consent-box').classList.add('hidden');
  $('age-hint').replaceChildren();
}

function guardianPayload() {
  if (!isMinor()) return null;
  const name = $('g-name').value.trim();
  if (!name) throw new Error('未滿 18 歲需家長同意書：請填寫家長姓名');
  if (!$('g-rel').value) throw new Error('請選擇家長與參賽者的關係');
  if (sigPad.isEmpty()) throw new Error('請家長在簽名欄簽名');
  if (!$('g-agree').checked) throw new Error('請勾選「已閱讀並同意」家長同意書');
  return { name, relationship: $('g-rel').value, signature: sigPad.toDataURL(), agreed: true };
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
    if (!birthInput.value) throw new Error('請填寫出生日期');
    const name = nameInput.value;
    const guardian = guardianPayload();
    const result = check(await sb.rpc('register', {
      p_name: name, p_team: teamInput.value, p_category_id: Number(categorySelect.value),
      p_birth_date: birthInput.value, p_guardian: guardian,
    }));
    const cat = state.categories.find((c) => String(c.id) === categorySelect.value);
    state.lastRegistered = { id: result.id, display_name: result.display_name, category_name: cat?.name ?? '', fullName: name.trim() };

    $('reg-done-text').replaceChildren(el('strong', {}, result.display_name), ` 已報名「${cat?.name ?? ''}」`,
      state.comp.fee ? `，報名費 ${formatMoney(state.comp.fee)}。` : '。',
      result.minor ? el('div', { class: 'muted' }, '✓ 家長同意書已簽署') : null);
    const instr = state.comp.payment_instructions.trim();
    $('reg-done-pay').textContent = instr ? `匯款方式：\n${instr}` : '';
    $('reg-done-pay').classList.toggle('hidden', !instr);
    $('reg-card').classList.add('hidden');
    $('reg-done').classList.remove('hidden');
    window.scrollTo({ top: 0 });
    nameInput.value = '';
    birthInput.value = '';
    resetConsent();
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
      el('div', { class: 'name' }, r.display_name, r.is_package ? el('span', { class: 'pkg-badge' }, '套票') : null),
      el('div', { class: 'sub' }, [r.category_name, r.team].filter(Boolean).join('・'))),
    el('div', { class: 'end' }, r.payment_status === 'unpaid'
      ? el('button', { type: 'button', class: 'pay unpaid', onclick: () => openPayDialog(r) }, '未繳費 ✎')
      : payBadge(r.payment_status)),
  )));
}

$('search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });

// ---------- 繳費資訊 ----------
const payDialog = createPayDialog({
  onDone: async () => {
    $('reg-done').classList.add('hidden');
    $('reg-card').classList.remove('hidden');
    showTab('participants');
    await load();
  },
});

function openPayDialog(reg, fullName = '') {
  const pkg = reg.is_package && state.series;
  payDialog.open(reg, {
    fullName,
    amount: pkg ? state.series.package_fee : state.comp.fee,
    instructions: (pkg && state.series.payment_instructions) || state.comp.payment_instructions,
    label: pkg ? `${reg.category_name}・套票` : reg.category_name,
  });
}

// ---------- 載入 ----------
async function load() {
  if (!state.comp) {
    state.comp = check(await sb.from('competitions')
      .select('id, slug, title, event_date, location, fee, payment_instructions, brochure, minor_consent, is_published, registration_open, series_id')
      .eq('slug', slug).maybeSingle());
    if (!state.comp) {
      $('comp-title').textContent = '';
      $('subnav').classList.add('hidden');
      document.querySelectorAll('section.tab').forEach((s) => s.classList.add('hidden'));
      $('not-found').classList.remove('hidden');
      return false;
    }
    if (state.comp.series_id) {
      state.series = (await sb.from('series').select(SERIES_FIELDS).eq('id', state.comp.series_id).maybeSingle()).data ?? null;
      if (state.series) state.seriesComps = await loadSeriesComps(state.series.id).catch(() => []);
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
  renderSeriesBanner();
  renderCategorySelect();
  renderTabs();
  renderList();
  updateCta();
  return true;
}

applySite();
load()
  .then((ok) => { if (ok) showTab(tabFromUrl || 'info', false); })
  .catch((err) => {
    $('comp-title').textContent = '';
    document.querySelector('main').prepend(el('div', { class: 'msg show err' }, `無法載入資料：${err.message}`));
  });
