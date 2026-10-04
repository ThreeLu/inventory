import { GitHub, DEVICE, recentCommits } from './github.js';
import {
  Store, diff, apply as applyPatch, normalizeAssetId, newId, assertAssetFree, LOCATION_PREFIX,
  defaultLabel, setLabel, LABEL_TEXT, prefixForTags, defaultConsumable, isDepleted, ARCHIVE_REASONS,
  shoppingData, shoppingList, shopWeek, shopEstimate, usageRate, monthlyConsumables, costPerWear,
  isBox, isBag, ensureHome, parseDate, moveItem, borrowStatus,
  RETURN_TAGS, RETURN_DAYS, INTIMATE_PARTS, laundryPrefs, laundryStatus, laundryBatches, localDay, setTodayWear, nextAssetInPrefix, nextTagCode, reminders,
} from './store.js';
import { h, today, compressImage, blobToBase64, lazyPhoto, photoUrl } from './util.js';
import { makeXlsx } from './xlsx.js';
import { icon } from './icons.js';
import { SCHEDULES, FIELD_OPTIONS, todayWeather, weatherLine, wearable, partOf, ruleOutfit, aiOutfits, todayStr, isColdDay } from './outfit.js';
import { seasonPlan, storageFor, currentTerm, nextTerm as nextSeasonTerm } from './season.js';
import { askJson, itemLine } from './ai.js';
import { pushSupport, subscribe, currentSubscription, deviceName, PUSH_FILE } from './push.js';
import { startScanner, assetFromScan } from './scan.js';
import { PURPOSES, geocode, weatherFor, summarizeWeather, rulePlan, aiPlan } from './trip.js';
import { ledgerGitHub, readLedger, guessCategory, groupLines, addLedgerExpenses } from './bridge.js';

const SETTINGS_KEY = 'inventory-settings';
const DEFAULT_REPO = 'ThreeLu/inventory-data';
// 二维码里的网址：本页地址 + ?a=编号
const SITE_URL = window.location.origin + window.location.pathname;
// 在这些页面上不要因为后台刷新而重画（会丢掉正在填的内容、关掉摄像头）
const EDITING_ROUTES = /^\/(new|item\/[^/]+\/edit|scan|check)/;

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
  store.onStatus = showSync;
  store.loadCached();
  showSync(store.status);
}

// 顶上的小标记：有没上传的修改时显示。上传很快的话不显示（免得一闪一闪）
const syncPill = h('button', { class: 'sync-pill', type: 'button', hidden: true, onclick: () => {
  if (store?.status.state === 'error') toast(`上传失败：${store.status.error}（改动都还在手机上）`, 'error');
  store?.sync();
} });
let syncTimer = null;
let renderedData = '';
function showSync(st) {
  clearTimeout(syncTimer);
  const n = st.pending;
  const text = st.state === 'offline' ? `没网，${n} 项存在手机上，有网自动上传`
    : st.state === 'error' ? `${n} 项没传上去，点一下看看`
      : n ? `正在上传 ${n} 项` : '';
  const show = () => { syncPill.textContent = text; syncPill.hidden = !text; syncPill.className = `sync-pill ${st.state}`; };
  if (st.state === 'offline' || st.state === 'error' || !text) show();
  else syncTimer = setTimeout(show, 1500);
  // 传完以后，如果合并进了别的设备的修改，页面刷新一下（正在填的表单、扫码不动）
  if (st.state === 'ok' && store?.data && !EDITING_ROUTES.test(currentPath()) && JSON.stringify(store.data) !== renderedData) render();
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
  setupNav();
  document.body.append(syncPill);
  window.addEventListener('online', () => store?.sync());
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
  [/^\/?$/, () => homeView()],
  [/^\/items$/, (_, q) => itemsView(q)],
  [/^\/places$/, () => { setTimeout(() => go('#/items?mode=place', true)); return null; }],
  [/^\/place\/([^/]+)$/, (id) => placeView(id)],
  [/^\/place\/([^/]+)\/label$/, (id) => labelView('location', id)],
  [/^\/item\/([^/]+)$/, (id) => itemView(id)],
  [/^\/item\/([^/]+)\/edit$/, (id) => formView(id)],
  [/^\/item\/([^/]+)\/label$/, (id) => labelView('item', id)],
  [/^\/new$/, (_, q) => formView(null, q)],
  [/^\/a\/([^/]+)$/, (asset) => scanResultView(decodeURIComponent(asset))],
  [/^\/scan$/, () => scanView()],
  [/^\/wardrobe$/, () => wardrobeView()],
  [/^\/me$/, () => meView()],
  [/^\/more$/, () => meView()],
  [/^\/labels$/, () => labelsView()],
  [/^\/reminders$/, () => remindersView()],
  [/^\/shopping$/, () => shoppingView()],
  [/^\/restock$/, () => { setTimeout(() => go('#/shopping', true)); return null; }],
  [/^\/borrow$/, () => borrowView()],
  [/^\/loans$/, () => borrowView()],
  [/^\/boxes$/, () => boxesView()],
  [/^\/trips$/, () => tripsView()],
  [/^\/trip\/new$/, () => tripPlanView(null)],
  [/^\/trip\/([^/]+)$/, (id) => tripPlanView(id)],
  [/^\/outfit$/, (_, q) => outfitView(q)],
  [/^\/wear$/, () => wearView()],
  [/^\/laundry$/, () => laundryView()],
  [/^\/season$/, () => seasonView()],
  [/^\/ask$/, () => chatView()],
  [/^\/lists$/, () => listsView()],
  [/^\/list\/([^/]+)$/, (id) => listView(id)],
  [/^\/check\/(trip|box|list|bag)\/([^/]+)(?:\/(out|back))?$/, (m) => checkRoute(...m)],
  [/^\/stats$/, () => statsView()],
  [/^\/manage$/, () => manageView()],
  [/^\/settings$/, () => settingsView()],
  [/^\/lost$/, () => lostView()],
  [/^\/find$/, (_, q) => findView(q)],
  [/^\/term$/, (_, q) => termView(q)],
  [/^\/siri$/, () => siriView()],
];

// 底部导航：每个标签管哪些页面
const NAV_GROUPS = {
  '/': [/^\/?$/, /^\/ask/],
  '/items': [/^\/items/, /^\/find/, /^\/places?/, /^\/item\//, /^\/new/, /^\/a\//, /^\/scan/],
  '/wardrobe': [/^\/wardrobe/, /^\/outfit/, /^\/wear/, /^\/laundry/, /^\/trips?/, /^\/season/, /^\/lists?/, /^\/check/],
  '/me': [/^\/me/, /^\/lost/, /^\/siri/, /^\/term/, /^\/more/, /^\/labels/, /^\/restock/, /^\/shopping/, /^\/reminders/, /^\/stats/, /^\/manage/, /^\/settings/, /^\/boxes/, /^\/borrow/, /^\/loans/],
};

function setupNav() {
  for (const a of nav.querySelectorAll('a[data-icon]')) {
    a.prepend(h('span', { class: 'tab-icon' }, icon(a.dataset.icon)));
  }
  nav.querySelector('a[href="#/me"] .tab-icon').append(h('span', { class: 'dot-badge', hidden: true }));
  const plus = nav.querySelector('.plus');
  plus.append(h('span', { class: 'circle' }, icon('plus')));
  plus.addEventListener('click', openPlusSheet);
}

// 中间的「＋」：新建 / 扫码 / 问一问
function openPlusSheet() {
  const close = () => overlay.remove();
  const item = (href, ic, color, title, desc) => h('a', { class: 'cell', href, onclick: close },
    h('span', { class: 'dot', style: `background:${color}` }, icon(ic)),
    h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'meta' }, desc)), icon('chev', 'i chev'));
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'group' },
        item('#/new', 'plus', 'var(--accent)', '新建物品', '拍照、填名称，自动编号'),
        item('#/scan', 'scan', '#5f7fa8', '扫码', '查找、整理、盘点'),
        item('#/ask', 'chat', 'var(--sage)', '问一问', '用一句话问你的物品'))));
  document.body.append(overlay);
}

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
    else content = re.source.includes('check') ? fn(m.slice(1), q) : fn(m[1], q);
    break;
  }
  view.replaceChildren(content || notFound('没有这个页面'));
  renderedData = store?.data ? JSON.stringify(store.data) : '';
  for (const a of nav.querySelectorAll('a[href]')) {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('active', (NAV_GROUPS[target] || []).some((re) => re.test(path)));
  }
  const badge = nav.querySelector('.dot-badge');
  if (badge) badge.hidden = !(store?.data && (reminders(store.data).length || store.data.items.some((i) => borrowStatus(i)?.soon)));
}

// ---------- 通用组件 ----------

function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}

// 常用的操作不先问「确定吗」：直接做，底部提示几秒，点「撤销」改回去
function undoToast(text, onUndo) {
  for (const el of document.querySelectorAll('.toast.undo')) el.remove();
  const el = h('div', { class: 'toast undo', role: 'status' }, h('span', {}, text),
    h('button', { type: 'button', class: 'toast-undo', onclick: () => { el.remove(); onUndo(); } }, '撤销'));
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// 能撤销的修改：撤销时只把这次改到的东西改回去，这期间别的修改不受影响
async function saveUndoable(message, mutate, doneText) {
  const before = structuredClone(store.data);
  const result = await saving('正在保存…', () => store.save(message, mutate));
  if (result === false) return result;
  const back = diff(store.data, before);
  delete back.obj.assetHighWater; // 编号只增不减
  undoToast(doneText, () => saving('正在撤销…', () => store.save(`撤销：${message}`, (data) => { applyPatch(data, back); }))
    .then(() => { toast('已撤销'); render(); }).catch(() => {}));
  return result;
}

function busy(message) {
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, message));
  document.body.append(el);
  return { set: (m) => { el.firstChild.textContent = m; }, done: () => el.remove() };
}

// 「正在保存」只在真的要等的时候出现：普通修改先存手机，马上就好，不弹；带照片、问 AI 这种要等的才弹
async function saving(message, fn) {
  let b = null;
  let text = message;
  const timer = setTimeout(() => { b = busy(text); }, 250);
  const handle = { set: (m) => { text = m; b?.set(m); } };
  try {
    return await fn(handle);
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  } finally {
    clearTimeout(timer);
    b?.done();
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
  const actions = extra.filter(Boolean);
  return h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title)),
    actions.length ? h('div', { class: 'head-actions' }, actions) : null);
}

function headerSub(title, sub, ...actions) {
  const el = header(title, ...actions);
  el.firstChild.append(h('div', { class: 'sub' }, sub));
  return el;
}

const scanButton = () => h('a', { class: 'icon-btn', href: '#/scan', 'aria-label': '扫码' }, icon('scan'));

// 苹果式分组列表的一行
function cell({ href, onclick, ic, color = 'var(--accent)', title, meta, count }) {
  return h(href ? 'a' : 'button', { class: 'cell', href, onclick, type: href ? undefined : 'button' },
    ic ? h('span', { class: 'dot', style: `background:${color}` }, icon(ic)) : null,
    h('span', { class: 'grow' }, title),
    meta ? h('span', { class: 'meta' }, meta) : null,
    count ? h('span', { class: 'count' }, count) : null,
    icon('chev', 'i chev'));
}

function tagChip(tag) {
  return h('a', { class: 'chip', href: `#/items?tag=${encodeURIComponent(tag)}` }, tag);
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
function openSheet({ title, body, confirmText = '确定', cancelText = '取消', onConfirm }) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet' },
      h('h3', {}, title),
      body,
      h('div', { class: 'actions' },
        h('button', { onclick: async () => { if ((await onConfirm()) !== false) close(); } }, confirmText),
        cancelText ? h('button', { class: 'secondary', onclick: close }, cancelText) : null)));
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
function changeLabel(type, id, state, message, undoText) {
  const mutate = (data) => {
    const x = (type === 'item' ? data.items : data.locations).find((o) => o.id === id);
    if (!x) throw new Error('找不到了，可能已经在别处被删除');
    setLabel(x, state);
    if (type === 'item') x.updatedAt = new Date().toISOString();
  };
  return (undoText ? saveUndoable(message, mutate, undoText) : saving('正在保存…', () => store.save(message, mutate))).then(render).catch(() => {});
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
      onclick: () => changeLabel(type, obj.id, 'pending', `重新打印：${obj.assetId} ${name}`, `${obj.assetId} 放回待打印，编号不变`),
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
  const text = r.kind === '退货' ? (r.days === 0 ? '今天过退货期' : `${r.days} 天后过退货期`) : `${r.kind}${daysText(r.days)}`;
  return itemRow(r.item, h('span', { class: r.days < 0 ? 'warn' : 'soon' }, text));
}

// ---------- 物品列表 ----------

const listState = { q: '', tag: '', loc: '', label: '', archived: false, mode: 'catalog', filters: false };

function matches(item, words) {
  const text = [
    item.name, item.assetId, item.description, item.notes, item.manufacturer, item.modelNumber,
    item.serialNumber, item.purchaseFrom, ...item.tags, ...Object.values(item.fields || {}),
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w) || (item.assetId && item.assetId.replace('-', '').includes(w.replace('-', ''))));
}

function itemTile(item) {
  const thumb = item.photos?.[0]?.thumb;
  return h('a', { class: `tile${item.archived ? ' archived' : ''}`, href: `#/item/${item.id}` },
    h('div', { class: 'ph' },
      thumb ? lazyPhoto(gh, thumb) : h('span', { class: 'initial' }, item.name.slice(0, 1)),
      item.label === 'pending' && !item.archived ? h('span', { class: 'corner' }, labelChip(item)) : null),
    h('div', { class: 'name' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
    h('div', { class: 'info' }, assetChip(item.assetId), store.shortName(item.location),
      isDepleted(item) && !item.archived ? h('span', { class: 'badge warn' }, '已用完') : null,
      item.borrow ? h('span', { class: 'badge' }, '借阅') : null,
      item.archived ? h('span', { class: 'badge' }, '已归档') : null));
}

function itemsView(q = {}) {
  if (q.tag !== undefined) listState.tag = q.tag;
  if (q.mode) listState.mode = q.mode;
  const body = h('div', {});
  const count = h('p', { class: 'muted small' });
  const filterBox = h('div', { class: 'filters', hidden: !listState.filters });
  const chipBox = h('div', { class: 'chip-scroll' });

  const filtered = () => {
    const words = listState.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const inLoc = listState.loc ? store.descendantIds(listState.loc) : null;
    return store.data.items
      .filter((i) => listState.archived || !i.archived)
      .filter((i) => !listState.tag || i.tags.includes(listState.tag))
      .filter((i) => !inLoc || inLoc.has(i.location))
      .filter((i) => !listState.label || i.label === listState.label)
      .filter((i) => matches(i, words))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  };
  const drawChips = () => {
    const active = store.data.items.filter((i) => listState.archived || !i.archived);
    const counts = store.data.tags.map((t) => [t, active.filter((i) => i.tags[0] === t).length]).filter(([, n]) => n);
    chipBox.replaceChildren(
      h('button', { type: 'button', class: `chip${listState.tag ? '' : ' on'}`, onclick: () => { listState.tag = ''; drawChips(); update(); } }, `全部 ${active.length}`),
      ...counts.map(([t, n]) => h('button', {
        type: 'button', class: `chip${listState.tag === t ? ' on' : ''}`,
        onclick: () => { listState.tag = listState.tag === t ? '' : t; drawChips(); update(); },
      }, `${t} ${n}`)));
  };
  const update = () => {
    chipBox.hidden = listState.mode === 'place';
    if (listState.mode === 'place') { count.textContent = ''; return fill(body, placesList()); }
    const items = filtered();
    const total = items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
    count.textContent = `${items.length} 件` + (total !== items.length ? `（共 ${total} 个）` : '');
    let shown = 120;
    const draw = () => {
      const part = items.slice(0, shown);
      fill(body,
        listState.mode === 'catalog' ? h('div', { class: 'catalog' }, part.map(itemTile)) : h('div', { class: 'list' }, part.map((i) => itemRow(i))),
        items.length > shown ? h('button', { class: 'secondary wide', onclick: () => { shown += 120; draw(); } }, '显示更多') : null,
        store.data.items.length ? null : h('div', { class: 'card' }, h('p', {}, '还没有物品。'), h('a', { class: 'button', href: '#/new' }, '新建第一件')));
    };
    draw();
  };
  fill(filterBox,
    locationSelect(listState.loc, { onchange: (e) => { listState.loc = e.target.value; update(); } }, '全部位置'),
    h('select', { value: listState.label, onchange: (e) => { listState.label = e.target.value; update(); } },
      h('option', { value: '' }, '标签状态'), Object.entries(LABEL_TEXT).map(([k, v]) => h('option', { value: k }, v))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: listState.archived, onchange: (e) => { listState.archived = e.target.checked; drawChips(); update(); } }),
      '含已归档'));
  const seg = (mode, text) => h('button', {
    type: 'button', class: `seg${listState.mode === mode ? ' on' : ''}`,
    onclick: (e) => { listState.mode = mode; for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target); update(); },
  }, text);
  const filterBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': '筛选',
    onclick: () => { listState.filters = !listState.filters; filterBox.hidden = !listState.filters; },
  }, icon('filter'));

  drawChips();
  update();
  return h('div', {},
    header('物品', filterBtn, scanButton()),
    h('input', {
      type: 'search', placeholder: '搜索名称、编号、品牌……', value: listState.q, class: 'search',
      oninput: (e) => { listState.q = e.target.value; update(); },
    }),
    h('div', { class: 'segmented' }, seg('catalog', '按类别'), seg('place', '按位置'), seg('list', '列表')),
    filterBox, chipBox, count, body);
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

  const change = (fn) => (data) => {
    const it = data.items.find((i) => i.id === id);
    if (!it) throw new Error('这件物品已经在别处被删除了');
    fn(it);
    it.updatedAt = new Date().toISOString();
  };
  const update = (message, fn) => saving('正在保存…', () => store.save(message, change(fn))).then(render).catch(() => {});
  // 直接做、可以撤销（不再弹「确定吗」）
  const updateUndo = (message, fn, doneText) => saveUndoable(message, change(fn), doneText).then(render).catch(() => {});

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
  const useUp = () => updateUndo(`用完：${item.name}`, (it) => { it.quantity = 0; delete it.runningLow; note(it, '用完'); }, `「${item.name}」用完了，已放进购物清单`);
  const runLow = (on) => update(`${on ? '快用完了' : '还够用'}：${item.name}`, (it) => { if (on) it.runningLow = today(); else delete it.runningLow; });
  const restock = () => openRestock(item);
  const bs = borrowStatus(item);
  const renew = () => {
    const due = h('input', { type: 'date', value: addDays(item.borrow.due, 30) });
    openSheet({
      title: `续借「${item.name}」`,
      body: h('div', { class: 'form' }, h('label', {}, '新的应还日期', due)),
      confirmText: '续借',
      onConfirm: () => update(`续借：${item.name} → ${due.value}`, (it) => {
        note(it, `续借，应还日期 ${it.borrow.due} → ${due.value}`);
        it.borrow = { ...it.borrow, due: due.value, renewals: (it.borrow.renewals || 0) + 1 };
      }),
    });
  };
  const giveBack = () => updateUndo(`归还：${item.name}`, (it) => {
    note(it, `已归还${it.borrow.from}（${it.borrow.date} 借）`);
    it.archived = true;
    it.archiveReason = '已归还';
    it.archivedAt = today();
  }, `《${item.name}》已归还，归档了`);

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
    isDepleted(item) && !item.archived ? h('div', { class: 'banner warn' }, '已用完，在购物清单上') : null,
    item.runningLow && !isDepleted(item) && !item.archived ? h('div', { class: 'banner soon' }, `快用完了（${item.runningLow.slice(5)} 标记），在购物清单上`) : null,
    item.laundry && !item.archived ? h('div', { class: 'banner' }, item.laundry.autoReturn ? '贴身衣物，今天在洗，明天自动收回' : `${LAUNDRY_TEXT[item.laundry.state]}（${item.laundry.since.slice(5)} 起）`) : null,
    bs ? h('div', { class: `banner ${bs.overdue ? 'warn' : bs.soon ? 'soon' : ''}` },
      `借自${item.borrow.from}，${item.borrow.due} 前还`, bs.overdue ? `，已逾期 ${-bs.left} 天` : `，还剩 ${bs.left} 天`) : null,
    item.leftBehind ? h('div', { class: 'banner warn' }, `${item.leftBehind.date} 出行时落在${item.leftBehind.place}了`) : null,
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
        (() => { const c = costPerWear(item); return c ? field('穿一次', c.wears ? `¥${c.each}（穿了 ${c.wears} 次）` : '还没记过穿它') : null; })(),
        (() => { const u = item.consumable ? usageRate(store.data, item) : null; return u ? field('多久买一次', `平均 ${u.every} 天，下次大概 ${u.next.slice(5)}`) : null; })(),
        field('价格', item.purchasePrice != null && item.purchasePrice !== '' ? `¥${item.purchasePrice}` : null),
        field('购买地点', item.purchaseFrom),
        field('保修到期', item.warrantyExpires),
        item.returnBy && item.returnBy >= today() ? field('退货截止', item.returnBy) : null),
      item.returnBy && item.returnBy >= today() && !item.archived ? h('div', { class: 'banner soon return-banner' },
        `${item.returnBy} 前还能退。用着有问题吗？`,
        h('button', { class: 'small secondary', onclick: () => updateUndo(`不退了：${item.name}`, (it) => { delete it.returnBy; }, '好，不再提醒退货') }, '没问题，不退了')) : null,
      item.notes ? [h('h3', {}, '备注'), h('p', { class: 'pre' }, item.notes)] : null),
    item.receipts?.length ? h('div', { class: 'card' }, h('h3', {}, '发票 / 保修卡'),
      h('div', { class: 'photo-grid' }, item.receipts.map((p) =>
        lazyPhoto(gh, p.thumb, { onclick: () => openPhoto(p.file) })))) : null,
    h('div', { class: 'actions' },
      h('a', { class: 'button', href: `#/item/${id}/edit` }, '编辑'),
      item.consumable && !item.archived ? [
        item.quantity > 1 ? h('button', { class: 'secondary', onclick: useOne }, '用掉一个') : null,
        isDepleted(item) ? null : item.runningLow ? h('button', { class: 'secondary', onclick: () => runLow(false) }, '还够用')
          : h('button', { class: 'secondary', onclick: () => runLow(true) }, '快用完了'),
        isDepleted(item) ? null : h('button', { class: 'secondary', onclick: useUp }, '用完了'),
        h('button', { class: isDepleted(item) ? '' : 'secondary', onclick: restock }, '补货'),
      ] : null,
      item.archived ? null : labelButtons('item', item),
      bs ? [h('button', { onclick: giveBack }, '已归还'), h('button', { class: 'secondary', onclick: renew }, '续借')] : null,
      item.leftBehind ? [
        h('button', { onclick: () => update(`找回来了：${item.name}`, (it) => { note(it, `找回来了（${it.leftBehind.date} 落在${it.leftBehind.place}）`); delete it.leftBehind; }) }, '找回来了'),
        h('button', { class: 'secondary', onclick: () => updateUndo(`找不到了：${item.name}`, (it) => {
          note(it, `落在${it.leftBehind.place}，找不到了`); delete it.leftBehind;
          it.archived = true; it.archiveReason = '丢失'; it.archivedAt = today();
        }, `「${item.name}」已归档（丢失）`) }, '找不到了'),
      ] : null,
      !item.archived && canWash(item) ? (
        !item.laundry ? h('button', { class: 'secondary', onclick: () => setLaundry([id], 'dirty', `放进洗衣篮：${item.name}`) }, '放进洗衣篮')
          : item.laundry.state === 'dirty' ? h('button', { class: 'secondary', onclick: () => setLaundry([id], 'washing', `开洗：${item.name}`) }, '开洗')
            : h('button', { class: 'secondary', onclick: () => setLaundry([id], null, `收好了：${item.name}`) }, '收好了')) : null,
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
        delete it.runningLow;
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
    id: itemId, name: q.name || '', assetId: null, location: q.loc || '',
    tags: q.tags ? q.tags.split(',').filter((t) => store.data.tags.includes(t)) : [],
    quantity: Math.max(1, Number(q.qty) || 1), description: '', fields: {}, photos: [], receipts: [],
    manufacturer: '', modelNumber: '', serialNumber: '', purchaseDate: q.date || '', purchasePrice: q.price ? Number(q.price) : null,
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
    value: draft.assetId || '', inputmode: 'numeric', placeholder: '例如 290-0001', 'aria-label': '编号',
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

  // 剩几件进购物清单：只对能数的消耗品有意义（抽纸 6 包、电池 4 节）；一瓶一支的用物品页的「快用完了」
  const lowRow = h('label', { class: 'low-row' }, '剩几件时进购物清单',
    h('input', { type: 'number', min: 1, inputmode: 'numeric', placeholder: '选填，不填就等用完再提醒', 'aria-label': '剩几件提醒',
      value: draft.lowAt || '', oninput: (e) => { draft.lowAt = e.target.value; } }));
  const syncLow = () => { lowRow.hidden = !wantConsumable; };
  const consumableSwitch = h('input', {
    type: 'checkbox', checked: wantConsumable,
    onchange: (e) => { wantConsumable = e.target.checked; consumableTouched = true; syncLow(); },
  });
  syncLow();

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
          syncLow();
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
        FIELD_OPTIONS[r.k]
          ? h('select', { value: r.v, onchange: (e) => { r.v = e.target.value; } },
            h('option', { value: '' }, '选择…'), [...new Set([...FIELD_OPTIONS[r.k], r.v].filter(Boolean))].map((o) => h('option', { value: o }, o)))
          : h('input', { placeholder: r.k === '保质期' ? '2027-03-01' : '内容', value: r.v, oninput: (e) => { r.v = e.target.value; } }),
        h('button', { type: 'button', class: 'x-inline', onclick: () => { fieldRows.splice(i, 1); drawFields(); } }, '×'))),
      h('div', { class: 'chips' },
        presets.map((k) => h('button', { type: 'button', class: 'chip add', onclick: () => { fieldRows.push({ k, v: '' }); drawFields(); } }, `＋${k}`)),
        h('button', { type: 'button', class: 'chip add', onclick: () => { fieldRows.push({ k: '', v: '' }); drawFields(); } }, '＋其他字段')));
  };
  drawTags();
  drawFields();

  // ---- AI 补全：只填名称，AI 推荐类别、字段、是不是消耗品 ----
  const suggestBox = h('div', { class: 'ai-suggest', hidden: true });
  const autoFill = async () => {
    const name = (draft.name || '').trim();
    if (!name) return toast('先填名称', 'error');
    const ai = readAi();
    if (!ai.key) return toast('还没有设置 DeepSeek（设置 → AI）', 'error');
    const presets = Object.entries(store.data.fieldPresets || {}).map(([t, ks]) => `${t}：${ks.join('、')}`).join('；');
    const options = Object.entries(FIELD_OPTIONS).map(([k, vs]) => `${k}只能是 ${vs.join('/')}`).join('；');
    let out;
    try {
      out = await saving('DeepSeek 正在看这是什么……', () => askJson(ai, [
        '你帮用户给宿舍里的物品建档。根据物品名称（和用户已选的类别）推荐：',
        `1. category：从这些类别里选一个：${store.data.tags.join('、')}。`,
        `2. fields：按类别该填的字段（${presets}）；${options}。看不出来的字段不要填，不要编。`,
        '3. consumable：会用完、还会再买的是 true（零食、药品、纸巾、洗漱用品），耐用品是 false。',
        '4. note：一句有用的提示，比如药品、食品常见的保质期是多久（只是参考），没有就空字符串。',
        '只输出 JSON：{"category":"","fields":{},"consumable":false,"note":""}',
      ].join('\n'), `名称：${name}${draft.tags[0] ? `\n用户已选类别：${draft.tags[0]}` : ''}${draft.description ? `\n描述：${draft.description}` : ''}`,
      { maxTokens: 4000, timeout: 60000 }));
    } catch { return; }
    const cat = store.data.tags.includes(out.category) ? out.category : null;
    const fields = Object.entries(out.fields || {}).filter(([k, v]) => k && v && (!FIELD_OPTIONS[k] || FIELD_OPTIONS[k].includes(String(v))));
    const apply = () => {
      if (cat && draft.tags[0] !== cat) {
        draft.tags = [cat];
        drawTags();
        if (autoAsset || !assetInput.value) applySuggestion();
        if (!labelTouched) { wantLabel = defaultLabel(store.data, draft.tags) !== 'none'; labelSwitch.checked = wantLabel; drawLabelStatus(); }
      }
      for (const [k, v] of fields) {
        const row = fieldRows.find((r) => r.k === k);
        if (!row) fieldRows.push({ k, v: String(v) });
        else if (!String(row.v).trim()) row.v = String(v); // 已经填了的不覆盖
      }
      if (typeof out.consumable === 'boolean') { wantConsumable = out.consumable; consumableSwitch.checked = out.consumable; consumableTouched = true; syncLow(); }
      drawFields();
      suggestBox.hidden = true;
      toast('已填好，看看对不对');
    };
    fill(suggestBox,
      h('b', {}, 'AI 建议'),
      h('div', { class: 'chips' },
        cat ? h('span', { class: 'chip on' }, cat) : null,
        fields.map(([k, v]) => h('span', { class: 'chip' }, `${k}：${v}`)),
        typeof out.consumable === 'boolean' ? h('span', { class: 'chip' }, out.consumable ? '消耗品' : '耐用') : null),
      out.note ? h('p', { class: 'muted small' }, out.note) : null,
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'small', onclick: apply }, '采用'),
        h('button', { type: 'button', class: 'small secondary', onclick: () => { suggestBox.hidden = true; } }, '不用了')));
    suggestBox.hidden = false;
  };

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
    const low = Math.floor(Number(draft.lowAt));
    if (wantConsumable && low >= 1) draft.lowAt = low; else delete draft.lowAt;
    draft.purchasePrice = draft.purchasePrice === '' || draft.purchasePrice == null ? null : Number(draft.purchasePrice);
    // 新买的电子产品、衣服鞋包：退货截止默认购买日期 + 7 天（已经过了就不填）
    if (!existing && !draft.returnBy && draft.purchaseDate && RETURN_TAGS.includes(draft.tags[0])) {
      const d = new Date(`${draft.purchaseDate}T00:00:00`);
      d.setDate(d.getDate() + RETURN_DAYS);
      const by = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (by >= today()) draft.returnBy = by;
    }
    if (!draft.returnBy) delete draft.returnBy;
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
          // 从购物清单「买回来了」点进来建档的：建好就从「还没建档」里去掉
          if (q.shop && data.shopping?.toFile) data.shopping.toFile = data.shopping.toFile.filter((e) => e.id !== q.shop);
        }
        return record.assetId;
      }, { uploads, removes: removed.flatMap((p) => [p.file, p.thumb]) });
    });
    toast(savedAsset !== draft.assetId ? `已保存（编号 ${savedAsset}）` : '已保存');
    // 新买的东西填了价格：问一下要不要顺手记到账本（从小票导入、已经记过账的不问）
    if (!existing && draft.purchasePrice > 0 && !q.paid) {
      offerLedger([{ name: draft.name, price: draft.purchasePrice, tag: draft.tags[0] }], { date: draft.purchaseDate || today() });
    }
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
    h('label', {}, '名称',
      h('div', { class: 'asset-row' }, bind('name', { placeholder: '例如 黑色羽绒服（优衣库）', required: true, 'aria-label': '名称' }),
        h('button', { type: 'button', class: 'chip add', onclick: () => autoFill() }, icon('sparkle'), 'AI 补全'))),
    suggestBox,
    h('label', {}, '位置', locationSelect(draft.location, { onchange: (e) => { draft.location = e.target.value; } })),
    h('div', { class: 'label' }, '类别', h('span', { class: 'hint inline' }, '只选一个，决定编号前 3 位'), tagBox),
    h('div', { class: 'label' }, '编号', h('div', { class: 'asset-row' }, assetInput, suggestBtn), renumberBtn, assetMsg),
    h('div', { class: 'label' }, h('label', { class: 'switch-row' }, labelSwitch, '贴标签'), labelStatus),
    h('div', { class: 'label' }, h('label', { class: 'switch-row' }, consumableSwitch, '消耗品'),
      h('div', { class: 'hint' }, '会用完、还会再买的东西。用完了不归档，进「购物清单」，买回来编号不变。'), lowRow),
    h('label', {}, '数量', bind('quantity', { type: 'number', min: 0, inputmode: 'numeric' })),
    h('div', { class: 'label' }, '其他信息', fieldBox),
    h('label', {}, '描述', bind('description', { multiline: true, rows: 2 })),
    h('details', { open: Boolean(draft.manufacturer || draft.purchaseDate || draft.purchasePrice || draft.serialNumber || draft.warrantyExpires) },
      h('summary', {}, '品牌、购买与保修'),
      h('label', {}, '品牌', bind('manufacturer')),
      h('label', {}, '型号', bind('modelNumber')),
      h('label', {}, '序列号', bind('serialNumber')),
      h('label', {}, '购买日期', bind('purchaseDate', { type: 'date' })),
      h('label', {}, '价格（元）', bind('purchasePrice', { type: 'number', step: '0.01', inputmode: 'decimal' })),
      h('label', {}, '购买地点', bind('purchaseFrom')),
      h('label', {}, '保修到期', bind('warrantyExpires', { type: 'date' })),
      h('label', {}, '退货截止', bind('returnBy', { type: 'date' }),
        h('div', { class: 'hint' }, `电子产品、衣服鞋包填了购买日期、这里空着的话，自动按购买日期 + ${RETURN_DAYS} 天（七天无理由），到期前 3 天提醒。`)),
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

function placesList() {
  return [
    h('div', { class: 'list' }, store.locationTree().filter(({ loc }) => !isBox(store.data, loc.id)).map(({ loc, depth }) =>
      h('a', { class: 'row place', href: `#/place/${loc.id}`, style: `padding-left:${12 + depth * 22}px` },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, loc.name),
          h('div', { class: 'row-meta' }, assetChip(loc.assetId), `${store.itemsIn(loc.id).length} 件`))))),
    h('p', { class: 'center' }, h('a', { href: '#/manage', class: 'small' }, '管理位置和类别')),
  ];
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
    isBox(store.data, id) ? null : h('a', { class: 'button wide', href: `#/new?loc=${id}` }, '在这里新建物品'));
}

// ---------- 更多 ----------

function meView() {
  const pending = store.pendingLabels().length;
  const due = reminders(store.data).length;
  const borrowDue = store.data.items.filter((i) => !i.archived && borrowStatus(i)?.soon).length;
  const shopping = shoppingList(store.data).length;
  return h('div', {},
    header('我的'),
    h('div', { class: 'group' },
      cell({ href: '#/labels', ic: 'printer', title: '标签打印', meta: pending ? `待打印 ${pending}` : '' }),
      cell({ href: '#/borrow', ic: 'book', color: 'var(--sage)', title: '借阅', count: borrowDue || null,
        meta: `${store.data.items.filter((i) => i.borrow && !i.archived).length} 本在借` }),
      cell({ href: '#/boxes', ic: 'box', color: '#b98a5e', title: '装箱 / 收纳袋', meta: store.data.locations.filter((l) => l.box).length ? `${store.data.locations.filter((l) => l.box).length} 个` : '' }),
      cell({ href: '#/lists', ic: 'list', color: '#9a8c7a', title: '清单模板', meta: (store.data.lists || []).length ? `${store.data.lists.length} 个` : '' }),
      cell({ href: '#/term', ic: 'suitcase', color: '#5f7fa8', title: '放假离校 / 开学返校', meta: termMeta() })),
    h('div', { class: 'section-title' }, '提醒和统计'),
    h('div', { class: 'group' },
      cell({ href: '#/reminders', ic: 'clock', color: 'var(--danger)', title: '到期提醒', count: due || null }),
      cell({ href: '#/shopping', ic: 'cart', color: 'var(--amber)', title: '购物清单', count: shopping || null }),
      cell({ href: '#/stats', ic: 'chart', color: '#5f7fa8', title: '统计' })),
    h('div', { class: 'section-title' }, '设置'),
    h('div', { class: 'group' },
      cell({ href: '#/manage', ic: 'list', color: '#8a8680', title: '管理位置和类别' }),
      cell({ href: '#/settings', ic: 'gear', color: '#8a8680', title: '设置' })),
    h('p', { class: 'center' }, h('button', { class: 'link small', onclick: exportExcel }, '导出全部物品（Excel）')));
}

// ---------- 今天（首页） ----------

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const homeCity = () => store.data.prefs?.homeCity || '';
const weatherCache = { date: '', city: '', w: null, loading: null };

// 今天的天气：一天查一次，存在内存里
async function getWeather() {
  const city = homeCity();
  if (!city) return null;
  if (weatherCache.date === todayStr() && weatherCache.city === city && weatherCache.w) return weatherCache.w;
  weatherCache.loading ||= todayWeather(city).then((w) => {
    Object.assign(weatherCache, { date: todayStr(), city, w });
    return w;
  }).finally(() => { weatherCache.loading = null; });
  return weatherCache.loading;
}

function notices() {
  const out = [];
  if (settings.tokenExpires) {
    const left = Math.round((new Date(settings.tokenExpires) - new Date()) / 86400000);
    if (left <= 14) out.push({ href: '#/settings', ic: 'gear', color: 'var(--danger)', title: left < 0 ? 'GitHub 令牌已经过期' : `GitHub 令牌还有 ${left} 天过期` });
  }
  const t = tonight();
  if (!t.answered && new Date().getHours() >= 20) {
    if (t.items.length) out.push({ href: '#/laundry', ic: 'wardrobe', color: 'var(--accent)', title: '今天穿的要洗吗？', meta: `${t.items.length} 件` });
    else if (!wornToday().length && wearable(store.data).length) out.push({ href: '#/laundry', ic: 'wardrobe', color: 'var(--accent)', title: '今天穿了什么？' });
  }
  const ls = laundryStatus(store.data);
  if (ls.due) out.push({ href: '#/laundry', ic: 'wardrobe', color: 'var(--amber)', title: '该洗衣服了', meta: `篮子里 ${ls.dirty.length} 件` });
  if (ls.bedding.length) out.push({ href: '#/laundry', ic: 'wardrobe', color: 'var(--amber)', title: '床上用品该洗了', meta: ls.bedding[0].item.name });
  const all = reminders(store.data);
  for (const r of all.filter((x) => x.kind === '退货')) {
    out.push({ href: `#/item/${r.item.id}`, ic: 'clock', color: 'var(--danger)', title: `${r.item.name}${r.days === 0 ? '今天' : r.days === 1 ? '明天' : ` ${r.days} 天后`}过退货期`, meta: '有问题吗？' });
  }
  const due = all.filter((x) => x.kind !== '退货');
  if (due.length) out.push({ href: '#/reminders', ic: 'clock', color: 'var(--amber)', title: `${due.length} 件快过期`, meta: due[0].item.name });
  const books = store.data.items.filter((i) => borrowStatus(i)?.soon);
  if (books.length) {
    const st = borrowStatus(books[0]);
    out.push({ href: '#/borrow', ic: 'book', color: 'var(--sage)', title: `${books.length} 本书要还了`,
      meta: `《${books[0].name}》${st.overdue ? `逾期 ${-st.left} 天` : `剩 ${st.left} 天`}` });
  }
  const lost = store.data.items.filter((i) => i.leftBehind && !i.archived);
  if (lost.length) out.push({ href: `#/item/${lost[0].id}`, ic: 'suitcase', color: 'var(--danger)', title: `${lost.length} 件东西落在外面了`, meta: `${lost[0].name} · ${lost[0].leftBehind.place}` });
  // 购物清单：周六、周日（去超市前后）才在首页提
  const shop = [0, 6].includes(new Date().getDay()) ? shoppingList(store.data) : [];
  if (shop.length) out.push({ href: '#/shopping', ic: 'cart', color: 'var(--amber)', title: `这周要买 ${shop.length} 样`, meta: shop.slice(0, 2).map((e) => e.name).join('、') });
  const phase = termPhase();
  if (phase) {
    const t = store.data.term;
    const left = termChecklist(phase, t).flatMap(([, l]) => l).filter((r) => !t.done?.[r.key]).length;
    const days = termDays(phase === 'leave' ? t.leave : t.back);
    if (left) out.push({ href: `#/term?kind=${phase}`, ic: 'suitcase', color: '#5f7fa8', title: phase === 'leave' ? `${days === 0 ? '今天' : `${days} 天后`}离校：清单还有 ${left} 项` : `开学返校清单还有 ${left} 项`, meta: '' });
  }
  const toFile = store.data.shopping?.toFile || [];
  if (toFile.length) out.push({ href: '#/shopping', ic: 'plus', color: 'var(--accent)', title: `${toFile.length} 样买回来还没建档`, meta: toFile.slice(0, 2).map((e) => e.name).join('、') });
  const trips = store.data.trips.filter((t) => t.status === 'packed');
  if (trips.length) out.push({ href: `#/trip/${trips[0].id}`, ic: 'suitcase', color: '#5f7fa8', title: '行李箱里还有东西', meta: trips[0].city });
  const pending = store.pendingLabels().length;
  if (pending) out.push({ href: '#/labels', ic: 'printer', title: `${pending} 张标签待打印` });
  return out;
}

function homeView() {
  const d = new Date();
  const sub = h('div', { class: 'sub' }, `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`);
  getWeather().then((w) => { if (w) sub.textContent += ` · ${w.city} ${w.min}～${w.max}°C`; }).catch(() => {});
  const list = notices();
  const head = header('今天', scanButton());
  head.firstChild.append(sub);
  return h('div', {},
    head,
    outfitCard(),
    h('a', { class: 'ask-field', href: '#/ask' }, icon('chat'), '问问你的物品……'),
    list.length ? [h('div', { class: 'section-title' }, '需要注意'), h('div', { class: 'group' }, list.map(cell))] : null);
}

// ---------- 今天穿什么 ----------

const outfitState = { generating: null, option: 0 };

function todaysOutfit() {
  const o = store.data.outfit;
  return o && o.date === todayStr() ? o : null;
}

// 生成今天的搭配，存进数据仓库（当天再打开直接看，不重复花钱）
async function generateOutfit({ schedule, note } = {}) {
  if (outfitState.generating) return outfitState.generating;
  outfitState.generating = (async () => {
    const prev = todaysOutfit();
    schedule ||= prev?.schedule || [new Date().getDay() % 6 === 0 ? '宅宿舍' : '上课'];
    note ??= prev?.note || '';
    let w = null;
    try { w = await getWeather(); } catch { /* 没天气也能按季节挑 */ }
    const ai = readAi();
    let plan = null;
    let fallback = '';
    if (ai.key) {
      try { plan = await aiOutfits(ai, store.data, w, schedule, note); } catch (e) { fallback = e.message; }
    }
    plan ||= ruleOutfit(store.data, w);
    if (!plan) return null;
    const record = { date: todayStr(), schedule, note, weather: w, ...plan, fallback, chosen: null };
    await store.save(`今天穿什么：${schedule.join('、')}`, (data) => { data.outfit = record; });
    outfitState.option = 0;
    return record;
  })();
  try {
    return await outfitState.generating;
  } finally {
    outfitState.generating = null;
  }
}

function garmentTile(id, { selected, recommended, onclick } = {}) {
  const it = store.item(id);
  if (!it) return null;
  const thumb = it.photos?.[0]?.thumb;
  return h(onclick ? 'button' : 'a', {
    class: `garment${selected ? ' selected' : ''}`, type: onclick ? 'button' : undefined,
    href: onclick ? undefined : `#/item/${id}`, onclick,
  },
  h('div', { class: 'ph' }, thumb ? lazyPhoto(gh, thumb) : h('span', { class: 'initial' }, it.name.slice(0, 1)),
    recommended ? h('span', { class: 'rec' }, '推荐') : null,
    selected ? h('span', { class: 'tick' }, '✓') : null),
  h('span', {}, it.name));
}

// 今天已经记录穿了哪些（衣服、鞋，不含贴身衣物）
function wornToday() {
  const day = todayStr();
  return store.data.items.filter((i) => isClothes(i) && (i.worn || []).includes(day) && !INTIMATE_PARTS.includes(i.fields?.['部位']));
}

async function saveTodayWear(ids) {
  const day = todayStr();
  await saving('正在记录…', () => store.save(`今天穿：${ids.map((id) => store.item(id)?.name).join('、') || '（清空）'}`, (data) => {
    setTodayWear(data, ids, day);
    if (data.outfit?.date === day) data.outfit.chosenItems = ids;
  }));
  toast('记下了');
  // 晚上记的，接着问要不要洗
  go(new Date().getHours() >= 20 ? '#/laundry' : '#/', true);
}

function outfitCard() {
  const clothes = wearable(store.data);
  const card = h('div', { class: 'card outfit-card' }, h('div', { class: 'eyebrow' }, '今天穿什么'));
  const worn = wornToday();
  if (worn.length) {
    card.append(h('h2', {}, '今天穿的'), h('div', { class: 'outfit' }, worn.map((i) => garmentTile(i.id))),
      h('a', { class: 'button secondary wide', href: '#/outfit?pick=1' }, '改一下'));
    return card;
  }
  if (!clothes.length) {
    card.append(h('h2', {}, '先把衣服录进来'),
      h('p', { class: 'why' }, '衣服填好部位、季节、厚薄、颜色，这里每天会按天气和安排推荐搭配。新建时点「AI 补全」可以自动填。'),
      h('a', { class: 'button secondary wide', href: '#/new?tags=衣服' }, '新建一件衣服'));
    return card;
  }
  if (!homeCity()) {
    card.append(h('h2', {}, '设置常住城市'), h('p', { class: 'why' }, '用来查今天的天气。'),
      h('a', { class: 'button secondary wide', href: '#/settings' }, '去设置'));
    return card;
  }
  const o = todaysOutfit();
  if (!o) {
    card.append(h('h2', {}, '正在为你搭配……'), h('p', { class: 'why' }, '第一次打开要等十几秒，今天再打开就直接看到了。'),
      h('a', { class: 'button secondary wide', href: '#/outfit?pick=1' }, '直接选今天穿的'));
    generateOutfit().then(() => { if (currentPath() === '' || currentPath() === '/') render(); })
      .catch((e) => { card.querySelector('.why').textContent = `没生成出来：${e.message}`; });
    return card;
  }
  const idx = Math.min(outfitState.option, o.options.length - 1);
  const opt = o.options[idx];
  const next = () => { outfitState.option = (idx + 1) % o.options.length; render(); };
  card.append(
    h('h2', {}, opt.title),
    h('div', { class: 'outfit' }, opt.items.map((id) => garmentTile(id))),
    h('p', { class: 'why' }, opt.why, opt.tips?.length ? h('span', { class: 'block' }, `💡 ${opt.tips.join('；')}`) : null),
    h('div', { class: 'row-btns' },
      h('a', { class: 'button', href: '#/outfit?pick=1' }, '选今天穿的'),
      o.options.length > 1 ? h('button', { class: 'secondary', onclick: next }, `换一套（${idx + 1}/${o.options.length}）`) : null));
  return card;
}

const PICK_PARTS = ['上衣', '下装', '外套', '鞋', '配饰'];

function outfitView(q = {}) {
  const o = todaysOutfit();
  const schedule = new Set(o?.schedule || ['上课']);
  const chipBox = h('div', { class: 'chips' });
  const draw = () => chipBox.replaceChildren(...SCHEDULES.map((s) => h('button', {
    type: 'button', class: `chip${schedule.has(s) ? ' on' : ''}`,
    onclick: () => { if (schedule.has(s)) schedule.delete(s); else schedule.add(s); draw(); },
  }, s)));
  draw();
  const note = h('input', { placeholder: '补充一句，比如 下午有汇报、晚上去跑步', value: o?.note || '' });
  const weather = h('p', { class: 'muted small' }, o?.weather ? weatherLine(o.weather) : '');
  if (!o?.weather) getWeather().then((w) => { weather.textContent = weatherLine(w); }).catch(() => {});
  const regen = async () => {
    await saving(readAi().key ? 'DeepSeek 正在搭配…（十几秒）' : '正在搭配…', () => generateOutfit({ schedule: [...schedule], note: note.value.trim() }))
      .catch(() => {});
    render();
  };

  // 挑选：推荐的只打「推荐」标记，不预选；已经记录过的预选
  const recommended = new Set((o?.options || []).flatMap((opt) => opt.items));
  const already = wornToday().map((i) => i.id);
  const picked = new Set(already);
  const pool = [...wearable(store.data), ...wornToday().filter((i) => !wearable(store.data).includes(i))];
  const pickBox = h('div', {});
  const saveBtn = h('button', { onclick: () => saveTodayWear([...picked]) });
  const drawPick = () => {
    saveBtn.textContent = already.length ? `改成这些（${picked.size} 件）` : `就穿这些（${picked.size} 件）`;
    saveBtn.disabled = !picked.size && !already.length;
    fill(pickBox, PICK_PARTS.map((part) => {
      const xs = pool.filter((i) => partOf(i) === part)
        .sort((a, b) => Number(recommended.has(b.id)) - Number(recommended.has(a.id)));
      return xs.length ? [h('div', { class: 'group-title' }, part),
        h('div', { class: 'outfit pick' }, xs.map((i) => garmentTile(i.id, {
          selected: picked.has(i.id), recommended: recommended.has(i.id),
          onclick: () => { if (picked.has(i.id)) picked.delete(i.id); else picked.add(i.id); drawPick(); },
        })))] : null;
    }));
  };
  drawPick();
  const pickCard = h('div', { class: 'card', id: 'pick' },
    h('div', { class: 'eyebrow' }, already.length ? '今天穿的（可以改）' : '今天穿什么，点选'),
    h('p', { class: 'why' }, '标「推荐」的是 AI 推荐过的，穿哪件你自己点。'),
    pickBox);
  if (q.pick) setTimeout(() => pickCard.scrollIntoView({ block: 'start' }), 50);

  return h('div', {},
    header('今天穿什么'),
    weather,
    o ? [
      h('p', { class: 'muted small' }, o.source === 'DeepSeek' ? '由 DeepSeek 搭配' : `按规则挑的${o.fallback ? `（DeepSeek 没用上：${o.fallback}）` : ''}`),
      o.options.map((opt, i) => h('div', { class: 'card outfit-card' },
        h('div', { class: 'eyebrow' }, `推荐 ${i + 1}`),
        h('h2', {}, opt.title),
        h('div', { class: 'outfit' }, opt.items.map((id) => garmentTile(id))),
        h('p', { class: 'why' }, opt.why, opt.tips?.length ? h('span', { class: 'block' }, `💡 ${opt.tips.join('；')}`) : null))),
    ] : null,
    pickCard,
    h('details', { class: 'card' }, h('summary', {}, '换个安排重新推荐'),
      chipBox, note, h('button', { class: 'wide', onclick: regen }, '重新推荐')),
    h('div', { class: 'actions sticky' }, saveBtn));
}

// 记一次穿着：同一天只算一次；贴身衣物当天进「在洗」，第二天自动收回原处
function markWorn(it, day) {
  if ((it.worn || []).includes(day)) return;
  it.worn = [...(it.worn || []), day].slice(-90);
  it.wearsSinceWash = (it.wearsSinceWash || 0) + 1;
  if (INTIMATE_PARTS.includes(it.fields?.['部位'])) it.laundry = { state: 'washing', since: day, autoReturn: localDay(1) };
}

// ---------- 洗衣篮 ----------

const LAUNDRY_TEXT = { dirty: '在洗衣篮里', washing: '在洗 / 在晾' };
const canWash = (it) => ['衣服', '运动服', '床上用品'].includes(it.tags[0]) && !INTIMATE_PARTS.includes(it.fields?.['部位']);

function setLaundry(ids, state, message) {
  return saving('正在保存…', () => store.save(message, (data) => {
    for (const it of data.items) {
      if (!ids.includes(it.id)) continue;
      if (state) {
        it.laundry = { state, since: state === it.laundry?.state ? it.laundry.since : localDay() };
      } else {
        delete it.laundry;
        it.wearsSinceWash = 0;
        it.lastWashed = localDay();
      }
    }
  })).then(render).catch(() => {});
}

// 今天穿过、还没处理的衣服（晚上问「要洗吗」）
function tonight() {
  const day = localDay();
  const items = store.data.items.filter((i) => !i.archived && (i.worn || []).includes(day) && !i.laundry && canWash(i));
  return { day, items, answered: store.data.prefs?.laundryAsked === day };
}

function shouldWash(it) {
  const p = laundryPrefs(store.data);
  const w = weatherCache.w || todaysOutfit()?.weather;
  const rule = isColdDay(w, p.coldBelow) ? p.cold : p.warm;
  return (it.wearsSinceWash || 0) >= (rule[partOf(it)] ?? 99);
}

function laundryView() {
  const st = laundryStatus(store.data);
  const t = tonight();
  const p = laundryPrefs(store.data);
  const picked = new Set(t.items.filter(shouldWash).map((i) => i.id));
  const checkRow = (it, set, meta) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: set.has(it.id), onchange: (e) => { if (e.target.checked) set.add(it.id); else set.delete(it.id); } }),
    h('span', { class: 'grow' }, it.name, h('span', { class: 'muted small block' }, meta)));
  const answer = (ids) => saving('正在保存…', () => store.save(`今晚：${ids.length ? `${ids.length} 件放进洗衣篮` : '都不洗'}`, (data) => {
    for (const it of data.items) if (ids.includes(it.id)) it.laundry = { state: 'dirty', since: localDay() };
    data.prefs = { ...data.prefs, laundryAsked: t.day };
  })).then(render).catch(() => {});

  const selDirty = new Set(st.dirty.map((i) => i.id));
  const selWash = new Set(st.washing.map((i) => i.id));
  const editRules = () => {
    const num = (v) => h('input', { type: 'number', min: 1, value: v, inputmode: 'numeric' });
    const rows = ['上衣', '下装', '外套'].map((k) => ({ k, warm: num(p.warm[k]), cold: num(p.cold[k]) }));
    const coldBelow = num(p.coldBelow);
    const others = { count: [num(p.count), '洗衣篮里攒几件提醒'], days: [num(p.days), '最早一件放几天提醒'], bedding: [num(p.bedding), '床上用品几天洗一次'] };
    openSheet({
      title: '洗衣设置',
      body: h('div', { class: 'form' },
        h('p', { class: 'small' }, '穿几次默认勾「要洗」。当天最高温低于下面的温度按秋冬算。'),
        h('div', { class: 'rule-grid' }, h('span', {}), h('b', {}, '春夏'), h('b', {}, '秋冬'),
          rows.map((r) => [h('span', {}, r.k === '下装' ? '裤子' : r.k), r.warm, r.cold])),
        h('label', {}, '最高温低于几度算秋冬（°C）', coldBelow),
        Object.values(others).map(([el, text]) => h('label', {}, text, el))),
      confirmText: '保存',
      onConfirm: () => saving('正在保存…', () => store.save('洗衣设置', (data) => {
        const n = (el, d) => Math.max(1, Number(el.value) || d);
        data.prefs = { ...data.prefs, laundry: {
          warm: Object.fromEntries(rows.map((r) => [r.k, n(r.warm, p.warm[r.k])])),
          cold: Object.fromEntries(rows.map((r) => [r.k, n(r.cold, p.cold[r.k])])),
          coldBelow: Number(coldBelow.value) || p.coldBelow,
          ...Object.fromEntries(Object.entries(others).map(([k, [el]]) => [k, n(el, p[k])])),
        } };
      })).then(render).catch(() => {}),
    });
  };
  const noRecord = !t.answered && !wornToday().length;
  const skipToday = () => saving('正在保存…', () => store.save('今天没换衣服', (data) => {
    data.prefs = { ...data.prefs, laundryAsked: t.day };
  })).then(render).catch(() => {});

  return h('div', {},
    header('洗衣篮', h('button', { class: 'icon-btn', 'aria-label': '洗衣设置', onclick: editRules }, icon('gear'))),
    noRecord ? h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, '今天'),
      h('h3', {}, '今天穿了什么？先记一下，再看要不要洗'),
      h('div', { class: 'row-btns' },
        h('a', { class: 'button', href: '#/outfit?pick=1' }, '去选'),
        h('button', { class: 'secondary', onclick: skipToday }, '今天没换衣服'))) : null,
    t.items.length && !t.answered ? h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, '今天穿的'),
      h('h3', {}, '要洗吗？勾上的放进洗衣篮'),
      h('p', { class: 'muted small' }, `今天按${isColdDay(weatherCache.w || todaysOutfit()?.weather, p.coldBelow) ? '秋冬' : '春夏'}的次数默认勾选`),
      t.items.map((it) => checkRow(it, picked, `${partOf(it)} · 洗后穿了 ${it.wearsSinceWash || 1} 次`)),
      h('div', { class: 'row-btns', style: 'margin-top:12px' },
        h('button', { onclick: () => answer([...picked]) }, '放进洗衣篮'),
        h('button', { class: 'secondary', onclick: () => answer([]) }, '都不洗'))) : null,
    st.due ? h('div', { class: 'banner soon' }, `该洗衣服了：篮子里 ${st.dirty.length} 件，最早一件放了 ${st.oldest} 天`) : null,
    h('div', { class: 'section-title' }, `待洗（${st.dirty.length}）`),
    st.dirty.length ? h('div', { class: 'card' },
      laundryBatches(st.dirty).map(([name, xs]) => [h('div', { class: 'group-title' }, name),
        xs.map((it) => checkRow(it, selDirty, `放进来 ${Math.max(0, Math.floor((new Date(localDay()) - new Date(it.laundry.since)) / 86400000))} 天`))]),
      h('div', { class: 'actions', style: 'margin-top:12px' },
        h('button', { onclick: () => setLaundry([...selDirty], 'washing', `开洗：${selDirty.size} 件`) }, '开洗勾选的'))) : h('p', { class: 'muted small' }, '洗衣篮是空的。'),
    st.washing.length ? [h('div', { class: 'section-title' }, `在洗 / 在晾（${st.washing.length}）`),
      h('div', { class: 'card' }, st.washing.map((it) => checkRow(it, selWash, `${it.laundry.since.slice(5)} 开洗 · 收好后回到${store.shortName(it.location)}`)),
        h('div', { class: 'actions', style: 'margin-top:12px' },
          h('button', { onclick: () => setLaundry([...selWash], null, `收好了：${selWash.size} 件`) }, '收好了')))] : null,
    st.bedding.length ? [h('div', { class: 'section-title' }, '床上用品该洗了'),
      h('div', { class: 'list' }, st.bedding.map((b) => itemRow(b.item, h('span', { class: 'soon' }, `${b.days} 天没洗`))))] : null,
    h('p', { class: 'muted small' }, `内衣、袜子每天洗，第二天自动收回，不用在这里处理。床上用品每 ${p.bedding} 天提醒一次。`));
}

// ---------- 穿着记录 ----------

function wearView() {
  const clothes = store.data.items.filter((i) => isClothes(i) && !i.archived);
  const byDay = new Map();
  for (const it of clothes) for (const d of it.worn || []) {
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  }
  const days = [...byDay.keys()].sort().reverse().slice(0, 30);
  const longest = [...clothes].sort((a, b) => ((a.worn || []).slice(-1)[0] || '').localeCompare((b.worn || []).slice(-1)[0] || '')).slice(0, 10);
  return h('div', {},
    header('穿着记录'),
    days.length ? days.map((d) => [
      h('div', { class: 'section-title' }, `${d.slice(5).replace('-', '月')}日 ${WEEKDAY[new Date(d).getDay()]}`),
      h('div', { class: 'outfit card' }, byDay.get(d).map((it) => garmentTile(it.id)))])
      : h('div', { class: 'card' }, h('p', {}, '还没有记录。在「今天穿什么」里点「就穿这套」就会记下来。')),
    longest.length ? [h('div', { class: 'section-title' }, '最久没穿的'),
      h('div', { class: 'list' }, longest.map((it) => itemRow(it, h('span', {}, (it.worn || []).length ? `上次 ${(it.worn || []).slice(-1)[0]}` : '没穿过记录'))))] : null);
}

// ---------- 换季整理 ----------

function seasonView() {
  const plan = seasonPlan(store.data);
  const next = nextSeasonTerm();
  const chosen = new Set([...plan.bring, ...plan.store].map((i) => i.id));
  const row = (it, to) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) chosen.add(it.id); else chosen.delete(it.id); } }),
    h('span', { class: 'grow' }, it.name, h('span', { class: 'muted small block' }, `${store.shortName(it.location)} → ${to ? store.shortName(to.id) : '?'}`)));
  const apply = async () => {
    const moves = [...plan.bring.map((i) => [i, plan.wardrobe]), ...plan.store.map((i) => [i, storageFor(store.data, i)])]
      .filter(([i, to]) => chosen.has(i.id) && to);
    if (!moves.length) return toast('没有勾选要整理的衣服', 'error');
    await saveUndoable(`换季整理（${plan.term.name}）：${moves.length} 件`, (data) => {
      for (const [i, to] of moves) {
        const it = data.items.find((x) => x.id === i.id);
        if (it) moveItem(data, it, to.id);
      }
    }, `移好了 ${moves.length} 件衣服`).catch(() => {});
    render();
  };
  return h('div', {},
    header('换季整理'),
    h('p', { class: 'muted small' }, `现在是${plan.term.name}之后，该穿${plan.term.wear.join('、')}的衣服。下次提醒：${next.name}（${next.date.slice(5).replace('-', '/')}），会发邮件。`),
    !plan.wardrobe ? h('div', { class: 'card' }, h('p', {}, '没找到「当季衣柜」这个位置。')) : null,
    plan.bring.length ? [h('div', { class: 'section-title' }, `拿进当季衣柜（${plan.bring.length}）`), h('div', { class: 'card' }, plan.bring.map((i) => row(i, plan.wardrobe)))] : null,
    plan.store.length ? [h('div', { class: 'section-title' }, `收起来（${plan.store.length}）`), h('div', { class: 'card' }, plan.store.map((i) => row(i, storageFor(store.data, i))))] : null,
    plan.bring.length || plan.store.length
      ? h('div', { class: 'actions' }, h('button', { onclick: apply }, '按勾选整理'), h('a', { class: 'button secondary', href: '#/scan' }, '用扫码一件件整理'))
      : h('div', { class: 'card' }, h('p', {}, '当季衣柜里正好都是该穿的，不用整理。')),
    plan.unknown.length ? [h('div', { class: 'section-title' }, `没填季节的（${plan.unknown.length}，填了才能判断）`),
      h('div', { class: 'list' }, plan.unknown.slice(0, 20).map((i) => itemRow(i)))] : null);
}

// ---------- 问一问 ----------

// 聊天记录只放在内存里，关掉页面就没了
const chatState = { messages: [], busy: false };

const ACTIONS = {
  move: { text: (a) => `把「${store.item(a.id)?.name}」移到 ${store.locationPath(a.to)}`, ok: (a) => store.item(a.id) && store.location(a.to) },
  use_up: { text: (a) => `「${store.item(a.id)?.name}」标记为用完了`, ok: (a) => store.item(a.id)?.consumable },
  restock: { text: (a) => `「${store.item(a.id)?.name}」补货，数量 ${a.qty}${a.expiry ? `，保质期 ${a.expiry}` : ''}`, ok: (a) => store.item(a.id) && Number(a.qty) > 0 },
  archive: { text: (a) => `归档「${store.item(a.id)?.name}」（${a.reason}）`, ok: (a) => store.item(a.id) && ARCHIVE_REASONS.includes(a.reason) },
  return_book: { text: (a) => `《${store.item(a.id)?.name}》已归还`, ok: (a) => store.item(a.id)?.borrow },
  renew: { text: (a) => `《${store.item(a.id)?.name}》续借到 ${a.due}`, ok: (a) => store.item(a.id)?.borrow && /^\d{4}-\d{2}-\d{2}$/.test(a.due) },
  set_field: { text: (a) => `「${store.item(a.id)?.name}」的${a.field}改成 ${a.value}`, ok: (a) => store.item(a.id) && a.field && a.value != null },
  running_low: { text: (a) => `「${store.item(a.id)?.name}」快用完了，放进购物清单`, ok: (a) => store.item(a.id)?.consumable },
  shop: { text: (a) => `购物清单加上：${a.name}`, ok: (a) => typeof a.name === 'string' && a.name.trim() },
  wear: { text: (a) => `记下今天穿了：${(a.ids || []).map((id) => store.item(id)?.name).join('、')}`, ok: (a) => (a.ids || []).every((id) => store.item(id)) },
};

function applyAction(data, a) {
  const it = data.items.find((i) => i.id === a.id);
  const note = (text) => { it.notes = [it.notes, `${today()} ${text}`].filter(Boolean).join('\n'); };
  const now = new Date().toISOString();
  if (a.type === 'shop') { addToShopping(data, [a.name.trim()]); return; }
  switch (a.type) {
    case 'move': moveItem(data, it, a.to); break;
    case 'use_up': it.quantity = 0; delete it.runningLow; note('用完'); break;
    case 'running_low': it.runningLow = today(); break;
    case 'restock':
      delete it.runningLow;
      it.quantity = Number(a.qty);
      if (a.expiry) it.fields = { ...it.fields, 保质期: a.expiry };
      note(`补货 ×${a.qty}${a.expiry ? `，保质期 ${a.expiry}` : ''}`);
      break;
    case 'archive': it.archived = true; it.archiveReason = a.reason; it.archivedAt = today(); note(`归档：${a.reason}`); break;
    case 'return_book':
      note(`已归还${it.borrow.from}（${it.borrow.date} 借）`);
      it.archived = true; it.archiveReason = '已归还'; it.archivedAt = today();
      break;
    case 'renew': note(`续借，应还日期 ${it.borrow.due} → ${a.due}`); it.borrow = { ...it.borrow, due: a.due, renewals: (it.borrow.renewals || 0) + 1 }; break;
    case 'set_field': it.fields = { ...it.fields, [a.field]: String(a.value) }; break;
    case 'wear':
      for (const x of data.items) if (a.ids.includes(x.id)) markWorn(x, todayStr());
      return;
    default: return;
  }
  it.updatedAt = now;
}

async function askInventory(question) {
  const ai = readAi();
  const d = store.data;
  const system = [
    '你是用户宿舍物品档案的助手，用中文简洁地回答。下面是全部物品和位置，只根据这些回答；查不到就直说没有，不要编。',
    `今天是 ${todayStr()}。`,
    '回答里提到具体物品时，把它们的 id 放进 items（最多 8 个），界面会显示成卡片。',
    '用户要求修改档案时（比如移动位置、用完了、快用完了、补货、加到购物清单、归档、还书、续借、改字段、记录今天穿了什么），不要说已经改了，',
    '而是把要做的修改放进 actions，界面会让用户确认后再执行。只能用这些类型：',
    'move{id,to(位置id)}、use_up{id}、running_low{id}（档案里的消耗品快用完了）、shop{name}（档案里没有的东西加到购物清单）、restock{id,qty,expiry?}、archive{id,reason(扔掉/用完不再买/送人/卖掉/丢失/坏了/其他)}、',
    'return_book{id}、renew{id,due(YYYY-MM-DD)}、set_field{id,field,value}、wear{ids}。',
    '关于药品：只回答有没有、在哪、过没过期，不给用药建议（吃什么、吃多少），遇到这类问题提醒看说明书或问医生。',
    '只输出 JSON：{"answer":"","items":["id"],"actions":[{"type":"","id":""}]}',
    '',
    '位置（id | 路径）：',
    ...d.locations.map((l) => `${l.id} | ${store.locationPath(l.id)}`),
    '',
    '物品（id | 编号 | 名称 | 类别 | 位置 | 数量 | 字段 | 状态 | 品牌型号 | 购买日期 | 价格 | 描述和备注）：',
    ...d.items.map((i) => itemLine(d, i, { extra: true })),
  ].join('\n');
  const history = chatState.messages.slice(-8).filter((m) => !m.pending)
    .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.role === 'me' ? m.text : JSON.stringify({ answer: m.text }) }));
  const out = await askJson(ai, system, question, { history, maxTokens: 6000, timeout: 90000 });
  const valid = new Set(d.items.map((i) => i.id));
  return {
    text: String(out.answer || '（没有回答）'),
    items: (out.items || []).filter((id) => valid.has(id)).slice(0, 8),
    actions: (out.actions || []).filter((a) => ACTIONS[a.type]?.ok(a)),
  };
}

function chatView() {
  const box = h('div', { class: 'chat' });
  const input = h('textarea', { rows: 1, placeholder: '比如：我的充电宝在哪？' });
  const draw = () => {
    fill(box, chatState.messages.map((m, idx) => {
      if (m.role === 'me') return h('div', { class: 'msg me' }, m.text);
      if (m.pending) return h('div', { class: 'msg ai thinking' }, '正在翻你的档案……');
      return h('div', { class: 'msg ai' }, m.text,
        m.items?.length ? h('div', { class: 'list' }, m.items.map((id) => store.item(id)).filter(Boolean).map((it) => itemRow(it))) : null,
        m.actions?.length && !m.done ? h('div', { class: 'proposal' },
          h('b', {}, '要这样改吗？'),
          h('ul', {}, m.actions.map((a) => h('li', {}, ACTIONS[a.type].text(a)))),
          h('div', { class: 'row-btns' },
            h('button', { class: 'small', onclick: () => confirmActions(idx) }, '确认'),
            h('button', { class: 'small secondary', onclick: () => { m.done = '没有修改'; draw(); } }, '不用了'))) : null,
        m.done ? h('p', { class: 'muted small' }, m.done) : null);
    }));
    window.scrollTo(0, document.body.scrollHeight);
  };
  const confirmActions = async (idx) => {
    const m = chatState.messages[idx];
    try {
      await saving('正在修改…', () => store.save(`问一问：${m.actions.map((a) => ACTIONS[a.type].text(a)).join('；')}`.slice(0, 200), (data) => {
        for (const a of m.actions) applyAction(data, a);
      }));
      m.done = `✓ 已完成 ${m.actions.length} 项修改`;
    } catch { /* saving 已提示 */ }
    draw();
  };
  const send = async (text) => {
    const q = (text ?? input.value).trim();
    if (!q || chatState.busy) return;
    if (!readAi().key) return toast('还没有设置 DeepSeek（设置 → AI）', 'error');
    input.value = '';
    chatState.busy = true;
    chatState.messages.push({ role: 'me', text: q }, { role: 'ai', pending: true });
    draw();
    try {
      const r = await askInventory(q);
      chatState.messages.splice(-1, 1, { role: 'ai', ...r });
    } catch (e) {
      chatState.messages.splice(-1, 1, { role: 'ai', text: `出错了：${e.message}` });
    } finally {
      chatState.busy = false;
      if (currentPath() === '/ask') draw();
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  draw();
  const tips = ['我的充电宝在哪？', '有什么快过期的？', '我借了哪些书，什么时候还？', '冬天的外套有几件？'];
  return h('div', {},
    header('问一问', chatState.messages.length ? h('button', { class: 'link', onclick: () => { chatState.messages = []; render(); } }, '清空') : null),
    chatState.messages.length ? null : [
      h('p', { class: 'muted small' }, '问你的物品在哪、有多少、过没过期，也可以让它帮你改（会先问你确认）。聊天记录关掉页面就清空。'),
      h('div', { class: 'suggestions' }, tips.map((t) => h('button', { type: 'button', class: 'chip', onclick: () => send(t) }, t)))],
    box,
    h('div', { class: 'chat-input' }, input, h('button', { 'aria-label': '发送', onclick: () => send() }, icon('send'))));
}

// ---------- 衣橱 ----------

const isClothes = (item) => ['衣服', '运动服', '鞋'].includes(item.tags[0]);

function wardrobeView() {
  const clothes = store.data.items.filter((i) => isClothes(i) && !i.archived);
  const shoes = clothes.filter((i) => i.tags[0] === '鞋').length;
  const week = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const wornDays = new Set(clothes.flatMap((i) => (i.worn || []).filter((d) => d >= week))).size;
  const next = nextSeasonTerm();
  return h('div', {},
    header('衣橱'),
    h('div', { class: 'tiles2' },
      h('a', { class: 'mini', href: '#/items?tag=衣服' }, icon('wardrobe'), h('div', { class: 'stat-num' }, clothes.length - shoes),
        h('div', { class: 'stat-label' }, `件衣服 · ${shoes} 双鞋`)),
      h('a', { class: 'mini', href: '#/wear' }, icon('calendar'), h('div', { class: 'stat-num' }, wornDays),
        h('div', { class: 'stat-label' }, '最近 7 天记录了穿搭'))),
    h('div', { class: 'section-title' }, '穿搭'),
    h('div', { class: 'group' },
      cell({ href: '#/outfit', ic: 'today', title: '今天穿什么' }),
      cell({ href: '#/wear', ic: 'calendar', color: '#9a8c7a', title: '穿着记录' }),
      cell({ href: '#/laundry', ic: 'wardrobe', color: 'var(--sage)', title: '洗衣篮',
        meta: (() => { const ls = laundryStatus(store.data); return ls.dirty.length || ls.washing.length ? `待洗 ${ls.dirty.length} · 在洗 ${ls.washing.length}` : ''; })(),
        count: laundryStatus(store.data).due ? '!' : null })),
    h('div', { class: 'section-title' }, '出门和换季'),
    h('div', { class: 'group' },
      cell({ href: '#/trips', ic: 'suitcase', color: '#5f7fa8', title: '出行',
        count: store.data.trips.filter((t) => t.status === 'packed').length || null }),
      cell({ href: '#/season', ic: 'season', color: 'var(--amber)', title: '换季整理', meta: next ? `下次：${next.name} ${next.date.slice(5).replace('-', '/')}` : '' })));
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
  const setState = async (state, done, message) => {
    const ids = new Set(chosen().map((p) => p.obj.id));
    if (!ids.size) return toast('没有选中的标签', 'error');
    await saveUndoable(message(ids.size), (data) => {
      for (const x of [...data.items, ...data.locations]) if (ids.has(x.id)) setLabel(x, state);
    }, done(ids.size)).catch(() => {});
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
          h('button', { class: 'secondary', onclick: () => setState('printed', (n) => `${n} 张标记为已打印`, (n) => `标记已打印：${n} 张标签`) }, '标记为已打印'))
        : h('div', { class: 'actions' },
          h('button', { class: 'secondary', onclick: () => setState('pending', (n) => `${n} 张放回待打印，编号不变`, (n) => `重新打印：${n} 张标签`) }, '重新打印选中的')))
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

// ---------- 购物清单 ----------

// 在超市勾掉的只存在这台手机上（一勾一提交太慢），点「买回来了」才写进仓库
const SHOP_CHECKED = 'inventory-shop-checked';
const shopChecked = new Set((() => { try { return JSON.parse(localStorage.getItem(SHOP_CHECKED)) || []; } catch { return []; } })());
const persistChecked = () => { try { localStorage.setItem(SHOP_CHECKED, JSON.stringify([...shopChecked])); } catch { /* 存不了就只在这次打开里有效 */ } };
const shopState = { generating: null, error: '' };

// 手动加：名字和档案里还在用的消耗品一样，就当作那件「快用完了」，买回来能直接补数量
function addToShopping(data, names) {
  const sh = shoppingData(data);
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const name of names) {
    const it = data.items.find((i) => !i.archived && i.consumable && same(i.name, name));
    if (it) { if (Number(it.quantity) > 0) it.runningLow = today(); delete sh.skip[`i:${it.id}`]; continue; }
    if (sh.extra.some((e) => same(e.name, name))) continue;
    sh.extra.push({ id: newId('s'), name, addedAt: today() });
  }
}

const SHOP_HELP = [
  ['清单里的东西从哪来', [
    '用完了的消耗品：物品页点「用完了」。',
    '快用完的：洗发水这种一瓶一支数不了的，快见底时在物品页点「快用完了」；抽纸、电池这种能数的，编辑物品时填「剩几件时进购物清单」，用到那个数自动进来。',
    '快过期的：保质期 14 天内到期的，提醒你买新的换掉。',
    '自己加的：在上面的框里打字，点「加入」。一次加几样用逗号或顿号隔开，比如「鸡蛋、5 号电池」。',
    'AI 建议：每周看一次天气和你的档案，觉得该买的列在下面，点「加入」才进清单。',
  ]],
  ['预算', [
    '顶上的「大概 ¥85」是按每样上次买的价格估的（买回来时填过价格、或者小票导入过的才有），没买过的不算。',
    '点「设预算」填每周去超市打算花多少，超了会提醒你看看有没有这周可以不买的。',
    '下面那行是账本里这个月吃饭、日常还剩多少，心里有个数。',
  ]],
  ['在超市', [
    '买到一样就点一下那一行，打上勾；点错了再点一下取消。',
    '某样这周不想买：点右边的「⋯」→「这周不买」，下周还会出现。',
  ]],
  ['回到宿舍', [
    '点最下面的「买回来了」。档案里有的东西填一下现在有多少（快过期的顺便填新保质期），价格想填就填。',
    '档案里没有的新东西可以打开「建档」，保存后会列在清单下面的「还没建档」，点进去补照片和位置；鸡蛋这种吃完就没的，不用建档。',
  ]],
  ['提醒', [
    '每周日早上 9 点，清单不是空的就推送到手机。也可以在问一问里说「洗衣液快用完了」「购物清单加上牙线」。',
  ]],
];

// 页面右上角的「?」：怎么用。sections = [[小标题, [一句一句]]]
function helpButton(title, sections) {
  return h('button', { class: 'icon-btn help-btn', 'aria-label': '怎么用', onclick: () => openSheet({
    title,
    body: h('div', { class: 'help' }, sections.map(([t, lines]) => [h('h4', {}, t), h('ul', {}, lines.map((l) => h('li', {}, l)))])),
    confirmText: '知道了', cancelText: null, onConfirm: () => {},
  }) }, '?');
}

// 底部弹出的一列按钮
function actionSheet(title, actions) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet' }, h('h3', {}, title),
      h('div', { class: 'group' }, actions.filter(Boolean).map(([text, fn, danger]) =>
        h('button', { class: `cell${danger ? ' danger-text' : ''}`, type: 'button', onclick: () => { close(); fn(); } }, h('span', { class: 'grow' }, text)))),
      h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: close }, '取消'))));
  document.body.append(overlay);
}

async function generateShopAi() {
  const d = store.data;
  const ai = readAi();
  const w = await getWeather().catch(() => null);
  const history = (d.shopping?.history || []).filter((x) => x.date >= localDay(-90)).map((x) => `${x.date} ${x.name}`);
  const system = [
    '你是一个男大学生的宿舍生活助手。他每周日去超市买一次生活必需品。',
    '根据季节、天气、他的物品档案和最近的购物记录，提醒这周可能需要买、但还不在清单上的生活必需品。',
    '规则：最多 5 条；已经在清单上的不要；档案里有、数量够、没用完的不要；宿舍没有厨房和电器，不建议做饭用品；',
    '药品只说「备一点」，不给用药建议；没有特别需要就少说，可以一条都没有。',
    'name 写要买的东西（简短，比如「护手霜」），reason 一句话说为什么（20 字以内）。',
    '只输出 JSON：{"suggestions":[{"name":"","reason":""}]}',
  ].join('\n');
  const user = [
    `今天 ${todayStr()} ${WEEKDAY[new Date().getDay()]}，节气：${currentTerm().name}之后。`,
    w ? `天气：${weatherLine(w)}` : '',
    `清单上已有：${shoppingList(d).map((e) => e.name).join('、') || '（空）'}`,
    `最近 90 天买过：${history.join('；') || '（没有记录）'}`,
    '档案里的消耗品（id | 编号 | 名称 | 类别 | 位置 | 数量 | 字段 | 状态）：',
    ...d.items.filter((i) => i.consumable && !i.archived).map((i) => itemLine(d, i)),
    `其他类别：${[...new Set(d.items.filter((i) => !i.archived && !i.consumable).map((i) => i.tags[0]).filter(Boolean))].join('、')}`,
  ].filter(Boolean).join('\n');
  const out = await askJson(ai, system, user, { maxTokens: 6000, timeout: 90000 });
  const list = (Array.isArray(out.suggestions) ? out.suggestions : [])
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .slice(0, 5).map((x) => ({ name: x.name.trim().slice(0, 30), reason: String(x.reason || '').slice(0, 60) }));
  await store.save(`购物清单 AI 建议（${shopWeek()}）`, (data) => { shoppingData(data).ai = { week: shopWeek(), list }; });
}

function shopAiCard() {
  if (!readAi().key) return null;
  const s = store.data.shopping || {};
  const fresh = s.ai?.week === shopWeek();
  if (!fresh && !shopState.generating && !shopState.error) {
    shopState.generating = generateShopAi()
      .catch((e) => { shopState.error = e.message; })
      .finally(() => { shopState.generating = null; if (/^\/shopping/.test(currentPath())) render(); });
  }
  const retry = () => { shopState.error = ''; render(); };
  const list = fresh ? s.ai.list : [];
  const save = (message, fn) => saving('正在保存…', () => store.save(message, (data) => fn(shoppingData(data), data))).then(render).catch(() => {});
  const drop = (sh, name) => { if (sh.ai) sh.ai.list = sh.ai.list.filter((x) => x.name !== name); };
  return h('div', { class: 'card shop-ai' },
    h('h3', {}, icon('sparkle'), ' AI 建议'),
    shopState.generating ? h('p', { class: 'muted small' }, '正在看天气和你的档案……')
      : shopState.error ? h('p', { class: 'muted small' }, shopState.error, ' ', h('button', { class: 'link', onclick: retry }, '重试'))
        : !list.length ? h('p', { class: 'muted small' }, '这周没有别的要补充。')
          : list.map((x) => h('div', { class: 'check-item' },
            h('span', { class: 'grow' }, x.name, h('span', { class: 'muted small block' }, x.reason)),
            h('button', { class: 'small', onclick: () => save(`购物清单加上：${x.name}（AI 建议）`, (sh, data) => { addToShopping(data, [x.name]); drop(sh, x.name); }) }, '加入'),
            h('button', { class: 'small secondary', onclick: () => save(`不采用 AI 建议：${x.name}`, (sh) => drop(sh, x.name)) }, '不用'))));
}

// 买回来了：档案里有的补数量（快过期的换新保质期），手动加的可以顺手建档；价格选填，记进购物记录
function openBought(entries) {
  const rows = entries.map((e) => {
    const it = e.item;
    const hasExpiry = it && (it.fields?.['保质期'] !== undefined || it.tags.some((t) => (store.data.fieldPresets?.[t] || []).includes('保质期')));
    const startQty = !it ? null : e.expiring || isDepleted(it) ? 1 : (Number(it.quantity) || 0) + 1;
    const r = {
      e,
      qty: it ? h('input', { type: 'number', min: 1, inputmode: 'numeric', value: startQty, 'aria-label': `${e.name} 现在有` }) : null,
      expiry: hasExpiry ? h('input', { class: 'span2', placeholder: '新保质期（选填），如 2027-05', 'aria-label': `${e.name} 新保质期` }) : null,
      price: h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: '价格（选填）', 'aria-label': `${e.name} 价格` }),
      file: !it ? h('input', { type: 'checkbox', 'aria-label': `${e.name} 建档` }) : null,
    };
    r.el = h('div', { class: 'bought-row' },
      h('div', { class: 'bought-name' }, e.name, h('span', { class: 'muted small' }, ` ${e.why}`)),
      h('div', { class: 'bought-inputs' },
        r.qty ? h('label', {}, '现在有', r.qty) : null,
        r.price, r.expiry,
        r.file ? h('label', { class: 'switch-row small' }, r.file, '建档') : null));
    return r;
  });
  openSheet({
    title: `买回来了（${entries.length} 样）`,
    body: h('div', { class: 'form' }, rows.map((r) => r.el),
      h('p', { class: 'muted small' }, '「现在有」是买回来后一共有几个（快过期的旧的扔掉不算）。没勾的东西留在清单上。')),
    confirmText: '记好了',
    onConfirm: async () => {
      for (const r of rows) {
        if (r.qty && !(Number(r.qty.value) >= 1)) { toast(`${r.e.name}：数量至少是 1`, 'error'); return false; }
      }
      const date = today();
      await saving('正在保存…', () => store.save(`买回来了：${entries.map((e) => e.name).join('、')}`, (data) => {
        const sh = shoppingData(data);
        for (const r of rows) {
          const price = r.price.value === '' ? null : Number(r.price.value);
          const rec = { date, name: r.e.name };
          if (price != null && Number.isFinite(price)) rec.price = price;
          if (r.e.item) {
            const it = data.items.find((i) => i.id === r.e.item.id);
            if (!it) continue;
            const n = Number(r.qty.value);
            const exp = r.expiry?.value.trim();
            it.quantity = n;
            delete it.runningLow;
            if (exp) it.fields = { ...it.fields, 保质期: exp };
            it.purchaseDate = date;
            it.updatedAt = new Date().toISOString();
            it.notes = [it.notes, `${date} 买回来，现在 ×${n}${exp ? `，保质期 ${exp}` : ''}${rec.price != null ? `，¥${rec.price}` : ''}`].filter(Boolean).join('\n');
            rec.itemId = it.id;
          } else {
            sh.extra = sh.extra.filter((x) => x.id !== r.e.extra.id);
            if (r.file.checked) sh.toFile.push({ id: r.e.extra.id, name: r.e.name, price: rec.price ?? null, date });
          }
          delete sh.skip[r.e.key];
          sh.history.push(rec);
        }
      }));
      for (const e of entries) shopChecked.delete(e.key);
      persistChecked();
      toast(`记好了 ${entries.length} 样`);
      render();
      offerLedger(rows.map((r) => ({ name: r.e.name, price: Number(r.price.value), tag: r.e.item?.tags[0] })), { date });
    },
  });
}

// 账本里这个月吃饭、日常还剩多少（购物清单页顶上用）；一次打开读一次
const shopLedger = { at: 0, left: null, loading: false };
function loadShopLedger() {
  if (shopLedger.loading || Date.now() - shopLedger.at < 60000) return;
  shopLedger.loading = true;
  readLedger(ledgerGitHub(settings)).then((l) => { shopLedger.left = l?.left || null; })
    .catch(() => {}).finally(() => { shopLedger.loading = false; shopLedger.at = Date.now(); if (/^\/shopping/.test(currentPath())) render(); });
}

// 这次大概花多少、预算够不够
function shopBudgetCard(list, checked) {
  loadShopLedger();
  const sum = (arr) => arr.reduce((a, e) => a + (shopEstimate(store.data, e) || 0), 0);
  const unknown = list.filter((e) => !shopEstimate(store.data, e)).length;
  const total = Math.round(sum(list));
  const done = Math.round(sum(checked));
  const budget = Number(store.data.prefs?.shopBudget) || 0;
  const setBudget = () => {
    const v = prompt('每周去超市的预算（元），不想设就留空：', budget || '');
    if (v === null) return;
    const n = Math.round(Number(v));
    saving('正在保存…', () => store.save(`每周购物预算：${n || '不设'}`, (data) => {
      data.prefs ||= {};
      if (n > 0) data.prefs.shopBudget = n; else delete data.prefs.shopBudget;
    })).then(render).catch(() => {});
  };
  const left = shopLedger.left;
  const over = budget && total > budget;
  return h('div', { class: 'card shop-budget' },
    h('div', { class: 'shop-budget-main' },
      h('div', { class: 'grow' },
        h('div', { class: 'shop-budget-num' }, list.length ? `大概 ¥${total}` : '¥0'),
        h('div', { class: 'muted small' }, list.length ? `按上次买的价格估${unknown ? `，${unknown} 样没价格` : ''}` : '清单是空的')),
      h('button', { class: 'link small', onclick: setBudget }, budget ? `预算 ¥${budget}` : '设预算')),
    budget && list.length ? h('div', { class: 'bar-track' }, h('span', { class: `bar${over ? ' over' : ''}`, style: `width:${Math.min(100, (total / budget) * 100)}%` })) : null,
    budget && list.length ? h('p', { class: `small ${over ? 'warn-text' : 'muted'}` }, over ? `比预算多 ¥${total - budget}，看看有没有这周可以不买的` : `预算内，还能剩 ¥${budget - total}`) : null,
    checked.length ? h('p', { class: 'small' }, `已经拿了 ${checked.length} 样，大概 ¥${done}`) : null,
    left ? h('p', { class: 'muted small' }, `账本：这个月日常还剩 ¥${left.daily}、吃饭还剩 ¥${left.food}（到 ${left.end.slice(5)}）`) : null);
}

function shoppingView() {
  const list = shoppingList(store.data);
  const s = store.data.shopping || {};
  const keys = new Set(list.map((e) => e.key));
  for (const k of [...shopChecked]) if (!keys.has(k)) shopChecked.delete(k); // 已经不在清单上的勾去掉
  persistChecked();
  const checked = list.filter((e) => shopChecked.has(e.key));
  const save = (message, fn) => saving('正在保存…', () => store.save(message, (data) => fn(shoppingData(data), data))).then(render).catch(() => {});

  const input = h('input', { placeholder: '想买什么？如 鸡蛋、5 号电池', 'aria-label': '加到购物清单', enterkeyhint: 'done',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } } });
  const add = () => {
    const names = input.value.split(/[，,、\n]/).map((t) => t.trim()).filter(Boolean);
    if (!names.length) return toast('先写要买什么', 'error');
    save(`购物清单加上：${names.join('、')}`, (sh, data) => addToShopping(data, names));
  };
  const toggle = (e) => {
    if (shopChecked.has(e.key)) shopChecked.delete(e.key); else shopChecked.add(e.key);
    persistChecked();
    render();
  };
  const more = (e) => actionSheet(e.name, [
    e.item ? ['看看这件', () => go(`#/item/${e.item.id}`)] : null,
    e.item?.runningLow && Number(e.item.quantity) > 0 ? ['还够用，不用买', () => save(`还够用：${e.name}`, (sh, data) => { delete data.items.find((i) => i.id === e.item.id).runningLow; })] : null,
    ['这周不买（下周再提醒）', () => save(`这周不买：${e.name}`, (sh) => { sh.skip[e.key] = localDay(7); })],
    e.extra ? ['从清单删掉', () => save(`购物清单删掉：${e.name}`, (sh) => { sh.extra = sh.extra.filter((x) => x.id !== e.extra.id); }), true] : null,
  ]);
  const row = (e) => {
    const on = shopChecked.has(e.key);
    return h('div', { class: `shop-row${on ? ' done' : ''}`, role: 'checkbox', 'aria-checked': String(on), tabindex: 0,
      onclick: () => toggle(e), onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggle(e); } } },
    h('span', { class: 'shop-tick' }, on ? '✓' : ''),
    h('span', { class: 'grow' }, e.name, h('span', { class: `small block ${e.expiring || e.why === '已用完' ? 'warn-text' : 'muted'}` }, e.why,
      shopEstimate(store.data, e) ? h('span', { class: 'muted' }, ` · 约 ¥${shopEstimate(store.data, e)}`) : null)),
    h('button', { class: 'link more-btn', 'aria-label': `${e.name} 更多`, onclick: (ev) => { ev.stopPropagation(); more(e); } }, '⋯'));
  };
  const toFile = s.toFile || [];
  const month = localDay().slice(0, 7);
  const spent = (s.history || []).filter((x) => x.date.startsWith(month) && x.price != null).reduce((a, x) => a + x.price, 0);

  return h('div', {},
    headerSub('购物清单', list.length ? `这周要买 ${list.length} 样${checked.length ? `，已买 ${checked.length}` : ''}` : '目前没有要买的',
      helpButton('购物清单怎么用', SHOP_HELP)),
    h('form', { class: 'add-row', onsubmit: (e) => { e.preventDefault(); add(); } }, input, h('button', { class: 'small' }, '加入')),
    shopBudgetCard(list, checked),
    list.length ? h('div', { class: 'card shop-list' }, [...list.filter((e) => !shopChecked.has(e.key)), ...checked].map(row))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '没有用完、快用完或快过期的东西。想买什么直接在上面加。')),
    checked.length ? h('div', { class: 'actions sticky' }, h('button', { onclick: () => openBought(checked) }, `买回来了（${checked.length} 样）`)) : null,
    toFile.length ? [h('div', { class: 'section-title' }, '买回来还没建档'), h('div', { class: 'card' }, toFile.map((e) => h('div', { class: 'check-item' },
      h('span', { class: 'grow' }, e.name, h('span', { class: 'muted small block' }, `${e.date.slice(5)} 买的${e.from === 'receipt' ? '（小票导入）' : ''}`)),
      h('a', { class: 'button small', href: `#/new?${new URLSearchParams({ name: e.name, shop: e.id, ...(e.price != null ? { price: e.price } : {}), ...(e.qty > 1 ? { qty: e.qty } : {}), date: e.date, ...(e.paid ? { paid: 1 } : {}) })}` }, '建档'),
      h('button', { class: 'small secondary', onclick: () => save(`不建档：${e.name}`, (sh) => { sh.toFile = sh.toFile.filter((x) => x.id !== e.id); }) }, '不用了'))))] : null,
    shopAiCard(),
    h('p', { class: 'muted small center' }, '每周日早上 9 点推送清单到手机',
      spent ? [' · ', h('a', { href: '#/stats' }, `这个月买东西花了 ¥${Math.round(spent)}`)] : null));
}

// ---------- 顺手记账（写进账本） ----------
// 买回来的东西有价格时，问一下要不要同时记到账本：同一个类别合成一笔，类别按名字猜、可以改。
// 账本没开通或令牌没授权 finance-data 时什么都不问。
async function offerLedger(lines, { date = today(), prefix = '' } = {}) {
  lines = lines.filter((l) => l.price > 0);
  if (!lines.length) return;
  const lgh = ledgerGitHub(settings);
  let ledger = null;
  try { ledger = await readLedger(lgh); } catch { /* 读不到账本就不问 */ }
  if (!ledger?.accounts.length || !ledger.categories.length) return;
  const rows = lines.map((l) => ({ ...l, category: guessCategory(ledger, l.name, l.tag) }));
  let account = ledger.account;
  const catName = (id) => ledger.categories.find((c) => c.id === id)?.name || '';
  const preview = h('p', { class: 'muted small' });
  const drawPreview = () => {
    const groups = groupLines(rows);
    preview.textContent = `会记 ${groups.length} 笔：${groups.map((g) => `${catName(g.category)} ¥${g.amount}`).join('，')}`;
  };
  const body = h('div', { class: 'form' },
    rows.map((r) => h('div', { class: 'ledger-line' },
      h('span', { class: 'grow' }, r.name, h('span', { class: 'muted small' }, ` ¥${r.price}`)),
      h('select', { 'aria-label': `${r.name} 记成`, value: r.category, onchange: (e) => { r.category = e.target.value; drawPreview(); } },
        ledger.categories.map((c) => h('option', { value: c.id }, c.name))))),
    h('label', {}, '从哪个账户付', h('select', { 'aria-label': '从哪个账户付', value: account, onchange: (e) => { account = e.target.value; } },
      ledger.accounts.map((a) => h('option', { value: a.id }, a.name)))),
    preview,
    h('p', { class: 'muted small' }, '同一个类别的合成一笔，物品名写在备注里。记错了去账本的流水里改。'));
  drawPreview();
  openSheet({
    title: '顺手记一笔账？', body, confirmText: '记到账本', cancelText: '不用了',
    onConfirm: async () => {
      const groups = groupLines(rows);
      try {
        await saving('正在记账…', () => addLedgerExpenses(lgh, { date, account, groups, prefix }));
      } catch { return false; }
      toast(`已记到账本：${groups.map((g) => `${catName(g.category)} ¥${g.amount}`).join('，')}`);
      return true;
    },
  });
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
      h('span', { class: 'bar-num' }, r.text ?? r.count, r.value ? h('small', {}, ` ${money(r.value)}`) : null))));
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
  // 购物花费：最近 8 周，按周日开始算一周（只算买回来时填了价格的）
  const bought = (store.data.shopping?.history || []).filter((x) => x.price != null);
  const weeks = Array.from({ length: 8 }, (_, n) => shopWeek(new Date(Date.now() - n * 7 * 86400000)));
  const byWeek = weeks.map((w, n) => {
    const end = n ? weeks[n - 1] : '9999';
    const sum = bought.filter((x) => x.date >= w && x.date < end).reduce((a, x) => a + x.price, 0);
    return { label: n ? `${w.slice(5)} 周` : '这周', count: sum, text: money(sum), href: '#/shopping' };
  });
  const month = localDay().slice(0, 7);
  const monthSum = bought.filter((x) => x.date.startsWith(month)).reduce((a, x) => a + x.price, 0);
  const perMonth = monthlyConsumables(store.data);
  // 衣服穿一次多少钱：穿得多的最值，买了很少穿的「还没回本」
  const wears = items.map((i) => ({ i, c: costPerWear(i) })).filter((x) => x.c);
  const worn = wears.filter((x) => x.c.wears >= 3).sort((a, b) => a.c.each - b.c.each);
  const idle = wears.filter((x) => x.c.wears < 3).sort((a, b) => b.c.price - a.c.price);
  const totalWears = wears.reduce((a, x) => a + x.c.wears, 0);
  const wearRow = ({ i, c }) => h('a', { class: 'cpw-row', href: `#/item/${i.id}` },
    h('span', { class: 'grow' }, i.name, h('span', { class: 'muted small block' }, `¥${c.price} · 穿了 ${c.wears} 次`)),
    h('b', {}, c.wears ? `¥${c.each}/次` : '还没穿'));

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
    bought.length ? h('div', { class: 'card' }, h('h3', {}, `购物花费 · 这个月 ${money(monthSum)}`), bars(byWeek),
      h('p', { class: 'muted small' }, '只算「买回来了」时填了价格的')) : null,
    perMonth.length ? h('div', { class: 'card' }, h('h3', {}, `消耗品每月大约 ${money(perMonth.reduce((a, x) => a + x.perMonth, 0))}`),
      bars(perMonth.map((x) => ({ label: x.tag, count: x.perMonth, text: money(x.perMonth), href: '#/shopping' }))),
      h('p', { class: 'muted small' }, '最近 90 天买回来时记了价格的，平均到每个月')) : null,
    wears.length ? h('div', { class: 'card' }, h('h3', {}, '衣服穿一次多少钱'),
      totalWears ? h('p', { class: 'small' }, `记了价格的 ${wears.length} 件一共 ${money(wears.reduce((a, x) => a + x.c.price, 0))}，穿了 ${totalWears} 次，平均每次 ${money(wears.reduce((a, x) => a + x.c.price, 0) / totalWears)}。`) : null,
      worn.length ? [h('div', { class: 'label-sm' }, '最值（穿得多）'), worn.slice(0, 5).map(wearRow)] : null,
      idle.length ? [h('div', { class: 'label-sm' }, '还没回本（穿得少，贵的在前）'), idle.slice(0, 5).map(wearRow)] : null,
      h('p', { class: 'muted small' }, '价格 ÷ 穿过的次数，从开始记「今天穿什么」算起。下次买衣服前看看哪种穿得多。')) : null,
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

// ---------- 导出 ----------

function exportExcel() {
  const rows = store.data.items.map((i) => [
    i.assetId || '', i.name, i.tags.join('、'), store.locationPath(i.location), i.quantity, i.consumable ? '是' : '',
    LABEL_TEXT[i.label] || '', i.manufacturer || '', i.modelNumber || '', i.serialNumber || '', i.purchaseDate || '',
    i.purchasePrice ?? '', i.purchaseFrom || '', i.warrantyExpires || '',
    Object.entries(i.fields || {}).map(([k, v]) => `${k}：${v}`).join('；'), i.description || '', i.notes || '',
    i.borrow ? `${i.borrow.from} ${i.borrow.date}～${i.borrow.due}` : '', i.archived ? `${i.archiveReason || '已归档'} ${i.archivedAt || ''}` : '',
  ]);
  const head = ['编号', '名称', '类别', '位置', '数量', '消耗品', '标签状态', '品牌', '型号', '序列号', '购买日期', '价格', '购买地点',
    '保修到期', '其他信息', '描述', '备注', '借阅', '归档'];
  const blob = makeXlsx([head, ...rows.map((r) => r.map((v) => String(v)))], '物品');
  const a = h('a', { href: URL.createObjectURL(blob), download: `物品档案_${today()}.xlsx` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- 借阅 ----------

function addDays(date, n) {
  const d = new Date(date || Date.now());
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// 借一本书：建一条「书籍资料」类别的物品，带上借阅信息；不贴标签
function openBorrowSheet() {
  const lastFrom = store.data.items.filter((i) => i.borrow).map((i) => i.borrow.from).pop() || '学校图书馆';
  const name = h('input', { placeholder: '书名' });
  const from = h('input', { value: lastFrom });
  const date = h('input', { type: 'date', value: today() });
  const due = h('input', { type: 'date', value: addDays(today(), 30) });
  date.addEventListener('change', () => { due.value = addDays(date.value, 30); });
  const desk = store.data.locations.find((l) => l.name.startsWith('书桌'));
  const loc = locationSelect(desk?.id || '');
  openSheet({
    title: '借一本书',
    body: h('div', { class: 'form' }, h('label', {}, '书名', name), h('label', {}, '从哪借的', from),
      h('label', {}, '借阅日期', date), h('label', {}, '应还日期', due), h('label', {}, '放在哪', loc)),
    confirmText: '记下',
    onConfirm: async () => {
      if (!name.value.trim()) { toast('请填写书名', 'error'); return false; }
      if (!loc.value) { toast('请选择放在哪', 'error'); return false; }
      const id = newId('i');
      const now = new Date().toISOString();
      await saving('正在保存…', () => store.save(`借阅：${name.value.trim()}`, (data) => {
        const tags = data.tags.includes('书籍资料') ? ['书籍资料'] : [];
        data.items.push({
          id, name: name.value.trim(), assetId: nextAssetInPrefix(data, prefixForTags(data, tags)), location: loc.value, tags,
          quantity: 1, description: '', fields: {}, photos: [], receipts: [], notes: `${today()} 借自${from.value.trim()}`,
          archived: false, label: 'none', consumable: false, createdAt: now, updatedAt: now,
          borrow: { from: from.value.trim() || '图书馆', date: date.value, due: due.value, renewals: 0 },
        });
      })).catch(() => {});
      render();
    },
  });
}

function borrowView() {
  const now = store.data.items.filter((i) => i.borrow && !i.archived).sort((a, b) => a.borrow.due.localeCompare(b.borrow.due));
  const past = store.data.items.filter((i) => i.borrow && i.archived)
    .sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || '')).slice(0, 20);
  return h('div', {},
    header('借阅', h('button', { class: 'small', onclick: openBorrowSheet }, '借一本书')),
    h('p', { class: 'muted small' }, `还书前 3 天开始在首页和每周邮件里提醒。还了之后在书的页面点「已归还」，记录会保留在下面。`),
    now.length ? h('div', { class: 'list' }, now.map((i) => {
      const st = borrowStatus(i);
      return itemRow(i, h('span', { class: st.overdue ? 'warn' : st.soon ? 'soon' : '' },
        st.overdue ? `逾期 ${-st.left} 天` : `${i.borrow.due.slice(5)} 前还 · 剩 ${st.left} 天`));
    })) : h('div', { class: 'card' }, h('p', {}, '现在没有在借的书。')),
    past.length ? [h('div', { class: 'section-title' }, '已归还'), h('div', { class: 'list' }, past.map((i) => itemRow(i)))] : null);
}

// ---------- 扫码核对：出发、回程、拆箱、建模板、登记收纳袋共用 ----------

// 核对进度存在这台设备上（扫一件就存一次），中途离开再回来不会丢；完成后清掉
const progressKey = (key) => `inventory-check-${key}`;
function loadProgress(key) {
  try { return JSON.parse(localStorage.getItem(progressKey(key))) || { done: [], added: [] }; } catch { return { done: [], added: [] }; }
}
function saveProgress(key, p) {
  try { localStorage.setItem(progressKey(key), JSON.stringify(p)); } catch { /* 存不下就只放在内存里 */ }
}
function clearProgress(key) {
  try { localStorage.removeItem(progressKey(key)); } catch { /* 忽略 */ }
}

// cfg: { key, title, sub, expected: [物品id], collect（扫到就加，不问）, doneText, finishText, onFinish(done: Set, added: [id]) }
function checkView(cfg) {
  const prog = loadProgress(cfg.key);
  const added = [...new Set(prog.added)].filter((id) => store.item(id) && !cfg.expected.includes(id));
  const expected = () => [...cfg.expected, ...added].filter((id) => store.item(id));
  const done = new Set(prog.done.filter((id) => expected().includes(id)));
  const persist = () => saveProgress(cfg.key, { done: [...done], added });

  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const status = h('p', { class: 'muted small center' }, '正在打开摄像头…');
  const progress = h('div', { class: 'check-progress' });
  const lists = h('div', {});
  const flash = h('div', { class: 'scan-flash', hidden: true });

  const mark = (ids, label) => {
    const fresh = ids.filter((id) => !done.has(id));
    for (const id of fresh) done.add(id);
    persist();
    draw();
    flash.textContent = `✓ ${label}`;
    flash.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { flash.hidden = true; }, 1200);
    if (navigator.vibrate) navigator.vibrate(fresh.length ? 60 : [30, 40, 30]);
  };
  const addItem = (id) => {
    if (!added.includes(id) && !cfg.expected.includes(id)) added.push(id);
    mark([id], store.item(id).name);
  };
  const onCode = (text) => {
    const raw = assetFromScan(text);
    let asset;
    try { asset = raw && normalizeAssetId(raw); } catch { asset = null; }
    const hit = asset && store.findByAsset(asset);
    if (!hit) return toast(asset ? `编号 ${asset} 还没有建档` : '这不是物品标签的二维码', 'error');
    if (hit.type === 'location') {
      if (hit.obj.box !== 'bag') return toast(`这是「${hit.obj.name.split(' ')[0]}」的标签，不是物品`, 'error');
      // 扫收纳袋 = 扫里面登记的全部东西
      const inside = store.itemsIn(hit.obj.id).map((i) => i.id);
      const inList = inside.filter((id) => expected().includes(id));
      const outside = inside.filter((id) => !expected().includes(id));
      if (cfg.collect) { for (const id of outside) if (!added.includes(id)) added.push(id); }
      mark(cfg.collect ? inside : inList, `${hit.obj.name}：${cfg.collect ? inside.length : inList.length} 件`);
      if (!cfg.collect && outside.length) toast(`袋子里还有 ${outside.length} 件不在清单上`);
      return;
    }
    const id = hit.obj.id;
    if (expected().includes(id)) return mark([id], hit.obj.name);
    if (cfg.collect) return addItem(id);
    openSheet({
      title: `「${hit.obj.name}」不在清单上`,
      body: h('p', {}, '要加进清单吗？'),
      confirmText: '加进清单',
      onConfirm: () => { addItem(id); },
    });
  };

  const draw = () => {
    const all = expected();
    const left = all.filter((id) => !done.has(id));
    fill(progress,
      h('div', { class: 'check-count' }, h('b', {}, done.size), ` / ${all.length}`, h('span', { class: 'muted small' }, ` ${cfg.doneText || '已确认'}`)),
      h('div', { class: 'bar-track' }, h('span', { class: 'bar', style: `width:${all.length ? (done.size / all.length) * 100 : 0}%` })));
    const row = (id, isDone) => {
      const it = store.item(id);
      return h('div', { class: 'check-item' },
        h('span', { class: 'grow' }, it.name, h('span', { class: 'muted small block' },
          [it.assetId && it.label !== 'none' ? '扫码' : '没标签，手动点', store.shortName(it.location)].join(' · '))),
        isDone
          ? h('button', { class: 'link', onclick: () => { done.delete(id); persist(); draw(); } }, '撤销')
          : h('button', { class: 'small secondary', onclick: () => mark([id], it.name) }, '✓'));
    };
    fill(lists,
      left.length ? [h('div', { class: 'section-title' }, `还差（${left.length}）`), h('div', { class: 'card' }, left.map((id) => row(id, false)))]
        : cfg.collect ? h('p', { class: 'muted small' }, all.length ? `已有 ${all.length} 件，继续扫可以再加。` : '还是空的，扫码加东西。')
          : all.length ? h('div', { class: 'banner soon' }, '全部到齐 ✓') : h('p', { class: 'muted small' }, '清单是空的。'),
      done.size ? h('details', { class: 'card' }, h('summary', {}, `已确认（${done.size}）`), [...done].map((id) => row(id, true))) : null);
  };
  draw();

  let stop = null;
  let closed = false;
  startScanner(video, onCode)
    .then((s) => { if (closed) s(); else { stop = s; status.textContent = '对准标签连续扫；没标签的点 ✓'; } })
    .catch((e) => { status.textContent = e.message; });
  cleanup = () => { closed = true; if (stop) stop(); delete window.__scan; };
  // 自动测试没有摄像头，从这里把扫到的内容喂进来
  if (localStorage.getItem('inventory-test-scan')) window.__scan = onCode;

  const finish = async () => {
    try {
      await cfg.onFinish(new Set(done), [...added]);
      clearProgress(cfg.key);
    } catch { /* onFinish 自己提示错误 */ }
  };
  return h('div', {},
    header(cfg.title),
    cfg.sub ? h('p', { class: 'muted small' }, cfg.sub) : null,
    h('div', { class: 'scan-box short' }, video, h('div', { class: 'scan-frame' }), flash),
    status, progress, lists,
    h('div', { class: 'actions sticky' }, h('button', { onclick: finish }, cfg.finishText)));
}

// ---------- 清单模板 ----------

const SCENES = ['出差', '回家', '搬家', '其他'];

function listsView() {
  const lists = store.data.lists || [];
  const create = () => {
    const name = h('input', { placeholder: '比如 回家、健身包' });
    const scene = chipChoice(SCENES, '回家');
    openSheet({
      title: '新建清单模板',
      body: h('div', { class: 'form' }, h('label', {}, '名称', name), h('div', { class: 'label' }, '场景', scene.el)),
      confirmText: '新建',
      onConfirm: async () => {
        if (!name.value.trim()) { toast('请填写名称', 'error'); return false; }
        const id = newId('k');
        await saving('正在保存…', () => store.save(`新建清单模板：${name.value.trim()}`, (data) => {
          data.lists = [...(data.lists || []), { id, name: name.value.trim(), scene: scene.get(), items: [], createdAt: today() }];
        })).catch(() => {});
        go(`#/list/${id}`);
      },
    });
  };
  return h('div', {},
    header('清单模板', h('button', { class: 'small', onclick: create }, '新建')),
    h('p', { class: 'muted small' }, '常用场景要带的东西存成模板（比如回家、返校）。出行时拿出来，扫一遍就知道带齐没有。'),
    lists.length ? h('div', { class: 'group' }, lists.map((l) => cell({ href: `#/list/${l.id}`, ic: 'list', color: '#9a8c7a', title: l.name, meta: `${l.scene} · ${l.items.filter((id) => store.item(id)).length} 件` })))
      : h('div', { class: 'card' }, h('p', {}, '还没有模板。也可以在一次出行结束后点「存成模板」。')));
}

function listView(id) {
  const list = (store.data.lists || []).find((l) => l.id === id);
  if (!list) return notFound('找不到这个模板。');
  const items = list.items.map((x) => store.item(x)).filter(Boolean);
  const save = (message, fn) => saving('正在保存…', () => store.save(message, (data) => {
    const l = data.lists.find((x) => x.id === id);
    if (!l) throw new Error('模板已经被删除了');
    fn(l, data);
  })).then(render).catch(() => {});
  const addFromItems = () => {
    const chosen = new Set();
    const q = h('input', { type: 'search', placeholder: '搜索物品' });
    const box = h('div', { class: 'pick-list' });
    const draw = () => {
      const w = q.value.trim().toLowerCase();
      fill(box, store.data.items.filter((i) => !i.archived && !list.items.includes(i.id) && (!w || `${i.name} ${i.assetId}`.toLowerCase().includes(w)))
        .slice(0, 80).map((i) => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', checked: chosen.has(i.id), onchange: (e) => { if (e.target.checked) chosen.add(i.id); else chosen.delete(i.id); } }),
          h('span', { class: 'grow' }, i.name, h('span', { class: 'muted small block' }, store.shortName(i.location))))));
    };
    q.addEventListener('input', draw);
    draw();
    openSheet({
      title: '从物品里添加', body: h('div', {}, q, box), confirmText: '添加',
      onConfirm: () => save(`模板「${list.name}」加 ${chosen.size} 件`, (l) => { l.items = [...new Set([...l.items, ...chosen])]; }),
    });
  };
  const rename = () => {
    const name = prompt('新名称：', list.name);
    if (name?.trim()) save(`模板改名：${name.trim()}`, (l) => { l.name = name.trim(); });
  };
  const remove = () => {
    saveUndoable(`删除模板：${list.name}`, (data) => { data.lists = data.lists.filter((x) => x.id !== id); }, `删掉了模板「${list.name}」`)
      .then(() => go('#/lists', true)).catch(() => {});
  };
  const useIt = () => { tripDraft.current = { kind: list.scene === '出差' ? '出差' : list.scene === '回家' ? '回家' : '其他', listId: id }; go('#/trip/new'); };
  return h('div', {},
    header(list.name, h('button', { class: 'link', onclick: rename }, '改名')),
    h('p', { class: 'muted small' }, `${list.scene} · ${items.length} 件`),
    h('div', { class: 'actions' },
      h('button', { onclick: useIt }, '用它出行'),
      h('button', { class: 'secondary', onclick: addFromItems }, '从物品里添加'),
      h('a', { class: 'button secondary', href: `#/check/list/${id}` }, '扫码添加')),
    items.length ? h('div', { class: 'card' }, items.map((it) => h('div', { class: 'check-item' },
      h('a', { class: 'grow', href: `#/item/${it.id}` }, it.name, h('span', { class: 'muted small block' }, store.shortName(it.location))),
      h('button', { class: 'link danger-text', onclick: () => save(`模板「${list.name}」去掉 ${it.name}`, (l) => { l.items = l.items.filter((x) => x !== it.id); }) }, '去掉'))))
      : h('div', { class: 'card' }, h('p', {}, '模板是空的。')),
    h('p', { class: 'center' }, h('button', { class: 'link danger-text', onclick: remove }, '删除这个模板')));
}

// ---------- 装箱：收纳袋、搬家箱子、行李箱 ----------

function boxesView() {
  const bags = store.data.locations.filter((l) => l.box === 'bag');
  const boxes = store.data.locations.filter((l) => l.box === 'move');
  const luggage = store.data.locations.filter((l) => l.box === 'trip');
  const create = (kind) => {
    const name = h('input', { value: kind === 'bag' ? '' : `箱子 ${boxes.length + 1}`, placeholder: kind === 'bag' ? '比如 洗漱包、衣物收纳袋' : '比如 箱子 1、书籍箱' });
    const where = locationSelect('', {}, '平时放在哪');
    openSheet({
      title: kind === 'bag' ? '新建收纳袋' : '新建搬家箱子',
      body: h('div', { class: 'form' }, h('label', {}, '名称', name), kind === 'bag' ? h('label', {}, '平时放在哪', where) : null,
        h('p', { class: 'muted small' }, kind === 'bag'
          ? '收纳袋会得到一个 010 开头的编号，贴上标签后，核对时扫一下袋子，里面登记的东西就全部算带上了。'
          : '箱子会得到一个 010 开头的编号，标签进「待打印」。扫一下箱子就能看到里面装了什么。')),
      confirmText: '新建',
      onConfirm: async () => {
        if (!name.value.trim()) { toast('请填写名称', 'error'); return false; }
        if (kind === 'bag' && !where.value) { toast('请选择平时放在哪', 'error'); return false; }
        const id = newId('L');
        await saving('正在保存…', () => store.save(`新建${kind === 'bag' ? '收纳袋' : '箱子'}：${name.value.trim()}`, (data) => {
          data.locations.push({ id, name: name.value.trim(), parent: kind === 'bag' ? where.value : null, box: kind,
            assetId: nextAssetInPrefix(data, LOCATION_PREFIX), label: 'pending', createdAt: today() });
        })).catch(() => {});
        go(`#/place/${id}`);
      },
    });
  };
  const rows = (list, ic) => h('div', { class: 'list' }, list.map((b) => h('a', { class: 'row place', href: `#/place/${b.id}` },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, ic, ' ', b.name),
      h('div', { class: 'row-meta' }, assetChip(b.assetId), labelChip(b), `${store.itemsIn(b.id).length} 件`,
        b.box === 'bag' && b.parent ? `平时在${store.shortName(b.parent)}` : null)))));
  return h('div', {},
    header('装箱 / 收纳袋'),
    h('div', { class: 'section-title' }, '收纳袋（常驻，出行时整袋带走）'),
    bags.length ? rows(bags, '👝') : h('p', { class: 'muted small' }, '还没有收纳袋。'),
    h('button', { class: 'secondary', onclick: () => create('bag') }, '新建收纳袋'),
    h('div', { class: 'section-title' }, '搬家箱子'),
    boxes.length ? rows(boxes, '📦') : h('p', { class: 'muted small' }, '现在没有搬家箱子。'),
    h('button', { class: 'secondary', onclick: () => create('move') }, '新建搬家箱子'),
    luggage.length ? [h('div', { class: 'section-title' }, '行李箱（出行中，自动建的）'), rows(luggage, '🧳')] : null);
}

// 箱子、收纳袋页面上的操作（在 placeView 里调用）
function boxPanel(loc, items) {
  if (loc.box === 'bag') {
    return h('div', { class: 'card' },
      h('h3', {}, `收纳袋 · 平时在${store.shortName(loc.parent)}`),
      h('p', { class: 'small' }, '登记袋子里装了什么。出行核对时扫一下袋子，里面的东西全部算带上了。'),
      h('a', { class: 'button secondary', href: `#/check/bag/${loc.id}` }, '扫码登记袋子里的东西'),
      h('p', { class: 'muted small' }, '也可以在物品的编辑页，把位置改成这个袋子。'));
  }
  const backable = items.filter((i) => i.homeLocation && store.location(i.homeLocation));
  const target = locationSelect('', {}, '全部搬到……');
  const run = (message, fn) => saving('正在保存…', () => store.save(message, fn)).then(render).catch(() => {});
  const putBack = () => saveUndoable(`拆箱：${loc.name}，${backable.length} 件放回原处`, (data) => {
    for (const it of data.items) if (it.location === loc.id && it.homeLocation) moveItem(data, it, it.homeLocation);
  }, `${backable.length} 件放回了原处`).then(render).catch(() => {});
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
      loc.box === 'move' ? h('button', { onclick: scanInto }, '扫码装箱') : null,
      items.length ? h('a', { class: 'button secondary', href: `#/check/box/${loc.id}` }, '核对拆箱') : null,
      backable.length ? h('button', { class: 'secondary', onclick: putBack }, `全部放回原处（${backable.length}）`) : null),
    items.length ? h('div', { class: 'asset-row' }, target, h('button', { class: 'secondary small', onclick: moveAll }, '搬过去')) : null,
    items.length ? null : h('button', { class: 'link danger-text', onclick: remove }, '删除这个箱子'));
}

// 核对页的路由：出发 / 回程 / 拆箱 / 模板扫码添加 / 收纳袋登记
function checkRoute(kind, id, phase) {
  if (kind === 'trip') {
    const trip = store.data.trips.find((t) => t.id === id);
    if (!trip) return notFound('找不到这次出行。');
    return phase === 'back' ? backCheck(trip) : outCheck(trip);
  }
  if (kind === 'box') {
    const loc = store.location(id);
    if (!loc) return notFound('找不到这个箱子。');
    return checkView({
      key: `box-${id}`, title: `核对拆箱：${loc.name}`, sub: '把箱子里的东西逐件扫一遍，确认一件不少。', doneText: '已找到',
      expected: store.itemsIn(id).map((i) => i.id), finishText: '核对完了',
      onFinish: (done) => {
        const missing = store.itemsIn(id).filter((i) => !done.has(i.id));
        toast(missing.length ? `还差 ${missing.length} 件：${missing.map((i) => i.name).join('、')}` : '一件不少 ✓', missing.length ? 'error' : 'ok');
        go(`#/place/${id}`, true);
      },
    });
  }
  if (kind === 'list') {
    const list = (store.data.lists || []).find((l) => l.id === id);
    if (!list) return notFound('找不到这个模板。');
    return checkView({
      key: `list-${id}`, title: `扫码添加：${list.name}`, sub: '对着实物逐件扫，扫到的加进模板；扫收纳袋会把袋子里的都加进来。',
      expected: list.items, collect: true, doneText: '件在模板里', finishText: '保存模板',
      onFinish: (done, added) => saving('正在保存…', () => store.save(`模板「${list.name}」扫码添加 ${added.length} 件`, (data) => {
        const l = data.lists.find((x) => x.id === id);
        l.items = [...new Set([...l.items, ...added])];
      })).then(() => go(`#/list/${id}`, true)),
    });
  }
  if (kind === 'bag') {
    const bag = store.location(id);
    if (!bag) return notFound('找不到这个收纳袋。');
    return checkView({
      key: `bag-${id}`, title: `登记：${bag.name}`, sub: '把要放进袋子的东西逐件扫一下。', collect: true,
      expected: store.itemsIn(id).map((i) => i.id), doneText: '件在袋子里', finishText: '保存',
      onFinish: (done, added) => saving('正在保存…', () => store.save(`收纳袋「${bag.name}」放进 ${added.length} 件`, (data) => {
        for (const it of data.items) if (added.includes(it.id)) moveItem(data, it, id);
      })).then(() => go(`#/place/${id}`, true)),
    });
  }
  return notFound('没有这个页面');
}

// ---------- 出行 ----------

const TRIP_KINDS = ['出差', '回家', '其他'];
const tripTitle = (t) => `${t.kind && t.kind !== '出差' ? `${t.kind === '回家' ? '回家' : t.city}` : t.city}${t.start ? ` · ${t.start.slice(5)}${t.end && t.end !== t.start ? `～${t.end.slice(5)}` : ''}` : ''}`;

function tripsView() {
  const trips = [...store.data.trips].sort((a, b) => (b.start || b.createdAt || '').localeCompare(a.start || a.createdAt || ''));
  const status = { planning: '准备中', packed: '在路上', done: '已结束' };
  return h('div', {},
    header('出行', h('button', { class: 'small', onclick: () => { tripDraft.current = null; go('#/trip/new'); } }, '新出行')),
    h('div', { class: 'group' }, cell({ href: '#/lists', ic: 'list', color: '#9a8c7a', title: '清单模板', meta: `${(store.data.lists || []).length} 个` })),
    h('div', { class: 'section-title' }, '出行记录'),
    trips.length ? h('div', { class: 'list' }, trips.map((t) => h('a', { class: 'row place', href: `#/trip/${t.id}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, tripTitle(t)),
        h('div', { class: 'row-meta' }, h('span', { class: `label-state ${t.status === 'packed' ? 'pending' : t.status === 'done' ? 'printed' : 'none'}` }, status[t.status]),
          t.kind || '出差', (t.purposes || []).join('、'), `${(t.out || t.checked || []).length} 件`)))))
      : h('div', { class: 'card' }, h('p', {}, '还没有出行记录。出差会按天气推荐带什么；回家、返校可以用清单模板。')));
}

const tripDraft = { current: null }; // 还没保存的新出行（生成清单后先放这里）

function tripPlanView(id) {
  const saved = id ? store.data.trips.find((t) => t.id === id) : null;
  if (id && !saved) return notFound('找不到这次出行。');
  const trip = saved ? structuredClone(saved) : tripDraft.current;
  return trip?.plan ? tripResult(trip, Boolean(saved)) : tripForm(trip);
}

function tripForm(prev) {
  const kind = chipChoice(TRIP_KINDS, prev?.kind || '出差');
  const body = h('div', {});
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
  const lists = store.data.lists || [];
  const listSel = h('select', { value: prev?.listId || '' }, h('option', { value: '' }, '不用模板，自己挑'),
    lists.map((l) => h('option', { value: l.id }, `${l.name}（${l.items.length} 件）`)));
  const ai = readAi();

  const generate = async () => {
    const k = kind.get();
    const base = { id: newId('t'), kind: k, start: start.value, end: end.value || start.value, status: 'planning', createdAt: today() };
    if (k === '出差') {
      if (!city.value.trim()) return toast('请填写目的地', 'error');
      if (!start.value || !end.value || end.value < start.value) return toast('日期不对', 'error');
      const trip = { ...base, city: city.value.trim(), purposes: [...purposes], laundry: laundry.checked, note: note.value.trim() };
      await saving('正在查天气…', async (b) => {
        trip.place = await geocode(trip.city);
        trip.weather = await weatherFor(trip.place, trip.start, trip.end);
        const rules = rulePlan(store.data, trip, trip.weather);
        trip.plan = rules;
        if (ai.key) {
          b.set('DeepSeek 正在挑东西、搭配衣服…（可能要一分钟）');
          try { trip.plan = await aiPlan(store.data, trip, trip.weather, rules, ai); } catch (e) { trip.plan = { ...rules, fallback: e.message }; }
        }
        trip.checked = trip.plan.items.map((i) => i.id);
      }).catch(() => { throw new Error('stop'); });
      tripDraft.current = trip;
    } else {
      const list = lists.find((l) => l.id === listSel.value);
      const ids = (list?.items || []).filter((id) => store.item(id) && !store.item(id).archived);
      tripDraft.current = {
        ...base, city: k === '回家' ? '家' : (city.value.trim() || '外出'), purposes: [], listId: list?.id || null,
        plan: { source: list ? `模板「${list.name}」` : '自己挑', items: ids.map((id) => ({ id, qty: 1, reason: '' })), outfits: [], missing: [], tips: [] },
        checked: ids,
      };
    }
    render();
  };

  const draw = () => {
    const k = kind.get();
    fill(body, k === '出差' ? [
      h('label', {}, '目的地', city),
      h('div', { class: 'asset-row' }, h('label', { class: 'grow' }, '出发', start), h('label', { class: 'grow' }, '返回', end)),
      h('div', { class: 'label' }, '目的（可多选）', chipBox),
      h('label', { class: 'switch-row' }, laundry, '住处可以洗衣服'),
      h('label', {}, '补充说明', note),
      h('p', { class: 'muted small' }, ai.key ? '会用 DeepSeek 推荐并搭配衣服。' : '没填 DeepSeek 密钥，只用规则推荐。'),
      h('button', { class: 'wide', onclick: () => generate().catch(() => {}) }, '生成推荐'),
    ] : [
      k === '其他' ? h('label', {}, '去哪', city) : null,
      h('div', { class: 'asset-row' }, h('label', { class: 'grow' }, '出发', start), h('label', { class: 'grow' }, '回来（大概）', end)),
      h('label', {}, '用哪个清单模板', listSel),
      h('button', { class: 'wide', onclick: () => generate().catch(() => {}) }, '生成清单'),
    ]);
  };
  kind.el.addEventListener('click', () => setTimeout(draw));
  draw();
  return h('div', { class: 'form' }, header('新出行'), h('div', { class: 'label' }, '类型', kind.el), body);
}

function tripResult(trip, isSaved) {
  const checked = new Set(trip.checked || []);
  const byId = (id) => store.item(id);
  const planItems = trip.plan.items.filter((i) => byId(i.id));
  const extra = (trip.checked || []).filter((id) => !planItems.some((p) => p.id === id) && byId(id)).map((id) => ({ id, qty: 1, reason: '自己加的' }));
  const shown = trip.status === 'planning' ? [...planItems, ...extra] : (trip.out || trip.checked || []).filter(byId).map((id) => ({ id, qty: 1, reason: '' }));
  const groups = new Map(); // 按位置分组，照着去柜子里拿
  for (const p of shown) {
    const key = store.shortName(byId(p.id).homeLocation && isBox(store.data, byId(p.id).location) ? byId(p.id).homeLocation : byId(p.id).location);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const persist = (message, fn, then = `#/trip/${trip.id}`) => saving('正在保存…', () => store.save(message, (data) => {
    const i = data.trips.findIndex((t) => t.id === trip.id);
    const next = { ...trip, checked: [...checked] };
    fn?.(data, next);
    if (i < 0) data.trips.push(next); else data.trips[i] = next;
  })).then(() => { tripDraft.current = null; go(then, true); }).catch(() => {});

  const directPack = () => {
    const ids = [...checked].filter((id) => byId(id) && !isBox(store.data, byId(id).location));
    if (!ids.length) return toast('没有勾选要带的东西', 'error');
    if (!confirm(`不核对，直接把勾选的 ${ids.length} 件装进行李箱？`)) return;
    persist(`出发：${trip.city}，${ids.length} 件装进行李箱`, (data, next) => packTrip(data, next, ids));
  };
  const directUnpack = () => {
    const inBox = trip.boxId ? store.itemsIn(trip.boxId) : [];
    if (!confirm(`不核对，直接把行李箱里的 ${inBox.length} 件放回原处？`)) return;
    persist(`回来：${trip.city}，${inBox.length} 件放回原处`, (data, next) => {
      for (const it of data.items) if (it.location === trip.boxId) moveItem(data, it, it.homeLocation || it.location);
      dropEmptyBox(data, trip.boxId);
      next.status = 'done';
    });
  };
  const saveAsList = () => {
    const name = prompt('模板名称：', trip.kind === '回家' ? '回家' : trip.city);
    if (!name?.trim()) return;
    const ids = trip.out?.length ? trip.out : [...checked];
    saving('正在保存…', () => store.save(`存成模板：${name.trim()}`, (data) => {
      data.lists = [...(data.lists || []), { id: newId('k'), name: name.trim(), scene: trip.kind || '出差', items: ids, createdAt: today() }];
    })).then(() => toast('已存成模板')).catch(() => {});
  };
  const again = () => { tripDraft.current = { ...trip, id: undefined, plan: null, status: 'planning' }; go('#/trip/new'); };
  const addSelect = h('select', {},
    h('option', { value: '' }, '再加一件……'),
    store.data.items.filter((i) => !i.archived && !shown.some((p) => p.id === i.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((i) => h('option', { value: i.id }, `${i.name}（${store.shortName(i.location)}）`)));
  addSelect.addEventListener('change', () => {
    if (!addSelect.value) return;
    checked.add(addSelect.value);
    trip.checked = [...checked];
    if (!isSaved) tripDraft.current = trip;
    render();
  });
  const editable = trip.status === 'planning';
  const w = trip.weather ? summarizeWeather(trip.weather) : null;
  const left = (store.data.items || []).filter((i) => i.leftBehind?.trip === trip.id);

  return h('div', {},
    header(tripTitle(trip)),
    h('div', { class: 'card' },
      h('p', {}, trip.kind || '出差', (trip.purposes || []).length ? ` · ${trip.purposes.join('、')}` : '', trip.laundry ? ' · 能洗衣服' : '', trip.note ? ` · ${trip.note}` : ''),
      w ? [h('p', { class: 'muted small' }, `${trip.weather.source}：${w.min}～${w.max}℃，最大降水概率 ${w.rain}%${w.snow ? '，有雪' : ''}`),
        trip.weather.days.length ? h('div', { class: 'weather-row' }, trip.weather.days.map((d) =>
          h('span', { class: 'weather-day' }, h('b', {}, d.date.slice(5)), `${Math.round(d.min)}～${Math.round(d.max)}℃`, d.rain >= 40 ? ` ☂${d.rain}%` : ''))) : null] : null,
      h('p', { class: 'muted small' }, trip.plan.source === 'DeepSeek' ? '由 DeepSeek 推荐和搭配' : `清单来自：${trip.plan.source}${trip.plan.fallback ? `（DeepSeek 没用上：${trip.plan.fallback}）` : ''}`)),
    trip.status === 'done' ? h('div', { class: 'banner' }, `出发带了 ${(trip.out || []).length} 件，回程找到 ${(trip.back || []).length} 件`, left.length ? `，落下 ${left.length} 件` : '') : null,
    trip.plan.tips?.length ? h('div', { class: 'card' }, h('h3', {}, '提醒'), h('ul', {}, trip.plan.tips.map((t) => h('li', {}, t)))) : null,
    h('div', { class: 'card' },
      h('h3', {}, trip.status === 'planning' ? `要带的东西（${checked.size} 件，按位置分组）` : `带走的东西（${shown.length} 件）`),
      [...groups.entries()].map(([place, list]) => [
        h('div', { class: 'group-title' }, place),
        list.map((p) => {
          const it = byId(p.id);
          return h('label', { class: 'check-row' },
            editable ? h('input', {
              type: 'checkbox', checked: checked.has(p.id),
              onchange: (e) => { if (e.target.checked) checked.add(p.id); else checked.delete(p.id); trip.checked = [...checked]; },
            }) : null,
            h('span', { class: 'grow' }, it.name, p.qty > 1 ? ` ×${p.qty}` : '', p.reason ? h('span', { class: 'muted small block' }, p.reason) : null,
              it.leftBehind?.trip === trip.id ? h('span', { class: 'warn small block' }, `落在${it.leftBehind.place}了`) : null));
        })]),
      editable ? addSelect : null),
    trip.plan.outfits?.length ? h('div', { class: 'card' }, h('h3', {}, '每天穿搭'),
      trip.plan.outfits.map((o) => h('p', {}, h('b', {}, `${o.day}：`), o.items.map((id) => byId(id)?.name).filter(Boolean).join(' + '),
        o.note ? h('span', { class: 'muted small block' }, o.note) : null))) : null,
    trip.plan.missing?.length ? h('div', { class: 'card' }, h('h3', {}, '档案里没有，建议另外准备'),
      h('ul', {}, trip.plan.missing.map((m) => h('li', {}, h('b', {}, m.name), m.reason ? `：${m.reason}` : '')))) : null,
    h('div', { class: 'actions' },
      trip.status === 'planning' ? [
        h('button', { onclick: () => persist(`准备出行：${tripTitle(trip)}`, null, `#/check/trip/${trip.id}/out`) }, '开始出发核对'),
        h('button', { class: 'secondary', onclick: directPack }, '不核对，直接出发'),
        h('button', { class: 'secondary', onclick: () => persist(`保存出行：${tripTitle(trip)}`) }, isSaved ? '保存勾选' : '先保存'),
        trip.kind === '出差' || !trip.kind ? h('button', { class: 'secondary', onclick: again }, '改条件重新推荐') : null,
      ] : null,
      trip.status === 'packed' ? [
        h('a', { class: 'button', href: `#/check/trip/${trip.id}/back` }, '开始回程核对'),
        h('a', { class: 'button secondary', href: `#/place/${trip.boxId}` }, '看行李箱'),
        h('button', { class: 'secondary', onclick: directUnpack }, '不核对，直接放回原处'),
      ] : null,
      trip.status === 'done' ? h('button', { class: 'secondary', onclick: again }, '再来一次') : null,
      h('button', { class: 'secondary', onclick: saveAsList }, '存成模板')));
}

// 出发：带走的东西装进这次出行的行李箱（位置临时变成行李箱，记住原位置）
function packTrip(data, trip, ids) {
  const boxId = newId('L');
  data.locations.push({ id: boxId, name: `行李箱（${trip.kind === '回家' ? '回家' : trip.city} ${(trip.start || today()).slice(5)}）`, parent: null, box: 'trip',
    assetId: nextAssetInPrefix(data, LOCATION_PREFIX), label: 'none', createdAt: today() });
  for (const it of data.items) if (ids.includes(it.id)) moveItem(data, it, boxId);
  trip.boxId = boxId;
  trip.out = ids;
  trip.status = 'packed';
}

function dropEmptyBox(data, boxId) {
  if (boxId && !data.items.some((it) => it.location === boxId)) data.locations = data.locations.filter((l) => l.id !== boxId);
}

function outCheck(trip) {
  return checkView({
    key: `trip-${trip.id}-out`, title: `出发核对：${tripTitle(trip)}`, doneText: '已带',
    sub: '收拾的时候逐件扫；没标签的点 ✓；扫收纳袋 = 袋子里的都带了。',
    expected: (trip.checked || []).filter((id) => store.item(id)), finishText: '出发',
    onFinish: (done, added) => {
      const planned = [...(trip.checked || []), ...added];
      const notTaken = planned.filter((id) => !done.has(id) && store.item(id));
      if (!done.size) { toast('还没确认任何东西', 'error'); throw new Error('empty'); }
      if (notTaken.length && !confirm(`还有 ${notTaken.length} 件没确认：${notTaken.slice(0, 5).map((id) => store.item(id).name).join('、')}${notTaken.length > 5 ? '…' : ''}\n这些不带了？`)) throw new Error('cancel');
      return saving('正在出发…', () => store.save(`出发：${tripTitle(trip)}，带 ${done.size} 件`, (data) => {
        const t = data.trips.find((x) => x.id === trip.id);
        t.checked = [...new Set(planned)];
        packTrip(data, t, [...done]);
      })).then(() => { toast(`出发！带了 ${done.size} 件`); go(`#/trip/${trip.id}`, true); });
    },
  });
}

function backCheck(trip) {
  return checkView({
    key: `trip-${trip.id}-back`, title: `回程核对：${tripTitle(trip)}`, doneText: '已找到',
    sub: '回程前把出发时带的东西扫一遍，看看有没有落下。从那边新带回来的也可以扫进来。',
    expected: (trip.out || []).filter((id) => store.item(id)), finishText: '核对完了',
    onFinish: (done, added) => new Promise((resolve, reject) => {
      const missing = (trip.out || []).filter((id) => store.item(id) && !done.has(id));
      const newOnes = added.filter((id) => !(trip.out || []).includes(id));
      const choices = new Map(missing.map((id) => [id, chipChoice(trip.kind === '回家' ? ['落下了', '留在家里', '其实没带'] : ['落下了', '其实没带'], '落下了')]));
      const dest = locationSelect('', {}, '放到哪');
      openSheet({
        title: missing.length ? `还有 ${missing.length} 件没找到` : '都找到了 ✓',
        body: h('div', { class: 'form' },
          missing.map((id) => h('div', { class: 'label' }, store.item(id).name, choices.get(id).el)),
          newOnes.length ? h('label', {}, `新带回来的 ${newOnes.length} 件放到`, dest) : null,
          h('p', { class: 'muted small' }, '确认后：找到的放回原处；「落下了」的会在首页提醒你去找；「留在家里」的位置改成「家」。')),
        confirmText: '到了，放回原处',
        onConfirm: async () => {
          if (newOnes.length && !dest.value) { toast('选一下新带回来的东西放哪', 'error'); return false; }
          try {
            await saving('正在放回原处…', () => store.save(`回程：${tripTitle(trip)}，找到 ${done.size} 件，没找到 ${missing.length} 件`, (data) => {
              const t = data.trips.find((x) => x.id === trip.id);
              for (const it of data.items) {
                if (newOnes.includes(it.id)) { moveItem(data, it, dest.value); continue; }
                if (!(trip.out || []).includes(it.id)) continue;
                const back = it.homeLocation || it.location;
                const choice = choices.get(it.id)?.get();
                if (choice === '留在家里') {
                  moveItem(data, it, ensureHome(data));
                  it.notes = [it.notes, `${today()} 回家时留在家里了`].filter(Boolean).join('\n');
                } else {
                  if (isBox(data, it.location)) moveItem(data, it, back);
                  if (choice === '落下了') it.leftBehind = { trip: trip.id, place: trip.kind === '回家' ? '家里' : trip.city, date: today() };
                }
              }
              dropEmptyBox(data, t.boxId);
              t.back = [...done];
              t.status = 'done';
            }));
            go(`#/trip/${trip.id}`, true);
            resolve();
          } catch (e) { reject(e); }
        },
      });
    }),
  });
}

// ---------- 设置 ----------

function settingsView() {
  const repo = h('input', { value: settings.repo || DEFAULT_REPO });
  const token = h('input', { type: 'password', value: settings.token || '', placeholder: 'github_pat_…', autocomplete: 'off' });
  const expires = h('input', { type: 'date', value: settings.tokenExpires || '' });
  const ai = store?.data ? readAi() : readLocalAi();
  const inRepo = Boolean(store?.config?.deepseek?.key);
  const aiKey = h('input', { type: 'password', value: ai.key || '', placeholder: 'sk-…', autocomplete: 'off' });
  const aiModel = h('input', { value: ai.model || '', placeholder: '留空自动选' });
  const saveAi = async () => {
    if (!store?.data) return toast('先连接数据仓库', 'error');
    const next = { key: aiKey.value.trim(), model: aiModel.value.trim() };
    if (next.key) {
      // 列模型的接口不花钱，用来验证密钥；填的模型这个账号用不了（或没填）就自动选一个能用的
      const res = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${next.key}` } }).catch(() => null);
      if (!res) return toast('连不上 DeepSeek', 'error');
      if (!res.ok) return toast(res.status === 401 ? 'DeepSeek 密钥不对' : `DeepSeek 返回 ${res.status}`, 'error');
      const models = ((await res.json()).data || []).map((m) => m.id);
      if (models.length && !models.includes(next.model)) {
        next.model = models.find((m) => /flash|chat/.test(m)) || models[0];
      }
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
        h('li', {}, 'Expiration 选最长；Repository access 选 Only select repositories → inventory-data 和 finance-data（账本也用这一个）。'),
        h('li', {}, 'Permissions → Repository permissions → Contents 选 Read and write。'),
        h('li', {}, '生成后复制，粘贴到下面。')),
      h('label', {}, '数据仓库', repo),
      h('label', {}, '令牌', token),
      h('label', {}, '令牌到期日（创建时 GitHub 会显示，填了会提前 14 天提醒）', expires),
      h('button', { class: 'wide', onclick: () => saveSettings().catch(() => {}) }, '保存并连接')),
    settings.token ? h('div', { class: 'card' },
      h('p', { class: 'small' }, '数据仓库：', h('a', { href: `https://github.com/${settings.repo || DEFAULT_REPO}`, target: '_blank', rel: 'noopener' }, settings.repo || DEFAULT_REPO),
        '（每次修改都是一次提交，可以在 GitHub 上查看历史）'),
      h('div', { class: 'actions' }, h('a', { class: 'button secondary', href: '#/siri' }, 'Siri 找东西'), h('a', { class: 'button secondary', href: '#/lost' }, '手机丢了怎么办'), h('button', { class: 'danger', onclick: logout }, '退出这台设备'))) : null,
    store?.data ? cityCard() : null,
    store?.data ? pushCard() : null,
    aiCard(inRepo, ai, aiKey, aiModel, saveAi));
}

// ---------- 放假离校 / 开学返校 ----------
// data.term = { leave, back, done: { 清单项 key: true } }。离校前 7 天、返校后 3 天首页提醒。
// 清单按档案现算：放假期间会过期的吃的药、要还的书、洗衣篮、床品、贵重东西，加几件每次都要做的事。

const TERM_HELP = [
  ['怎么用', ['填好离校和返校的日期。离校前 7 天起首页会提醒，返校那几天提醒返校清单。', '清单是按你的档案算出来的：放假期间会过期的吃的和药、要还的书、没洗的衣服、贵重东西……做完一项点一下打勾。', '贵重东西那一组可以一键「建成回家出行」，用出行的扫码核对装包。']],
  ['返校', ['留在家里的东西（位置是「家」的）列出来，看看哪些要带回来。', '放假前用完、放假期间过期的东西，开学第一次去超市一起买。']],
];
const TERM_TASKS = {
  leave: ['倒垃圾，桌上、柜子里不留吃的', '拔掉插头（台灯、充电器、插线板）', '水杯、餐具洗干净晾干', '关窗、锁好柜门'],
  back: ['开窗通风，看看柜子里有没有受潮发霉', '插头插回去，台灯、充电器试一下', '床单被套铺之前洗一下或晒一晒'],
};

function termDays(day) {
  return day ? Math.round((new Date(`${day}T00:00:00`) - new Date(`${localDay()}T00:00:00`)) / 86400000) : null;
}
// 现在该看哪张清单：离校前 7 天到离校 → leave；返校前 1 天到返校后 3 天 → back
function termPhase(t = store.data.term) {
  if (!t) return null;
  const l = termDays(t.leave);
  const b = termDays(t.back);
  if (l !== null && l >= 0 && l <= 7) return 'leave';
  if (b !== null && b >= -3 && b <= 1) return 'back';
  return null;
}
function termMeta() {
  const t = store.data.term;
  const l = termDays(t?.leave);
  const b = termDays(t?.back);
  if (l !== null && l >= 0) return l === 0 ? '今天离校' : `${l} 天后离校`;
  if (b !== null && b >= -3) return b > 0 ? `${b} 天后返校` : '刚返校';
  return '';
}

function termChecklist(kind, t) {
  const d = store.data;
  const live = d.items.filter((i) => !i.archived);
  const home = d.locations.find((l) => l.home);
  const inDorm = (i) => !home || i.location !== home.id;
  const groups = [];
  if (kind === 'leave') {
    const back = t.back || '9999-12-31';
    const spoil = live.filter((i) => inDorm(i) && !isDepleted(i) && parseDate(i.fields?.['保质期']) && i.fields['保质期'] <= back);
    if (spoil.length) groups.push(['放假期间会过期（吃掉、带走或扔掉）', spoil.map((i) => ({ key: `spoil:${i.id}`, text: i.name, sub: `保质期 ${i.fields['保质期']}`, href: `#/item/${i.id}` }))]);
    const books = live.filter((i) => i.borrow && i.borrow.due <= back);
    if (books.length) groups.push(['要还的书（还掉或续借）', books.map((i) => ({ key: `book:${i.id}`, text: i.name, sub: `${i.borrow.due} 到期`, href: `#/item/${i.id}` }))]);
    const wash = live.filter((i) => i.laundry && !INTIMATE_PARTS.includes(i.fields?.['部位']));
    const bedding = live.filter((i) => i.tags[0] === '床上用品' && inDorm(i));
    const laundryRows = [
      wash.length ? { key: 'wash', text: `洗衣篮里的 ${wash.length} 件洗完收好`, sub: wash.slice(0, 3).map((i) => i.name).join('、'), href: '#/laundry' } : null,
      bedding.length ? { key: 'bedding', text: '床单被套洗好收起来，或者带回家洗', sub: bedding.slice(0, 3).map((i) => i.name).join('、') } : null,
    ].filter(Boolean);
    if (laundryRows.length) groups.push(['衣服和床品', laundryRows]);
    const valuable = live.filter((i) => inDorm(i) && !i.borrow && (['证件文件', '钥匙'].includes(i.tags[0]) || (i.tags[0] === '电子产品' && Number(i.purchasePrice) >= 300)));
    if (valuable.length) groups.push(['贵重东西（带走或锁好）', valuable.map((i) => ({ key: `take:${i.id}`, text: i.name, sub: store.shortName(i.location), href: `#/item/${i.id}`, take: i.id }))]);
  } else {
    const atHome = home ? live.filter((i) => i.location === home.id) : [];
    if (atHome.length) groups.push(['留在家里的（要带回来的打勾）', atHome.map((i) => ({ key: `bring:${i.id}`, text: i.name, href: `#/item/${i.id}` }))]);
    const shop = shoppingList(d);
    if (shop.length) groups.push(['第一次去超市', [{ key: 'shop', text: `购物清单上有 ${shop.length} 样`, sub: shop.slice(0, 4).map((e) => e.name).join('、'), href: '#/shopping' }]]);
  }
  groups.push(['每次都要做的', TERM_TASKS[kind].map((text, n) => ({ key: `task:${kind}:${n}`, text }))]);
  return groups;
}

function termView(q) {
  const t = store.data.term || {};
  const kind = q.kind || termPhase(t) || 'leave';
  const done = t.done || {};
  const save = (message, fn) => saving('正在保存…', () => store.save(message, (data) => { data.term ||= {}; fn(data.term); })).then(render).catch(() => {});
  const leave = h('input', { type: 'date', value: t.leave || '', 'aria-label': '离校日期', onchange: (e) => save(`离校日期：${e.target.value}`, (x) => { x.leave = e.target.value; x.done = {}; }) });
  const back = h('input', { type: 'date', value: t.back || '', 'aria-label': '返校日期', onchange: (e) => save(`返校日期：${e.target.value}`, (x) => { x.back = e.target.value; }) });
  const groups = termChecklist(kind, t);
  const rows = groups.flatMap(([, list]) => list);
  const left = rows.filter((r) => !done[r.key]).length;
  const toggle = (r) => save(`${done[r.key] ? '取消' : ''}${kind === 'leave' ? '离校' : '返校'}清单：${r.text}`, (x) => {
    x.done ||= {};
    if (x.done[r.key]) delete x.done[r.key]; else x.done[r.key] = true;
  });
  // 贵重东西 → 存成「放假带回家」模板，用出行的扫码核对装包
  const takeIds = rows.filter((r) => r.take).map((r) => r.take);
  const makeTrip = () => saving('正在保存…', () => store.save('放假带回家：存成清单模板', (data) => {
    data.lists ||= [];
    let l = data.lists.find((x) => x.name === '放假带回家');
    if (!l) { l = { id: newId('T'), name: '放假带回家', scene: '回家', items: [] }; data.lists.push(l); }
    l.items = [...new Set([...l.items, ...takeIds])];
    return l.id;
  })).then((listId) => { tripDraft.current = { kind: '回家', listId, start: t.leave, end: t.back }; go('#/trip/new'); }).catch(() => {});
  return h('div', {},
    headerSub(kind === 'leave' ? '放假离校' : '开学返校', rows.length ? (left ? `还有 ${left} 项` : '都做完了 ✓') : '', helpButton('离校 / 返校清单怎么用', TERM_HELP)),
    h('div', { class: 'segmented' }, [['leave', '离校'], ['back', '返校']].map(([k, text]) =>
      h('button', { type: 'button', class: `seg${kind === k ? ' on' : ''}`, onclick: () => go(`#/term?kind=${k}`, true) }, text))),
    h('div', { class: 'card' }, h('div', { class: 'row-2 term-dates' }, h('label', {}, '离校', leave), h('label', {}, '返校', back))),
    groups.map(([title, list]) => [
      h('div', { class: 'section-title' }, title),
      h('div', { class: 'card shop-list' }, list.map((r) => h('div', { class: `shop-row${done[r.key] ? ' done' : ''}`, role: 'checkbox', 'aria-checked': String(Boolean(done[r.key])), tabindex: 0,
        onclick: () => toggle(r), onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggle(r); } } },
      h('span', { class: 'shop-tick' }, done[r.key] ? '✓' : ''),
      h('span', { class: 'grow' }, r.text, r.sub ? h('span', { class: 'muted small block' }, r.sub) : null),
      r.href ? h('a', { class: 'link small', href: r.href, onclick: (ev) => ev.stopPropagation() }, '看看') : null))),
      title.startsWith('贵重') && takeIds.length ? h('button', { class: 'secondary wide', onclick: makeTrip }, '建成回家出行，扫码装包') : null,
    ]));
}

// ---------- 找东西（Siri：「充电线在哪」） ----------
// 快捷指令打开 #/find?text=一句话：去掉「在哪、放哪了」这些词，按名称找；找不到再按全部信息、按字找

function findItems(items, text) {
  const key = String(text || '').replace(/[?？。！!，,]/g, ' ')
    .replace(/(放在|放到|放)?(哪里|哪儿|哪了|哪)(了|呢|去了)?|在(哪|那)|我的|帮我|找一?下|找|有没有|还有吗|呢/g, ' ').trim().toLowerCase();
  const live = items.filter((i) => !i.archived);
  if (!key) return { key, list: [] };
  const words = key.split(/\s+/).filter(Boolean);
  let list = live.filter((i) => words.every((w) => i.name.toLowerCase().includes(w)));
  if (!list.length) list = live.filter((i) => matches(i, words));
  if (!list.length) {
    // 按字找：「充电线」也能找到「USB-C 数据线（充电用）」，名字里重合两个字以上的排前面
    const chars = [...new Set(key.replace(/\s/g, ''))];
    list = live.map((i) => ({ i, n: chars.filter((c) => i.name.toLowerCase().includes(c)).length }))
      .filter((x) => x.n >= Math.min(2, chars.length)).sort((a, b) => b.n - a.n).slice(0, 6).map((x) => x.i);
  }
  return { key, list };
}

function findView(q) {
  const input = h('input', { value: q.text || '', placeholder: '比如 充电线、护照', 'aria-label': '找什么', enterkeyhint: 'search',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) go(`#/find?text=${encodeURIComponent(input.value)}`, true); } });
  const { key, list } = findItems(store.data.items, q.text);
  const zh = (id) => store.locationPath(id, ' › ').split(' › ').map((x) => x.split(' ')[0]).join(' › '); // 只要中文名，短一点
  const where = (it) => (isBox(store.data, it.location) && it.homeLocation ? `${zh(it.location)}（平时在 ${zh(it.homeLocation)}）` : zh(it.location));
  return h('div', {},
    headerSub('找东西', key ? `「${key}」` : '说名字就行'),
    h('div', { class: 'add-row' }, input, h('button', { class: 'small', onclick: () => go(`#/find?text=${encodeURIComponent(input.value)}`, true) }, '找')),
    !key ? null : list.length
      ? h('div', { class: 'group' }, list.map((it) => h('a', { class: 'cell find-hit', href: `#/item/${it.id}` },
        it.photos?.[0]?.thumb ? lazyPhoto(gh, it.photos[0].thumb, { class: 'find-thumb' }) : null,
        h('span', { class: 'grow' }, it.name, h('span', { class: 'find-where block' }, where(it)),
          it.borrow ? h('span', { class: 'muted small block' }, `借的，${it.borrow.due} 前还`) : null,
          it.leftBehind ? h('span', { class: 'warn-text small block' }, `落在${it.leftBehind.place}了`) : null),
        icon('chev', 'i chev'))))
      : h('div', { class: 'card' }, h('p', {}, '档案里没找到。'),
        h('a', { class: 'button secondary', href: `#/ask` }, '问问 AI'), ' ',
        h('a', { class: 'button secondary', href: `#/new?name=${encodeURIComponent(key)}` }, '建档')));
}

function siriView() {
  const base = window.location.origin + window.location.pathname;
  const url = `${base}#/find?text=`;
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('复制好了'); } catch { toast(url); } };
  return h('div', {},
    headerSub('Siri 找东西', '「嘿 Siri，找东西」→「充电线在哪」'),
    h('div', { class: 'card' },
      h('ol', { class: 'small' },
        h('li', {}, '打开 iPhone 自带的「快捷指令」App，右上角 ＋ 新建，名字改成「找东西」（Siri 就是听这个名字）。'),
        h('li', {}, '添加操作「要求输入」：类型选「文本」，提示写「找什么？」。'),
        h('li', {}, '添加操作「URL 编码」：编码的内容选上一步的「提供的输入」。'),
        h('li', {}, '添加操作「打开 URL」：网址填下面这一串，然后在最后插入变量「URL 编码文本」。')),
      h('div', { class: 'url-row' }, h('code', {}, url), h('button', { class: 'small secondary', onclick: copy }, '复制')),
      h('p', { class: 'muted small' }, '说「充电线在哪」「护照放哪了」都行，会去掉「在哪」这些词，按名字找；找到的会显示在哪个柜子、哪一层。')),
    h('div', { class: 'card' },
      h('p', { class: 'small' }, '快捷指令打开的是 Safari，不是主屏幕上的图标，iPhone 上这两个各存各的：第一次在 Safari 打开要填一次令牌，之后就不用了。')));
}

// ---------- 手机丢了怎么办 ----------
// 令牌在手机的浏览器里，捡到手机的人能看、能改物品档案和账本。在 GitHub 上删掉令牌，马上就失效。
function lostView() {
  const box = h('div', {}, h('p', { class: 'muted small' }, '正在读最近的修改……'));
  const repos = [['物品档案', gh], ['账本', ledgerGitHub(settings)]].filter(([, g]) => g);
  Promise.all(repos.map(([name, g]) => recentCommits(g, 40).then((list) => list.map((c) => ({ ...c, site: name }))).catch(() => [])))
    .then((lists) => {
      const all = lists.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
      if (!all.length) { box.replaceChildren(h('p', { class: 'muted small' }, '读不到修改记录。')); return; }
      const count = {};
      for (const c of all) count[c.device] = (count[c.device] || 0) + 1;
      const when = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      box.replaceChildren(
        h('p', { class: 'small' }, `最近 ${all.length} 次修改来自：`, Object.entries(count).map(([k, v]) => `${k} ${v} 次`).join('、'), `。这台是 ${DEVICE}。`),
        h('div', { class: 'commit-list' }, all.map((c) => h('div', { class: 'commit-row' },
          h('span', { class: 'muted small commit-when' }, when(c.date)),
          h('span', { class: 'grow small' }, c.message, h('span', { class: 'muted block' }, `${c.site} · ${c.device}`))))));
    });
  return h('div', {},
    headerSub('手机丢了怎么办', '两分钟，让丢的手机再也打不开你的数据'),
    h('div', { class: 'card' },
      h('h3', {}, '马上做'),
      h('ol', { class: 'small' },
        h('li', {}, '用电脑或借别人的手机，登录 github.com，打开 ', h('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener' }, '令牌列表'), '（Settings → Developer settings → Personal access tokens → Fine-grained tokens）。'),
        h('li', {}, '点这两个网站用的那个令牌（能访问 inventory-data 和 finance-data 的）→ 最下面 Delete。删掉的那一刻，丢的手机上的物品档案和账本就读不了、改不了了。'),
        h('li', {}, '新建一个令牌（Only select repositories 勾 inventory-data 和 finance-data，Contents 选 Read and write），在新手机的物品档案「设置」里填上；账本会自动用同一个。'),
        h('li', {}, 'DeepSeek 密钥存在数据仓库里，令牌删了别人也拿不到了。不放心的话去 DeepSeek 后台换一个新密钥，在物品档案「设置 → AI」里更新。'))),
    h('div', { class: 'card' },
      h('h3', {}, '然后看看'),
      h('ul', { class: 'small' },
        h('li', {}, '下面的修改记录里，有没有不是你做的（陌生的设备、你没改过的东西）。'),
        h('li', {}, '真被改了也不怕：每次修改在 GitHub 上都有历史，可以恢复到任何一次之前（让 Claude 帮你恢复）。'),
        h('li', {}, '平时：iPhone 设好锁屏密码、打开「查找我的 iPhone」，丢了还能远程抹掉。'))),
    h('div', { class: 'section-title' }, '最近的修改'),
    h('div', { class: 'card' }, box));
}

// 手机推送：每晚 8 点问「今天穿的要洗吗」，该洗衣服、床单该洗也会一起说
function pushCard() {
  const status = h('p', { class: 'muted small' }, '检查中……');
  const sup = pushSupport();
  const enable = async () => {
    try {
      await saving('正在开启……', async () => {
        const sub = await subscribe();
        await store.saveJson(PUSH_FILE, (cfg) => {
          const subs = (cfg.subscriptions || []).filter((x) => x.endpoint !== sub.endpoint);
          return { ...cfg, subscriptions: [...subs, { ...sub, device: deviceName(), added: localDay() }] };
        }, `开启推送：${deviceName()}`);
      });
      toast('已开启，应该马上收到一条「提醒已开启」');
      render();
    } catch { /* saving 已提示 */ }
  };
  if (sup.ok) {
    currentSubscription().then((sub) => {
      status.textContent = sub ? `✓ 这台设备已开启（${Notification.permission === 'granted' ? '通知已允许' : '通知没允许'}）` : '这台设备还没开启';
    }).catch(() => { status.textContent = '这台设备还没开启'; });
  } else {
    status.textContent = sup.why;
  }
  return h('div', { class: 'card' },
    h('h3', {}, '手机提醒'),
    h('p', { class: 'small' }, '每晚 8 点到 9 点之间推送「今天穿的要洗吗」；该洗衣服、床单该洗了也会一起提醒。由 GitHub 定时发送，不是准点（一晚上排了几次，只会收到一条）。'),
    status,
    sup.ok ? h('button', { class: 'secondary', onclick: enable }, '在这台设备上开启') : null);
}

// 常住城市：今天穿什么查天气用，存在数据里，所有设备共用
function cityCard() {
  const city = h('input', { value: store.data.prefs?.homeCity || '', placeholder: '比如 济南' });
  const save = async () => {
    const name = city.value.trim();
    if (!name) return toast('请填写城市', 'error');
    await saving('正在保存…', async () => {
      await geocode(name); // 先确认查得到这个城市
      await store.save(`常住城市：${name}`, (data) => { data.prefs = { ...(data.prefs || {}), homeCity: name }; });
    }).then(() => { weatherCache.date = ''; toast('已保存'); }).catch(() => {});
  };
  return h('div', { class: 'card' },
    h('h3', {}, '常住城市'),
    h('p', { class: 'small' }, '「今天穿什么」按这个城市查天气。'),
    h('div', { class: 'asset-row' }, city, h('button', { class: 'small', onclick: save }, '保存')));
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
      h('p', { class: 'small' }, `✓ 已连接 DeepSeek（${ai.model || '自动'}），出差推荐等 AI 功能会自动使用。`),
      h('details', { class: 'plain' }, h('summary', {}, '更换或删除密钥'), form));
  }
  return h('div', { class: 'card' },
    h('h3', {}, 'AI（选填）'),
    h('p', { class: 'small' }, '填了 DeepSeek 密钥，出差推荐会让 AI 挑东西、搭配衣服。密钥保存在你的私有数据仓库（config/ai.json），所有设备共用，只需填一次。发给 DeepSeek 的只有物品名称、类别和字段（季节、颜色等），不发照片、价格、序列号、备注。'),
    h('p', { class: 'muted small' }, ai.key ? '密钥目前只在这台设备上，点下面的按钮存到数据仓库' : '还没有填'),
    form);
}

boot();
