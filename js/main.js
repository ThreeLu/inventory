import { GitHub } from './github.js';
import {
  Store, normalizeAssetId, newId, assertAssetFree, LOCATION_PREFIX,
  defaultLabel, setLabel, LABEL_TEXT, prefixForTags, defaultConsumable, isDepleted, ARCHIVE_REASONS,
  isBox, moveItem, loanStatus, nextAssetInPrefix, nextTagCode, reminders,
} from './store.js';
import { h, today, compressImage, blobToBase64, lazyPhoto, photoUrl } from './util.js';
import { makeXlsx } from './xlsx.js';
import { startScanner, assetFromScan } from './scan.js';
import { PURPOSES, geocode, weatherFor, summarizeWeather, rulePlan, aiPlan } from './trip.js';

const SETTINGS_KEY = 'inventory-settings';
const DEFAULT_REPO = 'ThreeLu/inventory-data';
// 二维码里的网址：本页地址 + ?a=编号
const SITE_URL = window.location.origin + window.location.pathname;
// 在这些页面上不要因为后台刷新而重画（会丢掉正在填的内容、关掉摄像头）
const EDITING_ROUTES = /^\/(new|item\/[^/]+\/edit|scan)/;

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let settings = readSettings();
let gh = null;
let store = null;
let loadError = null;
let cleanup = null; // 当前页面离开时要做的事（比如关摄像头）

// ---------- 启动 ----------

function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

function connect() {
  gh = new GitHub({ token: settings.token, repo: settings.repo || DEFAULT_REPO });
  store = new Store(gh);
  store.loadCached();
}

function currentPath() {
  return window.location.hash.replace(/^#/, '').split('?')[0];
}

async function refresh() {
  const before = store.head;
  const hadData = Boolean(store.data);
  try {
    await store.load();
    loadError = null;
  } catch (e) {
    loadError = e;
  }
  if (!loadError) migrateLocalAiKey();
  // 第一次拿到数据（或出错）一定要画；之后数据有变化时，正在填表或扫码的页面不重画
  if (!hadData || loadError) render();
  else if (store.head !== before && !EDITING_ROUTES.test(currentPath())) render();
}

// 旧版把 DeepSeek 密钥存在设备的浏览器里；仓库里还没有时，自动存进数据仓库，所有设备共用
let aiMigrating = false;
async function migrateLocalAiKey() {
  let local;
  try { local = JSON.parse(localStorage.getItem('inventory-deepseek')); } catch { local = null; }
  if (!local?.key || aiMigrating) return;
  if (store.config?.deepseek?.key) { localStorage.removeItem('inventory-deepseek'); return; }
  aiMigrating = true;
  try {
    await store.saveConfig({ ...(store.config || {}), deepseek: { key: local.key, model: local.model || 'deepseek-chat' } }, '保存 DeepSeek 设置（从设备迁移）');
    localStorage.removeItem('inventory-deepseek');
    toast('已把这台设备上的 DeepSeek 密钥存到数据仓库，所有设备都能用');
    if (!EDITING_ROUTES.test(currentPath())) render();
  } catch { /* 下次打开再试 */ } finally {
    aiMigrating = false;
  }
}

function boot() {
  // 扫码进来的网址是 ?a=290-0001，转成页面内的路由
  const scanned = new URLSearchParams(window.location.search).get('a');
  if (scanned) history.replaceState(null, '', `${window.location.pathname}#/a/${encodeURIComponent(scanned)}`);

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  if (settings.token) {
    connect();
    render();
    refresh();
  } else {
    // 还没登录：记住要去的页面（比如扫码的编号），登录后再跳过去
    if (window.location.hash && window.location.hash !== '#/settings') sessionStorage.setItem('after-login', window.location.hash);
    go('#/settings', true);
  }
  // 从后台切回来时拉一次最新数据（比如在另一台设备上改过）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store) refresh();
  });
}

function go(hash, replace = false) {
  if (replace) {
    history.replaceState(null, '', hash);
    render();
  } else {
    window.location.hash = hash;
  }
}

// ---------- 路由 ----------

const routes = [
  [/^\/?$/, () => listView()],
  [/^\/places$/, () => placesView()],
  [/^\/place\/([^/]+)$/, (id) => placeView(id)],
  [/^\/place\/([^/]+)\/label$/, (id) => labelView('location', id)],
  [/^\/item\/([^/]+)$/, (id) => itemView(id)],
  [/^\/item\/([^/]+)\/edit$/, (id) => formView(id)],
  [/^\/item\/([^/]+)\/label$/, (id) => labelView('item', id)],
  [/^\/new$/, (_, q) => formView(null, q)],
  [/^\/a\/([^/]+)$/, (asset) => scanResultView(decodeURIComponent(asset))],
  [/^\/scan$/, () => scanView()],
  [/^\/more$/, () => moreView()],
  [/^\/labels$/, () => labelsView()],
  [/^\/reminders$/, () => remindersView()],
  [/^\/restock$/, () => restockView()],
  [/^\/loans$/, () => loansView()],
  [/^\/boxes$/, () => boxesView()],
  [/^\/trips$/, () => tripsView()],
  [/^\/trip\/new$/, () => tripPlanView(null)],
  [/^\/trip\/([^/]+)$/, (id) => tripPlanView(id)],
  [/^\/stats$/, () => statsView()],
  [/^\/manage$/, () => manageView()],
  [/^\/settings$/, () => settingsView()],
];

const NAV_GROUPS = { '/more': ['/more', '/labels', '/restock', '/reminders', '/stats', '/manage', '/settings', '/boxes', '/box', '/trip', '/loans'] };

function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [path, query = ''] = window.location.hash.replace(/^#/, '').split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  let content;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (re.source.includes('settings')) content = fn();
    else if (!settings.token) content = settingsView();
    else if (!store.data) content = loadError ? errorView(loadError) : h('p', { class: 'muted center' }, '正在读取数据…');
    else content = fn(m[1], q);
    break;
  }
  view.replaceChildren(content || notFound('没有这个页面'));
  for (const a of nav.querySelectorAll('a')) {
    const target = a.getAttribute('href').slice(1);
    const group = NAV_GROUPS[target];
    a.classList.toggle('active', target === '/'
      ? path === '' || path === '/'
      : group ? group.some((g) => path.startsWith(g)) : path.startsWith(target));
  }
  const pending = store?.data ? store.pendingLabels().length + reminders(store.data).length : 0;
  nav.querySelector('a[href="#/more"] .dot')?.toggleAttribute('hidden', !pending);
}

// ---------- 通用组件 ----------

function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}

function busy(message) {
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, message));
  document.body.append(el);
  return { set: (m) => { el.firstChild.textContent = m; }, done: () => el.remove() };
}

async function saving(message, fn) {
  const b = busy(message);
  try {
    return await fn(b);
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  } finally {
    b.done();
  }
}

function errorView(e) {
  return h('div', { class: 'card' },
    h('p', {}, '读取数据失败：', e.message),
    h('button', { onclick: refresh }, '重试'),
    ' ', h('a', { href: '#/settings', class: 'button secondary' }, '检查设置'));
}

function notFound(message) {
  return h('div', { class: 'card' }, h('p', {}, message), h('a', { href: '#/', class: 'button' }, '回到首页'));
}

function header(title, ...extra) {
  return h('header', { class: 'page-head' }, h('h1', {}, title), ...extra);
}

function tagChip(tag) {
  return h('a', { class: 'chip', href: `#/?tag=${encodeURIComponent(tag)}` }, tag);
}

function assetChip(assetId) {
  return assetId ? h('span', { class: 'asset' }, assetId) : null;
}

function itemRow(item, extra = null) {
  const thumb = item.photos?.[0]?.thumb;
  return h('a', { class: `row${item.archived ? ' archived' : ''}`, href: `#/item/${item.id}` },
    thumb ? lazyPhoto(gh, thumb, { class: 'thumb' }) : h('div', { class: 'thumb empty' }, item.name.slice(0, 1)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
      h('div', { class: 'row-meta' },
        assetChip(item.assetId),
        item.label === 'pending' ? labelChip(item) : null,
        h('span', {}, store.shortName(item.location)),
        item.tags.length ? h('span', {}, item.tags.join('、')) : null,
        isDepleted(item) && !item.archived ? h('span', { class: 'badge warn' }, '已用完') : null,
        item.archived ? h('span', { class: 'badge' }, item.archiveReason ? `已归档 · ${item.archiveReason}` : '已归档') : null,
        extra)));
}

// 清空元素再放入内容。和 replaceChildren 不同，这里会展开数组、跳过 null（经过 h()）
function fill(el, ...children) {
  el.replaceChildren(...h('div', {}, ...children).childNodes);
}

// 底部弹出的小表单。onConfirm 返回 false 表示不关闭（比如校验没过）
function openSheet({ title, body, confirmText = '确定', onConfirm }) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet' },
      h('h3', {}, title),
      body,
      h('div', { class: 'actions' },
        h('button', { onclick: async () => { if ((await onConfirm()) !== false) close(); } }, confirmText),
        h('button', { class: 'secondary', onclick: close }, '取消'))));
  document.body.append(overlay);
  overlay.querySelector('input, textarea')?.focus();
}

function chipChoice(options, initial) {
  let value = initial;
  const box = h('div', { class: 'chips' });
  const draw = () => box.replaceChildren(...options.map((o) => h('button', {
    type: 'button', class: `chip${o === value ? ' on' : ''}`, onclick: () => { value = o; draw(); },
  }, o)));
  draw();
  return { el: box, get: () => value };
}

// 标签状态小标记：不贴 / 待打印 / 已打印 10-04
function labelChip(obj) {
  if (!obj.assetId) return null;
  const text = obj.label === 'printed' && obj.labelPrintedAt ? `已打印 ${obj.labelPrintedAt.slice(5)}` : LABEL_TEXT[obj.label] || '';
  return h('span', { class: `label-state ${obj.label}` }, text);
}

// 改一件物品或一个位置的标签状态
function changeLabel(type, id, state, message) {
  return saving('正在保存…', () => store.save(message, (data) => {
    const x = (type === 'item' ? data.items : data.locations).find((o) => o.id === id);
    if (!x) throw new Error('找不到了，可能已经在别处被删除');
    setLabel(x, state);
    if (type === 'item') x.updatedAt = new Date().toISOString();
  })).then(render).catch(() => {});
}

// 按当前状态给出的按钮：待打印 → 打印这一张 / 标记已打印；已打印 → 重新打印；不贴 → 要贴标签
function labelButtons(type, obj) {
  if (!obj.assetId) return [];
  const base = type === 'item' ? `#/item/${obj.id}` : `#/place/${obj.id}`;
  const name = type === 'item' ? obj.name : obj.name.split(' ')[0];
  if (obj.label === 'pending') {
    return [
      h('a', { class: 'button secondary', href: `${base}/label` }, '打印这一张'),
      h('button', { class: 'secondary', onclick: () => changeLabel(type, obj.id, 'printed', `标记已打印：${obj.assetId} ${name}`) }, '标记已打印'),
    ];
  }
  if (obj.label === 'printed') {
    return [h('button', {
      class: 'secondary',
      onclick: () => confirm(`重新打印 ${obj.assetId} 的标签？编号不变，新标签贴在旧标签的位置。`)
        && changeLabel(type, obj.id, 'pending', `重新打印：${obj.assetId} ${name}`),
    }, '重新打印')];
  }
  return [h('button', { class: 'secondary', onclick: () => changeLabel(type, obj.id, 'pending', `要贴标签：${obj.assetId} ${name}`) }, '要贴标签')];
}

function locationSelect(value, props = {}, placeholder = '选择位置…') {
  return h('select', { ...props, value: value || '' },
    h('option', { value: '' }, placeholder),
    store.locationTree().map(({ loc, depth }) =>
      h('option', { value: loc.id }, `${'　'.repeat(depth)}${loc.name}`)));
}

function daysText(days) {
  if (days < 0) return `已过期 ${-days} 天`;
  if (days === 0) return '今天到期';
  return `还剩 ${days} 天`;
}

function reminderRow(r) {
  return itemRow(r.item, h('span', { class: r.days < 0 ? 'warn' : 'soon' }, `${r.kind}${daysText(r.days)}`));
}

// ---------- 物品列表 ----------

const listState = { q: '', tag: '', loc: '', label: '', archived: false };

function matches(item, words) {
  const text = [
    item.name, item.assetId, item.description, item.notes, item.manufacturer, item.modelNumber,
    item.serialNumber, item.purchaseFrom, ...item.tags, ...Object.values(item.fields || {}),
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w) || (item.assetId && item.assetId.replace('-', '').includes(w.replace('-', ''))));
}

function listView() {
  const q = Object.fromEntries(new URLSearchParams(window.location.hash.split('?')[1] || ''));
  if (q.tag !== undefined) listState.tag = q.tag;
  const results = h('div', { class: 'list' });
  const count = h('p', { class: 'muted' });

  const update = () => {
    const words = listState.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const inLoc = listState.loc ? store.descendantIds(listState.loc) : null;
    const items = store.data.items
      .filter((i) => listState.archived || !i.archived)
      .filter((i) => !listState.tag || i.tags.includes(listState.tag))
      .filter((i) => !inLoc || inLoc.has(i.location))
      .filter((i) => !listState.label || i.label === listState.label)
      .filter((i) => matches(i, words))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const total = items.reduce((s, i) => s + (Number(i.quantity) || 1), 0);
    count.textContent = `${items.length} 件` + (total !== items.length ? `（共 ${total} 个）` : '');
    let shown = 100;
    const draw = () => {
      results.replaceChildren(...items.slice(0, shown).map((i) => itemRow(i)));
      if (items.length > shown) {
        results.append(h('button', { class: 'secondary wide', onclick: () => { shown += 100; draw(); } }, '显示更多'));
      }
    };
    draw();
    if (!store.data.items.length) {
      results.replaceChildren(h('div', { class: 'card' },
        h('p', {}, '还没有物品。'), h('a', { class: 'button', href: '#/new' }, '新建第一件')));
    }
  };

  // 首页顶部：快到期的东西
  const due = reminders(store.data);
  const dueCard = due.length ? h('a', { class: 'card notice', href: '#/reminders' },
    h('strong', {}, `${due.length} 件需要注意`),
    h('span', { class: 'muted small' }, due.slice(0, 3).map((r) => `${r.item.name}（${r.kind}${daysText(r.days)}）`).join('，'),
      due.length > 3 ? '……' : '')) : null;
  const depleted = store.data.items.filter((i) => isDepleted(i) && !i.archived);
  const restockCard = depleted.length ? h('a', { class: 'card notice', href: '#/restock' },
    h('strong', {}, `${depleted.length} 件用完了，需要补货`),
    h('span', { class: 'muted small' }, depleted.slice(0, 4).map((i) => i.name).join('，'), depleted.length > 4 ? '……' : '')) : null;
  const pending = store.pendingLabels().length;
  const labelCard = pending ? h('a', { class: 'card notice', href: '#/labels' },
    h('strong', {}, `${pending} 张标签待打印`), h('span', { class: 'muted small' }, '打印后贴上，再标记为已打印')) : null;

  const page = h('div', {},
    header('物品'),
    tokenCard(), dueCard, restockCard, loanCard(), boxCard(), labelCard,
    h('input', {
      type: 'search', placeholder: '搜索名称、编号、品牌……', value: listState.q, class: 'search',
      oninput: (e) => { listState.q = e.target.value; update(); },
    }),
    h('div', { class: 'filters' },
      h('select', { value: listState.tag, onchange: (e) => { listState.tag = e.target.value; update(); } },
        h('option', { value: '' }, '全部类别'), store.data.tags.map((t) => h('option', { value: t }, t))),
      locationSelect(listState.loc, { onchange: (e) => { listState.loc = e.target.value; update(); } }, '全部位置'),
      h('select', { value: listState.label, onchange: (e) => { listState.label = e.target.value; update(); } },
        h('option', { value: '' }, '标签状态'),
        Object.entries(LABEL_TEXT).map(([k, v]) => h('option', { value: k }, v))),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: listState.archived, onchange: (e) => { listState.archived = e.target.checked; update(); } }),
        '含已归档')),
    count, results);
  update();
  return page;
}

// ---------- 物品详情 ----------

function field(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return [h('dt', {}, label), h('dd', {}, value)];
}

function gallery(photos, cls = 'gallery') {
  if (!photos?.length) return null;
  const main = lazyPhoto(gh, photos[0].file, { class: 'main-photo', onclick: () => openPhoto(main.dataset.file) });
  main.dataset.file = photos[0].file;
  const strip = photos.length > 1 ? h('div', { class: 'strip' }, photos.map((p) =>
    lazyPhoto(gh, p.thumb, {
      onclick: () => {
        main.dataset.file = p.file;
        photoUrl(gh, p.file).then((url) => { main.src = url; });
      },
    }))) : null;
  return h('div', { class: cls }, main, strip);
}

function openPhoto(path) {
  const img = lazyPhoto(gh, path);
  const overlay = h('div', { class: 'overlay', onclick: () => overlay.remove() }, img);
  document.body.append(overlay);
}

function itemView(id) {
  const item = store.item(id);
  if (!item) return notFound('找不到这件物品，可能已经被删除了。');
  const fields = Object.entries(item.fields || {});
  const due = reminders(store.data).filter((r) => r.item.id === id);

  const update = (message, fn) => saving('正在保存…', () => store.save(message, (data) => {
    const it = data.items.find((i) => i.id === id);
    if (!it) throw new Error('这件物品已经在别处被删除了');
    fn(it);
    it.updatedAt = new Date().toISOString();
  })).then(render).catch(() => {});

  const note = (it, text) => { it.notes = [it.notes, `${today()} ${text}`].filter(Boolean).join('\n'); };

  // 归档：点选原因，可补充说明。编号保留、永不复用
  const archive = () => {
    const reason = chipChoice(ARCHIVE_REASONS, isDepleted(item) ? '用完不再买' : '扔掉');
    const extra = h('input', { placeholder: '补充说明（选填），比如送给了谁、在哪丢的' });
    openSheet({
      title: `归档「${item.name}」`,
      body: h('div', {}, reason.el, extra,
        h('p', { class: 'muted small' }, `编号 ${item.assetId || ''} 会保留，不会再分给别的东西。以后可以取消归档。`)),
      confirmText: '归档',
      onConfirm: () => update(`归档（${reason.get()}）：${item.name}`, (it) => {
        it.archived = true;
        it.archiveReason = reason.get();
        it.archivedAt = today();
        note(it, `归档：${reason.get()}${extra.value.trim() ? `，${extra.value.trim()}` : ''}`);
      }),
    });
  };
  const unarchive = () => update(`取消归档：${item.name}`, (it) => {
    it.archived = false;
    delete it.archiveReason;
    delete it.archivedAt;
    note(it, '取消归档');
  });

  // 消耗品：用掉一个 / 用完了 / 补货
  const useOne = () => update(`用掉一个：${item.name}`, (it) => {
    it.quantity = Math.max(0, (Number(it.quantity) || 1) - 1);
    if (it.quantity === 0) note(it, '用完');
  });
  const useUp = () => confirm(`「${item.name}」用完了？\n会放进「需要补货」清单，编号和记录都保留。`)
    && update(`用完：${item.name}`, (it) => { it.quantity = 0; note(it, '用完'); });
  const restock = () => openRestock(item);
  const lend = () => {
    const who = h('input', { placeholder: '借给谁，比如 室友小王' });
    const date = h('input', { type: 'date', value: today() });
    const due = h('input', { type: 'date' });
    openSheet({
      title: `借出「${item.name}」`,
      body: h('div', { class: 'form' }, h('label', {}, '借给谁', who), h('label', {}, '借出日期', date),
        h('label', {}, '约定归还（选填，不填就 30 天后提醒）', due)),
      confirmText: '借出',
      onConfirm: () => {
        if (!who.value.trim()) { toast('请填写借给谁', 'error'); return false; }
        return update(`借出：${item.name} → ${who.value.trim()}`, (it) => {
          it.loan = { to: who.value.trim(), date: date.value || today(), ...(due.value ? { due: due.value } : {}) };
          note(it, `借给 ${it.loan.to}${due.value ? `，约定 ${due.value} 前还` : ''}`);
        });
      },
    });
  };
  const giveBack = () => confirm(`「${item.name}」已经还回来了？`) && update(`归还：${item.name}`, (it) => {
    note(it, `${it.loan.to} 已归还（${it.loan.date} 借出）`);
    delete it.loan;
  });
  const loan = loanStatus(item);

  const remove = async () => {
    if (!confirm(`彻底删除「${item.name}」？\n\n删除只用于录错了、重复录入。扔掉、送人、用完不再买请用「归档」，记录会保留。\n（删除后编号也不会再分给别的东西）`)) return;
    const files = [...(item.photos || []), ...(item.receipts || [])].flatMap((p) => [p.file, p.thumb]);
    try {
      await saving('正在删除…', () => store.save(`删除：${item.name}`, (data) => {
        data.items = data.items.filter((i) => i.id !== id);
      }, { removes: files }));
      go('#/', true);
    } catch { /* saving 已经提示过错误 */ }
  };
  const copy = () => go(`#/new?from=${id}`);

  return h('div', {},
    item.archived ? h('div', { class: 'banner' }, `已归档${item.archiveReason ? `：${item.archiveReason}` : ''}${item.archivedAt ? `（${item.archivedAt}）` : ''}`) : null,
    isDepleted(item) && !item.archived ? h('div', { class: 'banner warn' }, '已用完，等补货') : null,
    loan ? h('div', { class: `banner ${loan.overdue ? 'warn' : ''}` },
      `借给 ${item.loan.to}（${item.loan.date}），已借 ${loan.since} 天`,
      loan.due !== null ? (loan.due < 0 ? `，超过约定 ${-loan.due} 天` : `，约定还剩 ${loan.due} 天`) : '') : null,
    item.homeLocation && isBox(store.data, item.location) ? h('div', { class: 'banner' },
      `装在「${store.shortName(item.location)}」里，原来在 ${store.locationPath(item.homeLocation)}`) : null,
    due.map((r) => h('div', { class: `banner ${r.days < 0 ? 'warn' : 'soon'}` }, `${r.kind}：${r.date}，${daysText(r.days)}`)),
    gallery(item.photos),
    h('div', { class: 'card' },
      h('h1', { class: 'item-title' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
      h('div', { class: 'row-meta' }, assetChip(item.assetId), labelChip(item),
        item.consumable ? h('span', { class: 'badge' }, '消耗品') : null,
        h('a', { href: `#/place/${item.location}` }, store.locationPath(item.location))),
      item.tags.length ? h('div', { class: 'chips' }, item.tags.map(tagChip)) : null,
      item.description ? h('p', { class: 'pre' }, item.description) : null,
      h('dl', {},
        fields.map(([k, v]) => field(k, v)),
        field('品牌', item.manufacturer),
        field('型号', item.modelNumber),
        field('序列号', item.serialNumber),
        field('购买日期', item.purchaseDate),
        field('价格', item.purchasePrice != null && item.purchasePrice !== '' ? `¥${item.purchasePrice}` : null),
        field('购买地点', item.purchaseFrom),
        field('保修到期', item.warrantyExpires)),
      item.notes ? [h('h3', {}, '备注'), h('p', { class: 'pre' }, item.notes)] : null),
    item.receipts?.length ? h('div', { class: 'card' }, h('h3', {}, '发票 / 保修卡'),
      h('div', { class: 'photo-grid' }, item.receipts.map((p) =>
        lazyPhoto(gh, p.thumb, { onclick: () => openPhoto(p.file) })))) : null,
    h('div', { class: 'actions' },
      h('a', { class: 'button', href: `#/item/${id}/edit` }, '编辑'),
      item.consumable && !item.archived ? [
        item.quantity > 1 ? h('button', { class: 'secondary', onclick: useOne }, '用掉一个') : null,
        isDepleted(item) ? null : h('button', { class: 'secondary', onclick: useUp }, '用完了'),
        h('button', { class: isDepleted(item) ? '' : 'secondary', onclick: restock }, '补货'),
      ] : null,
      item.archived ? null : labelButtons('item', item),
      item.archived ? null : item.loan
        ? h('button', { onclick: giveBack }, '已归还')
        : h('button', { class: 'secondary', onclick: lend }, '借出'),
      h('button', { class: 'secondary', onclick: copy }, '复制'),
      item.archived
        ? h('button', { class: 'secondary', onclick: unarchive }, '取消归档')
        : h('button', { class: 'secondary', onclick: archive }, '归档'),
      h('button', { class: 'danger', onclick: () => remove() }, '删除')),
    h('p', { class: 'muted small center' },
      `创建于 ${(item.createdAt || '').slice(0, 10)} · 更新于 ${(item.updatedAt || '').slice(0, 10)}`));
}

// 补货：填新数量、新保质期；新包装要贴标签的话，顺手放回待打印（编号不变）
function openRestock(item) {
  const qty = h('input', { type: 'number', min: 1, inputmode: 'numeric', value: Math.max(1, Number(item.quantity) || 1) });
  const hasExpiry = item.fields?.['保质期'] !== undefined || item.tags.some((t) => (store.data.fieldPresets?.[t] || []).includes('保质期'));
  const expiry = h('input', { placeholder: '例如 2028-05 或 2028-05-09', value: '' });
  const reprint = h('input', { type: 'checkbox', checked: item.label === 'printed' });
  openSheet({
    title: `补货「${item.name}」`,
    body: h('div', { class: 'form' },
      h('label', {}, '现在有多少', qty),
      hasExpiry ? h('label', {}, `新的保质期${item.fields?.['保质期'] ? `（原来 ${item.fields['保质期']}）` : ''}`, expiry) : null,
      item.label !== 'none' ? h('label', { class: 'switch-row' }, reprint, '新包装要重新贴标签（编号不变）') : null),
    confirmText: '补货',
    onConfirm: async () => {
      const n = Number(qty.value);
      if (!Number.isFinite(n) || n < 1) { toast('数量至少是 1', 'error'); return false; }
      const exp = expiry.value.trim();
      await saving('正在保存…', () => store.save(`补货：${item.name} ×${n}`, (data) => {
        const it = data.items.find((i) => i.id === item.id);
        if (!it) throw new Error('这件物品已经在别处被删除了');
        it.quantity = n;
        if (exp) it.fields = { ...it.fields, 保质期: exp };
        if (reprint.checked && it.label !== 'none') setLabel(it, 'pending');
        it.purchaseDate = today();
        it.updatedAt = new Date().toISOString();
        it.notes = [it.notes, `${today()} 补货 ×${n}${exp ? `，保质期 ${exp}` : ''}`].filter(Boolean).join('\n');
      })).catch(() => {});
      render();
    },
  });
}

// ---------- 新建 / 编辑 ----------

function formView(id, q = {}) {
  const existing = id ? store.item(id) : null;
  if (id && !existing) return notFound('找不到这件物品。');
  const source = q.from ? store.item(q.from) : null; // 「复制」：从这件物品带出字段
  const itemId = existing?.id || newId('i');
  const blank = {
    id: itemId, name: '', assetId: null, location: q.loc || '',
    tags: q.tags ? q.tags.split(',').filter((t) => store.data.tags.includes(t)) : [],
    quantity: 1, description: '', fields: {}, photos: [], receipts: [],
    manufacturer: '', modelNumber: '', serialNumber: '', purchaseDate: '', purchasePrice: null,
    purchaseFrom: '', warrantyExpires: '', notes: '', archived: false,
  };
  const draft = existing ? structuredClone(existing)
    : source ? { ...structuredClone(source), ...pick(blank, ['id', 'assetId', 'photos', 'receipts', 'notes', 'archived']), label: undefined, labelPrintedAt: undefined }
      : blank;
  const added = { photos: [], receipts: [] }; // 新选的照片：{ file, url }
  const removed = [];
  let fieldRows = Object.entries(draft.fields || {}).map(([k, v]) => ({ k, v }));
  // 编号是不是系统推荐的：推荐的可以随类别变化、保存时撞号自动顺延；手动填的、扫码带来的、已有的不动
  let autoAsset = false;
  let renumberConfirmed = false;
  // 「贴标签」开关。编号和贴不贴标签无关：每件都有编号，开关只决定要不要进打印清单。
  // 新建时跟着类别的默认值走（衣服、鞋默认不贴），用户动过开关就不再自动改。
  let wantLabel = existing ? existing.label !== 'none'
    : source ? source.label !== 'none' : defaultLabel(store.data, draft.tags) !== 'none';
  let labelTouched = Boolean(existing || source);
  // 「消耗品」开关：同样按类别给默认值（零食、药品、洗漱、清洁），可以单件改
  let wantConsumable = existing || source ? Boolean(draft.consumable) : defaultConsumable(store.data, draft.tags);
  let consumableTouched = Boolean(existing || source);

  const bind = (key, props = {}) => h(props.multiline ? 'textarea' : 'input', {
    ...props, multiline: undefined, value: draft[key] ?? '',
    oninput: (e) => { draft[key] = e.target.value; },
  });

  // ---- 编号 ----
  const assetInput = h('input', {
    value: draft.assetId || '', inputmode: 'numeric', placeholder: '例如 290-0001',
    oninput: (e) => { autoAsset = false; checkAsset(e.target.value); },
  });
  const assetMsg = h('div', { class: 'hint' });
  const suggestBtn = h('button', { type: 'button', class: 'chip add', onclick: () => applySuggestion(true) }, '推荐编号');
  const renumberBtn = h('button', { type: 'button', class: 'chip add', hidden: true, onclick: () => renumber() }, '按新类别重新编号');
  const checkAsset = (value) => {
    assetMsg.classList.remove('error');
    renumberBtn.hidden = true;
    try {
      const norm = normalizeAssetId(value);
      const hit = norm && store.findByAsset(norm);
      if (hit && hit.obj.id !== itemId) throw new Error(`编号 ${norm} 已经被「${hit.obj.name}」用了`);
      const prefix = prefixForTags(store.data, draft.tags);
      if (!norm) {
        assetMsg.textContent = draft.tags.length ? '保存时会按类别自动编号。' : '选好标签后会按类别自动编号（不选标签就用 000 开头）。';
      } else if (autoAsset) {
        assetMsg.textContent = `按类别自动编号（${draft.tags[0] || '无类别'} ${prefix}-xxxx）`;
      } else if (existing && draft.tags.length && !norm.startsWith(`${prefix}-`)) {
        // 编号是建档时的类别，之后改了标签不会自动换号（贴好的标签不能随便换）
        assetMsg.textContent = `编号是建档时的类别，和现在的类别「${draft.tags[0]}」（${prefix}）不一致。`;
        renumberBtn.hidden = false;
      } else {
        assetMsg.textContent = `编号：${norm}`;
      }
      suggestBtn.hidden = Boolean(norm);
      return norm;
    } catch (e) {
      assetMsg.textContent = e.message;
      assetMsg.classList.add('error');
      suggestBtn.hidden = true;
      return undefined;
    }
  };
  // force：用户点了按钮，没选标签也按 000 给号
  const applySuggestion = (force = false) => {
    if (!force && !draft.tags.length) {
      assetInput.value = '';
    } else {
      try {
        assetInput.value = nextAssetInPrefix(store.data, prefixForTags(store.data, draft.tags));
      } catch (e) { return toast(e.message, 'error'); }
    }
    autoAsset = true;
    checkAsset(assetInput.value);
  };
  const renumber = () => {
    if (existing?.label === 'printed' && !confirm('这件已经打印过标签。重新编号后，旧标签就扫不出它了，需要重新打印。继续？')) return;
    renumberConfirmed = true;
    applySuggestion(true);
  };
  if (q.asset) {
    assetInput.value = safeAsset(q.asset) || '';
  } else if (!existing) {
    applySuggestion();
  }
  checkAsset(assetInput.value);

  // ---- 贴标签开关 ----
  const labelSwitch = h('input', {
    type: 'checkbox', checked: wantLabel,
    onchange: (e) => { wantLabel = e.target.checked; labelTouched = true; drawLabelStatus(); },
  });
  const labelStatus = h('div', { class: 'hint' });
  const drawLabelStatus = () => {
    labelStatus.textContent = !wantLabel
      ? (existing?.label === 'printed' ? '不再打印。已经贴着的标签照样能扫。' : '不进打印清单，编号照常保留。以后想贴随时打开。')
      : existing?.label === 'printed' ? `已打印（${existing.labelPrintedAt || '日期未知'}）。要重打，在物品页点「重新打印」。`
        : '保存后进入「待打印」。';
  };
  drawLabelStatus();

  const consumableSwitch = h('input', {
    type: 'checkbox', checked: wantConsumable,
    onchange: (e) => { wantConsumable = e.target.checked; consumableTouched = true; },
  });

  // ---- 照片 ----
  const photoSection = (kind, title) => {
    const grid = h('div', { class: 'photo-grid' });
    const draw = () => {
      grid.replaceChildren(
        ...draft[kind].map((p, i) => h('div', { class: 'photo-cell' },
          lazyPhoto(gh, p.thumb),
          h('button', { type: 'button', class: 'x', onclick: () => { removed.push(p); draft[kind].splice(i, 1); draw(); } }, '×'))),
        ...added[kind].map((p, i) => h('div', { class: 'photo-cell' },
          h('img', { src: p.url, alt: '' }),
          h('button', { type: 'button', class: 'x', onclick: () => { URL.revokeObjectURL(p.url); added[kind].splice(i, 1); draw(); } }, '×'))),
        h('label', { class: 'photo-add' }, '＋',
          h('input', {
            type: 'file', accept: 'image/*', multiple: true, hidden: true,
            onchange: (e) => {
              for (const file of e.target.files) added[kind].push({ file, url: URL.createObjectURL(file) });
              e.target.value = '';
              draw();
            },
          })));
    };
    draw();
    return h('section', {}, h('h3', {}, title), grid);
  };

  // ---- 类别（一件东西只有一个）和自定义字段 ----
  const tagBox = h('div', { class: 'chips' });
  const fieldBox = h('div', {});
  const drawTags = () => {
    tagBox.replaceChildren(...store.data.tags.map((t) => h('button', {
      type: 'button', class: `chip${draft.tags.includes(t) ? ' on' : ''}`,
      onclick: () => {
        // 只能选一个类别：再点一下已选的就取消
        draft.tags = draft.tags[0] === t ? [] : [t];
        drawTags();
        drawFields();
        // 类别决定编号前 3 位；推荐的编号跟着变，手动填的、已有的不动
        if (autoAsset || (!existing && !assetInput.value)) applySuggestion();
        else checkAsset(assetInput.value);
        if (!labelTouched) {
          wantLabel = defaultLabel(store.data, draft.tags) !== 'none';
          labelSwitch.checked = wantLabel;
          drawLabelStatus();
        }
        if (!consumableTouched) {
          wantConsumable = defaultConsumable(store.data, draft.tags);
          consumableSwitch.checked = wantConsumable;
        }
      },
    }, t)));
  };
  const drawFields = () => {
    const presets = [...new Set(draft.tags.flatMap((t) => store.data.fieldPresets?.[t] || []))]
      .filter((k) => !fieldRows.some((r) => r.k === k));
    fieldBox.replaceChildren(
      ...fieldRows.map((r, i) => h('div', { class: 'field-row' },
        h('input', { placeholder: '名称', value: r.k, oninput: (e) => { r.k = e.target.value; } }),
        h('input', { placeholder: r.k === '保质期' ? '2027-03-01' : '内容', value: r.v, oninput: (e) => { r.v = e.target.value; } }),
        h('button', { type: 'button', class: 'x-inline', onclick: () => { fieldRows.splice(i, 1); drawFields(); } }, '×'))),
      h('div', { class: 'chips' },
        presets.map((k) => h('button', { type: 'button', class: 'chip add', onclick: () => { fieldRows.push({ k, v: '' }); drawFields(); } }, `＋${k}`)),
        h('button', { type: 'button', class: 'chip add', onclick: () => { fieldRows.push({ k: '', v: '' }); drawFields(); } }, '＋其他字段')));
  };
  drawTags();
  drawFields();

  // ---- 保存 ----
  const save = async (andNext) => {
    draft.name = draft.name.trim();
    if (!draft.name) return toast('请填写名称', 'error');
    if (!draft.location) return toast('请选择位置', 'error');
    const asset = checkAsset(assetInput.value);
    if (asset === undefined) return toast(assetMsg.textContent, 'error');
    if (existing?.label === 'printed' && existing.assetId && asset !== existing.assetId && !renumberConfirmed
      && !confirm(`编号从 ${existing.assetId} 改成 ${asset || '自动编号'}，已经贴着的旧标签就扫不出这件了，需要重新打印。继续？`)) return;
    draft.assetId = asset;
    draft.consumable = wantConsumable;
    // 消耗品数量可以是 0（用完了）；其他东西至少 1
    const n = Number(draft.quantity);
    draft.quantity = wantConsumable ? (Number.isFinite(n) && n >= 0 ? n : 1) : Math.max(1, n || 1);
    draft.purchasePrice = draft.purchasePrice === '' || draft.purchasePrice == null ? null : Number(draft.purchasePrice);
    draft.fields = Object.fromEntries(fieldRows.filter((r) => r.k.trim() && String(r.v).trim()).map((r) => [r.k.trim(), String(r.v).trim()]));
    for (const k of ['manufacturer', 'modelNumber', 'serialNumber', 'purchaseFrom', 'description', 'notes']) {
      draft[k] = (draft[k] || '').trim();
    }
    // 标签状态：不贴 → none；要贴时，编号没变就保持原状态（已打印的还是已打印），否则进待打印
    const assetChanged = !existing || existing.assetId !== draft.assetId;
    const label = !wantLabel ? 'none'
      : existing && !assetChanged && existing.label !== 'none' ? existing.label : 'pending';

    let savedAsset;
    await saving('正在处理照片…', async (b) => {
      // 新照片先放在临时数组里，提交成功才算数；失败后重新保存不会重复添加
      const uploads = [];
      const fresh = { photos: [], receipts: [] };
      for (const kind of ['photos', 'receipts']) {
        for (const [n, p] of added[kind].entries()) {
          b.set(`正在压缩照片 ${n + 1}/${added[kind].length}…`);
          const name = `${newId('')}.jpg`;
          const full = await compressImage(p.file, 1600, 0.82);
          const thumb = await compressImage(p.file, 400, 0.7);
          uploads.push({ path: `photos/${itemId}/${name}`, base64: await blobToBase64(full) });
          uploads.push({ path: `thumbs/${itemId}/${name}`, base64: await blobToBase64(thumb) });
          fresh[kind].push({ file: `photos/${itemId}/${name}`, thumb: `thumbs/${itemId}/${name}` });
        }
      }
      b.set(uploads.length ? '正在上传…' : '正在保存…');
      const now = new Date().toISOString();
      const record = {
        ...draft, label,
        photos: [...draft.photos, ...fresh.photos], receipts: [...draft.receipts, ...fresh.receipts],
      };
      if (!record.labelPrintedAt) delete record.labelPrintedAt;
      savedAsset = await store.save(`${existing ? '修改' : '新建'}：${draft.name}`, (data) => {
        // 每件都要有编号：没填就按类别给；推荐的编号刚好被别的设备占了，就顺延到下一个空号
        const taken = (a) => data.items.concat(data.locations).some((x) => x.assetId === a && x.id !== itemId);
        if (!record.assetId || (autoAsset && taken(record.assetId))) {
          record.assetId = nextAssetInPrefix(data, prefixForTags(data, record.tags));
        }
        assertAssetFree(data, record.assetId, itemId);
        if (existing) {
          const i = data.items.findIndex((x) => x.id === itemId);
          if (i < 0) throw new Error('这件物品已经在别处被删除了');
          const prev = data.items[i];
          const target = record.location;
          data.items[i] = { ...record, location: prev.location, createdAt: prev.createdAt, updatedAt: now };
          moveItem(data, data.items[i], target);
        } else {
          data.items.push({ ...record, createdAt: now, updatedAt: now });
        }
        return record.assetId;
      }, { uploads, removes: removed.flatMap((p) => [p.file, p.thumb]) });
    });
    toast(savedAsset !== draft.assetId ? `已保存（编号 ${savedAsset}）` : '已保存');
    if (andNext) {
      go(`#/new?loc=${draft.location}&tags=${encodeURIComponent(draft.tags.join(','))}&t=${Date.now()}`, true);
      window.scrollTo(0, 0);
    } else {
      go(`#/item/${itemId}`, true);
    }
  };

  return h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(false).catch(() => {}); } },
    header(existing ? '编辑物品' : source ? `复制：${source.name}` : '新建物品'),
    photoSection('photos', '照片'),
    h('label', {}, '名称', bind('name', { placeholder: '例如 黑色羽绒服（优衣库）', required: true })),
    h('label', {}, '位置', locationSelect(draft.location, { onchange: (e) => { draft.location = e.target.value; } })),
    h('div', { class: 'label' }, '类别', h('span', { class: 'hint inline' }, '只选一个，决定编号前 3 位'), tagBox),
    h('div', { class: 'label' }, '编号', h('div', { class: 'asset-row' }, assetInput, suggestBtn), renumberBtn, assetMsg),
    h('div', { class: 'label' }, h('label', { class: 'switch-row' }, labelSwitch, '贴标签'), labelStatus),
    h('div', { class: 'label' }, h('label', { class: 'switch-row' }, consumableSwitch, '消耗品'),
      h('div', { class: 'hint' }, '会用完、还会再买的东西。用完了不归档，进「需要补货」，补货后编号不变。')),
    h('label', {}, '数量', bind('quantity', { type: 'number', min: 0, inputmode: 'numeric' })),
    h('div', { class: 'label' }, '其他信息', fieldBox),
    h('label', {}, '描述', bind('description', { multiline: true, rows: 2 })),
    h('details', { open: Boolean(draft.manufacturer || draft.purchaseDate || draft.serialNumber || draft.warrantyExpires) },
      h('summary', {}, '品牌、购买与保修'),
      h('label', {}, '品牌', bind('manufacturer')),
      h('label', {}, '型号', bind('modelNumber')),
      h('label', {}, '序列号', bind('serialNumber')),
      h('label', {}, '购买日期', bind('purchaseDate', { type: 'date' })),
      h('label', {}, '价格（元）', bind('purchasePrice', { type: 'number', step: '0.01', inputmode: 'decimal' })),
      h('label', {}, '购买地点', bind('purchaseFrom')),
      h('label', {}, '保修到期', bind('warrantyExpires', { type: 'date' })),
      photoSection('receipts', '发票 / 保修卡')),
    h('label', {}, '备注', bind('notes', { multiline: true, rows: 3 })),
    h('div', { class: 'actions sticky' },
      h('button', { type: 'submit' }, '保存'),
      existing ? null : h('button', { type: 'button', class: 'secondary', onclick: () => save(true).catch(() => {}) }, '保存，再建一件'),
      h('button', { type: 'button', class: 'link', onclick: () => history.back() }, '取消')));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

function safeAsset(value) {
  try { return normalizeAssetId(value); } catch { return null; }
}

// ---------- 扫码结果（相机扫码进来，或网页内扫码「查找」） ----------

function scanResultView(raw) {
  let asset;
  try { asset = normalizeAssetId(raw); } catch (e) { return notFound(e.message); }
  const hit = store.findByAsset(asset);
  if (hit) {
    setTimeout(() => go(hit.type === 'item' ? `#/item/${hit.obj.id}` : `#/place/${hit.obj.id}`, true));
    return h('p', { class: 'muted center' }, '正在打开…');
  }
  return h('div', {},
    header('还没有建档'),
    h('div', { class: 'card' },
      h('p', {}, '编号 ', h('span', { class: 'asset' }, asset), ' 还没有对应的物品或位置。'),
      h('a', { class: 'button wide', href: `#/new?asset=${asset}` }, '用这个编号新建物品')));
}

// ---------- 网页内扫码：查找 / 整理 / 盘点 ----------

const scanState = { mode: 'find', target: '', moves: [], checkLoc: '', found: new Set() };

function scanView() {
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const status = h('p', { class: 'muted small center' }, '正在打开摄像头…');
  const panel = h('div', {});

  const modeBtn = (mode, label) => h('button', {
    type: 'button', class: `seg${scanState.mode === mode ? ' on' : ''}`,
    onclick: () => { scanState.mode = mode; render(); },
  }, label);

  const onCode = (text) => {
    const raw = assetFromScan(text);
    let asset;
    try { asset = raw && normalizeAssetId(raw); } catch { asset = null; }
    if (!asset) return toast('这不是物品标签的二维码', 'error');
    const hit = store.findByAsset(asset);
    if (scanState.mode === 'find') return go(`#/a/${asset}`);
    if (!hit) return toast(`编号 ${asset} 还没有建档`, 'error');

    if (scanState.mode === 'move') {
      if (hit.type === 'location') {
        scanState.target = hit.obj.id;
        toast(`目标位置：${hit.obj.name}`);
      } else if (!scanState.target) {
        return toast('先选目标位置，或者先扫柜子上的标签', 'error');
      } else if (!scanState.moves.some((m) => m.id === hit.obj.id)) {
        scanState.moves.unshift({ id: hit.obj.id });
        toast(`+ ${hit.obj.name}`);
      }
    } else if (scanState.mode === 'check') {
      if (hit.type === 'location') {
        scanState.checkLoc = hit.obj.id;
        scanState.found = new Set();
        toast(`开始盘点：${hit.obj.name}`);
      } else {
        scanState.found.add(hit.obj.id);
        toast(`✓ ${hit.obj.name}`);
      }
    }
    drawPanel();
  };

  const drawPanel = () => {
    if (scanState.mode === 'find') {
      fill(panel, h('p', { class: 'muted small' }, '扫一个标签，直接打开这件物品或这个柜子。'));
    } else if (scanState.mode === 'move') {
      const target = locationSelect(scanState.target, { onchange: (e) => { scanState.target = e.target.value; drawPanel(); } }, '目标位置（或扫柜子的标签）');
      const saveMoves = async () => {
        const n = scanState.moves.length;
        await saving('正在保存…', () => store.save(`整理：${n} 件移到 ${store.location(scanState.target).name}`, (data) => {
          const now = new Date().toISOString();
          for (const m of scanState.moves) {
            const it = data.items.find((i) => i.id === m.id);
            if (it) moveItem(data, it, scanState.target);
          }
        })).catch(() => {});
        toast(`已移动 ${n} 件`);
        scanState.moves = [];
        drawPanel();
      };
      fill(panel, 
        target,
        h('p', { class: 'muted small' }, '选好目标位置后，逐个扫要放进去的东西，最后点保存。'),
        h('div', { class: 'list' }, scanState.moves.map((m) => {
          const it = store.item(m.id);
          return it ? itemRow(it, h('span', {}, `→ ${store.shortName(scanState.target)}`)) : null;
        })),
        scanState.moves.length ? h('div', { class: 'actions' },
          h('button', { onclick: saveMoves }, `保存（移动 ${scanState.moves.length} 件）`),
          h('button', { class: 'secondary', onclick: () => { scanState.moves = []; drawPanel(); } }, '清空')) : null);
    } else {
      const loc = locationSelect(scanState.checkLoc, {
        onchange: (e) => { scanState.checkLoc = e.target.value; scanState.found = new Set(); drawPanel(); },
      }, '要盘点的位置（或扫柜子的标签）');
      if (!scanState.checkLoc) return fill(panel, loc, h('p', { class: 'muted small' }, '选好位置后，把里面贴了标签的东西逐个扫一遍。'));
      const inside = store.itemsIn(scanState.checkLoc);
      const expected = inside.filter((i) => i.assetId);
      const missing = expected.filter((i) => !scanState.found.has(i.id));
      const strays = [...scanState.found].map((id) => store.item(id)).filter((i) => i && !inside.includes(i));
      const moveStrays = async () => {
        await saving('正在保存…', () => store.save(`盘点：${strays.length} 件归位到 ${store.location(scanState.checkLoc).name}`, (data) => {
          const now = new Date().toISOString();
          for (const s of strays) {
            const it = data.items.find((i) => i.id === s.id);
            if (it) moveItem(data, it, scanState.checkLoc);
          }
        })).catch(() => {});
        drawPanel();
      };
      fill(panel, 
        loc,
        h('p', {}, h('strong', {}, `已找到 ${expected.length - missing.length} / ${expected.length} 件`),
          inside.length > expected.length ? h('span', { class: 'muted small' }, `（另有 ${inside.length - expected.length} 件没贴标签，不在盘点范围）`) : null),
        missing.length ? [h('h3', {}, `还没扫到（${missing.length}）`), h('div', { class: 'list' }, missing.map((i) => itemRow(i)))] : null,
        strays.length ? [
          h('h3', {}, `记录在别处，但在这里扫到了（${strays.length}）`),
          h('div', { class: 'list' }, strays.map((i) => itemRow(i))),
          h('button', { class: 'secondary', onclick: moveStrays }, '把它们的位置改到这里')] : null);
    }
  };
  drawPanel();

  let stop = null;
  let closed = false;
  startScanner(video, onCode)
    .then((s) => { if (closed) s(); else { stop = s; status.textContent = '对准二维码'; } })
    .catch((e) => { status.textContent = e.message; status.classList.add('error'); });
  cleanup = () => { closed = true; if (stop) stop(); };

  return h('div', {},
    header('扫码'),
    h('div', { class: 'segmented' }, modeBtn('find', '查找'), modeBtn('move', '整理'), modeBtn('check', '盘点')),
    h('div', { class: 'scan-box' }, video, h('div', { class: 'scan-frame' })),
    status, panel);
}

// ---------- 位置 ----------

function placesView() {
  return h('div', {},
    header('位置', h('a', { href: '#/manage', class: 'button secondary small' }, '管理')),
    h('div', { class: 'list' }, store.locationTree().filter(({ loc }) => !loc.box).map(({ loc, depth }) =>
      h('a', { class: 'row place', href: `#/place/${loc.id}`, style: `padding-left:${12 + depth * 22}px` },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, loc.name),
          h('div', { class: 'row-meta' }, assetChip(loc.assetId), `${store.itemsIn(loc.id).length} 件`))))));
}

function placeView(id) {
  const loc = store.location(id);
  if (!loc) return notFound('找不到这个位置。');
  const items = store.itemsIn(id).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const setAsset = async () => {
    const suggestion = loc.assetId || nextAssetInPrefix(store.data, LOCATION_PREFIX);
    const value = prompt('这个位置的编号（柜子统一用 010 开头；留空表示不编号）：', suggestion);
    if (value === null) return;
    let asset;
    try { asset = normalizeAssetId(value); } catch (e) { return toast(e.message, 'error'); }
    if (loc.label === 'printed' && asset !== loc.assetId && !confirm('这个柜子的标签已经打印过，改编号后旧标签就扫不出它了，需要重新打印。继续？')) return;
    await saving('正在保存…', () => store.save(`设置位置编号：${loc.name}`, (data) => {
      assertAssetFree(data, asset, id);
      const l = data.locations.find((x) => x.id === id);
      if (l.assetId !== asset) l.label = asset ? 'pending' : 'none';
      l.assetId = asset;
    })).catch(() => {});
    render();
  };
  return h('div', {},
    h('p', { class: 'muted small' }, store.locationPath(loc.parent) || '　'),
    header(loc.name),
    h('div', { class: 'row-meta' }, assetChip(loc.assetId), labelChip(loc),
      h('button', { class: 'link', onclick: () => setAsset() }, loc.assetId ? '修改编号' : '给柜子编号')),
    loc.assetId ? h('div', { class: 'actions' }, labelButtons('location', loc),
      loc.label !== 'none' ? h('button', { class: 'link', onclick: () => changeLabel('location', id, 'none', `不贴标签：${loc.name}`) }, '不贴了') : null) : null,
    store.children(id).length ? h('div', { class: 'chips' }, store.children(id).map((c) =>
      h('a', { class: 'chip', href: `#/place/${c.id}` }, c.name.split(' ')[0]))) : null,
    loc.box ? boxPanel(loc, items) : null,
    h('p', { class: 'muted' }, `${items.length} 件`),
    h('div', { class: 'list' }, items.map((i) => itemRow(i))),
    loc.box ? null : h('a', { class: 'button wide', href: `#/new?loc=${id}` }, '在这里新建物品'));
}

// ---------- 更多 ----------

function moreView() {
  const pending = store.pendingLabels().length;
  const printed = store.labeled('printed').length;
  const due = reminders(store.data).length;
  const entry = (href, title, desc, badge) => h('a', { class: 'row', href },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, title), h('div', { class: 'row-meta' }, desc)),
    badge ? h('span', { class: 'count' }, badge) : null);
  return h('div', {},
    header('更多'),
    h('div', { class: 'list' },
      entry('#/labels', '标签', `待打印 ${pending} 张 · 已打印 ${printed} 张`, pending || null),
      entry('#/restock', '需要补货', '用完了的消耗品，相当于购物清单', store.data.items.filter((i) => isDepleted(i) && !i.archived).length || null),
      entry('#/reminders', '到期提醒', `保质期、保修 ${store.data.reminderDays} 天内到期的东西`, due || null),
      entry('#/stats', '统计', '每类、每个柜子有多少东西，值多少钱'),
      entry('#/manage', '管理位置和类别', '新建、改名、类别编号、哪些类别默认不贴标签、算不算消耗品'),
      entry('#/trips', '出差 / 旅行', '按天数、天气、目的推荐带什么，装进行李箱', store.data.trips.filter((t) => t.status === 'packed').length || null),
      entry('#/boxes', '装箱', '搬家打包：扫码装箱，扫箱子看里面有什么', store.data.locations.filter((l) => l.box).length || null),
      entry('#/loans', '借出', '借给别人还没还的东西', store.data.items.filter((i) => i.loan && !i.archived).length || null),
      entry('#/settings', '设置', '数据仓库、令牌、DeepSeek')),
    h('p', { class: 'center' }, h('button', { class: 'link muted small', onclick: exportExcel }, '导出全部物品（Excel）')));
}

// ---------- 标签打印 ----------

const labelTab = { tab: 'pending', q: '' };

function labelsView() {
  const tab = labelTab.tab;
  const nameOf = (p) => (p.type === 'item' ? p.obj.name : p.obj.name.split(' ')[0]);
  const list = store.labeled(tab);
  // 待打印默认全选；已打印默认都不选（勾上要重打的）
  const selected = new Set(tab === 'pending' ? list.map((p) => p.obj.id) : []);
  const chosen = () => list.filter((p) => selected.has(p.obj.id));

  const download = () => {
    const rows = chosen();
    if (!rows.length) return toast('没有选中的标签', 'error');
    const blob = makeXlsx([['编号', '名称', '二维码'], ...rows.map((p) => [p.obj.assetId, nameOf(p), `${SITE_URL}?a=${p.obj.assetId}`])], '标签');
    const a = h('a', { href: URL.createObjectURL(blob), download: `标签_${today()}_${rows.length}张.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
    toast('已下载。打印、贴好后，回来点「标记为已打印」');
  };
  const setState = async (state, question, message) => {
    const ids = new Set(chosen().map((p) => p.obj.id));
    if (!ids.size) return toast('没有选中的标签', 'error');
    if (!confirm(question(ids.size))) return;
    await saving('正在保存…', () => store.save(message(ids.size), (data) => {
      for (const x of [...data.items, ...data.locations]) if (ids.has(x.id)) setLabel(x, state);
    })).catch(() => {});
    render();
  };
  const tabBtn = (key, text) => h('button', {
    type: 'button', class: `seg${tab === key ? ' on' : ''}`,
    onclick: () => { labelTab.tab = key; render(); },
  }, `${text}（${store.labeled(key).length}）`);

  const rows = h('div', { class: 'list compact' }, list.map((p) => h('label', { class: 'check-row', 'data-text': `${p.obj.assetId} ${nameOf(p)}`.toLowerCase() },
    h('input', {
      type: 'checkbox', checked: selected.has(p.obj.id),
      onchange: (e) => { if (e.target.checked) selected.add(p.obj.id); else selected.delete(p.obj.id); },
    }),
    h('span', { class: 'asset' }, p.obj.assetId),
    h('a', { class: 'grow', href: p.type === 'item' ? `#/item/${p.obj.id}` : `#/place/${p.obj.id}` }, nameOf(p)),
    tab === 'printed' && p.obj.labelPrintedAt ? h('span', { class: 'muted small' }, p.obj.labelPrintedAt.slice(5)) : null)));
  // 全选只作用于搜索后看得见的行
  const selectAll = (on) => {
    rows.querySelectorAll('.check-row').forEach((row, i) => {
      if (row.hidden) return;
      row.querySelector('input').checked = on;
      if (on) selected.add(list[i].obj.id); else selected.delete(list[i].obj.id);
    });
  };
  const filter = () => {
    const w = labelTab.q.trim().toLowerCase();
    for (const row of rows.querySelectorAll('.check-row')) row.hidden = Boolean(w) && !row.dataset.text.includes(w);
  };
  if (tab === 'printed') filter();

  return h('div', {},
    header('标签'),
    h('div', { class: 'segmented' }, tabBtn('pending', '待打印'), tabBtn('printed', '已打印')),
    tab === 'printed' ? h('input', {
      type: 'search', class: 'search', placeholder: '搜索编号或名称', value: labelTab.q,
      oninput: (e) => { labelTab.q = e.target.value; filter(); },
    }) : null,
    list.length ? h('div', { class: 'card' },
      h('div', { class: 'select-bar' },
        h('button', { class: 'link', onclick: () => selectAll(true) }, '全选'),
        h('button', { class: 'link', onclick: () => selectAll(false) }, '全不选')),
      rows,
      tab === 'pending'
        ? h('div', { class: 'actions' },
          h('button', { onclick: download }, '下载 Excel'),
          h('button', { class: 'secondary', onclick: () => setState('printed', (n) => `把选中的 ${n} 张标记为已打印？\n确认已经打好、贴好了再点。`, (n) => `标记已打印：${n} 张标签`) }, '标记为已打印'))
        : h('div', { class: 'actions' },
          h('button', { class: 'secondary', onclick: () => setState('pending', (n) => `把选中的 ${n} 张放回「待打印」重新打印？编号不变。`, (n) => `重新打印：${n} 张标签`) }, '重新打印选中的')))
      : h('div', { class: 'card' }, h('p', {}, tab === 'pending'
        ? '没有待打印的标签。新建时开着「贴标签」的东西会出现在这里。'
        : '还没有打印过标签。')),
    tab === 'pending' ? h('div', { class: 'card' },
      h('h3', {}, '在汉码 App 里批量打印（汉印 M1，40×30mm）'),
      h('ol', {},
        h('li', {}, '勾选要打的，下载 Excel，发到手机（微信文件传输助手等）。'),
        h('li', {}, '汉码里新建 40×30mm 标签：加一个二维码，内容绑定「二维码」列，放在左边、尽量大。'),
        h('li', {}, '加两个文本，分别绑定「编号」和「名称」列，放在右边。模板存好，以后直接用。'),
        h('li', {}, '导入 Excel，批量打印，按名称贴到对应的东西上。'),
        h('li', {}, '贴好后回到这里，勾选、点「标记为已打印」。下载 Excel 不会自动标记，防止打印失败漏贴。')),
      h('p', { class: 'muted small' }, '只打一张：在物品页点「打印这一张」，保存图片后用汉码的图片打印。')) : null);
}

function drawLabel(assetId, name) {
  const canvas = h('canvas', { width: 640, height: 480, class: 'label-canvas' });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 640, 480);
  const qr = window.qrcode(0, 'M');
  qr.addData(`${SITE_URL}?a=${assetId}`);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.floor(440 / n);
  const size = cell * n;
  const ox = 20 + Math.floor((440 - size) / 2);
  const oy = Math.floor((480 - size) / 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
  ctx.textAlign = 'center';
  ctx.font = 'bold 60px system-ui, sans-serif';
  const [a, b] = assetId.split('-');
  ctx.fillText(a, 552, 150);
  ctx.fillText(b, 552, 240);
  // 名称按实际宽度折行：英文按单词，中文按字，最多 5 行
  ctx.font = '26px system-ui, sans-serif';
  const tokens = (name || '').match(/[A-Za-z0-9.'-]+|\s+|./gu) || [];
  const lines = [''];
  for (const t of tokens) {
    const last = lines.length - 1;
    if (ctx.measureText(lines[last] + t).width <= 150 || !lines[last]) lines[last] += t;
    else lines.push(t.trim());
  }
  if (lines.length > 5) { lines.length = 5; lines[4] = lines[4].slice(0, -1) + '…'; }
  lines.forEach((line, i) => ctx.fillText(line.trim(), 552, 300 + i * 32));
  return canvas;
}

function labelView(type, id) {
  const obj = type === 'item' ? store.item(id) : store.location(id);
  if (!obj?.assetId) return notFound('没有编号，无法生成标签。');
  const canvas = drawLabel(obj.assetId, type === 'item' ? obj.name : obj.name.split(' ')[0]);
  const img = h('img', { src: canvas.toDataURL('image/png'), class: 'label-img', alt: `标签 ${obj.assetId}` });
  return h('div', {},
    header('标签'),
    h('div', { class: 'card center' }, img,
      h('p', {}, assetChip(obj.assetId), ' ', labelChip(obj)),
      h('p', { class: 'muted small' }, '40×30mm。手机上长按图片保存到相册，再在汉码 App 里用「图片打印」。'),
      h('div', { class: 'actions center-row' },
        h('a', { class: 'button secondary', href: img.src, download: `label_${obj.assetId}.png` }, '下载图片'),
        obj.label !== 'printed'
          ? h('button', { onclick: () => changeLabel(type, id, 'printed', `标记已打印：${obj.assetId}`) }, '打好了，标记已打印')
          : null)));
}

// ---------- 需要补货 ----------

function restockView() {
  const list = store.data.items.filter((i) => isDepleted(i) && !i.archived)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return h('div', {},
    header('需要补货'),
    h('p', { class: 'muted small' }, '用完了的消耗品。买回来后点「补货」填数量和新保质期，编号不变；以后不打算再买，就去物品页归档。'),
    list.length ? h('div', { class: 'list' }, list.map((i) => h('div', { class: 'restock-row' },
      itemRow(i), h('button', { class: 'small', onclick: () => openRestock(i) }, '补货'))))
      : h('div', { class: 'card' }, h('p', {}, '没有用完待补的东西。')));
}

// ---------- 到期提醒 ----------

function remindersView() {
  const list = reminders(store.data);
  const setDays = async () => {
    const value = prompt('提前多少天提醒？', store.data.reminderDays);
    const days = Number(value);
    if (value === null || !Number.isInteger(days) || days < 1 || days > 365) return;
    await saving('正在保存…', () => store.save(`提醒天数改为 ${days}`, (data) => { data.reminderDays = days; })).catch(() => {});
    render();
  };
  return h('div', {},
    header('到期提醒'),
    h('p', { class: 'muted small' }, `零食药品的「保质期」和电子产品的「保修到期」，${store.data.reminderDays} 天内到期的都列在这里。`,
      h('button', { class: 'link', onclick: setDays }, '改天数')),
    list.length ? h('div', { class: 'list' }, list.map(reminderRow))
      : h('div', { class: 'card' }, h('p', {}, '目前没有快到期的东西。')),
    h('p', { class: 'muted small' }, '每周一早上还会检查一次，有快到期的东西就发邮件提醒你（GitHub 通知邮件）。吃完、用完的东西记得归档。'));
}

// ---------- 统计 ----------

function statsView() {
  const items = store.data.items.filter((i) => !i.archived);
  const qty = (i) => Number(i.quantity) || 1;
  const value = (list) => list.reduce((s, i) => s + (Number(i.purchasePrice) || 0), 0);
  const money = (n) => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
  const bars = (rows) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return h('div', { class: 'bars' }, rows.map((r) => h('a', { class: 'bar-row', href: r.href },
      h('span', { class: 'bar-label' }, r.label),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar', style: `width:${(r.count / max) * 100}%` })),
      h('span', { class: 'bar-num' }, r.count, r.value ? h('small', {}, ` ${money(r.value)}`) : null))));
  };
  const byTag = store.data.tags
    .map((t) => { const list = items.filter((i) => i.tags[0] === t); return { label: t, count: list.length, value: value(list), href: `#/?tag=${encodeURIComponent(t)}` }; })
    .filter((r) => r.count).sort((a, b) => b.count - a.count);
  const untagged = items.filter((i) => !i.tags.length).length;
  const byPlace = store.locationTree()
    .filter(({ loc }) => !store.children(loc.id).length) // 只列最底层的柜子，避免重复计数
    .map(({ loc }) => { const list = items.filter((i) => i.location === loc.id); return { label: loc.name.split(' ')[0], count: list.length, value: value(list), href: `#/place/${loc.id}` }; })
    .filter((r) => r.count).sort((a, b) => b.count - a.count);
  const archivedItems = store.data.items.filter((i) => i.archived);
  const archived = archivedItems.length;
  const byReason = ARCHIVE_REASONS.map((r) => ({ label: r, count: archivedItems.filter((i) => (i.archiveReason || '其他') === r).length, href: '#/' }))
    .filter((r) => r.count);
  const noPhoto = items.filter((i) => !i.photos?.length).length;

  return h('div', {},
    header('统计'),
    h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, items.length), h('div', { class: 'stat-label' }, '件物品')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, items.reduce((s, i) => s + qty(i), 0)), h('div', { class: 'stat-label' }, '个（含数量）')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, money(value(items))), h('div', { class: 'stat-label' }, '记录的总价值')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, `${items.filter((i) => i.label === 'printed').length} / ${items.filter((i) => i.label !== 'none').length}`),
        h('div', { class: 'stat-label' }, `标签已贴 / 要贴（待打印 ${items.filter((i) => i.label === 'pending').length}）`))),
    h('div', { class: 'card' }, h('h3', {}, '按类别'), byTag.length ? bars(byTag) : h('p', { class: 'muted' }, '还没有物品'),
      untagged ? h('p', { class: 'muted small' }, `另有 ${untagged} 件没有类别`) : null),
    h('div', { class: 'card' }, h('h3', {}, '按位置'), byPlace.length ? bars(byPlace) : h('p', { class: 'muted' }, '还没有物品')),
    byReason.length ? h('div', { class: 'card' }, h('h3', {}, `已归档（${archived}）`), bars(byReason)) : null,
    h('p', { class: 'muted small' }, `已归档 ${archived} 件（不计入上面的数字）· 已用完 ${items.filter(isDepleted).length} 件 · 没有照片的 ${noPhoto} 件 · 价值只统计填了价格的物品`));
}

// ---------- 管理位置和类别 ----------

function manageView() {
  const save = (message, fn) => saving('正在保存…', () => store.save(message, fn)).then(render).catch(() => {});

  const addLocation = (parent) => {
    const name = prompt(parent ? `在「${store.location(parent).name}」下新建位置：` : '新建顶层位置：');
    if (!name?.trim()) return;
    save(`新建位置：${name.trim()}`, (data) => { data.locations.push({ id: newId('L'), name: name.trim(), parent, assetId: null }); });
  };
  const renameLocation = (loc) => {
    const name = prompt('新名称：', loc.name);
    if (!name?.trim() || name.trim() === loc.name) return;
    save(`位置改名：${loc.name} → ${name.trim()}`, (data) => { data.locations.find((l) => l.id === loc.id).name = name.trim(); });
  };
  const deleteLocation = (loc) => {
    if (store.children(loc.id).length) return toast('里面还有子位置，不能删除', 'error');
    if (store.itemsIn(loc.id, { archived: true }).length) return toast('里面还有物品（含已归档），请先移走', 'error');
    if (!confirm(`删除位置「${loc.name}」？`)) return;
    save(`删除位置：${loc.name}`, (data) => { data.locations = data.locations.filter((l) => l.id !== loc.id); });
  };
  const addTag = () => {
    const name = prompt('新类别：');
    if (!name?.trim()) return;
    if (store.data.tags.includes(name.trim())) return toast('已经有这个类别了', 'error');
    save(`新建类别：${name.trim()}`, (data) => {
      data.tags.push(name.trim());
      data.tagCodes[name.trim()] = nextTagCode(data);
    });
  };
  const renameTag = (tag) => {
    const name = prompt('新名称：', tag);
    if (!name?.trim() || name.trim() === tag) return;
    const to = name.trim();
    if (store.data.tags.includes(to)) return toast('已经有这个类别了', 'error');
    save(`类别改名：${tag} → ${to}`, (data) => {
      data.tags = data.tags.map((t) => (t === tag ? to : t));
      for (const it of data.items) it.tags = it.tags.map((t) => (t === tag ? to : t));
      for (const key of ['fieldPresets', 'tagCodes']) {
        if (data[key]?.[tag] !== undefined) { data[key][to] = data[key][tag]; delete data[key][tag]; }
      }
      data.unlabeledTags = data.unlabeledTags.map((t) => (t === tag ? to : t));
      data.consumableTags = data.consumableTags.map((t) => (t === tag ? to : t));
    });
  };
  const deleteTag = (tag) => {
    const used = store.data.items.filter((i) => i.tags.includes(tag)).length;
    if (!confirm(`删除类别「${tag}」？${used ? `\n有 ${used} 件物品用了它，会从这些物品上去掉（已有的编号不变）。` : ''}`)) return;
    save(`删除类别：${tag}`, (data) => {
      data.tags = data.tags.filter((t) => t !== tag);
      for (const it of data.items) it.tags = it.tags.filter((t) => t !== tag);
      delete data.fieldPresets?.[tag];
      delete data.tagCodes[tag];
      data.unlabeledTags = data.unlabeledTags.filter((t) => t !== tag);
      data.consumableTags = data.consumableTags.filter((t) => t !== tag);
    });
  };
  const editCode = (tag) => {
    const value = prompt(`「${tag}」的编号前 3 位（001～899，000 和 010 已保留）。\n只影响以后新给的编号，已有的编号不变：`, store.data.tagCodes[tag]);
    if (value === null) return;
    const code = value.trim().padStart(3, '0');
    if (!/^\d{3}$/.test(code) || code === '000' || code === '010' || Number(code) > 899) return toast('要 3 位数字，001～899，不能是 000 或 010', 'error');
    const owner = Object.entries(store.data.tagCodes).find(([t, c]) => c === code && t !== tag);
    if (owner) return toast(`${code} 已经给「${owner[0]}」用了`, 'error');
    save(`类别编号：${tag} → ${code}`, (data) => { data.tagCodes[tag] = code; });
  };
  const toggleConsumable = (tag) => {
    const on = store.data.consumableTags.includes(tag);
    save(`${tag}：${on ? '默认不是消耗品' : '默认是消耗品'}`, (data) => {
      data.consumableTags = on ? data.consumableTags.filter((t) => t !== tag) : [...data.consumableTags, tag];
    });
  };
  const toggleLabel = (tag) => {
    const off = store.data.unlabeledTags.includes(tag);
    save(`${tag}：${off ? '贴标签' : '不贴标签'}`, (data) => {
      data.unlabeledTags = off ? data.unlabeledTags.filter((t) => t !== tag) : [...data.unlabeledTags, tag];
    });
  };

  return h('div', {},
    header('管理'),
    h('section', { class: 'card' },
      h('h3', {}, '位置'),
      store.locationTree().map(({ loc, depth }) => h('div', { class: 'manage-row', style: `padding-left:${depth * 18}px` },
        h('span', { class: 'grow' }, loc.name),
        h('button', { class: 'link', onclick: () => addLocation(loc.id) }, '＋子位置'),
        h('button', { class: 'link', onclick: () => renameLocation(loc) }, '改名'),
        h('button', { class: 'link danger-text', onclick: () => deleteLocation(loc) }, '删除'))),
      h('button', { class: 'secondary', onclick: () => addLocation(null) }, '新建顶层位置')),
    h('section', { class: 'card' },
      h('h3', {}, '类别'),
      h('p', { class: 'muted small' }, '编号的前 3 位由物品的类别决定，柜子统一是 010。「不贴 / 贴标签」「消耗品 / 耐用」是新建时的默认值，每件东西都能单独改。'),
      store.data.tags.map((tag) => {
        const off = store.data.unlabeledTags.includes(tag);
        return h('div', { class: 'manage-row' },
          h('button', { class: 'link asset', onclick: () => editCode(tag) }, store.data.tagCodes[tag]),
          h('span', { class: 'grow' }, tag),
          h('button', { class: `link${off ? ' muted' : ''}`, onclick: () => toggleLabel(tag) }, off ? '不贴' : '贴标签'),
          h('button', { class: `link${store.data.consumableTags.includes(tag) ? '' : ' muted'}`, onclick: () => toggleConsumable(tag) },
            store.data.consumableTags.includes(tag) ? '消耗品' : '耐用'),
          h('button', { class: 'link', onclick: () => renameTag(tag) }, '改名'),
          h('button', { class: 'link danger-text', onclick: () => deleteTag(tag) }, '删除'));
      }),
      h('button', { class: 'secondary', onclick: addTag }, '新建类别')));
}

// ---------- 首页提示卡片 ----------

const AI_KEY = 'inventory-deepseek'; // 旧版存在本机的密钥，仓库里没有时才用
const readLocalAi = () => { try { return JSON.parse(localStorage.getItem(AI_KEY)) || {}; } catch { return {}; } };
// DeepSeek 设置：优先用私有数据仓库里的 config/ai.json（所有设备共用）
const readAi = () => (store?.config?.deepseek?.key ? store.config.deepseek : readLocalAi());

function tokenCard() {
  if (!settings.tokenExpires) return null;
  const left = Math.round((new Date(settings.tokenExpires) - new Date()) / 86400000);
  if (left > 14) return null;
  return h('a', { class: 'card notice warn-card', href: '#/settings' },
    h('strong', {}, left < 0 ? 'GitHub 令牌已经过期' : `GitHub 令牌还有 ${left} 天过期`),
    h('span', { class: 'muted small' }, '到 GitHub 重新生成一个，再到「设置」里粘贴。'));
}

function loanCard() {
  const due = store.data.items.filter((i) => !i.archived && loanStatus(i)?.overdue);
  if (!due.length) return null;
  return h('a', { class: 'card notice', href: '#/loans' },
    h('strong', {}, `${due.length} 件借出还没还`),
    h('span', { class: 'muted small' }, due.slice(0, 3).map((i) => `${i.name}（${i.loan.to}）`).join('，'), due.length > 3 ? '……' : ''));
}

function boxCard() {
  const trips = store.data.trips.filter((t) => t.status === 'packed');
  if (!trips.length) return null;
  return h('a', { class: 'card notice', href: `#/trip/${trips[0].id}` },
    h('strong', {}, `行李箱里还有东西：${trips.map((t) => t.city).join('、')}`),
    h('span', { class: 'muted small' }, '回来后打开行程，把东西放回原处。'));
}

// ---------- 导出 ----------

function exportExcel() {
  const rows = store.data.items.map((i) => [
    i.assetId || '', i.name, i.tags.join('、'), store.locationPath(i.location), i.quantity, i.consumable ? '是' : '',
    LABEL_TEXT[i.label] || '', i.manufacturer || '', i.modelNumber || '', i.serialNumber || '', i.purchaseDate || '',
    i.purchasePrice ?? '', i.purchaseFrom || '', i.warrantyExpires || '',
    Object.entries(i.fields || {}).map(([k, v]) => `${k}：${v}`).join('；'), i.description || '', i.notes || '',
    i.loan ? `${i.loan.to}（${i.loan.date}）` : '', i.archived ? `${i.archiveReason || '已归档'} ${i.archivedAt || ''}` : '',
  ]);
  const head = ['编号', '名称', '类别', '位置', '数量', '消耗品', '标签状态', '品牌', '型号', '序列号', '购买日期', '价格', '购买地点',
    '保修到期', '其他信息', '描述', '备注', '借出', '归档'];
  const blob = makeXlsx([head, ...rows.map((r) => r.map((v) => String(v)))], '物品');
  const a = h('a', { href: URL.createObjectURL(blob), download: `物品档案_${today()}.xlsx` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- 借出 ----------

function loansView() {
  const list = store.data.items.filter((i) => i.loan && !i.archived)
    .sort((a, b) => (a.loan.date || '').localeCompare(b.loan.date || ''));
  return h('div', {},
    header('借出'),
    h('p', { class: 'muted small' }, '在物品页点「借出」记下借给谁；还回来点「已归还」。超过约定日期、或没约定但借出超过 30 天，会在首页和每周邮件里提醒。'),
    list.length ? h('div', { class: 'list' }, list.map((i) => {
      const st = loanStatus(i);
      return itemRow(i, h('span', { class: st.overdue ? 'warn' : '' }, `借给 ${i.loan.to} · ${st.since} 天`));
    })) : h('div', { class: 'card' }, h('p', {}, '没有借出未还的东西。')));
}

// ---------- 装箱 ----------

function boxesView() {
  const boxes = store.data.locations.filter((l) => l.box);
  const create = () => {
    const name = h('input', { placeholder: '比如 箱子 1、书籍箱', value: `箱子 ${boxes.filter((b) => b.box === 'move').length + 1}` });
    openSheet({
      title: '新建搬家箱子',
      body: h('div', { class: 'form' }, h('label', {}, '名称', name),
        h('p', { class: 'muted small' }, '箱子会自动得到一个 010 开头的编号，标签进「待打印」。贴在箱子上，扫一下就能看到里面装了什么。')),
      confirmText: '新建',
      onConfirm: async () => {
        if (!name.value.trim()) { toast('请填写名称', 'error'); return false; }
        const id = newId('L');
        await saving('正在保存…', () => store.save(`新建箱子：${name.value.trim()}`, (data) => {
          data.locations.push({ id, name: name.value.trim(), parent: null, box: 'move',
            assetId: nextAssetInPrefix(data, LOCATION_PREFIX), label: 'pending', createdAt: today() });
        })).catch(() => {});
        go(`#/place/${id}`);
      },
    });
  };
  return h('div', {},
    header('装箱', h('button', { class: 'small', onclick: create }, '新建箱子')),
    h('p', { class: 'muted small' }, '搬家时：新建箱子 → 打开箱子点「扫码装箱」，逐个扫要装的东西 → 到了新地方，打开箱子把东西放到新柜子，或者一键放回原处。出差的行李箱在「出差 / 旅行」里自动建。'),
    boxes.length ? h('div', { class: 'list' }, boxes.map((b) => h('a', { class: 'row place', href: `#/place/${b.id}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, b.box === 'trip' ? '🧳 ' : '📦 ', b.name),
        h('div', { class: 'row-meta' }, assetChip(b.assetId), labelChip(b), `${store.itemsIn(b.id).length} 件`)))))
      : h('div', { class: 'card' }, h('p', {}, '现在没有箱子。')));
}

// 箱子页面上的操作（在 placeView 里调用）
function boxPanel(loc, items) {
  const backable = items.filter((i) => i.homeLocation && store.location(i.homeLocation));
  const target = locationSelect('', {}, '全部搬到……');
  const run = (message, fn) => saving('正在保存…', () => store.save(message, fn)).then(render).catch(() => {});
  const putBack = () => confirm(`把 ${backable.length} 件放回各自原来的位置？`) && run(`拆箱：${loc.name}，${backable.length} 件放回原处`, (data) => {
    for (const it of data.items) if (it.location === loc.id && it.homeLocation) moveItem(data, it, it.homeLocation);
  });
  const moveAll = () => {
    if (!target.value || target.value === loc.id) return toast('先选要搬到哪里', 'error');
    run(`拆箱：${loc.name} → ${store.location(target.value).name}`, (data) => {
      for (const it of data.items) if (it.location === loc.id) moveItem(data, it, target.value);
    });
  };
  const remove = () => {
    if (items.length) return toast('箱子里还有东西，先拿出来', 'error');
    if (!confirm(`删除「${loc.name}」？（编号不会再分给别的东西）`)) return;
    saving('正在删除…', () => store.save(`删除箱子：${loc.name}`, (data) => {
      data.locations = data.locations.filter((l) => l.id !== loc.id);
    })).then(() => go('#/boxes', true)).catch(() => {});
  };
  const scanInto = () => { scanState.mode = 'move'; scanState.target = loc.id; scanState.moves = []; go('#/scan'); };
  return h('div', { class: 'card' },
    h('h3', {}, loc.box === 'trip' ? '行李箱' : '搬家箱子'),
    h('div', { class: 'actions' },
      h('button', { onclick: scanInto }, '扫码装箱'),
      backable.length ? h('button', { class: 'secondary', onclick: putBack }, `全部放回原处（${backable.length}）`) : null),
    items.length ? h('div', { class: 'asset-row' }, target, h('button', { class: 'secondary small', onclick: moveAll }, '搬过去')) : null,
    h('p', { class: 'muted small' }, '单件拿出来：打开物品，编辑位置，或在扫码页用「整理」扫进新柜子。'),
    items.length ? null : h('button', { class: 'link danger-text', onclick: remove }, '删除这个箱子'));
}

// ---------- 出差 / 旅行 ----------

function tripsView() {
  const trips = [...store.data.trips].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const status = { planning: '准备中', packed: '在路上', done: '已结束' };
  return h('div', {},
    header('出差 / 旅行', h('button', { class: 'small', onclick: () => { tripDraft.current = null; go('#/trip/new'); } }, '新行程')),
    trips.length ? h('div', { class: 'list' }, trips.map((t) => h('a', { class: 'row place', href: `#/trip/${t.id}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, `${t.city} · ${t.start.slice(5)}～${t.end.slice(5)}`),
        h('div', { class: 'row-meta' }, h('span', { class: `label-state ${t.status === 'packed' ? 'pending' : t.status === 'done' ? 'printed' : 'none'}` }, status[t.status]),
          t.purposes.join('、'), `${(t.checked || []).length} 件`)))))
      : h('div', { class: 'card' }, h('p', {}, '还没有行程。点「新行程」，填目的地、日期和目的，会根据天气和你的物品推荐带什么。')));
}

const tripDraft = { current: null }; // 还没保存的新行程（生成推荐后先放这里）

function tripPlanView(id) {
  const saved = id ? store.data.trips.find((t) => t.id === id) : null;
  if (id && !saved) return notFound('找不到这个行程。');
  const trip = saved ? structuredClone(saved) : tripDraft.current;
  return trip?.plan ? tripResult(trip, Boolean(saved)) : tripForm(trip);
}

function tripForm(prev) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const city = h('input', { placeholder: '比如 上海、成都', value: prev?.city || '' });
  const start = h('input', { type: 'date', value: prev?.start || tomorrow });
  const end = h('input', { type: 'date', value: prev?.end || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
  const purposes = new Set(prev?.purposes || []);
  const chipBox = h('div', { class: 'chips' });
  const drawChips = () => chipBox.replaceChildren(...PURPOSES.map((p) => h('button', {
    type: 'button', class: `chip${purposes.has(p) ? ' on' : ''}`,
    onclick: () => { if (purposes.has(p)) purposes.delete(p); else purposes.add(p); drawChips(); },
  }, p)));
  drawChips();
  const laundry = h('input', { type: 'checkbox', checked: Boolean(prev?.laundry) });
  const note = h('textarea', { rows: 2, placeholder: '比如 要见客户、可能去爬山、住朋友家' });
  if (prev?.note) note.value = prev.note;
  const ai = readAi();

  const generate = async () => {
    if (!city.value.trim()) return toast('请填写目的地', 'error');
    if (!start.value || !end.value || end.value < start.value) return toast('日期不对', 'error');
    const trip = {
      id: newId('t'), city: city.value.trim(), start: start.value, end: end.value,
      purposes: [...purposes], laundry: laundry.checked, note: note.value.trim(), status: 'planning', createdAt: today(),
    };
    await saving('正在查天气…', async (b) => {
      trip.place = await geocode(trip.city);
      trip.weather = await weatherFor(trip.place, trip.start, trip.end);
      const base = rulePlan(store.data, trip, trip.weather);
      trip.plan = base;
      if (ai.key) {
        b.set('DeepSeek 正在挑东西、搭配衣服…（可能要半分钟）');
        try {
          trip.plan = await aiPlan(store.data, trip, trip.weather, base, ai);
        } catch (e) {
          trip.plan = { ...base, fallback: e.message };
        }
      }
      trip.checked = trip.plan.items.map((i) => i.id);
    }).catch(() => { throw new Error('stop'); });
    tripDraft.current = trip;
    render();
  };

  return h('div', { class: 'form' },
    header('新行程'),
    h('label', {}, '目的地', city),
    h('div', { class: 'asset-row' }, h('label', { class: 'grow' }, '出发', start), h('label', { class: 'grow' }, '返回', end)),
    h('div', { class: 'label' }, '目的（可多选）', chipBox),
    h('label', { class: 'switch-row' }, laundry, '住处可以洗衣服'),
    h('label', {}, '补充说明', note),
    h('p', { class: 'muted small' }, ai.key ? '会用 DeepSeek 推荐并搭配衣服。' : '没填 DeepSeek 密钥，只用规则推荐。可以在「设置」里填密钥让推荐更聪明。'),
    h('button', { class: 'wide', onclick: () => generate().catch(() => {}) }, '生成推荐'));
}

function tripResult(trip, isSaved) {
  const checked = new Set(trip.checked || []);
  const byId = (id) => store.item(id);
  const w = summarizeWeather(trip.weather);
  const planItems = trip.plan.items.filter((i) => byId(i.id));
  const extra = (trip.checked || []).filter((id) => !planItems.some((p) => p.id === id) && byId(id)).map((id) => ({ id, qty: 1, reason: '自己加的' }));
  const all = [...planItems, ...extra];
  // 按现在放的位置分组，照着去柜子里拿
  const groups = new Map();
  for (const p of all) {
    const key = store.shortName(byId(p.id).location);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const persist = (message, fn) => saving('正在保存…', () => store.save(message, (data) => {
    const i = data.trips.findIndex((t) => t.id === trip.id);
    const next = { ...trip, checked: [...checked] };
    fn?.(data, next);
    if (i < 0) data.trips.push(next); else data.trips[i] = next;
  })).then(() => { tripDraft.current = null; go(`#/trip/${trip.id}`, true); }).catch(() => {});

  const pack = () => {
    const ids = [...checked].filter((id) => byId(id) && !isBox(store.data, byId(id).location));
    if (!ids.length) return toast('没有勾选要带的东西', 'error');
    if (!confirm(`把勾选的 ${ids.length} 件装进行李箱？\n它们的位置会临时变成「行李箱」，回来后可以一键放回原处。`)) return;
    persist(`出发：${trip.city}，${ids.length} 件装进行李箱`, (data, next) => {
      const boxId = newId('L');
      data.locations.push({ id: boxId, name: `行李箱（${trip.city} ${trip.start.slice(5)}）`, parent: null, box: 'trip',
        assetId: nextAssetInPrefix(data, LOCATION_PREFIX), label: 'none', createdAt: today() });
      for (const it of data.items) if (ids.includes(it.id)) moveItem(data, it, boxId);
      next.boxId = boxId;
      next.status = 'packed';
    });
  };
  const unpack = () => {
    const inBox = trip.boxId ? store.itemsIn(trip.boxId) : [];
    if (!confirm(`回来了？把行李箱里的 ${inBox.length} 件放回各自原来的位置。`)) return;
    persist(`回来：${trip.city}，${inBox.length} 件放回原处`, (data, next) => {
      for (const it of data.items) if (it.location === trip.boxId) moveItem(data, it, it.homeLocation || it.location);
      if (!data.items.some((it) => it.location === trip.boxId)) data.locations = data.locations.filter((l) => l.id !== trip.boxId);
      next.status = 'done';
    });
  };
  const again = () => { tripDraft.current = { ...trip, plan: null }; go('#/trip/new'); };
  const addSelect = h('select', {},
    h('option', { value: '' }, '再加一件……'),
    store.data.items.filter((i) => !i.archived && !all.some((p) => p.id === i.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((i) => h('option', { value: i.id }, `${i.name}（${store.shortName(i.location)}）`)));
  addSelect.addEventListener('change', () => {
    if (!addSelect.value) return;
    checked.add(addSelect.value);
    trip.checked = [...checked];
    if (!isSaved) tripDraft.current = trip;
    render();
  });
  const editable = trip.status === 'planning';

  return h('div', {},
    header(`${trip.city} · ${trip.start.slice(5)}～${trip.end.slice(5)}`),
    h('div', { class: 'card' },
      h('p', {}, trip.purposes.join('、') || '未写目的', trip.laundry ? ' · 能洗衣服' : '', trip.note ? ` · ${trip.note}` : ''),
      h('p', { class: 'muted small' }, `${trip.weather.source}：${w.min}～${w.max}℃，最大降水概率 ${w.rain}%${w.snow ? '，有雪' : ''}`),
      trip.weather.days.length ? h('div', { class: 'weather-row' }, trip.weather.days.map((d) =>
        h('span', { class: 'weather-day' }, h('b', {}, d.date.slice(5)), `${Math.round(d.min)}～${Math.round(d.max)}℃`, d.rain >= 40 ? ` ☂${d.rain}%` : ''))) : null,
      h('p', { class: 'muted small' }, trip.plan.source === 'DeepSeek' ? '由 DeepSeek 推荐和搭配' : `规则推荐${trip.plan.fallback ? `（DeepSeek 没用上：${trip.plan.fallback}）` : ''}`)),
    trip.plan.tips?.length ? h('div', { class: 'card' }, h('h3', {}, '提醒'), h('ul', {}, trip.plan.tips.map((t) => h('li', {}, t)))) : null,
    h('div', { class: 'card' },
      h('h3', {}, `要带的东西（${checked.size} 件，按位置分组）`),
      [...groups.entries()].map(([place, list]) => [
        h('div', { class: 'group-title' }, place),
        list.map((p) => {
          const it = byId(p.id);
          return h('label', { class: 'check-row' },
            h('input', {
              type: 'checkbox', checked: checked.has(p.id), disabled: !editable,
              onchange: (e) => { if (e.target.checked) checked.add(p.id); else checked.delete(p.id); trip.checked = [...checked]; },
            }),
            h('span', { class: 'grow' }, it.name, p.qty > 1 ? ` ×${p.qty}` : '', h('span', { class: 'muted small block' }, p.reason)));
        })]),
      editable ? addSelect : null),
    trip.plan.outfits?.length ? h('div', { class: 'card' }, h('h3', {}, '每天穿搭'),
      trip.plan.outfits.map((o) => h('p', {}, h('b', {}, `${o.day}：`), o.items.map((id) => byId(id)?.name).filter(Boolean).join(' + '),
        o.note ? h('span', { class: 'muted small block' }, o.note) : null))) : null,
    trip.plan.missing?.length ? h('div', { class: 'card' }, h('h3', {}, '档案里没有，建议另外准备'),
      h('ul', {}, trip.plan.missing.map((m) => h('li', {}, h('b', {}, m.name), m.reason ? `：${m.reason}` : '')))) : null,
    h('div', { class: 'actions' },
      trip.status === 'planning' ? [
        h('button', { onclick: pack }, '装进行李箱'),
        h('button', { class: 'secondary', onclick: () => persist(`保存行程：${trip.city}`) }, isSaved ? '保存勾选' : '先保存'),
        h('button', { class: 'secondary', onclick: again }, '改条件重新推荐'),
      ] : null,
      trip.status === 'packed' ? [
        h('a', { class: 'button secondary', href: `#/place/${trip.boxId}` }, '看行李箱'),
        h('button', { onclick: unpack }, '回来了，全部放回原处'),
      ] : null,
      trip.status === 'done' ? h('button', { class: 'secondary', onclick: again }, '用同样的条件再推荐一次') : null));
}

// ---------- 设置 ----------

function settingsView() {
  const repo = h('input', { value: settings.repo || DEFAULT_REPO });
  const token = h('input', { type: 'password', value: settings.token || '', placeholder: 'github_pat_…', autocomplete: 'off' });
  const expires = h('input', { type: 'date', value: settings.tokenExpires || '' });
  const ai = store?.data ? readAi() : readLocalAi();
  const inRepo = Boolean(store?.config?.deepseek?.key);
  const aiKey = h('input', { type: 'password', value: ai.key || '', placeholder: 'sk-…', autocomplete: 'off' });
  const aiModel = h('input', { value: ai.model || 'deepseek-chat' });
  const saveAi = async () => {
    if (!store?.data) return toast('先连接数据仓库', 'error');
    const next = { key: aiKey.value.trim(), model: aiModel.value.trim() || 'deepseek-chat' };
    if (next.key) {
      // 列模型的接口不花钱，用来验证密钥
      const res = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${next.key}` } }).catch(() => null);
      if (!res) return toast('连不上 DeepSeek', 'error');
      if (!res.ok) return toast(res.status === 401 ? 'DeepSeek 密钥不对' : `DeepSeek 返回 ${res.status}`, 'error');
    }
    const config = { ...(store.config || {}) };
    if (next.key) config.deepseek = next; else delete config.deepseek;
    await saving('正在保存到数据仓库…', () => store.saveConfig(config, next.key ? '保存 DeepSeek 设置' : '删除 DeepSeek 密钥')).catch(() => {});
    localStorage.removeItem(AI_KEY); // 以仓库里的为准
    toast(next.key ? 'DeepSeek 已连接，所有设备都能用' : '已删除 DeepSeek 密钥');
    render();
  };

  const saveSettings = async () => {
    const next = { repo: repo.value.trim(), token: token.value.trim(), tokenExpires: expires.value || undefined };
    if (!next.token) return toast('请填写令牌', 'error');
    await saving('正在连接 GitHub…', async () => {
      const test = new GitHub(next);
      await test.headSha();
      settings = next;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.removeItem('inventory-cache');
      connect();
      await store.load();
    });
    toast('已连接');
    const target = sessionStorage.getItem('after-login');
    sessionStorage.removeItem('after-login');
    go(target || '#/', true);
  };
  const logout = () => {
    if (!confirm('清除这台设备上保存的令牌和缓存？数据仓库里的数据不受影响。')) return;
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('inventory-cache');
    caches.delete('photos-v1').catch(() => {});
    settings = {};
    gh = store = null;
    render();
  };

  return h('div', {},
    header('设置'),
    h('div', { class: 'card' },
      h('h3', {}, '连接数据仓库'),
      h('p', { class: 'small' }, '数据存在你的 GitHub 私有仓库里。每台设备第一次使用时，要填一个只能访问这个仓库的令牌：'),
      h('ol', { class: 'small' },
        h('li', {}, '在 GitHub 打开 ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, '新建 Fine-grained 令牌'), '。'),
        h('li', {}, 'Expiration 选最长；Repository access 选 Only select repositories → inventory-data。'),
        h('li', {}, 'Permissions → Repository permissions → Contents 选 Read and write。'),
        h('li', {}, '生成后复制，粘贴到下面。')),
      h('label', {}, '数据仓库', repo),
      h('label', {}, '令牌', token),
      h('label', {}, '令牌到期日（创建时 GitHub 会显示，填了会提前 14 天提醒）', expires),
      h('button', { class: 'wide', onclick: () => saveSettings().catch(() => {}) }, '保存并连接')),
    settings.token ? h('div', { class: 'card' },
      h('p', { class: 'small' }, '数据仓库：', h('a', { href: `https://github.com/${settings.repo || DEFAULT_REPO}`, target: '_blank', rel: 'noopener' }, settings.repo || DEFAULT_REPO),
        '（每次修改都是一次提交，可以在 GitHub 上查看历史）'),
      h('button', { class: 'danger', onclick: logout }, '退出这台设备')) : null,
    aiCard(inRepo, ai, aiKey, aiModel, saveAi));
}

// AI 设置：连上了就只显示一行，要更换、删除再展开
function aiCard(inRepo, ai, aiKey, aiModel, saveAi) {
  const form = [
    h('label', {}, 'API 密钥', aiKey),
    h('label', {}, '模型', aiModel),
    h('button', { class: 'secondary', onclick: () => saveAi() }, '测试并保存到数据仓库'),
    h('p', { class: 'muted small' }, '清空密钥再保存就会删除。万一密钥泄露，到 DeepSeek 后台作废它、换新的。'),
  ];
  if (inRepo) {
    return h('div', { class: 'card' },
      h('h3', {}, 'AI'),
      h('p', { class: 'small' }, `✓ 已连接 DeepSeek（${ai.model || 'deepseek-chat'}），出差推荐等 AI 功能会自动使用。`),
      h('details', { class: 'plain' }, h('summary', {}, '更换或删除密钥'), form));
  }
  return h('div', { class: 'card' },
    h('h3', {}, 'AI（选填）'),
    h('p', { class: 'small' }, '填了 DeepSeek 密钥，出差推荐会让 AI 挑东西、搭配衣服。密钥保存在你的私有数据仓库（config/ai.json），所有设备共用，只需填一次。发给 DeepSeek 的只有物品名称、类别和字段（季节、颜色等），不发照片、价格、序列号、备注。'),
    h('p', { class: 'muted small' }, ai.key ? '密钥目前只在这台设备上，点下面的按钮存到数据仓库' : '还没有填'),
    form);
}

boot();
