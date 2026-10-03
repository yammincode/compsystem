'use strict';

const $home = (id) => document.getElementById(id);

async function load() {
  const list = document.getElementById('list');
  const comps = check(await sb.from('competitions')
    .select('slug, title, event_date, location, fee, registration_open, is_published')
    .order('event_date', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false }));

  if (!comps.length) {
    list.replaceChildren(el('p', { class: 'empty' }, '目前沒有公開的比賽'));
    return;
  }
  list.replaceChildren(...comps.map((c) => el('a', { class: 'comp-card', href: `/c/${c.slug}` },
    el('div', {},
      c.registration_open ? el('span', { class: 'badge' }, '報名中') : el('span', { class: 'badge closed' }, '報名截止'),
      c.is_published ? null : el('span', { class: 'badge full', style: 'margin-left:6px' }, '未公開（僅管理員可見）')),
    el('h2', {}, c.title),
    el('div', { class: 'meta' },
      c.event_date ? el('div', {}, `📅 ${formatDate(c.event_date)}`) : null,
      c.location ? el('div', {}, `📍 ${c.location}`) : null,
      c.fee != null ? el('div', {}, `💰 ${formatMoney(c.fee)}`) : null),
    el('div', { class: 'go' }, c.registration_open ? '查看簡章・報名 →' : '查看簡章・名單 →'),
  )));
}

applySite().then((site) => {
  document.title = site.site_name;
  $home('home-title').textContent = site.home_title;
  $home('home-intro').replaceChildren(renderMarkdown(site.home_intro));
});

load().catch((err) => {
  document.getElementById('list').replaceChildren(el('div', { class: 'msg show err' }, `無法載入資料：${err.message}`));
});
