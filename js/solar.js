// 节气、问候：和「生活」网站（life/js/life.js）同一套算法，三个网站外观保持一致。纯计算。

const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

// 寿星公式（21 世纪）：日 = [Y×0.2422 + C] − [L]，Y 是年份后两位；1、2 月的四个节气 L 用 (Y−1)/4，其余用 Y/4。个别年份可能差一天
const TERMS = [
  ['小寒', 1, 5.4055], ['大寒', 1, 20.12], ['立春', 2, 3.87], ['雨水', 2, 18.73], ['惊蛰', 3, 5.63], ['春分', 3, 20.646],
  ['清明', 4, 4.81], ['谷雨', 4, 20.1], ['立夏', 5, 5.52], ['小满', 5, 21.04], ['芒种', 6, 5.678], ['夏至', 6, 21.37],
  ['小暑', 7, 7.108], ['大暑', 7, 22.83], ['立秋', 8, 7.5], ['处暑', 8, 23.13], ['白露', 9, 7.646], ['秋分', 9, 23.042],
  ['寒露', 10, 8.318], ['霜降', 10, 23.438], ['立冬', 11, 7.438], ['小雪', 11, 22.36], ['大雪', 12, 7.18], ['冬至', 12, 21.94],
];
export function termDates(year) {
  const y = year % 100;
  return TERMS.map(([name, m, c]) => {
    const l = Math.floor((m <= 2 ? y - 1 : y) / 4);
    return { name, day: `${year}-${String(m).padStart(2, '0')}-${String(Math.floor(y * 0.2422 + c) - l).padStart(2, '0')}` };
  });
}
// 今天在哪个节气、下一个是什么、还有几天；season = spring|summer|autumn|winter（立春、立夏、立秋、立冬分）
export function solarTerm(day) {
  const y = Number(day.slice(0, 4));
  const all = [...termDates(y - 1), ...termDates(y), ...termDates(y + 1)];
  const i = all.findIndex((t) => t.day > day) - 1;
  const cur = all[i]; const next = all[i + 1];
  const idx = TERMS.findIndex((t) => t[0] === cur.name);
  const season = ['spring', 'summer', 'autumn', 'winter'][Math.floor(((idx - 2 + 24) % 24) / 6)];
  return { name: cur.name, today: cur.day === day, next: next.name, left: daysBetween(day, next.day), season };
}

// 按时间问候
export function greeting(now = new Date()) {
  const hr = now.getHours();
  return hr < 4 ? '夜深了，早点睡' : hr < 11 ? '早上好' : hr < 13 ? '中午好' : hr < 18 ? '下午好' : hr < 23 ? '晚上好' : '夜深了，早点睡';
}
// 首页的节气小标签
export function termTag(day) {
  const st = solarTerm(day);
  return st.today ? `今天${st.name}` : st.left <= 7 ? `${st.name} · ${st.next}还有 ${st.left} 天` : `${st.name}时节`;
}
