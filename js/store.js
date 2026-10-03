// 物品数据：inventory.json 的读取、查询和修改。
// 所有修改都走 save()：在最新的数据上执行修改函数，连同照片一起作为一次提交写回 GitHub。

import { GitHubError } from './github.js';

const DATA_FILE = 'inventory.json';
const CACHE_KEY = 'inventory-cache';

export const ASSET_MAX = 899999; // 标签编号范围 000-001 ~ 899-999

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
        this.data = cached.data;
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
      this.data = JSON.parse(await this.gh.readText(DATA_FILE, head));
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
      const base = head === this.head && this.data ? this.data : JSON.parse(await this.gh.readText(DATA_FILE, head));
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

  maxAssetNumber() {
    const all = [...this.data.items, ...this.data.locations].map((x) => x.assetId).filter(Boolean);
    return all.reduce((max, id) => Math.max(max, Number(id.replace('-', ''))), 0);
  }
}

// 修改数据时用的检查：编号不能和别的物品或位置重复
export function assertAssetFree(data, assetId, selfId) {
  if (!assetId) return;
  const hit = [...data.items, ...data.locations].find((x) => x.assetId === assetId && x.id !== selfId);
  if (hit) throw new Error(`编号 ${assetId} 已经被「${hit.name}」用了`);
}
