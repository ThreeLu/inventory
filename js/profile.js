// 「我的故事」（threelu.github.io/story）整理的「给 AI 的简介」：每次问 DeepSeek 都带上，让 AI 更懂他。
// 读私有仓库 story-data 的 profile.json（和这里同一个令牌，要授权 story-data），一天读一次存在这台设备上；读不到就不带。
// 物品档案、账本、生活三个网站同一份，改了三边一起改。

const KEY = 'story-profile';
const DAY = 86400000;

function account() {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const all = ['story-settings', 'life-settings', 'ledger-settings', 'inventory-settings'].map(read);
  const token = all.find((s) => s.token)?.token;
  if (!token) return null;
  const repo = all.find((s) => s.repo)?.repo || 'ThreeLu/x';
  return { token, owner: repo.split('/')[0] };
}

export async function profileText() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY)); } catch { /* 没有缓存 */ }
  if (cached && Date.now() - cached.fetched < DAY) return cached.text || '';
  const acc = account();
  if (!acc) return '';
  const base = ['inventory', 'ledger', 'life', 'story'].map((k) => localStorage.getItem(`${k}-api-base`)).find(Boolean) || 'https://api.github.com';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let text = '';
  try {
    const res = await fetch(`${base}/repos/${acc.owner}/story-data/contents/profile.json?ref=main`, {
      headers: { Authorization: `Bearer ${acc.token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store', signal: ctrl.signal,
    });
    if (res.ok) text = (await res.json()).text || '';
    else if (res.status !== 404) return cached?.text || ''; // 暂时读不到：先用旧的，下次再读
  } catch {
    return cached?.text || '';
  } finally {
    clearTimeout(timer);
  }
  try { localStorage.setItem(KEY, JSON.stringify({ text, fetched: Date.now() })); } catch { /* 存不了就算了 */ }
  return text;
}

export function withProfile(system, text) {
  return text ? `${system}\n\n关于他（来自他自己写的「我的故事」，当背景了解；用得上再用，不要复述，不要因此说教）：\n${text}` : system;
}
