// 今天穿什么：常住城市今天的天气 + 今天的安排 + 衣柜里能穿的衣服 + 最近穿过什么 → 2～3 套搭配。
// 没有 DeepSeek 时用规则挑一套。

import { isBox } from './store.js';
import { askJson, AiError } from './ai.js';
import { geocode } from './trip.js';

export const SCHEDULES = ['上课', '运动', '约会', '见客户', '面试', '出门逛街', '宅宿舍'];
export const CLOTHES_TAGS = ['衣服', '运动服', '鞋'];
// 衣服字段的可选值（表单里显示成下拉）
export const FIELD_OPTIONS = {
  部位: ['上衣', '下装', '外套', '连衣裙', '鞋', '配饰', '内衣', '袜子'],
  季节: ['春秋', '夏', '冬', '四季'],
  厚薄: ['薄', '适中', '厚'],
  风格: ['休闲', '正式', '运动'],
};

export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- 天气 ----------

export async function todayWeather(city) {
  const place = await geocode(city);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`
    + '&hourly=temperature_2m,precipitation_probability,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
    + '&timezone=Asia%2FShanghai&forecast_days=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error('查不到今天的天气');
  const d = await res.json();
  const temp = d.hourly?.temperature_2m || [];
  const avg = (from, to) => {
    const xs = temp.slice(from, to + 1).filter((x) => x != null);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  return {
    city: place.name,
    min: Math.round(d.daily.temperature_2m_min[0]),
    max: Math.round(d.daily.temperature_2m_max[0]),
    morning: avg(7, 9), noon: avg(12, 14), evening: avg(18, 21),
    rain: d.daily.precipitation_probability_max[0] ?? 0,
    wind: Math.round(Math.max(0, ...(d.hourly?.wind_speed_10m || [0]))),
    code: d.daily.weather_code?.[0],
  };
}

export function weatherLine(w) {
  if (!w) return '';
  const parts = [`${w.city} ${w.min}～${w.max}°C`];
  if (w.morning != null) parts.push(`早 ${w.morning}° · 午 ${w.noon}° · 晚 ${w.evening}°`);
  if (w.rain >= 30) parts.push(`降水 ${w.rain}%`);
  if (w.wind >= 25) parts.push(`风大 ${w.wind}km/h`);
  return parts.join(' · ');
}

// ---------- 衣柜 ----------

const isClothes = (i) => CLOTHES_TAGS.includes(i.tags[0]);

// 今天能穿的：没归档、没借出、不在箱子/行李箱里、不在洗
export function wearable(data) {
  return data.items.filter((i) => isClothes(i) && !i.archived && !i.borrow && !i.loan && !i.laundry && !isBox(data, i.location)
    && !['内衣', '袜子'].includes(i.fields?.['部位'])); // 贴身衣物不参与搭配
}

export function partOf(item) {
  const p = item.fields?.['部位'];
  if (p) return p;
  if (item.tags[0] === '鞋') return '鞋';
  if (/外套|夹克|羽绒|大衣|风衣|冲锋衣|棉服|开衫/.test(item.name)) return '外套';
  if (/裤|裙/.test(item.name)) return /连衣裙/.test(item.name) ? '连衣裙' : '下装';
  return '上衣';
}

const lastWorn = (item) => (item.worn || []).slice(-1)[0] || '';

// ---------- 规则 ----------

export function ruleOutfit(data, w) {
  const pool = wearable(data);
  const t = w ? (w.min + w.max) / 2 : 18;
  const wantSeason = t < 10 ? ['冬'] : t > 22 ? ['夏'] : ['春秋'];
  const wantThick = t < 10 ? '厚' : t > 22 ? '薄' : '适中';
  const score = (i) => {
    const s = i.fields?.['季节'] || '';
    let x = 0;
    if (s === '四季' || wantSeason.some((ws) => s.includes(ws))) x += 3;
    if ((t < 15 && s.includes('夏')) || (t > 22 && s.includes('冬'))) x -= 5; // 明显不合季节的往后放
    if (i.fields?.['厚薄'] === wantThick) x += 2;
    const lw = lastWorn(i);
    if (lw && (Date.now() - new Date(lw)) / 86400000 < 3) x -= 2; // 三天内穿过的往后排
    return x;
  };
  const best = (part) => pool.filter((i) => partOf(i) === part).sort((a, b) => score(b) - score(a))[0];
  const top = best('上衣');
  const dress = best('连衣裙');
  const items = [];
  if (top) items.push(top, best('下装'));
  else if (dress) items.push(dress);
  if (w && w.min < 16) items.push(best('外套'));
  items.push(best('鞋'));
  const ids = items.filter(Boolean).map((i) => i.id);
  if (!ids.length) return null;
  const tips = [];
  if (w?.rain >= 40) tips.push(`降水概率 ${w.rain}%，带伞`);
  if (w && w.max - w.min >= 10) tips.push(`早晚温差 ${w.max - w.min}°C，外套方便穿脱`);
  return {
    source: '规则',
    options: [{ title: '按天气挑的一套', items: ids, why: w ? `今天 ${w.min}～${w.max}°C，挑了季节、厚薄合适、最近没穿过的。` : '按季节挑的。', tips }],
  };
}

// ---------- DeepSeek ----------

export async function aiOutfits(ai, data, w, schedule, note) {
  const pool = wearable(data);
  if (!pool.length) throw new AiError('衣柜里还没有能穿的衣服');
  const lines = pool.map((i) => {
    const f = Object.entries(i.fields || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    return `${i.id} | ${i.name} | ${partOf(i)} | ${f || '-'} | 最近穿：${(i.worn || []).slice(-3).join(',') || '没记录'}`;
  });
  const system = [
    '你是帮大学生搭配日常穿着的助手。只能从给出的衣服里挑，用它们的 id。',
    '给出 2～3 套不同的方案（风格可以有差别），每套是一整身：上衣+下装（或连衣裙）+鞋，冷的时候加外套。',
    '要求：温度合适（参考早中晚气温和厚薄、季节字段），场合合适（见客户、面试偏正式，运动穿运动服），颜色协调；',
    '尽量不选最近两三天穿过的；下雨不选浅色鞋。',
    'title 写一句话概括这套（10 个字以内），why 用一两句话说明为什么这样搭，tips 是出门小提醒（比如带伞、中午热可以脱外套）。',
    '只输出 JSON：{"options":[{"title":"","items":["id"],"why":"","tips":[""]}]}',
  ].join('\n');
  const user = [
    `今天 ${todayStr()}，${weatherLine(w) || '天气未知'}。`,
    `今天的安排：${schedule.join('、') || '没说'}。${note ? `补充：${note}` : ''}`,
    '',
    '衣柜（每行：id | 名称 | 部位 | 字段 | 最近穿着日期）：',
    ...lines,
  ].join('\n');
  const out = await askJson(ai, system, user);
  const valid = new Set(pool.map((i) => i.id));
  const options = (out.options || []).map((o) => ({
    title: String(o.title || '').slice(0, 20),
    items: [...new Set((o.items || []).filter((id) => valid.has(id)))],
    why: String(o.why || '').slice(0, 200),
    tips: (o.tips || []).map(String).filter(Boolean).slice(0, 3),
  })).filter((o) => o.items.length).slice(0, 3);
  if (!options.length) throw new AiError('DeepSeek 没给出能用的搭配');
  return { source: 'DeepSeek', options };
}
