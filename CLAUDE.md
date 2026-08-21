# Kanbox

## 产品边界

当前维护免费本地版，保留首页卡片分组，支持笔记编辑、数据导出、粘贴链接导入、分类筛选、拖动分类、重新归档、阅读器、iCloud 存储，以及可选的在线 AI 能力（AI 摘要 / 知识拓展 / 音转文字增强）。

明确不在当前实现中的内容：

- 知识库、知识图谱和流墙
- 收藏夹批量同步
- `safe-xhs` 或其他自动抓取器
- 小红书登录态和账号切换
- AI 聊天对话界面和聚合知识库（AI 能力仅限摘要/拓展/转写，无对话）

## 当前调用链

1. 用户从小红书搜索页拖动一条笔记卡片，或粘贴笔记 URL
2. `browser-extension/content.js` 只把卡片已有的链接和标题写入拖拽载荷
3. `POST /notes/import` 调用无 Cookie 的本地匿名解析器读取这一条公开笔记页面
4. Sidecar 把配图保存到本地并调用 macOS Vision OCR
5. 标题、正文与图片文字参与本地分类（22 类规则分类，推断不出归入兜底「其他」）
6. `app/components/DeskView.tsx` 把新笔记按分类自动归入对应分组，无法分类的进「待整理」并置顶

扩展没有 `tabs` 或 `cookies` 权限，不能后台打开登录页面或读取账号凭证。匿名解析器显式使用 `credentials: omit`，失败时不会回退到登录浏览器。这条链路只处理用户拖入的单条笔记，不访问收藏夹。

## 主要文件

- `app/components/DeskView.tsx`：首页、卡片分组、整页拖入反馈、笔记编辑、粘贴导入
- `app/lib/xhs-client.ts`：前端访问本地服务
- `app/lib/desk-workspace.mjs`：分组状态
- `scripts/local-api.mjs`：本地存储 API（含导出和编辑接口）
- `scripts/kanbox-mcp.mjs`：MCP server，供 Claude Code / Codex 使用
- `scripts/lib/anonymous-note-resolver.mjs`：不带账号凭证的单条公开页面解析
- `scripts/lib/note-import.mjs`：拖拽载荷校验、标准化和去重
- `scripts/lib/media-import.mjs`：配图本地化与本地 OCR
- `scripts/lib/category-inference.mjs`：22 类规则分类（唯一版本，前端和后端共用，含重新归档 reCategorizeNotes）
- `scripts/lib/note-search.mjs`：笔记全文搜索
- `scripts/lib/ai-service.mjs`：AI 摘要 / 知识拓展 / 音转文字（OpenAI 兼容接口）
- `scripts/lib/storage-location.mjs`：数据目录解析（iCloud / 本机 / 自定义）
- `scripts/lib/ai-provider-presets.mjs`：推荐服务商/模型预设
- `app/components/ErrorBoundary.tsx`：渲染异常兜底
- `browser-extension/`：卡片拖拽与当前详情页的本地读取

## 验证命令

```bash
npm test
npm run lint
npm run build
```

## 接口

- `GET /health`
- `GET /events` — SSE 事件流（笔记变更、AI 流水线进度）
- `GET /notes`
- `GET /workspace` / `POST /workspace` — 自定义分组与排序持久化
- `POST /notes/import`
- `POST /notes/re-categorize` — 重新归档待整理笔记
- `PATCH /notes/:id` — 更新标题、标签、分类
- `DELETE /notes/:id`
- `GET /notes/export` — 导出全部笔记为 JSON
- `GET /notes/export/markdown` / `GET /notes/export/html` — 导出 Markdown / HTML
- `GET /media/:noteId/:file`
- `GET /storage` — 存储位置信息
- `POST /storage/location` — 切换存储位置
- `GET /ai/settings` / `POST /ai/settings` — AI 配置
- `GET /ai/presets` — 推荐服务商/模型
- `POST /ai/test` / `POST /ai/test-transcribe` — 连通性测试
- `POST /ai/batch-process` — 手动补跑 AI 流水线
- `GET /ai/pipeline` — AI 流水线进度
- `GET /data/info` — 数据目录统计
- `GET /data/integrity` / `POST /data/integrity/repair` — 完整性检查与修复
- `POST /data/backup` / `POST /data/restore` — 备份与恢复
- `GET /tags` / `POST /tags/rename` / `POST /tags/delete` — 标签管理
- `GET /setup`
- `POST /setup/browser-extension/open`
- `POST /setup/open-external` — 系统浏览器打开外链
- `POST /setup/agent/connect`
- `POST /setup/restart` — 重启应用
