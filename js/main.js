import { GitHub } from './github.js';
import {
  Store, normalizeAssetId, newId, assertAssetFree, ASSET_MAX, LOCATION_PREFIX,
  needsLabel, prefixForTags, nextAssetInPrefix, nextTagCode, reminders,
} from './store.js';
import { h, today, compressImage, blobToBase64, lazyPhoto, photoUrl } from './util.js';
import { makeXlsx } from './xlsx.js';
import { startScanner, assetFromScan } from './scan.js';

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
  // 第一次拿到数据（或出错）一定要画；之后数据有变化时，正在填表或扫码的页面不重画
  if (!hadData || loadError) render();
  else if (store.head !== before && !EDITING_ROUTES.test(currentPath())) render();
}

function boot() {
  // 扫码进来的网址是 ?a=000-123，转成页面内的路由
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
  [/^\/stats$/, () => statsView()],
  [/^\/manage$/, () => manageView()],
  [/^\/settings$/, () => settingsView()],
];

const NAV_GROUPS = { '/more': ['/more', '/labels', '/reminders', '/stats', '/manage', '/settings'] };

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
        h('span', {}, store.shortName(item.location)),
        item.tags.length ? h('span', {}, item.tags.join('、')) : null,
        item.archived ? h('span', { class: 'badge' }, '已归档') : null,
        extra)));
}

// 清空元素再放入内容。和 replaceChildren 不同，这里会展开数组、跳过 null（经过 h()）
function fill(el, ...children) {
  el.replaceChildren(...h('div', {}, ...children).childNodes);
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

const listState = { q: '', tag: '', loc: '', archived: false };

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
  const pending = store.pendingLabels().length;
  const labelCard = pending ? h('a', { class: 'card notice', href: '#/labels' },
    h('strong', {}, `${pending} 张标签待打印`), h('span', { class: 'muted small' }, '打印后贴上，再标记为已打印')) : null;

  const page = h('div', {},
    header('物品'),
    dueCard, labelCard,
    h('input', {
      type: 'search', placeholder: '搜索名称、编号、品牌……', value: listState.q, class: 'search',
      oninput: (e) => { listState.q = e.target.value; update(); },
    }),
    h('div', { class: 'filters' },
      h('select', { value: listState.tag, onchange: (e) => { listState.tag = e.target.value; update(); } },
        h('option', { value: '' }, '全部标签'), store.data.tags.map((t) => h('option', { value: t }, t))),
      locationSelect(listState.loc, { onchange: (e) => { listState.loc = e.target.value; update(); } }, '全部位置'),
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

  const archive = () => {
    const reason = prompt('归档原因（丢失、送人、卖掉、扔掉、吃完……），会记在备注里：');
    if (reason === null) return;
    update(`归档：${item.name}`, (it) => {
      it.archived = true;
      it.notes = [it.notes, `${today()} 归档：${reason || '未写原因'}`].filter(Boolean).join('\n');
    });
  };
  const unarchive = () => update(`取消归档：${item.name}`, (it) => {
    it.archived = false;
    it.notes = [it.notes, `${today()} 取消归档`].filter(Boolean).join('\n');
  });
  const remove = async () => {
    if (!confirm(`彻底删除「${item.name}」？\n\n丢失、送人、扔掉的东西建议用「归档」，记录会保留。`)) return;
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
    item.archived ? h('div', { class: 'banner' }, '这件物品已归档') : null,
    due.map((r) => h('div', { class: `banner ${r.days < 0 ? 'warn' : 'soon'}` }, `${r.kind}：${r.date}，${daysText(r.days)}`)),
    gallery(item.photos),
    h('div', { class: 'card' },
      h('h1', { class: 'item-title' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
      h('div', { class: 'row-meta' }, assetChip(item.assetId),
        item.assetId && item.labelPrinted === false ? h('a', { class: 'badge', href: `#/item/${id}/label` }, '标签待打印') : null,
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
      item.assetId ? h('a', { class: 'button secondary', href: `#/item/${id}/label` }, '标签') : null,
      h('button', { class: 'secondary', onclick: copy }, '复制'),
      item.archived
        ? h('button', { class: 'secondary', onclick: unarchive }, '取消归档')
        : h('button', { class: 'secondary', onclick: archive }, '归档'),
      h('button', { class: 'danger', onclick: () => remove() }, '删除')),
    h('p', { class: 'muted small center' },
      `创建于 ${(item.createdAt || '').slice(0, 10)} · 更新于 ${(item.updatedAt || '').slice(0, 10)}`));
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
    : source ? { ...structuredClone(source), ...pick(blank, ['id', 'assetId', 'photos', 'receipts', 'notes', 'archived']) }
      : blank;
  const added = { photos: [], receipts: [] }; // 新选的照片：{ file, url }
  const removed = [];
  let fieldRows = Object.entries(draft.fields || {}).map(([k, v]) => ({ k, v }));
  // 编号是不是系统推荐的：推荐的可以随标签变化、保存时撞号自动顺延；手动填的、扫码带来的不动
  let autoAsset = false;

  const bind = (key, props = {}) => h(props.multiline ? 'textarea' : 'input', {
    ...props, multiline: undefined, value: draft[key] ?? '',
    oninput: (e) => { draft[key] = e.target.value; },
  });

  // ---- 编号 ----
  const assetInput = h('input', {
    value: draft.assetId || '', inputmode: 'numeric', placeholder: '例如 100-003',
    oninput: (e) => { autoAsset = false; checkAsset(e.target.value); },
  });
  const assetMsg = h('div', { class: 'hint' });
  const suggestBtn = h('button', { type: 'button', class: 'chip add', onclick: () => applySuggestion(true) }, '推荐编号');
  const checkAsset = (value) => {
    assetMsg.classList.remove('error');
    try {
      const norm = normalizeAssetId(value);
      const hit = norm && store.findByAsset(norm);
      if (hit && hit.obj.id !== itemId) throw new Error(`编号 ${norm} 已经被「${hit.obj.name}」用了`);
      const prefix = prefixForTags(store.data, draft.tags);
      if (!norm) {
        assetMsg.textContent = !draft.tags.length ? '选好标签后会按类别自动给编号。'
          : needsLabel(store.data, draft.tags) ? '没有编号就不打印标签。点「推荐编号」按类别自动给号。'
            : `「${draft.tags[0]}」默认不贴标签，所以不给编号。`;
      } else {
        assetMsg.textContent = autoAsset ? `按类别自动编号（${draft.tags[0] || '无标签'} ${prefix}-xxx）` : `编号：${norm}`;
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
  // force：用户点了「推荐编号」，即使是不贴标签的类别也给号
  const applySuggestion = (force = false) => {
    if (!force && (!draft.tags.length || !needsLabel(store.data, draft.tags))) {
      assetInput.value = '';
    } else {
      try {
        assetInput.value = nextAssetInPrefix(store.data, prefixForTags(store.data, draft.tags));
      } catch (e) { return toast(e.message, 'error'); }
    }
    autoAsset = true;
    checkAsset(assetInput.value);
  };
  if (q.asset) {
    assetInput.value = safeAsset(q.asset) || '';
  } else if (!existing) {
    applySuggestion();
  }
  checkAsset(assetInput.value);

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

  // ---- 标签和自定义字段 ----
  const tagBox = h('div', { class: 'chips' });
  const fieldBox = h('div', {});
  const drawTags = () => {
    tagBox.replaceChildren(...store.data.tags.map((t) => h('button', {
      type: 'button', class: `chip${draft.tags.includes(t) ? ' on' : ''}`,
      onclick: () => {
        draft.tags = draft.tags.includes(t) ? draft.tags.filter((x) => x !== t) : [...draft.tags, t];
        drawTags();
        drawFields();
        // 第一个标签决定编号的类别；推荐的编号跟着变，手动填的不动
        if (autoAsset || !assetInput.value) applySuggestion();
        else checkAsset(assetInput.value);
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
    draft.assetId = asset;
    draft.quantity = Math.max(1, Number(draft.quantity) || 1);
    draft.purchasePrice = draft.purchasePrice === '' || draft.purchasePrice == null ? null : Number(draft.purchasePrice);
    draft.fields = Object.fromEntries(fieldRows.filter((r) => r.k.trim() && String(r.v).trim()).map((r) => [r.k.trim(), String(r.v).trim()]));
    for (const k of ['manufacturer', 'modelNumber', 'serialNumber', 'purchaseFrom', 'description', 'notes']) {
      draft[k] = (draft[k] || '').trim();
    }
    // 编号变了（或新给了编号）就要重新打印标签
    const assetChanged = !existing || existing.assetId !== draft.assetId;
    const labelPrinted = draft.assetId ? (assetChanged ? false : existing.labelPrinted) : undefined;

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
        ...draft, labelPrinted,
        photos: [...draft.photos, ...fresh.photos], receipts: [...draft.receipts, ...fresh.receipts],
      };
      if (record.labelPrinted === undefined) delete record.labelPrinted;
      savedAsset = await store.save(`${existing ? '修改' : '新建'}：${draft.name}`, (data) => {
        // 推荐的编号如果刚好被别的设备占了，自动顺延到下一个空号
        if (autoAsset && record.assetId && data.items.concat(data.locations).some((x) => x.assetId === record.assetId && x.id !== itemId)) {
          record.assetId = nextAssetInPrefix(data, prefixForTags(data, record.tags));
        }
        assertAssetFree(data, record.assetId, itemId);
        if (existing) {
          const i = data.items.findIndex((x) => x.id === itemId);
          if (i < 0) throw new Error('这件物品已经在别处被删除了');
          data.items[i] = { ...record, createdAt: data.items[i].createdAt, updatedAt: now };
        } else {
          data.items.push({ ...record, createdAt: now, updatedAt: now });
        }
        return record.assetId;
      }, { uploads, removes: removed.flatMap((p) => [p.file, p.thumb]) });
    });
    toast(savedAsset && savedAsset !== draft.assetId ? `已保存（编号改为 ${savedAsset}）` : '已保存');
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
    h('div', { class: 'label' }, '标签', h('span', { class: 'hint inline' }, '第一个选的标签决定编号类别'), tagBox),
    h('div', { class: 'label' }, '编号', h('div', { class: 'asset-row' }, assetInput, suggestBtn), assetMsg),
    h('label', {}, '数量', bind('quantity', { type: 'number', min: 1, inputmode: 'numeric' })),
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
            if (it) { it.location = scanState.target; it.updatedAt = now; }
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
            if (it) { it.location = scanState.checkLoc; it.updatedAt = now; }
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
    h('div', { class: 'list' }, store.locationTree().map(({ loc, depth }) =>
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
    const value = prompt('这个位置的标签编号（柜子统一用 010 开头；留空表示不贴标签）：', suggestion);
    if (value === null) return;
    let asset;
    try { asset = normalizeAssetId(value); } catch (e) { return toast(e.message, 'error'); }
    await saving('正在保存…', () => store.save(`设置位置编号：${loc.name}`, (data) => {
      assertAssetFree(data, asset, id);
      const l = data.locations.find((x) => x.id === id);
      if (l.assetId !== asset) l.labelPrinted = asset ? false : undefined;
      l.assetId = asset;
    })).catch(() => {});
    render();
  };
  return h('div', {},
    h('p', { class: 'muted small' }, store.locationPath(loc.parent) || '　'),
    header(loc.name),
    h('div', { class: 'row-meta' }, assetChip(loc.assetId),
      h('button', { class: 'link', onclick: () => setAsset() }, loc.assetId ? '修改编号' : '给柜子编号'),
      loc.assetId ? h('a', { href: `#/place/${id}/label` }, '标签') : null),
    store.children(id).length ? h('div', { class: 'chips' }, store.children(id).map((c) =>
      h('a', { class: 'chip', href: `#/place/${c.id}` }, c.name.split(' ')[0]))) : null,
    h('p', { class: 'muted' }, `${items.length} 件`),
    h('div', { class: 'list' }, items.map((i) => itemRow(i))),
    h('a', { class: 'button wide', href: `#/new?loc=${id}` }, '在这里新建物品'));
}

// ---------- 更多 ----------

function moreView() {
  const pending = store.pendingLabels().length;
  const due = reminders(store.data).length;
  const entry = (href, title, desc, badge) => h('a', { class: 'row', href },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, title), h('div', { class: 'row-meta' }, desc)),
    badge ? h('span', { class: 'count' }, badge) : null);
  return h('div', {},
    header('更多'),
    h('div', { class: 'list' },
      entry('#/labels', '待打印标签', '导出 Excel，用汉码批量打印', pending || null),
      entry('#/reminders', '到期提醒', `保质期、保修 ${store.data.reminderDays} 天内到期的东西`, due || null),
      entry('#/stats', '统计', '每类、每个柜子有多少东西，值多少钱'),
      entry('#/manage', '管理位置和标签', '新建、改名、类别编号、哪些类别不贴标签'),
      entry('#/settings', '设置', '数据仓库和令牌')));
}

// ---------- 标签打印 ----------

function labelsView() {
  const pending = store.pendingLabels();
  const selected = new Set(pending.map((p) => p.obj.id));
  const nameOf = (p) => (p.type === 'item' ? p.obj.name : p.obj.name.split(' ')[0]);

  const download = () => {
    const rows = pending.filter((p) => selected.has(p.obj.id));
    if (!rows.length) return toast('没有选中的标签', 'error');
    const blob = makeXlsx([['编号', '名称', '二维码'], ...rows.map((p) => [p.obj.assetId, nameOf(p), `${SITE_URL}?a=${p.obj.assetId}`])], '标签');
    const a = h('a', { href: URL.createObjectURL(blob), download: `标签_${today()}_${rows.length}张.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const markPrinted = async () => {
    const ids = new Set(pending.filter((p) => selected.has(p.obj.id)).map((p) => p.obj.id));
    if (!ids.size) return toast('没有选中的标签', 'error');
    if (!confirm(`把选中的 ${ids.size} 张标记为已打印？`)) return;
    await saving('正在保存…', () => store.save(`标记已打印：${ids.size} 张标签`, (data) => {
      for (const x of [...data.items, ...data.locations]) if (ids.has(x.id)) x.labelPrinted = true;
    })).catch(() => {});
    render();
  };

  return h('div', {},
    header('待打印标签'),
    pending.length ? h('div', { class: 'card' },
      h('div', { class: 'list compact' }, pending.map((p) => h('label', { class: 'check-row' },
        h('input', {
          type: 'checkbox', checked: true,
          onchange: (e) => { if (e.target.checked) selected.add(p.obj.id); else selected.delete(p.obj.id); },
        }),
        h('span', { class: 'asset' }, p.obj.assetId),
        h('span', { class: 'grow' }, nameOf(p))))),
      h('div', { class: 'actions' },
        h('button', { onclick: download }, '下载 Excel'),
        h('button', { class: 'secondary', onclick: markPrinted }, '标记为已打印')))
      : h('div', { class: 'card' }, h('p', {}, '没有待打印的标签。新建物品时给了编号，它就会出现在这里。')),
    h('div', { class: 'card' },
      h('h3', {}, '在汉码 App 里批量打印（汉印 M1，40×30mm）'),
      h('ol', {},
        h('li', {}, '下载 Excel，发到手机（微信文件传输助手等）。'),
        h('li', {}, '汉码里新建 40×30mm 标签：加一个二维码，内容绑定「二维码」列，放在左边、尽量大。'),
        h('li', {}, '加两个文本，分别绑定「编号」和「名称」列，放在右边。'),
        h('li', {}, '导入 Excel，批量打印，按名称贴到对应的东西上。'),
        h('li', {}, '贴好后回到这里点「标记为已打印」。')),
      h('p', { class: 'muted small' }, '只打一张：在物品页点「标签」，保存图片后用汉码的图片打印。')));
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
  ctx.font = 'bold 72px system-ui, sans-serif';
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
  const mark = async () => {
    await saving('正在保存…', () => store.save(`标记已打印：${obj.assetId}`, (data) => {
      const x = (type === 'item' ? data.items : data.locations).find((o) => o.id === id);
      if (x) x.labelPrinted = true;
    })).catch(() => {});
    toast('已标记');
    history.back();
  };
  return h('div', {},
    header('标签'),
    h('div', { class: 'card center' }, img,
      h('p', { class: 'muted small' }, '40×30mm。手机上长按图片保存到相册，再在汉码 App 里用「图片打印」。'),
      h('div', { class: 'actions center-row' },
        h('a', { class: 'button secondary', href: img.src, download: `label_${obj.assetId}.png` }, '下载图片'),
        obj.labelPrinted === false ? h('button', { onclick: mark }, '已打印，标记一下') : null)));
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
  const archived = store.data.items.length - items.length;
  const noPhoto = items.filter((i) => !i.photos?.length).length;

  return h('div', {},
    header('统计'),
    h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, items.length), h('div', { class: 'stat-label' }, '件物品')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, items.reduce((s, i) => s + qty(i), 0)), h('div', { class: 'stat-label' }, '个（含数量）')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, money(value(items))), h('div', { class: 'stat-label' }, '记录的总价值')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, items.filter((i) => i.assetId).length), h('div', { class: 'stat-label' }, '件有编号'))),
    h('div', { class: 'card' }, h('h3', {}, '按类别（第一个标签）'), byTag.length ? bars(byTag) : h('p', { class: 'muted' }, '还没有物品'),
      untagged ? h('p', { class: 'muted small' }, `另有 ${untagged} 件没有标签`) : null),
    h('div', { class: 'card' }, h('h3', {}, '按位置'), byPlace.length ? bars(byPlace) : h('p', { class: 'muted' }, '还没有物品')),
    h('p', { class: 'muted small' }, `已归档 ${archived} 件（不计入上面的数字）· 没有照片的 ${noPhoto} 件 · 价值只统计填了价格的物品`));
}

// ---------- 管理位置和标签 ----------

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
    const name = prompt('新标签：');
    if (!name?.trim()) return;
    if (store.data.tags.includes(name.trim())) return toast('已经有这个标签了', 'error');
    save(`新建标签：${name.trim()}`, (data) => {
      data.tags.push(name.trim());
      data.tagCodes[name.trim()] = nextTagCode(data);
    });
  };
  const renameTag = (tag) => {
    const name = prompt('新名称：', tag);
    if (!name?.trim() || name.trim() === tag) return;
    const to = name.trim();
    if (store.data.tags.includes(to)) return toast('已经有这个标签了', 'error');
    save(`标签改名：${tag} → ${to}`, (data) => {
      data.tags = data.tags.map((t) => (t === tag ? to : t));
      for (const it of data.items) it.tags = it.tags.map((t) => (t === tag ? to : t));
      for (const key of ['fieldPresets', 'tagCodes']) {
        if (data[key]?.[tag] !== undefined) { data[key][to] = data[key][tag]; delete data[key][tag]; }
      }
      data.unlabeledTags = data.unlabeledTags.map((t) => (t === tag ? to : t));
    });
  };
  const deleteTag = (tag) => {
    const used = store.data.items.filter((i) => i.tags.includes(tag)).length;
    if (!confirm(`删除标签「${tag}」？${used ? `\n有 ${used} 件物品用了它，会从这些物品上去掉（已有的编号不变）。` : ''}`)) return;
    save(`删除标签：${tag}`, (data) => {
      data.tags = data.tags.filter((t) => t !== tag);
      for (const it of data.items) it.tags = it.tags.filter((t) => t !== tag);
      delete data.fieldPresets?.[tag];
      delete data.tagCodes[tag];
      data.unlabeledTags = data.unlabeledTags.filter((t) => t !== tag);
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
      h('h3', {}, '标签'),
      h('p', { class: 'muted small' }, '编号的前 3 位由物品的第一个标签决定，柜子统一是 010。标「不贴」的类别新建时不自动给编号。'),
      store.data.tags.map((tag) => {
        const off = store.data.unlabeledTags.includes(tag);
        return h('div', { class: 'manage-row' },
          h('button', { class: 'link asset', onclick: () => editCode(tag) }, store.data.tagCodes[tag]),
          h('span', { class: 'grow' }, tag),
          h('button', { class: `link${off ? ' muted' : ''}`, onclick: () => toggleLabel(tag) }, off ? '不贴' : '贴标签'),
          h('button', { class: 'link', onclick: () => renameTag(tag) }, '改名'),
          h('button', { class: 'link danger-text', onclick: () => deleteTag(tag) }, '删除'));
      }),
      h('button', { class: 'secondary', onclick: addTag }, '新建标签')));
}

// ---------- 设置 ----------

function settingsView() {
  const repo = h('input', { value: settings.repo || DEFAULT_REPO });
  const token = h('input', { type: 'password', value: settings.token || '', placeholder: 'github_pat_…', autocomplete: 'off' });

  const saveSettings = async () => {
    const next = { repo: repo.value.trim(), token: token.value.trim() };
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
      h('button', { class: 'wide', onclick: () => saveSettings().catch(() => {}) }, '保存并连接')),
    settings.token ? h('div', { class: 'card' },
      h('p', { class: 'small' }, '数据仓库：', h('a', { href: `https://github.com/${settings.repo || DEFAULT_REPO}`, target: '_blank', rel: 'noopener' }, settings.repo || DEFAULT_REPO),
        '（每次修改都是一次提交，可以在 GitHub 上查看历史）'),
      h('button', { class: 'danger', onclick: logout }, '退出这台设备')) : null);
}

boot();
