# 后端代码审查报告 (2026-08)

**审查范围**：`scripts/local-api.mjs` / `scripts/lib/video-import.mjs` / `scripts/lib/category-inference.mjs` / `scripts/lib/storage-location.mjs`（+ 强耦合的 `media-import.mjs` / `note-import.mjs`）
**审查人**：DeepSeek
**日期**：2026-08-17
**版本**：v0.7.8

---

## 结论先行

后端在 v0.6.1 全代码审计（B1–B19）后已经历多轮加固，**本轮未发现新的 P0 级「常规路径必崩 / 必丢数据」缺陷**。写并发模型（`mutationQueue` + `writeNotesChain` + 唯一临时文件名）、AI 写回只合并新字段（B3/B4）、损坏备份恢复（B2）、DNS rebinding 防御（B19）等关键防线均健在且未回退。

发现的问题集中在 **P1（数据丢失 / 安全 / 阻塞）** 和 **P2（一致性 / 死代码 / 边界）** 两档，共 5 项 P1 + 7 项 P2。

---

## 🔴 P0 — 运行时崩溃 / 数据丢失

**无新增 P0。** v0.6.1 已修复的崩溃类缺陷（并发写交错、损坏静默清空、视频流内存溢出、multipart boundary 等）均未回退。

---

## 🟡 P1 — 数据丢失 / 安全 / 阻塞

### 1. 重复导入同一条笔记会整条覆盖，丢失手动分类 / 标签 / 已生成 AI 内容
**文件**：`scripts/lib/note-import.mjs`（`mergeImportedNote`）+ `scripts/local-api.mjs`（`importNote`）
**问题**：`mergeImportedNote` 对已存在的笔记做**整体替换**而非合并：
```js
return {
  created,
  notes: [importedNote, ...safeExistingNotes.filter((note) => note?.id !== importedNote?.id)],
};
```
用户对已收录的笔记再拖一次卡片「刷新内容」时，`importNote` 会生成一份全新的 `note`（`category` 重新推断、`tags` 取解析结果、`transcriptText` 因 defer 重置为空、`aiSummary`/`aiExpansion` 丢失），把旧笔记整条顶掉。**手动改过的分类、手动加的标签永久丢失**；AI 摘要/拓展/文稿虽会因 `autoPipeline` 5 秒后自动重跑而自愈，但用户的手动策展不可恢复。
**修复**：`mergeImportedNote` 或 `importNote` 里，若命中已有笔记，保留旧笔记的 `category`（若非「待分类/其他」等推断值）、`tags`（若新数据为空）、`aiSummary`/`aiExpansion` 等手动字段，只覆盖内容性字段（title/content/imageUrls/video）。

### 2. `isAllowedOrigin` 信任任意 `chrome-extension://` 前缀，任意已装扩展可读笔记与明文 API Key
**文件**：`scripts/local-api.mjs`（L252–265）
**问题**：
```js
if (origin.startsWith('chrome-extension://')) return true;
```
只校验了 `chrome-extension://` **前缀**，没有校验具体扩展 ID。而 `GET /ai/settings` 会回传**明文** API Key（v0.5.1 决策），`GET /notes` 回传全部笔记。任何已安装的 Chrome 扩展（恶意或已被劫持的）都能以 `chrome-extension://<自己的ID>` 作为 Origin 发起跨域请求，读走笔记内容和用户密钥，还能 `PATCH /notes/:id`、`POST /ai/settings`、`POST /setup/restart` 等（当前仅 DELETE 被拦）。
**修复**：把 Kanbox 扩展的**固定 ID** 加入白名单（或在 sidecar 与扩展间加一次性的本地握手 token），而不是信任整个 scheme 前缀。

### 3. 手动转写 `reanalyzeNoteVideo` 与 `importNote` 在 `mutationQueue` 内执行分钟级慢 I/O
**文件**：`scripts/local-api.mjs`（`reanalyzeNoteVideo` L905、`importNote` L715）
**问题**：`/notes/:id/transcribe` 走 `queueVideoReanalysis` → `queueMutation(() => reanalyzeNoteVideo(...))`，整段「读笔记 → 调本地 Vision / 在线大模型转写（长视频 1–2 分钟）」都**持有 mutationQueue 锁**；`importNote` 同样在队列内下载图片 + OCR + 下载视频。期间用户编辑笔记、导入、删除等所有写操作都被串行阻塞。这与 B3/B4 确立的「慢 AI 调用放队列外、只把『重读→合并→写回』放进队列」的模式相悖（`runPipelineStep` 是正确示范）。
**修复**：`reanalyzeNoteVideo` 拆成两步——队列外做转写拿到 `patch`，队列内 `readNotes` 重读 + 只合并 `patch` 字段 + `writeNotes`（与 `runPipelineStep` 同构）。`importNote` 同理把「媒体下载/OCR/视频下载」移出队列，只把「readNotes→mergeImportedNote→writeNotes」放入队列。

### 4. `resolveDataDirectory` 自定义路径不做可写探测，不可写目录导致 sidecar 启动即崩
**文件**：`scripts/lib/storage-location.mjs`（L110–144）
**问题**：iCloud 路径有 `isWritableDir` 真实写探针兜底，但 `custom` 指针路径直接 `return pointer.path`（L113），不校验可写、也不校验能否创建。若用户把自定义目录设到未挂载的卷 / 无权限目录，`startServer` 的 `ensureDataDirectory` 的 `mkdir` 抛错 → `startServer().catch` 置 `exitCode=1`，表现为「本地服务未连接」且无从恢复（改不回来，因为 UI 也依赖 sidecar）。
**修复**：`resolveDataDirectory` 对 custom 路径同样走 `isWritableDir`（或 try `mkdirSync`）失败回退本机默认目录并写日志，而不是直接崩溃。

### 5. 标签重命名 / 删除不广播，前端标签列表不实时刷新
**文件**：`scripts/local-api.mjs`（`renameTag` L384、`deleteTag` L399）
**问题**：`renameTag` / `deleteTag` 调 `writeNotes` 但不 `broadcastUpdate`（对照：`importNote`/`updateNote`/`deleteNote` 都广播 `notes-changed`）。用户重命名/删除标签后，前端（及其它 SSE 客户端）不会实时更新标签侧栏，需手动刷新才看到变化。另：`renameTag` 未校验 `newName` 非空，传空串会经 `.filter(Boolean)` 变成**静默删除该标签**。
**修复**：两个函数各加一行 `broadcastUpdate({ type: 'notes-changed', ... })`；`renameTag` 校验 `newName` 非空，为空时抛错或忽略。

---

## 🟢 P2 — 一致性 / 死代码 / 边界

### 6. `writeLegacyNotes` 用固定临时文件名 `notes.next.json`
**文件**：`scripts/local-api.mjs`（L363–368）
**问题**：这是 B1 修复前就存在的共享临时文件名反模式。当前仅因 `deleteNote` 走 `queueMutation` 串行化才没有并发冲突，属于「碰巧安全」的脆弱点，未来任何绕过队列的调用都会重蹈 B1 覆辙。
**修复**：改成与 `writeNotes` 一致的 `notes.<pid>.<seq>.next.json` 唯一名。

### 7. `/data/restore` 两条路径的体积上限不一致
**文件**：`scripts/local-api.mjs`（L1662–1698）
**问题**：`multipart/form-data` 路径上限 10MB，但 JSON 路径走 `readRequestBody`（2MB 上限，L421）。全量 JSON 备份一旦超过 2MB，用户通过 JSON 恢复会得到误导性的「导入内容过大」。
**修复**：统一上限（如都为 10MB），或对 restore 单独放宽。

### 8. `runNativeVideoAnalyzer` 的 `JSON.parse(stdout)` 无 try/catch
**文件**：`scripts/lib/video-import.mjs`（L102）
**问题**：分析器二进制若在 stdout 前面打印告警/日志（非 JSON），`JSON.parse` 抛 `Unexpected token`，错误信息晦涩（对照 `extractVideoAudio` L120 已有 try/catch 并给出友好错误）。
**修复**：与 `extractVideoAudio` 对齐，捕获解析失败并抛「本地视频分析没有返回有效结果」。

### 9. `normalizeImportedNote` 丢弃 likes / collects / comments
**文件**：`scripts/lib/note-import.mjs`（L196–198）
**问题**：三者硬编码为 `0`，匿名解析器拿到的点赞/收藏/评论数被丢弃，UI 上恒显 0。属数据保真度缺口而非崩溃。
**修复**：从 payload（`payload.likes` 等）透传，缺省才为 0。

### 10. `getDirectorySize` 死代码
**文件**：`scripts/local-api.mjs`（L444–466）
**问题**：函数定义 + 自递归，但全文件无任何调用点（`getDataInfo` 已内联实现媒体大小统计）。grep 确认仅 L444 定义、L452 自引用。
**修复**：删除，避免误导。

### 11. 备份 version 不一致
**文件**：`scripts/local-api.mjs`（`createBackup` L593 vs `runAutoBackup` L656）
**问题**：手动备份写 `version: '0.0.3'`，自动备份写 `version: '0.2.0'`，且都不随应用版本同步，恢复时无法据此判断兼容性。
**修复**：统一备份 schema 版本常量，随应用版本号一起 bump。

### 12. 导出内容未做 scheme 校验 / 标题含换行破坏结构
**文件**：`scripts/local-api.mjs`（`exportNotesHtml` L575、`exportNotesMarkdown` L540）
**问题**：HTML 导出的 `note.sourceUrl` 经 `escapeHtml` 但未校验 scheme——正常导入的笔记 URL 都被 `normalizeImportedNote` 收窄到 xiaohongshu.com，但**从备份恢复**的笔记可携带任意 `sourceUrl`，构造 `javascript:` href 存活在导出 HTML 中（self-XSS，需用户打开自己的导出文件，低危）。Markdown 导出的 `note.title`/`author`/`tags` 原样插入，标题含换行会破坏 `## 标题` 结构。
**修复**：HTML 导出对 sourceUrl 加 `^https?:` 校验；Markdown 导出对标题做单行化处理。

---

## 🎯 最影响用户体验的 Top 3

1. **P1 #1 重复导入整条覆盖** → 手动分类/标签被顶掉，用户「刷新内容」反而丢策展（修复：合并时保留手动字段）
2. **P1 #2 任意扩展可读密钥/笔记** → 明文 API Key + 过宽的 chrome-extension origin 白名单（修复：固定扩展 ID / 握手 token）
3. **P1 #3 手动转写阻塞写队列** → 长视频转写期间所有编辑/导入卡住（修复：慢调用移出 mutationQueue）

---

## 附：已复核的既有关键防线（未回退，无需改）

- `writeNotes` 唯一临时文件名 + `rename` 原子替换（B1）✅
- `readNotesFile` 损坏备份 + 返回原始数组不过滤（B2）✅
- AI 写回（`runPipelineStep`/summary/expand）只合并新字段、走 `queueMutation`（B3/B4）✅
- `applyVideoAnalysis` 不再删除 OCR 字段 ✅
- DNS rebinding Host 校验（B19）+ 视频/图片流式返回 + `.on('error')` 清理（B5/B11）✅
- multipart boundary 去引号 + `filename=` 不区分大小写（B7/B12）✅
- `FALLBACK_CATEGORY` 已加 `export`（v0.7.5 的 export 契约坑已修复）✅
- 分类器 22 类 + 兜底「其他」+ `reCategorizeNotes` 只重算未确定分类、绝不动手动分类 ✅
- `resolveDataDirectory` 优先级「自定义 → iCloud kanbox → 本机默认」+ iCloud 可写探针 ✅
