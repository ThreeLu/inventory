// 调用 DeepSeek 的公共部分：所有 AI 功能（出差推荐、今天穿什么、问一问、自动补全）都走这里。
// 密钥在私有数据仓库的 config/ai.json（store.config.deepseek），由调用方传进来。

import { profileText, withProfile } from './profile.js';

export class AiError extends Error {}

// 返回解析好的 JSON 对象。system / user 是提示词；会先思考再回答的模型（如 deepseek-flash）思考也占 max_tokens
export async function askJson({ key, model }, system, user, { maxTokens = 8000, timeout = 150000, history = [] } = {}) {
  if (!key) throw new AiError('还没有设置 DeepSeek 密钥（设置 → AI）');
  const profile = await profileText(); // 「我的故事」里的简介，每次都带上
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages: [{ role: 'system', content: withProfile(system, profile) }, ...history, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: maxTokens,
      }),
    });
  } catch (e) {
    throw new AiError(e.name === 'AbortError' ? 'DeepSeek 太久没响应' : '连不上 DeepSeek');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const msg = { 401: 'DeepSeek 密钥不对', 402: 'DeepSeek 余额不足', 429: 'DeepSeek 请求太频繁' }[res.status];
    throw new AiError(msg || `DeepSeek 返回 ${res.status}`);
  }
  const choice = (await res.json()).choices?.[0];
  if (choice?.finish_reason === 'length') throw new AiError('DeepSeek 想得太久，回答被截断了');
  try {
    return JSON.parse(choice.message.content);
  } catch {
    throw new AiError('DeepSeek 的回答格式不对');
  }
}

// 把物品整理成一行文字发给 AI。opts 决定带哪些信息（序列号、照片永远不带）
export function itemLine(data, item, { extra = false } = {}) {
  const loc = data.locations.find((l) => l.id === item.location);
  const fields = Object.entries(item.fields || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const status = [
    item.archived ? `已归档(${item.archiveReason || ''})` : '',
    item.consumable && Number(item.quantity) === 0 ? '已用完' : '',
    item.borrow ? `借阅中,应还${item.borrow.due}` : '',
    loc?.box === 'move' || loc?.box === 'trip' ? '在箱子/行李箱里' : '',
    item.leftBehind ? `落在${item.leftBehind.place}了` : '',
  ].filter(Boolean).join(',');
  const parts = [item.id, item.assetId || '-', item.name, item.tags[0] || '无类别', loc ? loc.name.split(' ')[0] : '-',
    `×${item.quantity}`, fields || '-', status || '-'];
  if (extra) {
    parts.push(
      [item.manufacturer, item.modelNumber].filter(Boolean).join(' ') || '-',
      item.purchaseDate || '-', item.purchasePrice != null && item.purchasePrice !== '' ? `¥${item.purchasePrice}` : '-',
      [item.description, item.notes].filter(Boolean).join(' / ').replace(/\n/g, ' ').slice(0, 200) || '-',
    );
  }
  return parts.map((s) => String(s).replace(/\|/g, '/')).join(' | ');
}
