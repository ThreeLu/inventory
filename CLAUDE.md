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
- 退役：扔掉/送人/丢失等用「归档」（`archived`、`archiveReason`、`archivedAt`），记录和编号都保留；「删除」只用于录错。消耗品（`consumable`，默认按 `consumableTags`）用完了把 `quantity` 设为 0（不归档），进「需要补货」；补货填新数量和保质期，编号不变，可选重新打印标签。用完的不做到期提醒。
- 旧数据缺 `tagCodes` 等字段、或还是旧的 `labelPrinted` 布尔值时，`store.js` 的 `migrate()` 会补上/转换；`tools/import_items.py` 的 `migrate()` 做同样的转换，两边要保持一致。
- 标签二维码内容：`https://threelu.github.io/inventory/?a=000-0123`。**改仓库名或网址会让已贴的标签全部失效。**
- 照片文件名随机且写入后不改，网页会永久缓存；改照片要换新文件名。
- **一件东西只有一个类别**（数据里仍是 `tags` 数组，但只放一个）。界面上分类叫「类别」，「标签」专指贴纸。
- DeepSeek 等密钥存在数据仓库的 `config/ai.json`（所有设备共用，`Store.readConfig/saveConfig`），不放进 inventory.json。
- 位置名称「中文 English」，柜子都在主屋；不用的东西归档并在备注写原因，不删除。

## 代码

- `js/main.js` 路由和页面；`js/scan.js` 网页内扫码（`vendor/jsQR.js`，按需加载）；`js/store.js` 数据读写（`save()` 在最新数据上执行修改函数，422 冲突时重读重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不要用 innerHTML 拼数据，令牌存在 localStorage，XSS 会泄露令牌）、图片压缩、照片缓存。
- `tools/import_items.py`：Mac 上批量录入，流程见 `.claude/skills/batch-import`。
- 没有构建步骤。

## 测试

- `python3 tests/test_app.py`：真浏览器 + 本地假 GitHub（`tests/fake_github.py`），天气和 DeepSeek 用假数据，不联网、不需要令牌。推送后 GitHub Actions（`.github/workflows/test.yml`）自动跑。**改了功能就在这里加对应的步骤**；只跑部分：`python3 tests/test_app.py 借出 出差`。
- 网页通过 `localStorage['inventory-api-base']` 换 API 地址，导入脚本通过环境变量 `GITHUB_API_URL`，测试就是这样接到假 GitHub 的。
- 摄像头扫码没有放进自动测试（要假摄像头视频），改了 `js/scan.js` 要手动测：Chromium 加 `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<y4m>`。
- **绝不拿用户的真实数据仓库做写入测试。**需要连真 GitHub 时，复制数据建一个临时私有仓库，测完删掉。

## 外观和结构

- 无印良品的生成り底色 + 苹果的系统字体、大标题、分组列表、毛玻璃底部导航，主色藤紫 `#7a68b0`（深色 `#b4a6e3`）。颜色都在 `css/app.css` 的 `:root` 里。图标是 `js/icons.js` 的细线 SVG。
- 底部五栏：今天（首页：今天穿什么、问一问、需要注意）/ 物品（照片目录，默认；按位置；列表）/ ＋（新建、扫码、问一问）/ 衣橱（今天穿什么、穿着记录、出差、换季）/ 我的（标签、借阅、装箱、提醒、补货、统计、管理、设置）。
- 暂缓、等和用户细聊的：购物清单、断舍离。

## AI 功能（都走 `js/ai.js` 的 `askJson`）

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

## 其他功能速记

- 装箱：箱子是带 `box: 'move'|'trip'` 的位置，装进去的物品记 `homeLocation`，「全部放回原处」靠它；统一用 `store.js` 的 `moveItem()` 移动物品。
- 出差：`js/trip.js`。天气用 Open-Meteo（16 天内逐日预报，否则按月份估计）；规则层永远可用；设置里填了 DeepSeek 密钥（存在设备的 localStorage `inventory-deepseek`）就让 AI 挑东西和搭配衣服，只发名称、类别、字段。AI 返回的 id 会过滤掉不存在的。行程存在 `data.trips`。
- 借阅（从图书馆借书）：`item.borrow = { from, date, due, renewals }`，还书前 3 天和逾期在首页、每周邮件提醒；续借改 due；「已归还」= 归档（原因 已归还）。旧的「借出」已去掉。
- 令牌到期日由用户在设置里填（GitHub 不把到期时间暴露给网页），提前 14 天在首页提醒。
