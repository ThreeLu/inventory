// 出差/旅行带什么：查天气 → 挑候选物品 → 规则先给一份 → 有 DeepSeek 密钥就让 AI 挑得更好（含衣服搭配）。
// 发给 DeepSeek 的只有物品的名称、类别、字段（季节、颜色、尺码……），不发照片、价格、序列号、备注。

import { isDepleted, isBox } from './store.js';

export const PURPOSES = ['出差开会', '见客户', '面试', '旅游', '回家', '运动户外', '探亲访友'];

// 这些类别和出行无关，不放进候选
const SKIP_TAGS = ['搬家用品', '收纳容器', '床上用品', '收藏纪念'];

const days = (start, end) => Math.round((new Date(end) - new Date(start)) / 86400000) + 1;

// ---------- 天气（Open-Meteo，免费、不用密钥） ----------

export async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('查不到这个城市');
  const r = (await res.json()).results?.[0];
  if (!r) throw new Error(`找不到「${city}」，换个写法试试（比如「上海」「成都」）`);
  return { name: r.name, admin: r.admin1 || '', lat: r.latitude, lon: r.longitude };
}

// 出发在 16 天以内就查逐日预报；更远的按月份大致估计
export async function weatherFor(place, start, end) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ahead = Math.round((new Date(end) - today) / 86400000);
  if (ahead <= 15 && new Date(start) >= today) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
      + `&timezone=Asia%2FShanghai&start_date=${start}&end_date=${end}`;
    const res = await fetch(url);
    if (res.ok) {
      const d = (await res.json()).daily;
      return {
        source: '天气预报',
        days: d.time.map((date, i) => ({
          date, min: d.temperature_2m_min[i], max: d.temperature_2m_max[i],
          rain: d.precipitation_probability_max[i] ?? 0, snow: [71, 73, 75, 77, 85, 86].includes(d.weather_code[i]),
        })),
      };
    }
  }
  return { source: '按季节估计', days: [], ...seasonGuess(new Date(start).getMonth() + 1, place.lat) };
}

function seasonGuess(month, lat = 30) {
  // 中国大致：北方冬天更冷
  const north = lat > 34;
  const table = {
    1: [north ? -8 : 3, north ? 3 : 12], 2: [north ? -5 : 5, north ? 6 : 14], 3: [north ? 2 : 9, north ? 13 : 18],
    4: [8, 21], 5: [14, 26], 6: [19, 30], 7: [23, 33], 8: [22, 32], 9: [16, 27], 10: [north ? 6 : 13, north ? 19 : 23],
    11: [north ? -2 : 8, north ? 10 : 18], 12: [north ? -7 : 4, north ? 3 : 13],
  };
  const [min, max] = table[month];
  return { min, max, rain: 30, estimated: true };
}

export function summarizeWeather(w) {
  if (w.days.length) {
    const min = Math.min(...w.days.map((d) => d.min));
    const max = Math.max(...w.days.map((d) => d.max));
    const rain = Math.max(...w.days.map((d) => d.rain));
    return { min, max, rain, snow: w.days.some((d) => d.snow) };
  }
  return { min: w.min, max: w.max, rain: w.rain, snow: false };
}

// ---------- 候选物品 ----------

export function candidates(data) {
  return data.items.filter((i) => !i.archived && !isDepleted(i) && !i.loan && !isBox(data, i.location)
    && !(i.tags[0] && SKIP_TAGS.includes(i.tags[0])));
}

function describe(data, item) {
  const loc = data.locations.find((l) => l.id === item.location);
  const fields = Object.entries(item.fields || {}).filter(([k]) => !['剩余', '规格'].includes(k)).map(([k, v]) => `${k}=${v}`);
  return [item.id, item.name, item.tags.join('/') || '无标签', fields.join(' ') || '-', loc ? loc.name.split(' ')[0] : '-', item.description || '']
    .map((s) => String(s).replace(/\|/g, '/')).join(' | ');
}

// ---------- 规则 ----------

const has = (item, words) => words.some((w) => `${item.name} ${item.description || ''}`.includes(w));

export function rulePlan(data, trip, weather) {
  const n = days(trip.start, trip.end);
  const w = summarizeWeather(weather);
  const pool = candidates(data);
  const picked = new Map(); // id -> { qty, reason }
  const pick = (item, reason, qty = 1) => { if (!picked.has(item.id)) picked.set(item.id, { id: item.id, qty, reason }); };
  const of = (tag) => pool.filter((i) => i.tags.includes(tag));

  // 衣服：按季节字段匹配温度，件数按天数（能洗衣服就少带）
  const seasonOk = (item) => {
    const s = item.fields?.['季节'];
    if (!s) return null; // 不知道季节
    return (w.min < 10 && s.includes('冬')) || (w.max > 24 && s.includes('夏')) || (w.min < 24 && w.max > 8 && /春|秋/.test(s));
  };
  const clothes = [...of('衣服'), ...(trip.purposes.includes('运动户外') ? of('运动服') : [])];
  const want = Math.min(trip.laundry ? Math.min(n, 3) : n, 7);
  const fit = clothes.filter((c) => seasonOk(c) === true);
  for (const c of fit.slice(0, want)) pick(c, `季节合适（${c.fields['季节']}）`);
  if (fit.length < want) {
    for (const c of clothes.filter((c) => seasonOk(c) === null).slice(0, want - fit.length)) pick(c, '没填季节，确认一下是否合适');
  }
  if (w.min < 12) for (const c of clothes.filter((c) => has(c, ['外套', '羽绒', '大衣', '夹克', '风衣'])).slice(0, 1)) pick(c, `最低 ${w.min}℃，带件外套`);

  // 鞋
  const shoes = of('鞋');
  const formal = trip.purposes.some((p) => ['出差开会', '见客户', '面试'].includes(p));
  if (formal) for (const s of shoes.filter((s) => has(s, ['皮鞋', '正装'])).slice(0, 1)) pick(s, '正式场合');
  if (trip.purposes.includes('运动户外')) for (const s of shoes.filter((s) => has(s, ['运动', '跑', '登山'])).slice(0, 1)) pick(s, '运动户外');
  if (formal) for (const c of clothes.filter((c) => has(c, ['衬衫', '西装', '西裤', '正装'])).slice(0, 2)) pick(c, '正式场合');

  // 每次都要的
  for (const i of [...of('证件文件'), ...of('钥匙')]) pick(i, '每次出门必带');
  for (const i of of('电子产品').filter((i) => has(i, ['充电', '数据线', '耳机', '充电宝', '电脑', '转换']))) pick(i, '常用电子产品');
  for (const i of of('洗漱护肤')) pick(i, '洗漱');
  for (const i of of('药品急救').filter((i) => has(i, ['感冒', '布洛芬', '蒙脱石', '创可贴', '肠', '晕', '过敏']))) pick(i, '常备药');
  if (w.rain >= 40) for (const i of pool.filter((i) => has(i, ['伞', '雨衣'])).slice(0, 1)) pick(i, `降水概率 ${w.rain}%`);
  for (const i of of('包').filter((i) => has(i, ['行李箱', '背包', '双肩'])).slice(0, 1)) pick(i, '装东西');

  // 档案里没有、建议另外准备的
  const missing = [];
  const lacks = (words) => !pool.some((i) => has(i, words));
  if (w.rain >= 40 && lacks(['伞', '雨衣'])) missing.push({ name: '雨伞', reason: `降水概率 ${w.rain}%` });
  if (lacks(['充电'])) missing.push({ name: '手机充电器', reason: '档案里没找到充电器' });
  if (!of('证件文件').length) missing.push({ name: '身份证', reason: '坐车、住酒店都要' });
  if (fit.length === 0 && clothes.length) missing.push({ name: '合适季节的衣服', reason: `目的地 ${w.min}～${w.max}℃，档案里的衣服大多没填季节` });

  return { source: '规则', items: [...picked.values()], outfits: [], missing, tips: [] };
}

// ---------- DeepSeek ----------

export async function aiPlan(data, trip, weather, base, { key, model }) {
  const pool = candidates(data);
  const n = days(trip.start, trip.end);
  const w = summarizeWeather(weather);
  const weatherText = weather.days.length
    ? weather.days.map((d) => `${d.date}：${d.min}～${d.max}℃，降水概率 ${d.rain}%${d.snow ? '，有雪' : ''}`).join('\n')
    : `（没有逐日预报，按季节估计）大约 ${w.min}～${w.max}℃`;
  const prompt = [
    `行程：去${trip.city}，${trip.start} 到 ${trip.end}，共 ${n} 天。`,
    `目的：${trip.purposes.join('、') || '未说明'}。${trip.laundry ? '住处可以洗衣服。' : '住处不方便洗衣服。'}`,
    trip.note ? `补充：${trip.note}` : '',
    `天气：\n${weatherText}`,
    '',
    '我的物品（每行：id | 名称 | 标签 | 字段 | 现在放在哪 | 描述）：',
    ...pool.map((i) => describe(data, i)),
    '',
    `规则初步挑选的 id：${base.items.map((i) => i.id).join(', ') || '无'}`,
  ].filter((x) => x !== '').join('\n');

  const system = [
    '你是帮大学生收拾行李的助手。只能从用户给出的物品里挑，用它们的 id。',
    '要求：',
    '1. 按天数、天气、目的挑够用但不过量的东西；衣服考虑能不能洗。',
    '2. 衣服要考虑搭配：颜色协调、风格符合场合（见客户、面试偏正式，运动偏运动风），上衣、下装、外套、鞋子能组合起来。按天给出穿搭（outfits），每天列出当天穿的物品 id。',
    '3. 证件、充电器、钥匙、常备药这类别漏。',
    '4. 档案里没有但应该准备的，放进 missing（比如雨伞、转换插头、正装）。',
    '5. 理由简短，一句话。',
    '只输出 JSON：{"items":[{"id":"","qty":1,"reason":""}],"outfits":[{"day":"10-10","items":["id"],"note":""}],"missing":[{"name":"","reason":""}],"tips":[""]}',
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res;
  try {
    res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: 3000,
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'DeepSeek 太久没响应' : '连不上 DeepSeek');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const msg = { 401: 'DeepSeek 密钥不对', 402: 'DeepSeek 余额不足', 429: 'DeepSeek 请求太频繁' }[res.status];
    throw new Error(msg || `DeepSeek 返回 ${res.status}`);
  }
  const out = JSON.parse((await res.json()).choices[0].message.content);
  // 只保留真实存在的物品 id，防止 AI 编造
  const valid = new Set(pool.map((i) => i.id));
  const seen = new Set();
  const items = (out.items || []).filter((i) => valid.has(i.id) && !seen.has(i.id) && seen.add(i.id))
    .map((i) => ({ id: i.id, qty: Math.max(1, Number(i.qty) || 1), reason: String(i.reason || '').slice(0, 60) }));
  const outfits = (out.outfits || []).map((o) => ({
    day: String(o.day || ''), note: String(o.note || '').slice(0, 80), items: (o.items || []).filter((id) => valid.has(id)),
  })).filter((o) => o.items.length);
  return {
    source: 'DeepSeek',
    items,
    outfits,
    missing: (out.missing || []).map((m) => ({ name: String(m.name || ''), reason: String(m.reason || '') })).filter((m) => m.name),
    tips: (out.tips || []).map(String).filter(Boolean).slice(0, 5),
  };
}
