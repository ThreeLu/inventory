// 换季整理：按节气判断现在该穿哪些季节的衣服，列出该拿进当季衣柜的、该收起来的。
// 和数据仓库里每节气发邮件的 .github/season.py 规则一致。

import { isBox } from './store.js';

// 气温明显转折的节气（日期每年差一两天，取常见日期）
export const TERMS = [
  { name: '清明', md: '04-05', wear: ['春秋'] },
  { name: '立夏', md: '05-05', wear: ['夏'] },
  { name: '白露', md: '09-07', wear: ['春秋'] },
  { name: '寒露', md: '10-08', wear: ['春秋', '冬'] },
  { name: '立冬', md: '11-07', wear: ['冬', '春秋'] },
];

const md = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 今天处在哪个节气之后
export function currentTerm(date = new Date()) {
  const today = md(date);
  const passed = TERMS.filter((t) => t.md <= today);
  return passed.length ? passed[passed.length - 1] : TERMS[TERMS.length - 1]; // 1～4 月初还在立冬之后
}

export function nextTerm(date = new Date()) {
  const today = md(date);
  const t = TERMS.find((x) => x.md > today) || TERMS[0];
  const year = date.getFullYear() + (t.md > today ? 0 : 1);
  return { ...t, date: `${year}-${t.md}` };
}

const CLOTHES = ['衣服', '运动服'];

// 返回 { term, wardrobe, bring: [物品], store: [物品], unknown: [物品] }
export function seasonPlan(data, date = new Date()) {
  const term = currentTerm(date);
  const wardrobe = data.locations.find((l) => l.name.startsWith('当季衣柜'));
  const clothes = data.items.filter((i) => CLOTHES.includes(i.tags[0]) && !i.archived && !i.borrow && !isBox(data, i.location));
  const inSeason = (i) => {
    const s = i.fields?.['季节'] || '';
    return s === '四季' || term.wear.some((w) => s.includes(w));
  };
  const known = clothes.filter((i) => i.fields?.['季节']);
  return {
    term,
    wardrobe,
    bring: wardrobe ? known.filter((i) => inSeason(i) && i.location !== wardrobe.id) : [],
    store: wardrobe ? known.filter((i) => !inSeason(i) && i.location === wardrobe.id) : [],
    unknown: clothes.filter((i) => !i.fields?.['季节']),
  };
}

// 收起来的衣服默认放哪：夏装 → 夏季衣物柜；冬装 → 冬装柜，冬天的小件（配饰、贴身的秋衣袜子）→ 冬季衣物与小件服饰柜；其他 → 储物间
const SMALL_PARTS = ['配饰', '内衣', '袜子'];
export function storageFor(data, item) {
  const find = (prefix) => data.locations.find((l) => l.name.startsWith(prefix));
  const store = find('储物间');
  const season = item.fields?.['季节'] || '';
  if (season.includes('夏')) return find('夏季衣物') || store;
  if (season.includes('冬')) {
    const small = find('冬季衣物');
    const big = find('冬装柜');
    return (SMALL_PARTS.includes(item.fields?.['部位']) ? small || big : big || small) || store;
  }
  return store || find('夏季衣物');
}
