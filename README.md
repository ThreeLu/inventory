# 物品档案

手机上用的物品档案网页：https://threelu.github.io/inventory/

- 本仓库只有网页程序，**没有任何数据**。数据在私有仓库里，每台设备第一次打开时填一个只能访问那个仓库的 GitHub 令牌。
- 标签二维码内容是 `https://threelu.github.io/inventory/?a=000-0123`，扫码直接打开对应物品；没建档的编号会进入新建页面。
- 纯静态页面，没有构建步骤，推送到 main 分支后由 GitHub Pages 自动发布。

## 文件

```
index.html          页面骨架和底部导航
css/app.css         样式（浅色 / 深色）
js/main.js          路由和各个页面
js/store.js         数据读写：inventory.json 的查询和修改
js/github.js        GitHub API：读文件、一次提交多个文件
js/util.js          建 DOM、图片压缩、照片缓存
js/xlsx.js          生成批量标签用的 Excel
tools/import_items.py   Mac 上批量录入（Claude Code 看照片 → 清单 → 写入数据仓库）
.claude/skills/batch-import/  给 Claude Code 的批量录入流程
CLAUDE.md           给 Claude Code 的开发说明
```
