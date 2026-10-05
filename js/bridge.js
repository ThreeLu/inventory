// 物品档案 → 账本：买回来的东西顺手记一笔账。
// 两个网站在同一个域名下（threelu.github.io），令牌是同一个，所以直接读写账本的数据仓库（finance.json）。
// 账本那边是「先存手机、后台上传」，它上传时会在 GitHub 最新的数据上合并，所以这里直接提交不会被覆盖。
// 账本的格式见 ledger/CLAUDE.md；这里只往 tx 里加支出，不改别的。

import { GitHub, GitHubError } from './github.js';

const LEDGER_FILE = 'finance.json';

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// 账本仓库：账本设置里填过就用那个，没有就和物品档案同一个账号下的 finance-data
export function ledgerGitHub(invSettings) {
  const ls = readLocal('ledger-settings');
  const owner = (invSettings.repo || 'ThreeLu/inventory-data').split('/')[0];
  const token = ls.token || invSettings.token;
  return token ? new GitHub({ token, repo: ls.repo || `${owner}/finance-data` }) : null;
}

// 读账本：只拿记账要用的（人民币账户、支出类别、上次用的账户）。读不到返回 null（没开通账本、令牌没授权）
export async function readLedger(gh) {
  if (!gh) return null;
  try {
    const d = JSON.parse(await gh.readText(LEDGER_FILE, 'main'));
    const accounts = (d.accounts || []).filter((a) => a.currency !== 'USD');
    const categories = (d.categories || []).filter((c) => c.kind === 'expense' && !c.hidden && !['c-wish', 'c-trip'].includes(c.id));
    const last = readLocal('ledger-last').account;
    return {
      accounts, categories, tx: d.tx || [],
      account: accounts.some((a) => a.id === last) ? last : accounts[0]?.id,
      left: budgetLeft(d),
    };
  } catch (e) {
    if (e instanceof GitHubError) return null;
    throw e;
  }
}

// 这个预算月吃饭、日常两组还剩多少（和账本 money.js 的 periodOf / 预算一样：预算月从 periodStartDay 号开始）
export function budgetLeft(d, now = new Date()) {
  const startDay = d.settings?.periodStartDay || 1;
  const y = now.getFullYear();
  const m = now.getMonth() - (now.getDate() < startDay ? 1 : 0);
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const start = fmt(new Date(y, m, startDay));
  const end = fmt(new Date(y, m + 1, startDay - 1));
  const group = new Map((d.categories || []).map((c) => [c.id, c.group]));
  const spent = { food: 0, daily: 0 };
  for (const t of d.tx || []) {
    if (!['expense', 'writeoff'].includes(t.type) || t.date < start || t.date > end) continue;
    const g = group.get(t.category);
    if (g in spent) spent[g] += t.cny ?? t.amount;
  }
  const r = (n) => Math.round(n);
  return { end, food: r((d.budget?.food || 0) - spent.food), daily: r((d.budget?.daily || 0) - spent.daily) };
}

// 物品档案的类别 → 账本的类别（猜一个默认的，界面上可以改）
const BY_TAG = {
  零食食品: 'c-snack', 洗漱护肤: 'c-toiletry', 清洁用品: 'c-tissue', 药品急救: 'c-medical', 文具: 'c-stationery',
  书籍资料: 'c-books', 电子产品: 'c-gadget', 衣服: 'c-clothes', 运动服: 'c-clothes', 鞋: 'c-shoes', 床上用品: 'c-bedding',
  收纳容器: 'c-storage', 搬家用品: 'c-storage', 日用杂物: 'c-dorm', 水杯餐具: 'c-dorm', 旅行用品: 'c-dorm', 包: 'c-accessory',
  运动器材: 'c-hobby', 收藏纪念: 'c-like',
};
// 名字里的字 → 类别（账本的导入小票用的是同一张表，改的话两边一起改）
const BY_WORD = [
  [/水$|矿泉水|可乐|雪碧|汽水|茶饮|奶茶|咖啡|饮料|果汁|酸奶|牛奶|豆奶|红牛|脉动|东方树叶/, 'c-drink'],
  [/苹果|香蕉|橙|橘|梨|葡萄|西瓜|草莓|蓝莓|芒果|猕猴桃|水果|柚/, 'c-fruit'],
  [/薯片|饼干|面包|巧克力|糖|坚果|瓜子|辣条|泡面|方便面|火腿肠|零食|蛋糕|卤|肉干|海苔|果冻/, 'c-snack'],
  [/纸巾|抽纸|卷纸|湿巾|洗衣|清洁|垃圾袋|洗洁精|消毒|除菌|抹布|拖把|刷子/, 'c-tissue'],
  [/洗面奶|洁面|面霜|乳液|精华|面膜|防晒|润唇|唇膏|身体乳|护手霜|爽肤水|护肤/, 'c-skin'],
  [/遮瑕|眉笔|素颜霜|粉底|隔离霜|修眉|眉刀|口红/, 'c-makeup'],
  [/香水|香氛/, 'c-scent'],
  [/牙膏|牙刷|牙线|洗面|洗发|护发|沐浴|香皂|肥皂|面霜|乳液|护肤|防晒|剃须|毛巾/, 'c-toiletry'],
  [/药|创可贴|口罩|体温计|碘伏|棉签/, 'c-medical'],
  [/笔|本子|笔记本|便利贴|文件夹|胶带|胶水|橡皮|尺|订书/, 'c-stationery'],
  [/电池|数据线|充电|耳机|插座|插线板|U盘|转接/, 'c-gadget'],
  [/收纳|挂钩|衣架|置物/, 'c-storage'],
  [/袜|内裤|背心|T恤|衬衫|裤|外套|卫衣/, 'c-clothes'],
];

export function guessCategory(ledger, name, tag) {
  const ok = (id) => (ledger.categories.some((c) => c.id === id) ? id : null);
  // 账本里以前记过同名的东西：按上次的类别
  const past = [...ledger.tx].reverse().find((t) => t.type === 'expense' && t.category && (t.note || '').split(/[、，,：:\s]/).includes(name));
  if (past && ok(past.category)) return past.category;
  for (const [re, id] of BY_WORD) if (re.test(name) && ok(id)) return id;
  return ok(BY_TAG[tag]) || ok('c-dorm') || ledger.categories[0]?.id;
}

const newTxId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const round2 = (n) => Math.round(n * 100) / 100;

// 同一个类别的合成一笔：[{ name, price, category }] → [{ category, amount, names }]
export function groupLines(lines) {
  const groups = new Map();
  for (const l of lines) {
    if (!(l.price > 0) || !l.category) continue;
    const g = groups.get(l.category) || { category: l.category, amount: 0, names: [] };
    g.amount = round2(g.amount + l.price);
    g.names.push(l.name);
    groups.set(l.category, g);
  }
  return [...groups.values()];
}

// 记进账本：每组一笔支出。冲突（账本刚被别的设备改过）就重读再来
export async function addLedgerExpenses(gh, { date, account, groups, prefix = '' }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await gh.headSha();
    const d = JSON.parse(await gh.readText(LEDGER_FILE, head));
    d.tx ||= [];
    const now = new Date().toISOString();
    for (const g of groups) {
      d.tx.push({
        id: newTxId(), type: 'expense', date, account, amount: g.amount, category: g.category,
        note: `${prefix}${g.names.join('、')}`, ...(g.category === 'c-other' ? { what: g.names.join('、') } : {}),
        from: 'inventory', createdAt: now,
      });
    }
    const total = round2(groups.reduce((a, g) => a + g.amount, 0));
    try {
      await gh.commit(head, [{ path: LEDGER_FILE, content: JSON.stringify(d, null, 1) + '\n' }], `物品档案记账：${groups.map((g) => g.names.join('、')).join('；')} ${total}`.slice(0, 200));
      return;
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
    }
  }
}
