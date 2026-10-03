# 物品档案 — 给 Claude Code 的说明

用户在学校宿舍，用这个网页记录所有物品。用中文交流。

## 结构

- **本仓库 `ThreeLu/inventory`（公开）**：纯静态网页，GitHub Pages 发布在 https://threelu.github.io/inventory/ 。推送到 main 就自动上线。**绝不能提交任何数据、照片或令牌。**
- **数据仓库 `ThreeLu/inventory-data`（私有）**：`inventory.json` + `photos/` + `thumbs/`。网页用用户自己填的 fine-grained 令牌（只授权这个仓库的 Contents 读写）通过 GitHub API 读写。每次修改是一次提交。
- 用户不想在本地留数据：不要把数据仓库 clone 到本地长期保存，读写都走 API。

## 数据格式（inventory.json）

```
{ version, tags: [名称], fieldPresets: { 标签: [字段名] },
  tagCodes: { 标签: '100' }, unlabeledTags: [标签], reminderDays: 30,
  locations: [{ id, name, parent, assetId, labelPrinted }],
  items: [{ id, name, assetId, location, tags, quantity, description, fields: {名: 值},
            photos: [{ file, thumb }], receipts: [{ file, thumb }],
            manufacturer, modelNumber, serialNumber, purchaseDate, purchasePrice, purchaseFrom,
            warrantyExpires, notes, archived, labelPrinted, createdAt, updatedAt }] }
```

- 编号 `XXX-YYY`：前 3 位是类别（物品按**第一个标签**查 `tagCodes`，柜子等位置统一 `010`，无标签 `000`），后 3 位是该类顺序号。新建时自动给下一个空号；`unlabeledTags`（衣服、运动服、鞋）不给号。物品和位置共用、不能重复，范围到 899。
- 先建档再打印：有编号且 `labelPrinted === false` 的进「待打印」，打完标记为 true；编号改了要重新置 false。
- `reminderDays` 天内到期的「保质期」字段和 `warrantyExpires` 会在首页提醒；数据仓库里的 `.github/workflows/reminders.yml` 每周一建 issue @用户，GitHub 发通知邮件。
- 旧数据缺 `tagCodes` 等字段时，`store.js` 的 `migrate()` 会补上（`tools/import_items.py` 依赖数据里已有这些字段）。
- 标签二维码内容：`https://threelu.github.io/inventory/?a=000-123`。**改仓库名或网址会让已贴的标签全部失效。**
- 照片文件名随机且写入后不改，网页会永久缓存；改照片要换新文件名。
- 位置名称「中文 English」，柜子都在主屋；不用的东西归档并在备注写原因，不删除。

## 代码

- `js/main.js` 路由和页面；`js/scan.js` 网页内扫码（`vendor/jsQR.js`，按需加载）；`js/store.js` 数据读写（`save()` 在最新数据上执行修改函数，422 冲突时重读重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不要用 innerHTML 拼数据，令牌存在 localStorage，XSS 会泄露令牌）、图片压缩、照片缓存。
- `tools/import_items.py`：Mac 上批量录入，流程见 `.claude/skills/batch-import`。
- 没有构建步骤。

## 测试

改了网页代码后：
1. `python3 -m http.server 8765 --bind 127.0.0.1`（在仓库根目录）。
2. 用 Playwright 跑主要流程（登录、新建带照片、扫码、编辑、归档、标签 Excel），检查控制台没有报错。令牌用 `gh auth token`。
3. 测试会往真实数据仓库写东西：**用户开始正式使用后，不要再拿真实数据仓库做写入测试**，改用一个临时测试仓库（在设置页里换仓库名）。
