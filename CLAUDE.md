# 物品档案 — 给 Claude Code 的说明

用户在学校宿舍，用这个网页记录所有物品。用中文交流。

## 结构

- **本仓库 `ThreeLu/inventory`（公开）**：纯静态网页，GitHub Pages 发布在 https://threelu.github.io/inventory/ 。推送到 main 就自动上线。**绝不能提交任何数据、照片或令牌。**
- **数据仓库 `ThreeLu/inventory-data`（私有）**：`inventory.json` + `photos/` + `thumbs/`。网页用用户自己填的 fine-grained 令牌（只授权这个仓库的 Contents 读写）通过 GitHub API 读写。每次修改是一次提交。
- 用户不想在本地留数据：不要把数据仓库 clone 到本地长期保存，读写都走 API。

## 数据格式（inventory.json）

```
{ version, tags: [名称], fieldPresets: { 标签: [字段名] },
  locations: [{ id, name, parent, assetId }],
  items: [{ id, name, assetId, location, tags, quantity, description, fields: {名: 值},
            photos: [{ file, thumb }], receipts: [{ file, thumb }],
            manufacturer, modelNumber, serialNumber, purchaseDate, purchasePrice, purchaseFrom,
            warrantyExpires, notes, archived, createdAt, updatedAt }] }
```

- 编号格式 `000-123`，范围 000-001 ~ 899-999，物品和位置共用、不能重复。衣服鞋子不贴标签，`assetId` 为 null。
- 标签二维码内容：`https://threelu.github.io/inventory/?a=000-123`。**改仓库名或网址会让已贴的标签全部失效。**
- 照片文件名随机且写入后不改，网页会永久缓存；改照片要换新文件名。
- 位置名称「中文 English」，柜子都在主屋；不用的东西归档并在备注写原因，不删除。

## 代码

- `js/main.js` 路由和页面；`js/store.js` 数据读写（`save()` 在最新数据上执行修改函数，422 冲突时重读重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不要用 innerHTML 拼数据，令牌存在 localStorage，XSS 会泄露令牌）、图片压缩、照片缓存。
- `tools/import_items.py`：Mac 上批量录入，流程见 `.claude/skills/batch-import`。
- 没有构建步骤。

## 测试

改了网页代码后：
1. `python3 -m http.server 8765 --bind 127.0.0.1`（在仓库根目录）。
2. 用 Playwright 跑主要流程（登录、新建带照片、扫码、编辑、归档、标签 Excel），检查控制台没有报错。令牌用 `gh auth token`。
3. 测试会往真实数据仓库写东西：**用户开始正式使用后，不要再拿真实数据仓库做写入测试**，改用一个临时测试仓库（在设置页里换仓库名）。
