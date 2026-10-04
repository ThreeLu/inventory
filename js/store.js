// 物品数据：inventory.json 的读取、查询和修改。
// 所有修改都走 save()：在最新的数据上执行修改函数，连同照片一起作为一次提交写回 GitHub。

import { GitHubError } from './github.js';

const DATA_FILE = 'inventory.json';
const CACHE_KEY = 'inventory-cache';

export const ASSET_MAX = 899999; // 标签编号范围 000-001 ~ 899-999

// 编号前 3 位表示类别：物品按第一个标签，柜子等位置统一用 010，没有标签的物品用 000
export const LOCATION_PREFIX = '010';
export const UNTAGGED_PREFIX = '000';
const RESERVED_PREFIXES = [UNTAGGED_PREFIX, LOCATION_PREFIX];
const DEFAULT_UNLABELED = ['衣服', '运动服', '鞋'];

// 补齐旧数据缺的字段（类别编号、默认不贴标签的类别、提醒天数、标签状态）。每次读到数据都调用。
export function migrate(data) {
  data.tagCodes ||= {};
  if (!data.unlabeledTags) data.unlabeledTags = DEFAULT_UNLABELED.filter((t) => data.tags.includes(t));
  data.reminderDays ||= 30;
  for (const tag of data.tags) if (!data.tagCodes[tag]) data.tagCodes[tag] = nextTagCode(data);
  // 旧版用 labelPrinted 布尔值，现在是 label: 'none' | 'pending' | 'printed'
  for (const x of [...data.items, ...data.locations]) {
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

// 新建时「贴标签」开关的默认值：第一个标签是衣服、鞋这类就默认不贴。编号不受影响，每件都有。
export function defaultLabel(data, tags) {
  return tags.length && data.unlabeledTags.includes(tags[0]) ? 'none' : 'pending';
}

export function prefixForTags(data, tags) {
  return tags.length ? data.tagCodes[tags[0]] || UNTAGGED_PREFIX : UNTAGGED_PREFIX;
}

// 这一类的下一个空号：100-001、100-002……
export function nextAssetInPrefix(data, prefix) {
  let max = 0;
  for (const x of [...data.items, ...data.locations]) {
    if (x.assetId && x.assetId.startsWith(`${prefix}-`)) max = Math.max(max, Number(x.assetId.slice(4)));
  }
  if (max >= 999) throw new Error(`编号 ${prefix}-xxx 已经用完了`);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
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
    if (item.archived) continue;
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

export function normalizeAssetId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^\d{1,6}$/.test(digits)) throw new Error(`编号格式不对：${value}（应该像 000-123）`);
  const n = Number(digits);
  if (n < 1 || n > ASSET_MAX) throw new Error(`编号 ${value} 超出范围（000-001 ~ 899-999）`);
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Store {
  constructor(gh) {
    this.gh = gh;
    this.data = null;
    this.head = null;
  }

  loadCached() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.repo === this.gh.repo) {
        this.data = migrate(cached.data);
        this.head = cached.head;
        return true;
      }
    } catch { /* 缓存坏了就当没有 */ }
    return false;
  }

  writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: this.gh.repo, head: this.head, data: this.data }));
    } catch { /* 存不下就算了，下次从 GitHub 读 */ }
  }

  async load() {
    const head = await this.gh.headSha();
    if (head !== this.head || !this.data) {
      this.data = migrate(JSON.parse(await this.gh.readText(DATA_FILE, head)));
      this.head = head;
      this.writeCache();
    }
  }

  // mutate(data) 直接修改传入的数据并可返回结果；uploads: [{ path, base64 }]；removes: [path]
  async save(message, mutate, { uploads = [], removes = [] } = {}) {
    const blobs = [];
    for (const u of uploads) blobs.push({ path: u.path, sha: await this.gh.createBlob(u.base64) });

    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const base = head === this.head && this.data ? this.data : migrate(JSON.parse(await this.gh.readText(DATA_FILE, head)));
      const next = structuredClone(base);
      const result = mutate(next);
      const changes = [
        { path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' },
        ...blobs,
        ...removes.map((path) => ({ path, remove: true })),
      ];
      try {
        this.head = await this.gh.commit(head, changes, message);
        this.data = next;
        this.writeCache();
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
