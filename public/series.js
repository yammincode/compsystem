'use strict';

// 網址：/s/<系列賽代碼>，/s/<系列賽代碼>/register 會直接捲到套票報名
const [, , seriesSlug = '', subFromUrl = ''] = location.pathname.split('/');
const $ = (id) => document.getElementById(id);

const state = {
  series: null,
  comps: [],
  cats: {},          // competitionId → 組別
  lastRegistered: null,
};

const payDialog = createPayDialog({ onDone: () => load().then((ok) => ok && renderAll()) });

// ---------- 畫面 ----------
function renderStations() {
  const n = state.comps.length;
  $('station-grid').replaceChildren(...state.comps.map((c, i) => {
    const final = isFinalStation(i, n);
    return el('a', { class: `station${final ? ' final' : ''}`, href: `/c/${c.slug}` },
      el('div', { class: 'band', style: final ? '' : `background:${stationColor(i)}` },
        el('small', {}, stationLabel(i, n)),
        el('h3', {}, c.title)),
      el('div', { class: 'body' },
        el('span', {}, c.event_date ? formatDate(c.event_date) : '日期待定'),
        c.location ? el('span', { class: 'muted' }, c.location) : null,
        el('span', { class: 'muted' }, c.fee != null ? `單場 ${formatMoney(c.fee)}` : '報名費未定'),
        el('span', { style: 'color:var(--accent);font-weight:700;margin-top:6px' },
          c.registration_open ? '簡章・單場報名 →' : '簡章・名單 →')));
  }));
}

function renderGroups() {
  // 以第一場的組別當作代表（各站組別通常相同）
  const cats = state.cats[state.comps[0]?.id] ?? [];
  $('groups').classList.toggle('hidden', !cats.length);
  const hasGrades = cats.some((c) => c.grade_min != null || c.grade_max != null);
  $('groups-lead').textContent = hasGrades
    ? `報名時填出生日期，系統會依 ${rocYear(state.comps[0]?.event_date || todayStr())} 學年度年級自動分組。`
    : '';
  $('group-grid').replaceChildren(...cats.map((c, i) => {
    const m = /^([A-Z])\s*(.*)$/.exec(c.name);
    return el('div', { class: 'group' },
      el('span', { class: 'letter' }, m ? m[1] : String.fromCharCode(65 + i)),
      el('span', { class: 'name' }, m ? m[2] : c.name),
      el('span', { class: 'muted' }, gradeRangeLabel(c.grade_min, c.grade_max) || c.description || ''));
  }));
}

function renderFees() {
  const pkg = packageInfo(state.series, state.comps);
  const cards = [];
  cards.push(el('div', { class: 'fee' },
    el('div', { class: 'title' }, '單場報名'),
    el('div', { class: 'price' }, pkg.sameFee != null ? formatMoney(pkg.sameFee) : '依場次',
      pkg.sameFee != null ? el('small', {}, ' / 場') : null),
    el('div', { class: 'note' }, '任選想參加的站別，每場分開報名、分開繳費。'),
    el('a', { class: 'btn secondary', href: '#stations' }, '選擇場次')));
  if (state.series.package_fee != null) {
    cards.push(el('div', { class: 'fee featured' },
      el('div', { class: 'title' }, `${state.comps.length} 場套票`,
        pkg.saving > 0 ? el('span', { class: 'save' }, `省 ${formatMoney(pkg.saving)}`) : null),
      el('div', { class: 'price' }, formatMoney(pkg.fee), el('small', {}, ` / ${state.comps.length} 場`)),
      el('div', { class: 'note' }, pkg.available
        ? `一次鎖定所有場次名額，平均每場 ${formatMoney(Math.round(pkg.fee / state.comps.length))}。`
        : '套票目前不開放購買。'),
      pkg.available ? el('a', { class: 'btn on-hero', href: '#register' }, '購買套票') : null));
  }
  $('fee-grid').replaceChildren(...cards);
}

// ---------- 套票報名表 ----------
const nameInput = $('name');
const birthInput = $('birth');
const sigPad = createSignaturePad($('sig-pad'), {
  onChange: (hasInk) => $('sig-hint').classList.toggle('hidden', hasInk),
});
birthInput.max = todayStr();
let consentShown = false;
const autoPicked = new Set(); // 由系統自動選的下拉選單（使用者改過就不再自動改）

function catAvailable(comp, cat) {
  return categoryStatus(cat, comp.registration_open).available;
}

function renderPickList() {
  $('pick-list').replaceChildren(...state.comps.map((comp, i) => {
    const cats = state.cats[comp.id] ?? [];
    const sel = el('select', { id: `pick-${comp.id}`, required: true, 'aria-label': `${comp.title} 組別` },
      el('option', { value: '' }, '請選擇組別'),
      ...cats.map((c) => {
        const s = categoryStatus(c, comp.registration_open);
        const range = gradeRangeLabel(c.grade_min, c.grade_max);
        const label = range ? `${c.name}（${range}）` : c.name;
        return el('option', { value: c.id, disabled: !s.available }, s.available ? label : `${label} — ${s.text}`);
      }));
    sel.addEventListener('change', () => autoPicked.delete(comp.id));
    return el('div', { class: 'station-pick' },
      el('div', { class: 'head' },
        el('span', { class: 'dot', style: `background:${isFinalStation(i, state.comps.length) ? 'var(--bright)' : stationColor(i)}` }),
        comp.title,
        el('span', { class: 'muted' }, comp.event_date ? formatDate(comp.event_date) : '')),
      sel);
  }));
}

function minorOnAnyDate() {
  if (!birthInput.value) return false;
  return state.comps.some((c) => {
    const age = ageOn(birthInput.value, c.event_date || todayStr());
    return age != null && age < 18;
  });
}

function onBirthChange() {
  const ref = state.comps[0]?.event_date || todayStr();
  const age = ageOn(birthInput.value, ref);
  const valid = age != null && age >= 0 && age <= 120;
  const grade = valid ? gradeOn(birthInput.value, ref) : null;
  const notes = [];
  let ambiguous = false;

  for (const comp of state.comps) {
    const sel = $(`pick-${comp.id}`);
    const { match, count } = categoryForGrade(state.cats[comp.id] ?? [], grade, (c) => catAvailable(comp, c));
    if (match && (!sel.value || autoPicked.has(comp.id))) {
      sel.value = String(match.id);
      autoPicked.add(comp.id);
    }
    if (!match && count > 1) ambiguous = true;
  }
  if (birthInput.value && !valid) notes.push('出生日期不正確');
  else if (grade != null) {
    notes.push(`${rocYear(ref)} 學年度 ${gradeLabel(grade)}`);
    if (ambiguous) notes.push('有多個組別符合（例如分男女組），請在下方自行選擇');
    else if (autoPicked.size) notes.push('已自動選好組別，跳級或晚讀可自行更改');
  }
  $('age-hint').replaceChildren(...(notes.length ? [el('div', { class: 'grade-hint' }, notes.join('・'))] : []));

  const minor = valid && minorOnAnyDate();
  $('consent-box').classList.toggle('hidden', !minor);
  if (minor && !consentShown) {
    consentShown = true;
    $('consent-text').replaceChildren(renderMarkdown(state.comps[0]?.minor_consent || '（主辦單位尚未提供同意書內容）'));
    requestAnimationFrame(() => sigPad.setup());
  }
}
birthInput.addEventListener('change', onBirthChange);
birthInput.addEventListener('input', onBirthChange);
$('sig-clear').addEventListener('click', () => sigPad.clear());

nameInput.addEventListener('input', () => {
  const v = nameInput.value.trim();
  $('preview').replaceChildren(...(v ? ['名單上會顯示為：', el('strong', {}, anonymizeName(v))] : []));
});

function guardianPayload() {
  if (!minorOnAnyDate()) return null;
  const name = $('g-name').value.trim();
  if (!name) throw new Error('未滿 18 歲需家長同意書：請填寫家長姓名');
  if (!$('g-rel').value) throw new Error('請選擇家長與參賽者的關係');
  if (sigPad.isEmpty()) throw new Error('請家長在簽名欄簽名');
  if (!$('g-agree').checked) throw new Error('請勾選「已閱讀並同意」家長同意書');
  return { name, relationship: $('g-rel').value, signature: sigPad.toDataURL(), agreed: true };
}

function resetForm() {
  $('pkg-form').reset();
  autoPicked.clear();
  consentShown = false;
  $('consent-box').classList.add('hidden');
  $('age-hint').replaceChildren();
  $('preview').replaceChildren();
}

$('pkg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submit-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '送出中…';
  $('form-msg').className = 'msg';
  try {
    if (!birthInput.value) throw new Error('請填寫出生日期');
    const ids = state.comps.map((c) => {
      const v = $(`pick-${c.id}`).value;
      if (!v) throw new Error(`請選擇「${c.title}」的組別`);
      return Number(v);
    });
    const name = nameInput.value;
    const result = check(await sb.rpc('register_package', {
      p_series_id: state.series.id, p_name: name, p_team: $('team').value,
      p_category_ids: ids, p_birth_date: birthInput.value, p_guardian: guardianPayload(),
    }));
    state.lastRegistered = {
      id: result.lead_id, display_name: result.display_name, is_package: true, fullName: name.trim(), fee: result.fee,
    };
    $('pkg-done-text').replaceChildren(el('strong', {}, result.display_name),
      ` 已報名 ${state.comps.length} 場套票，報名費 ${formatMoney(result.fee)}。`,
      result.minor ? el('div', { class: 'muted' }, '✓ 家長同意書已簽署') : null);
    const instr = payInstructions();
    $('pkg-done-pay').textContent = instr ? `匯款方式：\n${instr}` : '';
    $('pkg-done-pay').classList.toggle('hidden', !instr);
    $('pkg-card').classList.add('hidden');
    $('pkg-done').classList.remove('hidden');
    $('register').scrollIntoView({ behavior: 'smooth' });
    resetForm();
    if (await load()) renderAll();
  } catch (err) {
    showMsg($('form-msg'), err.message, 'err');
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

function payInstructions() {
  return (state.series.payment_instructions || state.comps[0]?.payment_instructions || '').trim();
}

$('pay-now-btn').addEventListener('click', () => {
  const r = state.lastRegistered;
  if (r) payDialog.open(r, { fullName: r.fullName, amount: r.fee, instructions: payInstructions(), label: `${state.comps.length} 場套票` });
});
$('again-btn').addEventListener('click', () => {
  $('pkg-done').classList.add('hidden');
  $('pkg-card').classList.remove('hidden');
  nameInput.focus();
});

function renderRegister() {
  const pkg = packageInfo(state.series, state.comps);
  $('pkg-closed').classList.toggle('hidden', pkg.available);
  $('pkg-closed').textContent = state.series.package_fee == null
    ? '這個系列賽沒有套票，請從上方賽程選擇單場報名。'
    : '套票目前不開放購買（可能有場次已截止），請從上方賽程選擇單場報名。';
  if (!pkg.available) $('pkg-card').classList.add('hidden');
  $('submit-btn').textContent = `送出套票報名（${formatMoney(pkg.fee)}）`;
}

// ---------- 載入 ----------
async function load() {
  if (!state.series) {
    state.series = check(await sb.from('series').select(SERIES_FIELDS).eq('slug', seriesSlug).maybeSingle());
    if (!state.series) {
      $('not-found').classList.remove('hidden');
      return false;
    }
  }
  state.comps = await loadSeriesComps(state.series.id);
  const lists = await Promise.all(state.comps.map((c) => sb.rpc('list_categories', { p_competition_id: c.id }).then(check)));
  state.comps.forEach((c, i) => { state.cats[c.id] = lists[i]; });
  return true;
}

function renderAll() {
  loadSite().then((site) => { document.title = `${state.series.title}｜${site.site_name}`; });
  $('hero').replaceChildren(renderSeriesHero(state.series, state.comps, { onSeriesPage: true }));
  renderStations();
  renderGroups();
  renderFees();
  $('intro-section').classList.toggle('hidden', !state.series.intro.trim());
  $('intro').replaceChildren(renderMarkdown(state.series.intro));
  renderPickList();
  renderRegister();
  $('content').classList.remove('hidden');
  $('series-nav').classList.remove('hidden');
}

applySite();
load()
  .then((ok) => {
    if (!ok) return;
    renderAll();
    if (subFromUrl === 'register') requestAnimationFrame(() => $('register').scrollIntoView());
  })
  .catch((err) => showMsg($('load-msg'), `無法載入資料：${err.message}`, 'err'));
