import { GitHub } from './github.js';
import { Store, normalizeAssetId, newId, assertAssetFree, ASSET_MAX } from './store.js';
import { h, today, compressImage, blobToBase64, lazyPhoto, photoUrl } from './util.js';
import { makeXlsx } from './xlsx.js';

const SETTINGS_KEY = 'inventory-settings';
const DEFAULT_REPO = 'ThreeLu/inventory-data';
// 二维码里的网址：本页地址 + ?a=编号
const SITE_URL = window.location.origin + window.location.pathname;

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let settings = readSettings();
let gh = null;
let store = null;
let loadError = null;

// ---------- 启动 ----------

function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

function connect() {
  gh = new GitHub({ token: settings.token, repo: settings.repo || DEFAULT_REPO });
  store = new Store(gh);
  store.loadCached();
}

async function refresh() {
  try {
    await store.load();
    loadError = null;
  } catch (e) {
    loadError = e;
  }
  render();
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
  [/^\/a\/([^/]+)$/, (asset) => scanView(decodeURIComponent(asset))],
  [/^\/labels$/, () => labelsView()],
  [/^\/manage$/, () => manageView()],
  [/^\/settings$/, () => settingsView()],
];

function render() {
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
    a.classList.toggle('active', target === '/' ? path === '' || path === '/' : path.startsWith(target));
  }
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

function itemRow(item) {
  const thumb = item.photos?.[0]?.thumb;
  return h('a', { class: `row${item.archived ? ' archived' : ''}`, href: `#/item/${item.id}` },
    thumb ? lazyPhoto(gh, thumb, { class: 'thumb' }) : h('div', { class: 'thumb empty' }, item.name.slice(0, 1)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
      h('div', { class: 'row-meta' },
        assetChip(item.assetId),
        h('span', {}, store.shortName(item.location)),
        item.tags.length ? h('span', {}, item.tags.join('、')) : null,
        item.archived ? h('span', { class: 'badge' }, '已归档') : null)));
}

function locationSelect(value, props = {}, placeholder = '选择位置…') {
  return h('select', { ...props, value: value || '' },
    h('option', { value: '' }, placeholder),
    store.locationTree().map(({ loc, depth }) =>
      h('option', { value: loc.id }, `${'　'.repeat(depth)}${loc.name}`)));
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
      results.replaceChildren(...items.slice(0, shown).map(itemRow));
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

  const page = h('div', {},
    header('物品'),
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

  const archive = async () => {
    const reason = prompt('归档原因（丢失、送人、卖掉、扔掉……），会记在备注里：');
    if (reason === null) return;
    await saving('正在归档…', () => store.save(`归档：${item.name}`, (data) => {
      const it = data.items.find((i) => i.id === id);
      it.archived = true;
      it.notes = [it.notes, `${today()} 归档：${reason || '未写原因'}`].filter(Boolean).join('\n');
      it.updatedAt = new Date().toISOString();
    }));
    render();
  };
  const unarchive = async () => {
    await saving('正在恢复…', () => store.save(`取消归档：${item.name}`, (data) => {
      const it = data.items.find((i) => i.id === id);
      it.archived = false;
      it.notes = [it.notes, `${today()} 取消归档`].filter(Boolean).join('\n');
      it.updatedAt = new Date().toISOString();
    }));
    render();
  };
  const remove = async () => {
    if (!confirm(`彻底删除「${item.name}」？\n\n丢失、送人、扔掉的东西建议用「归档」，记录会保留。`)) return;
    const files = [...(item.photos || []), ...(item.receipts || [])].flatMap((p) => [p.file, p.thumb]);
    await saving('正在删除…', () => store.save(`删除：${item.name}`, (data) => {
      data.items = data.items.filter((i) => i.id !== id);
    }, { removes: files }));
    go('#/', true);
  };

  return h('div', {},
    item.archived ? h('div', { class: 'banner' }, '这件物品已归档') : null,
    gallery(item.photos),
    h('div', { class: 'card' },
      h('h1', { class: 'item-title' }, item.name, item.quantity > 1 ? h('span', { class: 'qty' }, `×${item.quantity}`) : null),
      h('div', { class: 'row-meta' }, assetChip(item.assetId),
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
      item.assetId ? h('a', { class: 'button secondary', href: `#/item/${id}/label` }, '打印标签') : null,
      item.archived
        ? h('button', { class: 'secondary', onclick: unarchive }, '取消归档')
        : h('button', { class: 'secondary', onclick: archive }, '归档'),
      h('button', { class: 'danger', onclick: remove }, '删除')),
    h('p', { class: 'muted small center' },
      `创建于 ${(item.createdAt || '').slice(0, 10)} · 更新于 ${(item.updatedAt || '').slice(0, 10)}`));
}

// ---------- 新建 / 编辑 ----------

function formView(id, q = {}) {
  const existing = id ? store.item(id) : null;
  if (id && !existing) return notFound('找不到这件物品。');
  const itemId = existing?.id || newId('i');
  const draft = existing ? structuredClone(existing) : {
    id: itemId, name: '', assetId: q.asset ? safeAsset(q.asset) : null, location: q.loc || '',
    tags: [], quantity: 1, description: '', fields: {}, photos: [], receipts: [],
    manufacturer: '', modelNumber: '', serialNumber: '', purchaseDate: '', purchasePrice: null,
    purchaseFrom: '', warrantyExpires: '', notes: '', archived: false,
  };
  const added = { photos: [], receipts: [] }; // 新选的照片：{ file, url }
  const removed = [];
  let fieldRows = Object.entries(draft.fields || {}).map(([k, v]) => ({ k, v }));

  const bind = (key, props = {}) => h(props.multiline ? 'textarea' : 'input', {
    ...props, multiline: undefined, value: draft[key] ?? '',
    oninput: (e) => { draft[key] = e.target.value; },
  });

  // 编号：实时检查格式和是否重复
  const assetMsg = h('div', { class: 'hint' }, '贴了标签就填标签上的编号；衣服、鞋子留空。');
  const checkAsset = (value) => {
    assetMsg.classList.remove('error');
    try {
      const norm = normalizeAssetId(value);
      const hit = norm && store.findByAsset(norm);
      if (hit && hit.obj.id !== itemId) throw new Error(`编号 ${norm} 已经被「${hit.obj.name}」用了`);
      assetMsg.textContent = norm ? `编号：${norm}` : '贴了标签就填标签上的编号；衣服、鞋子留空。';
      return norm;
    } catch (e) {
      assetMsg.textContent = e.message;
      assetMsg.classList.add('error');
      return undefined;
    }
  };

  // 照片区：已有的 + 新加的，都可以删
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

  // 标签和自定义字段：选了「衣服」就提示季节、颜色、尺码等字段
  const tagBox = h('div', { class: 'chips' });
  const fieldBox = h('div', {});
  const drawTags = () => {
    tagBox.replaceChildren(...store.data.tags.map((t) => h('button', {
      type: 'button', class: `chip${draft.tags.includes(t) ? ' on' : ''}`,
      onclick: () => {
        draft.tags = draft.tags.includes(t) ? draft.tags.filter((x) => x !== t) : [...draft.tags, t];
        drawTags();
        drawFields();
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

  const save = async () => {
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
      const record = { ...draft, photos: [...draft.photos, ...fresh.photos], receipts: [...draft.receipts, ...fresh.receipts] };
      await store.save(`${existing ? '修改' : '新建'}：${draft.name}`, (data) => {
        assertAssetFree(data, record.assetId, itemId);
        if (existing) {
          const i = data.items.findIndex((x) => x.id === itemId);
          if (i < 0) throw new Error('这件物品已经在别处被删除了');
          data.items[i] = { ...record, createdAt: data.items[i].createdAt, updatedAt: now };
        } else {
          data.items.push({ ...record, createdAt: now, updatedAt: now });
        }
      }, { uploads, removes: removed.flatMap((p) => [p.file, p.thumb]) });
    });
    toast('已保存');
    go(`#/item/${itemId}`, true);
  };

  const assetInput = h('input', {
    value: draft.assetId || '', inputmode: 'numeric', placeholder: '例如 000-123',
    oninput: (e) => checkAsset(e.target.value),
  });
  if (draft.assetId) checkAsset(draft.assetId);

  return h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save().catch(() => {}); } },
    header(existing ? '编辑物品' : '新建物品'),
    photoSection('photos', '照片'),
    h('label', {}, '名称', bind('name', { placeholder: '例如 黑色羽绒服（优衣库）', required: true })),
    h('label', {}, '编号', assetInput, assetMsg),
    h('label', {}, '位置', locationSelect(draft.location, { onchange: (e) => { draft.location = e.target.value; } })),
    h('div', { class: 'label' }, '标签', tagBox),
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
      h('button', { type: 'button', class: 'secondary', onclick: () => history.back() }, '取消')));
}

function safeAsset(value) {
  try { return normalizeAssetId(value); } catch { return null; }
}

// ---------- 扫码 ----------

function scanView(raw) {
  let asset;
  try { asset = normalizeAssetId(raw); } catch (e) { return notFound(e.message); }
  const hit = store.findByAsset(asset);
  if (hit) {
    setTimeout(() => go(hit.type === 'item' ? `#/item/${hit.obj.id}` : `#/place/${hit.obj.id}`, true));
    return h('p', { class: 'muted center' }, '正在打开…');
  }
  const select = locationSelect('');
  const bindToLocation = async () => {
    if (!select.value) return toast('请先选择位置', 'error');
    const locId = select.value;
    await saving('正在保存…', () => store.save(`设置位置编号：${asset}`, (data) => {
      assertAssetFree(data, asset, locId);
      data.locations.find((l) => l.id === locId).assetId = asset;
    }));
    go(`#/place/${locId}`, true);
  };
  return h('div', {},
    header('还没有建档'),
    h('div', { class: 'card' },
      h('p', {}, '编号 ', h('span', { class: 'asset' }, asset), ' 还没有对应的物品。'),
      h('a', { class: 'button wide', href: `#/new?asset=${asset}` }, '用这个编号新建物品')),
    h('div', { class: 'card' },
      h('p', {}, '这张标签贴在柜子上？把它设为柜子的编号：'),
      select, h('button', { class: 'secondary wide', onclick: () => bindToLocation().catch(() => {}) }, '设为这个位置的编号')));
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
    const value = prompt('这个位置的标签编号（留空表示不贴标签）：', loc.assetId || '');
    if (value === null) return;
    let asset;
    try { asset = normalizeAssetId(value); } catch (e) { return toast(e.message, 'error'); }
    await saving('正在保存…', () => store.save(`设置位置编号：${loc.name}`, (data) => {
      assertAssetFree(data, asset, id);
      data.locations.find((l) => l.id === id).assetId = asset;
    }));
    render();
  };
  return h('div', {},
    h('p', { class: 'muted small' }, store.locationPath(loc.parent) || '　'),
    header(loc.name),
    h('div', { class: 'row-meta' }, assetChip(loc.assetId),
      h('button', { class: 'link', onclick: () => setAsset().catch(() => {}) }, loc.assetId ? '修改编号' : '设置标签编号'),
      loc.assetId ? h('a', { href: `#/place/${id}/label` }, '打印标签') : null),
    store.children(id).length ? h('div', { class: 'chips' }, store.children(id).map((c) =>
      h('a', { class: 'chip', href: `#/place/${c.id}` }, c.name.split(' ')[0]))) : null,
    h('p', { class: 'muted' }, `${items.length} 件`),
    h('div', { class: 'list' }, items.map(itemRow)),
    h('a', { class: 'button wide', href: `#/new?loc=${id}` }, '在这里新建物品'));
}

// ---------- 标签 ----------

function formatAsset(n) {
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

function labelsView() {
  const next = store.maxAssetNumber() + 1;
  const start = h('input', { value: formatAsset(next), inputmode: 'numeric' });
  const count = h('input', { type: 'number', value: 30, min: 1, max: 500 });

  const download = () => {
    let first;
    try { first = Number(normalizeAssetId(start.value).replace('-', '')); } catch (e) { return toast(e.message, 'error'); }
    const n = Math.max(1, Math.min(500, Number(count.value) || 0));
    if (first + n - 1 > ASSET_MAX) return toast('超出编号范围（最大 899-999）', 'error');
    const ids = Array.from({ length: n }, (_, i) => formatAsset(first + i));
    const used = ids.filter((a) => store.findByAsset(a));
    if (used.length && !confirm(`这些编号已经用过了：${used.slice(0, 5).join('、')}${used.length > 5 ? '…' : ''}\n还要继续生成吗？`)) return;
    const blob = makeXlsx([['编号', '二维码'], ...ids.map((a) => [a, `${SITE_URL}?a=${a}`])], '标签');
    const a = h('a', { href: URL.createObjectURL(blob), download: `labels_${ids[0]}_${ids[ids.length - 1]}.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
  };

  return h('div', {},
    header('批量标签'),
    h('div', { class: 'card' },
      h('p', {}, '已经用到的最大编号：', h('span', { class: 'asset' }, next > 1 ? formatAsset(next - 1) : '无')),
      h('label', {}, '起始编号', start),
      h('label', {}, '张数', count),
      h('button', { class: 'wide', onclick: download }, '下载 Excel')),
    h('div', { class: 'card' },
      h('h3', {}, '在汉码 App 里打印（汉印 M1，40×30mm）'),
      h('ol', {},
        h('li', {}, '把下载的 Excel 发到手机（微信文件传输助手等）。'),
        h('li', {}, '汉码里新建 40×30mm 标签，加一个二维码，内容绑定 Excel 的「二维码」列，尽量放大。'),
        h('li', {}, '加一个文本，内容绑定「编号」列，字放大。'),
        h('li', {}, '导入 Excel，批量打印。')),
      h('p', { class: 'muted small' }, '二维码内容示例：', `${SITE_URL}?a=${formatAsset(next)}`)));
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
  return h('div', {},
    header('标签'),
    h('div', { class: 'card center' }, img,
      h('p', { class: 'muted small' }, '40×30mm。手机上长按图片保存到相册，再在汉码 App 里用「图片打印」。'),
      h('a', { class: 'button', href: img.src, download: `label_${obj.assetId}.png` }, '下载图片')));
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
    save(`新建标签：${name.trim()}`, (data) => { data.tags.push(name.trim()); });
  };
  const renameTag = (tag) => {
    const name = prompt('新名称：', tag);
    if (!name?.trim() || name.trim() === tag) return;
    if (store.data.tags.includes(name.trim())) return toast('已经有这个标签了', 'error');
    save(`标签改名：${tag} → ${name.trim()}`, (data) => {
      data.tags = data.tags.map((t) => (t === tag ? name.trim() : t));
      for (const it of data.items) it.tags = it.tags.map((t) => (t === tag ? name.trim() : t));
      if (data.fieldPresets?.[tag]) { data.fieldPresets[name.trim()] = data.fieldPresets[tag]; delete data.fieldPresets[tag]; }
    });
  };
  const deleteTag = (tag) => {
    const used = store.data.items.filter((i) => i.tags.includes(tag)).length;
    if (!confirm(`删除标签「${tag}」？${used ? `\n有 ${used} 件物品用了它，会从这些物品上去掉。` : ''}`)) return;
    save(`删除标签：${tag}`, (data) => {
      data.tags = data.tags.filter((t) => t !== tag);
      for (const it of data.items) it.tags = it.tags.filter((t) => t !== tag);
      if (data.fieldPresets) delete data.fieldPresets[tag];
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
      store.data.tags.map((tag) => h('div', { class: 'manage-row' },
        h('span', { class: 'grow' }, tag),
        h('button', { class: 'link', onclick: () => renameTag(tag) }, '改名'),
        h('button', { class: 'link danger-text', onclick: () => deleteTag(tag) }, '删除'))),
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
