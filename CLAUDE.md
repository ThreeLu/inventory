# 物品档案 — 给 Claude Code 的说明

用户在学校宿舍，用这个网页记录所有物品。用中文交流。

## 结构

- **本仓库 `ThreeLu/inventory`（公开）**：纯静态网页，GitHub Pages 发布在 https://threelu.github.io/inventory/ 。推送到 main 就自动上线。**绝不能提交任何数据、照片或令牌。**
- **数据仓库 `ThreeLu/inventory-data`（私有）**：`inventory.json` + `photos/` + `thumbs/`。网页用用户自己填的 fine-grained 令牌（只授权这个仓库的 Contents 读写）通过 GitHub API 读写。每次修改是一次提交。
- 用户不想在本地留数据：不要把数据仓库 clone 到本地长期保存，读写都走 API。

## 数据格式（inventory.json）

```
{ version, tags: [名称], fieldPresets: { 标签: [字段名] },
  tagCodes: { 标签: '100' }, unlabeledTags: [标签], consumableTags: [标签], assetHighWater: { '100': 12 }, reminderDays: 30,
  locations: [{ id, name, parent, assetId, label, labelPrintedAt }],
  items: [{ id, name, assetId, location, tags, quantity, description, fields: {名: 值},
            photos: [{ file, thumb }], receipts: [{ file, thumb }],
            manufacturer, modelNumber, serialNumber, purchaseDate, purchasePrice, purchaseFrom,
            warrantyExpires, notes, consumable, archived, archiveReason, archivedAt, label, labelPrintedAt, createdAt, updatedAt }] }
```

- 编号 `XXX-YYYY`：前 3 位是类别（物品按**建档时的类别**查 `tagCodes`，柜子等位置统一 `010`，无标签 `000`），后 4 位是该类顺序号（0001～9999）。**每件物品都有编号**，之后改标签不自动换号（编辑页会提示不一致，可手动「按新类别重新编号」）。物品和位置共用、不能重复，前 3 位范围 000～899。
- 编号和贴不贴标签是两回事。`label`：`none` 不贴 / `pending` 待打印 / `printed` 已打印（`labelPrintedAt` 日期）。新建默认：`unlabeledTags`（衣服、运动服、鞋）为 none，其他 pending。打完标记 printed；「重新打印」回到 pending（编号不变）；改编号且要贴 → pending；关掉贴标签 → none（编号保留，已贴的照样能扫）。下载 Excel 不自动标记。
- `reminderDays` 天内到期的「保质期」字段和 `warrantyExpires` 会在首页提醒；数据仓库里的 `.github/workflows/reminders.yml` 每周一建 issue @用户，GitHub 发通知邮件。
- 编号永不复用：`assetHighWater` 记每类用到过的最大号（只增不减，`Store.save` 里统一更新），新号 = max(它, 现有最大) + 1，删除也不会让号回退。
- 退役：扔掉/送人/丢失等用「归档」（`archived`、`archiveReason`、`archivedAt`），记录和编号都保留；「删除」只用于录错。消耗品（`consumable`，默认按 `consumableTags`）用完了把 `quantity` 设为 0（不归档），进「购物清单」；补货填新数量和保质期，编号不变，可选重新打印标签。用完的不做到期提醒。
- 旧数据缺 `tagCodes` 等字段、或还是旧的 `labelPrinted` 布尔值时，`store.js` 的 `migrate()` 会补上/转换；`tools/import_items.py` 的 `migrate()` 做同样的转换，两边要保持一致。
- 标签二维码内容：`https://threelu.github.io/inventory/?a=000-0123`。**改仓库名或网址会让已贴的标签全部失效。**
- 照片文件名随机且写入后不改，网页会永久缓存；改照片要换新文件名。
- **一件东西只有一个类别**（数据里仍是 `tags` 数组，但只放一个）。界面上分类叫「类别」，「标签」专指贴纸。
- DeepSeek 等密钥存在数据仓库的 `config/ai.json`（所有设备共用，`Store.readConfig/saveConfig`），不放进 inventory.json。
- 位置名称「中文 English」，柜子都在主屋；不用的东西归档并在备注写原因，不删除。

## 代码

- **先存手机、后台上传**（`js/store.js`，和账本同一套）：`save()` 在本地数据上改、算 patch（带 id 的列表按 id 增改删和顺序，普通对象按字段，其他整个替换）进 localStorage 队列 `inventory-queue`，页面立刻更新；`sync()` 在 GitHub 最新数据上套 patch 提交（422 重读再来），没网 20 秒后重试、`online` 事件马上重试；顶上 `.sync-pill` 只在没网 / 失败 / 上传超过 1.5 秒时出现。**分了新编号的修改（新建物品、箱子、改编号）自动走 online**（`newAssetIds`，编号要在最新数据上分，免得两台设备撞号），带照片、删照片也走 online。`saving()` 的「正在保存」250ms 后才弹，所以本地保存不闪。测试里 `Ctx.data()` 会先等队列清空。
- 撤销代替确认：`saveUndoable(message, mutate, doneText)` 先做，底部 `undoToast`「…  撤销」6 秒；撤销 = 把 `diff(改后, 改前)` 套回去（只动这次改到的，`assetHighWater` 不回退）。用在用完了、已归还、找不到了、重新打印、标记已打印、换季、拆箱放回、删模板。删除物品 / 位置 / 类别、改已打印的编号、退出等仍然 `confirm`。
- 顺手记账（`js/bridge.js`）：同一个令牌直接写账本仓库 `finance-data/finance.json`（`ledgerGitHub`：账本设置的仓库，没有就同账号下的 finance-data），只往 `tx` 里加 `expense`（带 `from: 'inventory'`）。「买回来了」和新建物品填了价格后弹「顺手记一笔账？」：类别按 名字关键词 / 账本里同名的上次类别 / 物品类别 猜（`guessCategory`，关键词表和账本 `js/receipt.js` 的 `BY_WORD` 是同一张，改要两边改），同类合一笔，只列人民币账户，默认账本上次用的账户（`localStorage['ledger-last']`）。读不到账本就不问。
- 生活网站（`../life`）的形象页会写 inventory.json：护肤品「快用完了」设 / 删 `item.runningLow`（直接提交）。
- 账本的「导入小票」会写 inventory.json：补货（quantity、purchaseDate、notes、清 runningLow）、划掉 `shopping.extra`、`shopping.history` 记 `from: 'receipt'`、新东西进 `shopping.toFile`（带 `qty`、`paid: true`、`from: 'receipt'`）。`toFile` 建档链接带上价格、数量、日期，`paid` 的建档后不再问记账；首页「需要注意」显示还没建档的件数。
- 推送（数据仓库 `.github/*_push.py`）：GitHub 定时任务不准、整点常整次跳过（2026-10-04 晚两条都没发），所以每个推送错开整点排三次 cron，脚本 `once(key)` 用 `config/push-sent.json` 保证一天只发一次、过了点（晚上 23 点 / 购物 13 点）不发；手动运行不受影响。没合成一条：iPhone 上两个网站是两个 App，一条通知只能打开其中一个。
- 晚上洗衣推送顺带：今天 / 明天过退货期的、两天内离校的。周日购物推送带「大概 ¥N（预算 ¥M）」，规则里加了「按平时多久买一次快该买了」，和网页一致。
- 退货期：`item.returnBy`；新建时类别在 `RETURN_TAGS`（电子产品、衣服、运动服、鞋、包、运动器材）且填了购买日期、没填退货截止 → 购买日期 + 7 天（已过不填）。`reminders()` 里 kind「退货」只在 0～3 天内出现；首页单独一条，物品页横幅「没问题，不退了」删掉 returnBy。
- 消耗品节奏：`usageRate(data, item)` 用 `shopping.history` 里同一 itemId 的不同日期（≥2 次）算平均几天买一次；`next − 4 天` 到了就进购物清单（`平时 N 天买一次，差不多该买了`）。`monthlyConsumables()` 最近 90 天有价格的购物记录按类别 ÷ 3，统计页显示。
- 衣服穿一次多少钱：`costPerWear(item)` = 价格 ÷ `item.worn.length`（衣服、运动服、鞋）。物品页一行，统计页「最值」（穿 ≥3 次，便宜在前）和「还没回本」。
- 购物预算：`shopEstimate(data, entry)` = 上次买它的价格（history 按 itemId 或同名）或建档价格；`prefs.shopBudget` 每周预算；顶上卡片：大概多少、预算够不够、已勾的多少、账本这个月吃饭 / 日常还剩多少（`bridge.budgetLeft`，和账本 periodOf 一样算）。
- 放假离校 / 开学返校（`#/term`）：`data.term = { leave, back, done }`。清单现算（`termChecklist`）：返校前会过期的吃的药、要还的书、洗衣篮和床品、贵重东西（证件、钥匙、¥300 以上电子产品）、固定任务 `TERM_TASKS`；返校：在「家」的东西、购物清单。离校前 7 天 / 返校前后首页提醒；贵重东西可一键存成「放假带回家」模板去出行扫码装包。改离校日期会清空打勾。
- 找东西（`#/find?text=`，Siri 快捷指令用，说明在 `#/siri`）：去掉「在哪 / 放哪了」等词 → 名称包含 → 全部信息 → 按字重合 ≥2。结果显示中文位置路径。
- 手机丢了（`#/lost`，两站都有）：怎么在 GitHub 删令牌、换令牌；最近 40 次修改（两个仓库合起来）按设备统计。网页的每次提交说明后面自动加「 · 设备」（`github.js` 的 `DEVICE`），`recentCommits()` 拆出来。
- `js/main.js` 路由和页面；`js/scan.js` 网页内扫码（`vendor/jsQR.js`，按需加载）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不要用 innerHTML 拼数据，令牌存在 localStorage，XSS 会泄露令牌）、图片压缩、照片缓存。
- `tools/import_items.py`：Mac 上批量录入，流程见 `.claude/skills/batch-import`。
- 没有构建步骤。

## 测试

- `python3 tests/test_app.py`：真浏览器 + 本地假 GitHub（`tests/fake_github.py`，可以同时开几个仓库：`serve({"owner/name": FakeRepo})`，顺手记账写的是编的 `test/finance-data`），天气和 DeepSeek 用假数据，不联网、不需要令牌。推送后 GitHub Actions（`.github/workflows/test.yml`）自动跑。**改了功能就在这里加对应的步骤**；只跑部分：`python3 tests/test_app.py 借出 出差`。
- 网页通过 `localStorage['inventory-api-base']` 换 API 地址，导入脚本通过环境变量 `GITHUB_API_URL`，测试就是这样接到假 GitHub 的。
- 摄像头扫码没有放进自动测试（要假摄像头视频），改了 `js/scan.js` 要手动测：Chromium 加 `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<y4m>`。
- **绝不拿用户的真实数据仓库做写入测试。**需要连真 GitHub 时，复制数据建一个临时私有仓库，测完删掉。

## 外观和结构

- 无印良品的生成り底色 + 苹果的系统字体、大标题、分组列表、毛玻璃底部导航，主色藤紫 `#7a68b0`（深色 `#b4a6e3`）。颜色都在 `css/app.css` 的 `:root` 里。图标是 `js/icons.js` 的细线 SVG。
- 底部五栏：今天（首页：今天穿什么、问一问、需要注意）/ 物品（照片目录，默认；按位置；列表）/ ＋（新建、扫码、问一问）/ 衣橱（今天穿什么、穿着记录、出差、换季）/ 我的（标签、借阅、装箱、清单模板、提醒、购物清单、统计、管理、设置）。
- 暂缓、等和用户细聊的：断舍离（每季度一次）。
- 页面右上角的「?」是 `helpButton(title, sections)`：用户说过有时不知道怎么操作，新功能的页面都配一份「怎么用」。

## AI 功能（都走 `js/ai.js` 的 `askJson`）

- 隆重（第五类）：风格「隆重」或名字有西装 / 西服 / 礼服，只在安排「隆重场合」时推荐，缺鞋用正式的补；其他时候出门那套也排除。秋衣秋裤提醒线 `LAYER_BELOW` = 最低温 13°C。
- 厚薄跟着季节（`thickOptions`）：夏季只有 薄 / 厚，冬季、春秋、四季 薄 / 适中 / 厚；表单里选了季节，厚薄下拉跟着变，AI 补全不合的会丢掉。推荐按白天平均气温给每种「季节·厚薄」打分（`fitTargets` / `fitScore`，≥28 夏薄，23～28 夏厚，16～23 春秋适中，10～16 春秋厚 / 冬薄，3～10 冬适中，<3 冬厚）。尺码从衣服、运动服、鞋的常用字段里拿掉了（`presetVersion` 2，只删一次，已填的尺码不动）。
- 腰带轮换（`beltFatigue` / `beltAdvice`，名字有腰带 / 皮带）：系一天 +1、歇一天 −0.5（最低 0，今天没系不算歇）；正在系的那条「今天再系」就到 7 分时，在「选今天穿的」页提醒换成分最低的那条，并给它打「推荐」。物品页显示腰带疲劳。只有一条腰带时不提醒换。同一种腰带数量 ×2（用户的就是这样，一模一样分不出来）：`item.beltSwaps = [{ date, to }]` 记哪天换成第几条，每天系的算在当天正在用的那条上（`beltUnit`），按「正在系的 / 歇着的」分别算分；该换时横幅里点「换好了」记一次换（可撤销）。
- 衣服分四类（用户 2026-10-05 定的，`styleOf`）：**运动** = 名字里有「运动」（或类别运动服、风格运动），只在跑步时穿；**居家** = 风格「居家」或名字有睡衣睡裤家居服，只在宿舍穿；**休闲** = 爬山、出去玩；**正式** = 风格「正式」或没填，最常穿（上班）。秋衣秋裤这类打底（`isLayer`）不参与搭配，冷（早上 < 8°C）时提醒加在里面。安排 → 类别见 `SCHEDULE_STYLE`（上班 / 上课 / 见客户 / 面试 → 正式，跑步 → 运动，爬山 / 出去玩 → 休闲，逛街约会两类都行，宅宿舍 → 居家）；`dayStyles` 分出门那套、跑步那套、在宿舍那套，出门那套绝不混进运动、居家的（规则挑和 DeepSeek 回来的都在网站再过滤一遍）。工作日默认「上班」、周末默认「宅宿舍」。一套都挑不出来时存空的 options，首页说原因，不反复重新生成。
- 今天穿什么（`js/outfit.js`）：常住城市 `data.prefs.homeCity`（济南）今天的天气 + 安排 + 能穿的衣服（字段 部位/季节/厚薄/风格/颜色）→ 2～3 套推荐，存 `data.outfit`（当天缓存）。**推荐只打「推荐」标记、不预选**，用户在挑选页一件件点今天穿的（`setTodayWear`，一天可改几次，穿着次数跟着更正）。用户是男生（`prefs.gender`），没有连衣裙。无 AI 时规则挑一套。
- 问一问：把全部物品（含价格、购买日期、备注描述、品牌型号；不含序列号和照片）发给 AI；要修改时 AI 返回 `actions`，界面列出、用户确认后才执行（`ACTIONS` / `applyAction`）。不给用药建议。聊天记录只在内存。
- AI 补全：新建时按名称推荐类别、字段、是否消耗品。
- 换季整理（`js/season.js`）：清明/立夏/白露/寒露/立冬判断该穿的季节，列出拿进当季衣柜和收起来的；数据仓库 `.github/workflows/season.yml` 在这几天发邮件。

## 洗衣篮

- `item.laundry = { state: 'dirty'|'washing', since, autoReturn? }`，没有就是干净；`wearsSinceWash` 记洗后穿了几次，`lastWashed` 记上次洗。
- 晚上问「今天穿的要洗吗」：今天穿过、没在洗衣流程里的衣服；默认勾选按穿着次数：当天最高温 < `coldBelow`(20°C) 用 `cold`（上衣 3、裤子 5、外套 12），否则 `warm`（1/3/5）。当天没记录穿什么就先问「今天穿了什么？」（可点「今天没换衣服」）。回答后写 `prefs.laundryAsked = 今天`。
- 内衣、袜子（部位）每天洗：穿过就 `washing + autoReturn 明天`，`migrate()` 到期自动清掉，不参与搭配。
- 攒够件数或放太久、床上用品超过周期 → 首页和晚上推送提醒。分批：单独洗或送洗 / 床品 / 浅色 / 深色 / 彩色。
- 推送：`sw.js` + `js/push.js` 订阅，订阅存数据仓库 `config/push.json`；数据仓库 `.github/workflows/laundry.yml` 每天 12:00 UTC（北京 20 点）用 secret `VAPID_PRIVATE_KEY` 发送（`laundry_push.py`，规则和网页一致）。VAPID 联系方式用网址，不用用户邮箱。

## 扫码核对（出行、拆箱、模板、收纳袋）

- 通用核对页 `checkView(cfg)`：连续扫码打勾、手动 ✓、扫收纳袋 = 袋子里的全部；清单外的问要不要加（`collect` 模式直接加）。进度存在设备 localStorage（`inventory-check-*`），完成后清掉。路由 `#/check/(trip|box|list|bag)/:id[/out|back]`。
- 测试没有摄像头：`localStorage['inventory-test-scan']` 打开后，`window.__scan(code)` 直接喂扫码内容。真摄像头用假视频本地测。
- 出行（原「出差/旅行」）：`trip.kind` 出差/回家/其他；`checked` 计划、`out` 出发带走（装进行李箱，记 homeLocation）、`back` 回程找到。回程没找到的：落下了（`item.leftBehind`，首页提醒，找回来了/找不到了→归档丢失）、留在家里（位置改成「家」，`ensureHome`）、其实没带。
- 清单模板 `data.lists = [{id,name,scene,items}]`：从物品勾选、扫码添加、出行「存成模板」。
- 收纳袋：位置 `box: 'bag'`，常驻、`parent` 是平时放的柜子，里面的东西算在家（`isBox` 只认 move/trip）。行李箱装走时 homeLocation 是袋子，回来放回袋子。

## 购物清单

- 用户每周日去超市买一次生活必需品。`store.js` 的 `shoppingList(data)` 算出清单：消耗品用完的（quantity 0）、点过「快用完了」的（`item.runningLow` 日期）、数量 ≤ `item.lowAt`（「剩几件时进购物清单」，选填，能数的东西才设）、「保质期」14 天内到期的（买新的换掉），加上手动加的 `data.shopping.extra`。
- `data.shopping = { extra: [{id,name,addedAt,note?}], skip: {key: 到哪天为止}, history: [{date,name,itemId?,price?}], toFile: [{id,name,price,date}], ai: {week,list} }`。key：物品 `i:<id>`，手动 `m:<id>`。「这周不买」= skip 7 天。
- 在超市勾选只存在设备 localStorage（`inventory-shop-checked`），点「买回来了」才写仓库：物品填「现在有」几个（清掉 runningLow，可换保质期），手动加的从 extra 去掉，勾了「建档」的进 toFile（`#/new?name=..&shop=id` 建档后去掉）。价格记进 history，统计页按周显示花费。
- 手动加的名字和档案里的消耗品同名时，直接标那件「快用完了」。问一问也能 `running_low{id}`、`shop{name}`。
- AI 建议一周生成一次（按周日起算的 `shopWeek()`），存 `shopping.ai`，点「加入」才进清单。
- 首页只在周六、周日提示；数据仓库 `.github/workflows/shopping.yml` 周日 01:00 UTC（北京 9 点）推送（`shopping_push.py`，规则和 `shoppingList` 一致，复用 `laundry_push.send`）。`#/restock` 旧链接跳到 `#/shopping`。

## 其他功能速记

- 装箱：箱子是带 `box: 'move'|'trip'` 的位置，装进去的物品记 `homeLocation`，「全部放回原处」靠它；统一用 `store.js` 的 `moveItem()` 移动物品。
- 出差：`js/trip.js`。天气用 Open-Meteo（16 天内逐日预报，否则按月份估计）；规则层永远可用；设置里填了 DeepSeek 密钥（存在设备的 localStorage `inventory-deepseek`）就让 AI 挑东西和搭配衣服，只发名称、类别、字段。AI 返回的 id 会过滤掉不存在的。行程存在 `data.trips`。
- 借阅（从图书馆借书）：`item.borrow = { from, date, due, renewals }`，还书前 3 天和逾期在首页、每周邮件提醒；续借改 due；「已归还」= 归档（原因 已归还）。旧的「借出」已去掉。
- 令牌到期日由用户在设置里填（GitHub 不把到期时间暴露给网页），提前 14 天在首页提醒。

## 外观（2026-10，和「生活」「账本」一致）

- 无印良品底色 + 藤紫、白卡片柔阴影不变；页面大标题、卡片小标题用宋体（`--serif`），正文苹方。
- 首页开头：日期 → 宋体问候（`greeting`，按时间）→ 节气（`termTag`）和天气两个小标签。`js/solar.js` 和 life 仓库的节气算法是同一份，改了要三边一起改。
- 每页最下面角落一句话（`js/words.js`，物品观，安静的短句，每页每天一句）；扫码、编辑、标签、设置页不放。话要温柔、短，不说教。
- 点选标签 / 勾清单时轻轻弹一下（`.pop`）；换页淡入（`#view.enter`，只在换页时）；浅色时底色随节气微变（`html[data-season]`）。
