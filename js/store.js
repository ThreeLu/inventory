// 物品数据：inventory.json 的读取、查询和修改。
// 所有修改都走 save()：先改手机上的数据、页面立刻更新，后台再合并进 GitHub 上最新的数据（见下面 Store）。

import { GitHubError } from './github.js';

const DATA_FILE = 'inventory.json';
// AI 等服务的密钥放在私有数据仓库里，所有设备共用；不放进 inventory.json，导出、发给 AI 时都不会带上
const CONFIG_FILE = 'config/ai.json';
const CACHE_KEY = 'inventory-cache';

// 编号格式 XXX-YYYY：前 3 位类别（000～899），后 4 位顺序号（0001～9999）
export const PREFIX_MAX = 899;
export const SEQ_MAX = 9999;
const formatAsset = (prefix, n) => `${String(prefix).padStart(3, '0')}-${String(n).padStart(4, '0')}`;

// 编号前 3 位表示类别：物品按类别，柜子等位置统一用 010，没有类别的物品用 000
export const LOCATION_PREFIX = '010';
export const UNTAGGED_PREFIX = '000';
const RESERVED_PREFIXES = [UNTAGGED_PREFIX, LOCATION_PREFIX];
const DEFAULT_UNLABELED = ['衣服', '运动服', '鞋'];
const DEFAULT_CONSUMABLE = ['零食食品', '药品急救', '洗漱护肤', '清洁用品'];
export const ARCHIVE_REASONS = ['扔掉', '用完不再买', '送人', '卖掉', '丢失', '坏了', '其他'];

// 补齐旧数据缺的字段（类别编号、默认不贴标签的类别、提醒天数、标签状态）。每次读到数据都调用。
export function migrate(data) {
  data.tagCodes ||= {};
  if (!data.unlabeledTags) data.unlabeledTags = DEFAULT_UNLABELED.filter((t) => data.tags.includes(t));
  if (!data.consumableTags) data.consumableTags = DEFAULT_CONSUMABLE.filter((t) => data.tags.includes(t));
  data.reminderDays ||= 30;
  for (const tag of data.tags) if (!data.tagCodes[tag]) data.tagCodes[tag] = nextTagCode(data);
  // 每类用到过的最大编号：删除东西也不会往回退，所以编号永不复用
  data.assetHighWater ||= {};
  bumpHighWater(data);
  for (const item of data.items) {
    if (item.tags.length > 1) item.tags = item.tags.slice(0, 1); // 一件东西只有一个类别
    if (item.consumable === undefined) item.consumable = defaultConsumable(data, item.tags);
  }
  data.trips ||= [];
  data.prefs ||= {};
  // 贴身衣物第二天自动收回
  for (const it of data.items) {
    if (it.laundry?.autoReturn && it.laundry.autoReturn <= localDay()) { delete it.laundry; it.wearsSinceWash = 0; }
  }
  // 衣服加上部位、厚薄、风格（今天穿什么靠这些搭配）
  const want = { 衣服: ['部位', '季节', '厚薄', '风格', '颜色', '尺码'], 运动服: ['部位', '季节', '厚薄', '颜色', '尺码'], 鞋: ['季节', '风格', '颜色', '尺码'] };
  data.fieldPresets ||= {};
  for (const [tag, keys] of Object.entries(want)) {
    if (!data.tags.includes(tag)) continue;
    const have = data.fieldPresets[tag] || [];
    data.fieldPresets[tag] = [...have, ...keys.filter((k) => !have.includes(k))];
  }
  // 旧版用 labelPrinted 布尔值，现在是 label: 'none' | 'pending' | 'printed'；旧版编号后段 3 位，现在 4 位
  for (const x of [...data.items, ...data.locations]) {
    if (x.assetId && /^\d{3}-\d{3}$/.test(x.assetId)) x.assetId = `${x.assetId.slice(0, 4)}0${x.assetId.slice(4)}`;
    if (!x.label) x.label = !x.assetId ? 'none' : x.labelPrinted === true ? 'printed' : 'pending';
    delete x.labelPrinted;
  }
  return data;
}

// 标签状态
export const LABEL_TEXT = { none: '不贴', pending: '待打印', printed: '已打印' };

export function setLabel(obj, state) {
  obj.label = state;
  if (state === 'printed') obj.labelPrintedAt = new Date().toISOString().slice(0, 10);
}

export function nextTagCode(data) {
  const used = new Set([...RESERVED_PREFIXES, ...Object.values(data.tagCodes || {})]);
  for (let n = 100; n <= 890; n += 10) {
    const code = String(n).padStart(3, '0');
    if (!used.has(code)) return code;
  }
  for (let n = 1; n <= 899; n++) {
    const code = String(n).padStart(3, '0');
    if (!used.has(code)) return code;
  }
  throw new Error('类别编号用完了');
}

// 记下每类出现过的最大编号。每次保存前都调用（Store.save 里统一处理）
export function bumpHighWater(data) {
  for (const x of [...data.items, ...data.locations]) {
    if (!x.assetId) continue;
    const [prefix, n] = [x.assetId.slice(0, 3), Number(x.assetId.slice(4))];
    if (!(data.assetHighWater[prefix] >= n)) data.assetHighWater[prefix] = n;
  }
}

// 新建时「消耗品」开关的默认值：类别在 consumableTags 里
export function defaultConsumable(data, tags) {
  return Boolean(tags.length && data.consumableTags.includes(tags[0]));
}

// ---------- 洗衣 ----------
// item.laundry = { state: 'dirty'（待洗）| 'washing'（在洗在晾）, since, autoReturn? }；没有就是干净的
// item.wearsSinceWash：上次洗后穿了几次，用来决定晚上问「要洗吗」时默认勾不勾
export const INTIMATE_PARTS = ['内衣', '袜子']; // 贴身衣物：每天洗，第二天自动收回
// 穿几次默认勾「要洗」：当天最高温低于 coldBelow 按秋冬（cold），否则按春夏（warm）
export const LAUNDRY_DEFAULTS = {
  warm: { 上衣: 1, 下装: 3, 外套: 5 }, cold: { 上衣: 3, 下装: 5, 外套: 12 }, coldBelow: 20, count: 8, days: 4, bedding: 14,
};
export function laundryPrefs(data) {
  const p = data.prefs?.laundry || {};
  const D = LAUNDRY_DEFAULTS;
  return { ...D, ...p, warm: { ...D.warm, ...(p.warm || {}) }, cold: { ...D.cold, ...(p.cold || {}) } };
}

// 记录今天穿的（可以一天改几次）：新选的穿着次数 +1，取消的 -1
export function setTodayWear(data, ids, day) {
  for (const it of data.items) {
    const was = (it.worn || []).includes(day);
    const now = ids.includes(it.id);
    if (now && !was) {
      it.worn = [...(it.worn || []), day].slice(-90);
      it.wearsSinceWash = (it.wearsSinceWash || 0) + 1;
    } else if (!now && was && !INTIMATE_PARTS.includes(it.fields?.['部位'])) {
      it.worn = it.worn.filter((d) => d !== day);
      it.wearsSinceWash = Math.max(0, (it.wearsSinceWash || 0) - 1);
    }
  }
}

export function localDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysSince = (day) => Math.floor((new Date(localDay()) - new Date(day)) / 86400000);

export function laundryStatus(data) {
  const p = laundryPrefs(data);
  const live = data.items.filter((i) => !i.archived);
  const dirty = live.filter((i) => i.laundry?.state === 'dirty');
  const washing = live.filter((i) => i.laundry?.state === 'washing' && !i.laundry.autoReturn);
  const oldest = dirty.reduce((m, i) => Math.max(m, daysSince(i.laundry.since)), 0);
  const bedding = live.filter((i) => i.tags[0] === '床上用品' && !i.laundry)
    .map((i) => ({ item: i, days: daysSince(i.lastWashed || (i.createdAt || localDay()).slice(0, 10)) }))
    .filter((b) => b.days >= p.bedding);
  return { dirty, washing, oldest, due: dirty.length >= p.count || (dirty.length > 0 && oldest >= p.days), bedding };
}

// 洗衣服时按颜色、材质分批
export function laundryBatches(items) {
  const groups = { 单独洗或送洗: [], 床品: [], 浅色: [], 深色: [], 彩色: [] };
  for (const it of items) {
    const color = `${it.fields?.['颜色'] || ''} ${it.name}`;
    if (/羽绒|羊毛|羊绒|真丝|丝绸|西装|大衣|呢子/.test(it.name)) groups['单独洗或送洗'].push(it);
    else if (it.tags[0] === '床上用品') groups['床品'].push(it);
    else if (/白|米|浅|杏|奶|粉|淡/.test(color)) groups['浅色'].push(it);
    else if (/黑|深|藏青|藏蓝|灰|咖|棕|墨|军绿/.test(color)) groups['深色'].push(it);
    else groups['彩色'].push(it);
  }
  return Object.entries(groups).filter(([, xs]) => xs.length);
}

// 位置的 box 字段：'move' 搬家纸箱、'trip' 出行的行李箱（都是临时的，东西装进去会记住原位置）；
// 'bag' 收纳袋（常驻，平时放在某个柜子里，里面的东西算在家，扫袋子 = 扫里面登记的全部东西）
export function isBox(data, locId) {
  const box = data.locations.find((l) => l.id === locId)?.box;
  return box === 'move' || box === 'trip';
}

export function isBag(data, locId) {
  return data.locations.find((l) => l.id === locId)?.box === 'bag';
}

// 「家」：宿舍以外的地方，回家时留在家里的东西放这里。没有就建一个
export function ensureHome(data) {
  let home = data.locations.find((l) => l.home);
  if (!home) {
    home = { id: newId('L'), name: '家 Home', parent: null, assetId: null, label: 'none', home: true };
    data.locations.push(home);
  }
  return home.id;
}

// 移动物品。装进箱子时记住原来的位置（homeLocation），拿出箱子时清掉，方便「全部放回原处」
export function moveItem(data, item, target) {
  if (item.location === target) return;
  if (isBox(data, target)) {
    if (!isBox(data, item.location)) item.homeLocation = item.location;
  } else {
    delete item.homeLocation;
  }
  item.location = target;
  item.updatedAt = new Date().toISOString();
}

// 借阅（从图书馆借来的书）：item.borrow = { from, date, due, renewals }。还书前 3 天开始提醒
export const BORROW_REMIND_DAYS = 3;
export function borrowStatus(item, today = new Date()) {
  if (!item.borrow || item.archived) return null;
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const left = Math.round((parseDate(item.borrow.due) - t0) / 86400000);
  return { left, overdue: left < 0, soon: left <= BORROW_REMIND_DAYS };
}

// 消耗品数量为 0 就是「用完了」，等着补货
export function isDepleted(item) {
  return Boolean(item.consumable && Number(item.quantity) === 0);
}

// ---------- 购物清单 ----------
// 每周日去买一次。清单 = 用完的 + 点过「快用完了」的 + 剩余数量到提醒线的 + 14 天内过期要换新的 + 手动加的。
// 每样有个 key（物品是 i:<id>，手动加的是 m:<id>），勾选状态只存在手机上，买回来才写进仓库。
export const SHOP_EXPIRY_DAYS = 14;
export function shoppingData(data) {
  data.shopping ||= {};
  const s = data.shopping;
  s.extra ||= []; s.skip ||= {}; s.history ||= []; s.toFile ||= [];
  return s;
}
// 这一周（从周日算起）的第一天，AI 建议一周生成一次就按它
export function shopWeek(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function shoppingList(data, now = new Date()) {
  const s = data.shopping || {};
  const day = localDay();
  const skipped = (key) => s.skip?.[key] && s.skip[key] > day;
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const out = [];
  for (const item of data.items) {
    if (item.archived || item.borrow) continue;
    const key = `i:${item.id}`;
    if (skipped(key)) continue;
    const qty = Number(item.quantity) || 0;
    let why = null;
    if (item.consumable && qty === 0) why = '已用完';
    else if (item.consumable && item.runningLow) why = '快用完了';
    else if (item.consumable && item.lowAt > 0 && qty <= item.lowAt) why = `只剩 ${qty}`;
    let expiring = false;
    const exp = parseDate(item.fields?.['保质期']);
    if (!why && exp) {
      const left = Math.round((exp - today0) / 86400000);
      if (left <= SHOP_EXPIRY_DAYS) { why = left < 0 ? '已过期，买新的换掉' : `${item.fields['保质期']} 过期，买新的换掉`; expiring = true; }
    }
    if (why) out.push({ key, item, name: item.name, why, expiring });
  }
  for (const e of s.extra || []) {
    if (!skipped(`m:${e.id}`)) out.push({ key: `m:${e.id}`, extra: e, name: e.name, why: e.note || '自己加的' });
  }
  return out;
}

// 新建时「贴标签」开关的默认值：类别是衣服、鞋这类就默认不贴。编号不受影响，每件都有。
export function defaultLabel(data, tags) {
  return tags.length && data.unlabeledTags.includes(tags[0]) ? 'none' : 'pending';
}

export function prefixForTags(data, tags) {
  return tags.length ? data.tagCodes[tags[0]] || UNTAGGED_PREFIX : UNTAGGED_PREFIX;
}

// 这一类的下一个号：100-001、100-002……。用过的号（包括已删除的）永远不再分配
export function nextAssetInPrefix(data, prefix) {
  let max = data.assetHighWater?.[prefix] || 0;
  for (const x of [...data.items, ...data.locations]) {
    if (x.assetId && x.assetId.startsWith(`${prefix}-`)) max = Math.max(max, Number(x.assetId.slice(4)));
  }
  if (max >= SEQ_MAX) throw new Error(`编号 ${prefix}-xxxx 已经用完了`);
  return formatAsset(prefix, max + 1);
}

// 到期提醒：零食药品的「保质期」字段、电子产品的保修到期。返回 [{ item, kind, date, days }]，按剩余天数排序
export function parseDate(text) {
  const m = String(text || '').trim().match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null];
  return d ? new Date(y, mo - 1, d) : new Date(y, mo, 0); // 只写到月份时按月底算
}

export function reminders(data, days = data.reminderDays || 30) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (const item of data.items) {
    if (item.archived || isDepleted(item)) continue; // 归档的、用完的不提醒
    const checks = [['保质期', item.fields?.['保质期']], ['保修', item.warrantyExpires]];
    for (const [kind, text] of checks) {
      const date = parseDate(text);
      if (!date) continue;
      const left = Math.round((date - today) / 86400000);
      // 过期的食品药品一直提醒到归档为止；保修过期 30 天后就不再提
      if (left <= days && (kind === '保质期' || left >= -30)) out.push({ item, kind, date: text, days: left });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

// 290-1、290-001、290-0001、2900001 都认成 290-0001；旧版 6 位（290001）也认
export function normalizeAssetId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).replace(/\s/g, '');
  let m = text.match(/^(\d{1,3})-(\d{1,4})$/);
  if (!m && /^\d{6,7}$/.test(text)) m = [text, text.slice(0, 3), text.slice(3)];
  if (!m) throw new Error(`编号格式不对：${value}（应该像 290-0001）`);
  const [prefix, n] = [Number(m[1]), Number(m[2])];
  if (prefix > PREFIX_MAX || n < 1 || n > SEQ_MAX) throw new Error(`编号 ${value} 超出范围（前 3 位 000～899，后 4 位 0001～9999）`);
  return formatAsset(prefix, n);
}

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 先存手机、后台上传 ----------
//
// save() 在本地数据上执行修改，算出「改了什么」（patch），放进待上传队列（localStorage），页面立刻更新；
// 后台 sync() 读 GitHub 上最新的 inventory.json，把队列里的 patch 按顺序套上去，提交一次。
// 没信号也能改；两台设备各改各的也不会互相覆盖（按每件物品、每个位置合并，同一件两边都改了以后改的为准）。
// 和账本（ledger/js/store.js）是同一套做法。
//
// patch 的格式：
//   coll: { 列表名: { up: [新增或改过的对象], del: [删掉的 id], order: [id 顺序] | null } }   ← 元素都带 id 的列表（items、locations……）
//   obj:  { 键: { 字段: 新值 | DEL } }                                                         ← 普通对象（prefs、shopping……），按字段合并
//   sets: { 键: 新值 | DEL }                                                                   ← 其他（tags 这种没有 id 的列表），整个替换
//
// 带照片（要先传文件）、删照片文件的修改走 online：直接提交，没网就失败。

const QUEUE_KEY = 'inventory-queue';
const DEL = { __del: true };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isColl = (x) => Array.isArray(x) && x.every((o) => o && typeof o === 'object' && !Array.isArray(o) && 'id' in o);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function diff(base, next) {
  const patch = { coll: {}, obj: {}, sets: {} };
  for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const a = base[k];
    const b = next[k];
    if (same(a, b)) continue;
    if (b === undefined) { patch.sets[k] = DEL; continue; }
    if (isColl(b) && (a === undefined || isColl(a))) {
      const old = new Map((a || []).map((o) => [o.id, o]));
      const ids = new Set(b.map((o) => o.id));
      const kept = (a || []).map((o) => o.id).filter((id) => ids.has(id));
      const now = b.map((o) => o.id).filter((id) => old.has(id));
      patch.coll[k] = {
        up: b.filter((o) => !old.has(o.id) || !same(old.get(o.id), o)),
        del: (a || []).map((o) => o.id).filter((id) => !ids.has(id)),
        order: same(kept, now) ? null : b.map((o) => o.id),
      };
    } else if (isObj(a) && isObj(b)) {
      const fields = {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!same(a[f], b[f])) fields[f] = b[f] === undefined ? DEL : b[f];
      }
      patch.obj[k] = fields;
    } else {
      patch.sets[k] = b;
    }
  }
  return patch;
}

export const emptyPatch = (p) => !Object.keys(p.coll).length && !Object.keys(p.obj).length && !Object.keys(p.sets).length;

export function apply(data, patch) {
  const copy = (v) => structuredClone(v);
  for (const [k, v] of Object.entries(patch.sets || {})) {
    if (v && v.__del) delete data[k]; else data[k] = copy(v);
  }
  for (const [k, fields] of Object.entries(patch.obj || {})) {
    if (!isObj(data[k])) data[k] = {};
    for (const [f, v] of Object.entries(fields)) {
      if (v && v.__del) delete data[k][f]; else data[k][f] = copy(v);
    }
  }
  for (const [k, { up = [], del = [], order = null }] of Object.entries(patch.coll || {})) {
    let arr = Array.isArray(data[k]) ? data[k] : [];
    const gone = new Set(del);
    arr = arr.filter((o) => !gone.has(o.id));
    for (const o of up) {
      const i = arr.findIndex((x) => x.id === o.id);
      if (i >= 0) arr[i] = copy(o); else arr.push(copy(o));
    }
    if (order) {
      const pos = new Map(order.map((id, i) => [id, i]));
      arr = arr.map((o, i) => ({ o, i })).sort((x, y) => (pos.get(x.o.id) ?? 1e9 + x.i) - (pos.get(y.o.id) ?? 1e9 + y.i)).map((x) => x.o);
    }
    data[k] = arr;
  }
  return data;
}

function newAssetIds(before, after) {
  const old = new Map([...before.items, ...before.locations].map((x) => [x.id, x.assetId]));
  return [...after.items, ...after.locations].some((x) => x.assetId && old.get(x.id) !== x.assetId);
}

export class Store {
  constructor(gh) {
    this.gh = gh;
    this.remote = null; // GitHub 上的数据（最后一次读到 / 提交的）
    this.data = null; // 页面上看到的 = remote + 还没上传的修改
    this.head = null;
    this.queue = this.readQueue();
    this.status = { state: this.queue.length ? 'pending' : 'ok', error: '', pending: this.queue.length };
    this.onStatus = () => {};
    this.syncing = null;
    this.retryTimer = null;
  }

  readQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      return q && q.repo === this.gh.repo ? q.items : [];
    } catch { return []; }
  }

  writeQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify({ repo: this.gh.repo, items: this.queue })); } catch { /* 存不下：至少这次打开里还在 */ }
  }

  setStatus(state, error = '') {
    this.status = { state, error, pending: this.queue.length };
    this.onStatus(this.status);
  }

  rebuild() {
    this.data = this.remote ? this.queue.reduce((d, q) => apply(d, q.patch), migrate(structuredClone(this.remote))) : null;
  }

  loadCached() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.repo === this.gh.repo && cached.data) {
        this.remote = migrate(cached.data);
        this.head = cached.head;
        this.rebuild();
        return true;
      }
    } catch { /* 缓存坏了就当没有 */ }
    return false;
  }

  writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: this.gh.repo, head: this.head, data: this.remote }));
    } catch { /* 存不下就算了，下次从 GitHub 读 */ }
  }

  async readData(ref) {
    return migrate(JSON.parse(await this.gh.readText(DATA_FILE, ref)));
  }

  async load() {
    const head = await this.gh.headSha();
    // 用缓存打开时数据可能没变（head 相同），但 AI 设置不在缓存里，也要读一次
    if (this.config === undefined) this.config = await this.readConfig(head);
    if (head !== this.head || !this.remote) {
      this.config = await this.readConfig(head);
      this.remote = await this.readData(head);
      this.head = head;
      this.rebuild();
      this.writeCache();
    }
    if (this.queue.length) this.sync();
  }

  async readConfig(ref) {
    return (await this.readJson(CONFIG_FILE, ref)) || {};
  }

  // 读数据仓库里的一个 JSON 文件；不存在返回 null
  async readJson(path, ref = this.head || 'main') {
    try {
      return JSON.parse(await this.gh.readText(path, ref));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  // 改一个 JSON 文件（不是 inventory.json）：在最新内容上执行 mutate，冲突就重试
  async saveJson(path, mutate, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const next = mutate(structuredClone((await this.readJson(path, head)) || {}));
      try {
        const sha = await this.gh.commit(head, [{ path, content: JSON.stringify(next, null, 1) + '\n' }], message);
        if (path === CONFIG_FILE) this.config = next;
        if (head === this.head) this.head = sha; // inventory.json 没变，缓存还能用
        return next;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
      }
    }
  }

  // 写 config/ai.json（整个替换）
  saveConfig(config, message) {
    return this.saveJson(CONFIG_FILE, () => config, message);
  }

  // mutate(data) 直接修改传入的数据并可返回结果（返回 false 表示不用改）。
  // 默认先存手机、后台上传；uploads: [{ path, base64 }]、removes: [path] 或 online 时直接提交到 GitHub（要等、要有网）。
  async save(message, mutate, { uploads = [], removes = [], online = false } = {}) {
    if (uploads.length || removes.length || online) return this.saveOnline(message, mutate, { uploads, removes });
    if (!this.data) throw new Error('数据还没读出来');
    const next = structuredClone(this.data);
    const result = mutate(next);
    if (result === false) return false;
    // 分了新编号（新建物品、箱子，改编号）：要在 GitHub 最新的数据上分，别的设备可能刚用了这个号，所以直接提交
    if (newAssetIds(this.data, next)) return this.saveOnline(message, mutate, { uploads, removes });
    bumpHighWater(next);
    const patch = diff(this.data, next);
    if (emptyPatch(patch)) return result;
    this.queue.push({ id: newId('q'), message, patch, at: new Date().toISOString() });
    this.writeQueue();
    this.data = next;
    this.setStatus('pending');
    this.sync();
    return result;
  }

  // 把队列里的修改合并进 GitHub 上最新的数据，一次提交
  sync() {
    if (this.syncing) return this.syncing;
    clearTimeout(this.retryTimer);
    this.syncing = (async () => {
      for (let attempt = 0; this.queue.length && attempt < 5; attempt++) {
        const batch = this.queue.slice();
        this.setStatus('syncing');
        try {
          const head = await this.gh.headSha();
          const base = head === this.head && this.remote ? this.remote : await this.readData(head);
          const next = batch.reduce((d, q) => apply(d, q.patch), structuredClone(base));
          bumpHighWater(next);
          const msg = batch.length === 1 ? batch[0].message : `${batch[0].message}（等 ${batch.length} 项）`;
          const sha = await this.gh.commit(head, [{ path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' }], msg);
          const done = new Set(batch.map((q) => q.id));
          this.queue = this.queue.filter((q) => !done.has(q.id));
          this.writeQueue();
          this.remote = next;
          this.head = sha;
          this.writeCache();
          this.rebuild();
          attempt = -1; // 成功了：同步期间又改的，接着传
        } catch (e) {
          if (e instanceof GitHubError && e.status === 422) continue; // 别的设备刚提交过：重读再来
          const offline = !(e instanceof GitHubError) || e.status === 0;
          this.setStatus(offline ? 'offline' : 'error', e.message);
          // 过一会儿自动再试；有网了也会马上试（main.js 监听 online）
          this.retryTimer = setTimeout(() => this.sync(), offline ? 20000 : 60000);
          return;
        }
      }
      this.setStatus(this.queue.length ? 'pending' : 'ok');
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  // 等队列传完（传不上去就报错）：直接提交之前先把手机上的修改传上去，免得顺序乱
  async flush() {
    if (!this.queue.length) return;
    await this.sync();
    if (this.queue.length) throw new Error('现在连不上 GitHub，等有网了再试');
  }

  async saveOnline(message, mutate, { uploads, removes }) {
    await this.flush();
    const blobs = [];
    for (const u of uploads) blobs.push({ path: u.path, sha: await this.gh.createBlob(u.base64) });
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const base = head === this.head && this.remote ? this.remote : await this.readData(head);
      const next = structuredClone(base);
      const result = mutate(next);
      if (result === false) return false;
      bumpHighWater(next);
      const changes = [
        { path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' },
        ...blobs,
        ...removes.map((path) => ({ path, remove: true })),
      ];
      try {
        this.head = await this.gh.commit(head, changes, message);
        this.remote = next;
        this.writeCache();
        this.rebuild();
        return result;
      } catch (e) {
        // 422：别的设备刚提交过，分支不是我们基于的那个提交了，重新读最新数据再来
        if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
      }
    }
  }

  // 查询
  location(id) { return this.data.locations.find((l) => l.id === id); }
  item(id) { return this.data.items.find((i) => i.id === id); }

  locationPath(id, sep = ' / ') {
    const parts = [];
    for (let loc = this.location(id); loc; loc = this.location(loc.parent)) parts.unshift(loc.name);
    return parts.join(sep);
  }

  shortName(locId) {
    const loc = this.location(locId);
    return loc ? loc.name.split(' ')[0] : '（位置已删除）';
  }

  children(parentId) {
    return this.data.locations.filter((l) => l.parent === parentId).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  // 按树的顺序展开所有位置：[{ loc, depth }]
  locationTree() {
    const out = [];
    const walk = (parent, depth) => {
      for (const loc of this.children(parent)) {
        out.push({ loc, depth });
        walk(loc.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  descendantIds(locId) {
    const ids = new Set([locId]);
    for (const { loc } of this.locationTree()) if (ids.has(loc.parent)) ids.add(loc.id);
    return ids;
  }

  itemsIn(locId, { archived = false } = {}) {
    const ids = this.descendantIds(locId);
    return this.data.items.filter((i) => ids.has(i.location) && (archived || !i.archived));
  }

  findByAsset(assetId) {
    const item = this.data.items.find((i) => i.assetId === assetId);
    if (item) return { type: 'item', obj: item };
    const loc = this.data.locations.find((l) => l.assetId === assetId);
    if (loc) return { type: 'location', obj: loc };
    return null;
  }

  // 某种标签状态的物品和位置（不含已归档的物品），按编号排序
  labeled(state) {
    return [
      ...this.data.locations.filter((l) => l.assetId && l.label === state).map((obj) => ({ type: 'location', obj })),
      ...this.data.items.filter((i) => i.assetId && i.label === state && !i.archived).map((obj) => ({ type: 'item', obj })),
    ].sort((a, b) => a.obj.assetId.localeCompare(b.obj.assetId));
  }

  pendingLabels() { return this.labeled('pending'); }
}

// 修改数据时用的检查：编号不能和别的物品或位置重复
export function assertAssetFree(data, assetId, selfId) {
  if (!assetId) return;
  const hit = [...data.items, ...data.locations].find((x) => x.assetId === assetId && x.id !== selfId);
  if (hit) throw new Error(`编号 ${assetId} 已经被「${hit.name}」用了`);
}
