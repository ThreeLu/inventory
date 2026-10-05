// 今天穿什么：常住城市今天的天气 + 今天的安排 + 衣柜里能穿的衣服 + 最近穿过什么 → 2～3 套搭配。
// 没有 DeepSeek 时用规则挑一套。

import { isBox } from './store.js';
import { askJson, AiError } from './ai.js';
import { geocode } from './trip.js';

export const SCHEDULES = ['上班', '跑步', '爬山 / 出去玩', '隆重场合', '上课', '出门逛街', '约会', '见客户', '面试', '宅宿舍'];

// 五类衣服（用户 2026-10-05 定的）：
//   隆重：风格填「隆重」，或名字里有西装、西服、礼服——只在特别隆重的场合穿（选了「隆重场合」才推荐）；
//   运动：名字里有「运动」（或类别是运动服、风格填了运动）——只在跑步时穿；
//   居家：风格填「居家」，或名字里有睡衣、睡裤、家居服这类——只在宿舍里穿；
//   休闲：风格填「休闲」——爬山、出去玩；
//   正式：风格填「正式」或没填——最常穿，上班。
// 出门的搭配里绝不出现运动、居家的，隆重的只在隆重场合；秋衣秋裤是打底，最低温低于 LAYER_BELOW 时提醒加在里面。
export const LAYER_BELOW = 13;
const HOME = /睡衣|睡裤|睡袍|家居服|居家/;
const GRAND = /西装|西服|礼服|燕尾服/;
export function styleOf(item) {
  if (/运动/.test(item.name) || item.tags[0] === '运动服' || item.fields?.['风格'] === '运动') return '运动';
  if (item.fields?.['风格'] === '居家' || HOME.test(item.name)) return '居家';
  if (item.fields?.['风格'] === '隆重' || GRAND.test(item.name)) return '隆重';
  return item.fields?.['风格'] === '休闲' ? '休闲' : '正式';
}
const LAYER = /秋衣|秋裤|打底|保暖内衣|保暖裤/;
export const isLayer = (i) => LAYER.test(i.name);
// 每种安排穿哪类（排前面的优先）；以前存的「运动」就是跑步
const SCHEDULE_STYLE = {
  隆重场合: ['隆重'], 上班: ['正式'], 上课: ['正式'], 见客户: ['正式'], 面试: ['正式'], 跑步: ['运动'], 运动: ['运动'],
  '爬山 / 出去玩': ['休闲'], 出门逛街: ['休闲', '正式'], 约会: ['正式', '休闲'], 宅宿舍: ['居家'],
};
// 今天出门穿哪类（main）、要不要另外一套跑步的（run）、在宿舍穿的（home）。只选了宅宿舍就不用出门那套
export function dayStyles(schedule = []) {
  const styles = schedule.flatMap((s) => SCHEDULE_STYLE[s] || ['正式']);
  const home = styles.includes('居家');
  const main = [...new Set(styles.filter((x) => x !== '运动' && x !== '居家'))];
  return { main: main.length ? main : home ? [] : ['正式'], run: styles.includes('运动'), home };
}
export const CLOTHES_TAGS = ['衣服', '运动服', '鞋'];
// 衣服字段的可选值（表单里显示成下拉）
export const FIELD_OPTIONS = {
  部位: ['上衣', '下装', '外套', '鞋', '配饰', '内衣', '袜子'],
  季节: ['春秋', '夏', '冬', '四季'],
  厚薄: ['薄', '适中', '厚'],
  风格: ['正式', '休闲', '运动', '居家', '隆重'],
};

// 厚薄跟着季节分（用户 2026-10-05 定的）：夏季只有 薄 / 厚，冬季有 薄 / 适中 / 厚，春秋、四季还是 薄 / 适中 / 厚
export function thickOptions(season = '') {
  return season.includes('夏') && !season.includes('冬') ? ['薄', '厚'] : ['薄', '适中', '厚'];
}

// 今天的气温（白天平均）最适合穿哪种「季节·厚薄」，分数越高越合适
export function fitTargets(t) {
  if (t >= 28) return { '夏·薄': 3, '夏·厚': 2 };
  if (t >= 23) return { '夏·厚': 3, '夏·薄': 2, '春秋·薄': 2 };
  if (t >= 16) return { '春秋·适中': 3, '春秋·薄': 2, '春秋·厚': 2, '夏·厚': 1 };
  if (t >= 10) return { '春秋·厚': 3, '冬·薄': 3, '春秋·适中': 2 };
  if (t >= 3) return { '冬·适中': 3, '冬·薄': 2, '冬·厚': 2, '春秋·厚': 1 };
  return { '冬·厚': 3, '冬·适中': 2 };
}
export function fitScore(item, t) {
  const season = item.fields?.['季节'] || '';
  if (season === '四季') return 2;
  const thick = item.fields?.['厚薄'] || '';
  const targets = fitTargets(t);
  let best = 0;
  for (const s of season.split(/[、/,，\s]+/).filter(Boolean)) {
    if (thick) best = Math.max(best, targets[`${s}·${thick}`] || 0);
    else best = Math.max(best, ...Object.entries(targets).filter(([k]) => k.startsWith(`${s}·`)).map(([, v]) => v - 1), 0); // 没填厚薄：按这个季节最合适的减一点
  }
  if ((t < 15 && season.includes('夏')) || (t > 22 && season.includes('冬'))) best -= 5; // 明显不合季节的往后放
  return best;
}
export const fitText = (t) => Object.entries(fitTargets(t)).sort((a, b) => b[1] - a[1]).map(([k]) => k).join('、');

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
  if (/裤|裙/.test(item.name)) return '下装';
  return '上衣';
}

const lastWorn = (item) => (item.worn || []).slice(-1)[0] || '';

// ---------- 规则 ----------

// 能拿来搭配出门的：去掉睡衣和秋衣秋裤这类打底
const outfitPool = (data) => wearable(data).filter((i) => !isLayer(i));

export function ruleOutfit(data, w, schedule = []) {
  const all = outfitPool(data);
  const { main, run, home } = dayStyles(schedule);
  const t = w ? (w.min + w.max) / 2 : 18;
  const score = (i) => {
    let x = fitScore(i, t) * 2; // 季节 + 厚薄合不合今天的气温
    const lw = lastWorn(i);
    if (lw && (Date.now() - new Date(lw)) / 86400000 < 3) x -= 2; // 三天内穿过的往后排
    return x;
  };
  // 先按今天要的类别挑（排前面的优先）；日常那套缺哪个部位，用别的日常衣服补，但绝不用运动的
  const pick = (styles, part, strict) => {
    const of = (st) => all.filter((i) => partOf(i) === part && st.includes(styleOf(i))).sort((a, b) => score(b) - score(a))[0];
    // 缺的部位用平时出门的补（隆重的缺鞋就用正式的皮鞋）；绝不用运动、居家的
    return styles.map((st) => of([st])).find(Boolean) || (strict ? null : of(styles.includes('隆重') ? ['正式'] : ['正式', '休闲']));
  };
  const outfit = (styles, strict) => {
    const items = [pick(styles, '上衣', strict), pick(styles, '下装', strict)];
    if (w && w.min < 16) items.push(pick(styles, '外套', strict));
    items.push(pick(styles, '鞋', strict));
    return items.filter(Boolean).map((i) => i.id);
  };
  const tips = [];
  if (w?.rain >= 40) tips.push(`降水概率 ${w.rain}%，带伞`);
  if (w && w.max - w.min >= 10) tips.push(`早晚温差 ${w.max - w.min}°C，外套方便穿脱`);
  const layers = wearable(data).filter(isLayer);
  if (w && w.min < LAYER_BELOW && layers.length) tips.push(`最低 ${w.min}°C，里面可以加${layers.map((i) => i.name).join('、')}`);
  const options = [];
  const daily = main.length ? outfit(main, false) : [];
  if (daily.length) options.push({ title: `${main[0]}的一套`, items: daily, why: w ? `今天 ${w.min}～${w.max}°C，挑了${main.join('、')}的衣服里季节、厚薄合适、最近没穿过的。` : `按季节挑的${main[0]}衣服。`, tips });
  if (run) {
    const r = outfit(['运动'], true);
    if (r.length) options.push({ title: '跑步穿', items: r, why: '跑步专用的运动衣服，跑完换回来。', tips: [], run: true });
  }
  if (home) {
    const items = [pick(['居家'], '上衣', true), pick(['居家'], '下装', true), pick(['居家'], '鞋', true)].filter(Boolean).map((i) => i.id);
    if (items.length) options.push({ title: '在宿舍穿', items, why: '今天宅宿舍，穿居家的就好。', tips: [], home: true });
  }
  return options.length ? { source: '规则', options } : null;
}

// ---------- 腰带轮换 ----------
// 皮带天天系容易变形、开裂，歇一阵会慢慢恢复。用「疲劳分」算（用户 2026-10-05 要的）：
//   系一天 +1，歇一天 −0.5（最低 0）；正在系的那条今天再系就到 BELT_TIRED（7，差不多连着系一周）时，提醒换成歇得最好的那条。
//   恢复比累得慢一半：连系一周的那条要歇两周才完全恢复；两条隔几天轮着系就一直不会到 7。
// 今天还没系的话，今天不算歇（还没过完）。
export const BELT_TIRED = 7;
export const BELT_REST = 0.5;
export const isBelt = (i) => /腰带|皮带/.test(i.name);
const shiftDay = (d, n) => {
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export function beltFatigue(item, today = todayStr()) {
  const worn = new Set((item.worn || []).filter((d) => d <= today));
  const dates = [...worn].sort();
  if (!dates.length) return { score: 0, streak: 0, last: null, rested: null };
  let score = 0;
  for (let d = dates[0]; d <= today; d = shiftDay(d, 1)) {
    if (worn.has(d)) score += 1;
    else if (d < today) score = Math.max(0, score - BELT_REST);
  }
  const last = dates[dates.length - 1];
  let streak = 0;
  for (let d = last; worn.has(d); d = shiftDay(d, -1)) streak += 1; // 最近一次连着系了几天
  return { score, streak, last, rested: Math.round((new Date(`${today}T00:00:00`) - new Date(`${last}T00:00:00`)) / 86400000) };
}
// { belts: [{ b, score, streak, last, rested }], current, swap }：current 是最近系的那条；它累到 7 分、又有歇得更好的，swap 就是该换的那条
export function beltAdvice(data, today = todayStr()) {
  const belts = data.items.filter((i) => isBelt(i) && !i.archived).map((b) => ({ b, ...beltFatigue(b, today) }));
  if (!belts.length) return null;
  const current = belts.filter((x) => x.last).sort((a, b) => b.last.localeCompare(a.last))[0] || null;
  const others = belts.filter((x) => x !== current).sort((a, b) => a.score - b.score);
  // 今天还没系的话按「今天再系一天」算：第 7 天早上点开就提醒，不用等系满了才说
  const projected = current ? current.score + (current.last === today ? 0 : 1) : 0;
  const swap = current && projected >= BELT_TIRED && others[0] && others[0].score < current.score ? others[0] : null;
  return { belts, current, swap };
}

// ---------- DeepSeek ----------

// 今天算不算秋冬（决定洗衣的默认次数）：最高温低于 coldBelow；不知道天气就按月份猜
export function isColdDay(w, coldBelow = 20) {
  if (w && w.max != null) return w.max < coldBelow;
  const m = new Date().getMonth() + 1;
  return m >= 10 || m <= 4;
}

export async function aiOutfits(ai, data, w, schedule, note) {
  const pool = outfitPool(data);
  if (!pool.length) throw new AiError('衣柜里还没有能穿的衣服');
  const { main, run, home } = dayStyles(schedule);
  const lines = pool.map((i) => {
    const f = Object.entries(i.fields || {}).filter(([k]) => k !== '风格').map(([k, v]) => `${k}=${v}`).join(' ');
    return `${i.id} | ${i.name} | ${partOf(i)} | 类别=${styleOf(i)} | ${f || '-'} | 最近穿：${(i.worn || []).slice(-3).join(',') || '没记录'}`;
  });
  const layers = wearable(data).filter(isLayer).map((i) => i.name);
  const system = [
    `你是帮${data.prefs?.gender === '男' ? '男' : ''}大学生搭配日常穿着的助手。只能从给出的衣服里挑，用它们的 id。`,
    '他的衣服分五类（看每行的「类别」）：运动 = 只在跑步时穿；居家 = 只在宿舍里穿（睡衣这类）；休闲 = 爬山、出去玩；正式 = 他最常穿的，上班穿；隆重 = 西装这类，只在特别隆重的场合穿。',
    `铁规矩：出门的搭配里绝不能出现「运动」「居家」类的衣服和鞋；「隆重」类只在今天安排了隆重场合时用（缺鞋可以配正式的）${main.includes('隆重') ? '' : '，今天没有，不要用'}；一套里的衣服和鞋尽量同一类。`,
    main.length ? `今天出门穿：${main.join('、')}（按顺序优先）。给 2～3 套这一类的不同方案，每套是一整身：上衣+下装+鞋，冷的时候加外套。` : '今天不出门。',
    run ? '今天还要跑步：另外再给一套跑步穿的，只用「运动」类，title 写「跑步穿」。' : '今天不跑步，不要给运动的方案。',
    home ? '今天宅宿舍：给一套在宿舍穿的，只用「居家」类，title 写「在宿舍穿」。' : '不要给居家的方案。',
    layers.length ? `秋衣秋裤这类打底（${layers.join('、')}）不在列表里，最低温低于 ${LAYER_BELOW} 度时在 tips 里提醒可以加在里面。` : '',
    `要求：温度合适：看「季节」和「厚薄」两个字段一起判断（夏季的只分薄 / 厚，冬季的分薄 / 适中 / 厚），今天按白天平均气温最合适的依次是：${fitText(w ? (w.min + w.max) / 2 : 18)}；颜色协调；`,
    '尽量不选最近两三天穿过的；下雨不选浅色鞋。',
    'title 写一句话概括这套（10 个字以内），why 用一两句话说明为什么这样搭，tips 是出门小提醒（比如带伞、中午热可以脱外套）。',
    '只输出 JSON：{"options":[{"title":"","items":["id"],"why":"","tips":[""]}]}',
  ].filter(Boolean).join('\n');
  const user = [
    `今天 ${todayStr()}，${weatherLine(w) || '天气未知'}。`,
    `今天的安排：${schedule.join('、') || '没说'}。${note ? `补充：${note}` : ''}`,
    '',
    '衣柜（每行：id | 名称 | 部位 | 类别 | 其他字段 | 最近穿着日期）：',
    ...lines,
  ].join('\n');
  const out = await askJson(ai, system, user);
  const byId = new Map(pool.map((i) => [i.id, i]));
  // 网站再把一遍关：一套里哪类最多就算哪种方案——运动多是跑步那套、居家多是在宿舍那套（只留那一类），
  // 否则是出门那套（运动、居家的全去掉）；今天没安排的方案不要
  const options = (out.options || []).map((o) => {
    const ids = [...new Set((o.items || []).filter((id) => byId.has(id)))];
    const of = (st) => ids.filter((id) => styleOf(byId.get(id)) === st);
    const kind = of('运动').length > ids.length / 2 ? 'run' : of('居家').length > ids.length / 2 ? 'home' : 'out';
    const banned = ['运动', '居家', ...(main.includes('隆重') ? [] : ['隆重'])];
    const items = kind === 'run' ? of('运动') : kind === 'home' ? of('居家') : ids.filter((id) => !banned.includes(styleOf(byId.get(id))));
    return {
      title: String(o.title || '').slice(0, 20), items,
      why: String(o.why || '').slice(0, 200),
      tips: (o.tips || []).map(String).filter(Boolean).slice(0, 3),
      ...(kind === 'run' ? { run: true } : kind === 'home' ? { home: true } : {}),
    };
  }).filter((o) => o.items.length && (o.run ? run : o.home ? home : main.length > 0)).slice(0, 4);
  if (!options.length) throw new AiError('DeepSeek 没给出能用的搭配');
  return { source: 'DeepSeek', options };
}
