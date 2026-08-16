# 前端代码审查报告 (2026-08)

**审查范围**：DeskView.tsx / xhs-client.ts / ErrorBoundary.tsx / i18n.mjs / store.tsx / markdown.tsx / page.tsx / layout.tsx / desk-workspace.mjs / drag-import.mjs / note-content.mjs / video-transcript.mjs / browser-extension/*
**审查人**：Mimo
**日期**：2026-08-17

---

## 🔴 P0 — 运行时崩溃 / 数据丢失

### 1. DeskView: `onNoteChanged` 闭包捕获过期 `notes`
**文件**：`app/components/DeskView.tsx`
**问题**：`onNoteChanged` 回调里 `setNotes(notes.map(...))` 中的 `notes` 是闭包捕获的快照。如果 AI 后台处理更新了笔记而用户同时在编辑，`notes` 可能是旧的，导致覆盖掉新数据。
**修复**：改用函数式更新 `setNotes(prev => prev.map(...))`

### 2. DeskView: 拖放时 `draggedNoteId` 可能为 null
**文件**：`app/components/DeskView.tsx`
**问题**：专用 drop zone（非 label drop zone）调用 `handleMoveNoteToGroup(draggedNoteId, groupId)` 时没有 null 检查。如果 `draggedNoteId` 在 drag start 和 drop 之间被清除，会导致 null 传播。
**修复**：所有 drop 处理器加 `if (!draggedNoteId) return;`

### 3. xhs-client: `getNoteSummary`/`getNoteExpansion` 返回类型撒谎
**文件**：`app/lib/xhs-client.ts`
**问题**：`undefined as unknown as Note` 让 TypeScript 认为返回的是有效 Note，实际可能是 undefined。调用方 `result.note.id` 会运行时崩溃。
**修复**：返回类型改为 `{ summary: string; note?: Note }`

### 4. xhs-client: `repairNote` 使用 `!` 非空断言
**文件**：`app/lib/xhs-client.ts`
**问题**：`response.notes.find(...)!` 如果 find 返回 undefined，TypeScript 不会报错但运行时会崩。
**修复**：加显式检查

---

## 🟡 P1 — 安全 / 性能 / 可靠性

### 5. SSRF 风险：`openExternalUrl` 无 URL scheme 验证
**文件**：`xhs-client.ts` + `DeskView.tsx`
**问题**：用户保存的笔记可能包含 `javascript:` 或 `file:///` 等危险 URL，直接传给 `openExternalUrl` 或 `window.location.href`。
**修复**：客户端验证 URL scheme，只允许 `https://`（和已知域名的 `http://`）

### 6. DeskView: `useCallback` 依赖不稳定
**文件**：`app/components/DeskView.tsx`
**问题**：`handleKeyDown` 的 useCallback 依赖了 `handleCreateGroup` 和 `handleExport`（未 memoize 的普通函数），导致每次渲染都重建，defeat 了 useCallback 的目的。
**修复**：把 `handleCreateGroup` 和 `handleExport` 也用 `useCallback` 包裹

### 7. DeskView: `handleOpenSettings` 串行 await
**文件**：`app/components/DeskView.tsx`
**问题**：4 个独立的异步调用（`getDataInfo`, `getAiSettings`, `getStorageInfo`, `getAiPresets`）串行执行。
**修复**：改为 `Promise.allSettled` 并行

### 8. i18n: SSR hydration 不匹配风险
**文件**：`app/lib/i18n.mjs`
**问题**：模块顶层读取 `localStorage` + `navigator.language`。SSR 阶段返回 `'zh-CN'`，客户端可能不同，导致 hydration mismatch。
**修复**：延迟语言检测到客户端 init 函数

### 9. i18n: UTF-8 BOM
**文件**：`app/lib/i18n.mjs`
**问题**：文件开头有 UTF-8 BOM（EF BB BF），可能导致第一个键名包含不可见字符。
**修复**：去除 BOM

### 10. i18n: `subtitle` 是函数不是字符串
**文件**：`app/lib/i18n.mjs`
**问题**：`t('subtitle')` 返回一个函数而非字符串，与其他键行为不一致。`<p>{t('subtitle')}</p>` 会渲染为空或崩溃。
**修复**：改为 `t('subtitle', count)` 或单独文档化

### 11. xhs-client: `formatDate` 负数天数
**文件**：`app/lib/xhs-client.ts`
**问题**：如果 `date` 在未来（时钟偏差），输出 `"-3天前"` 之类的无意义文本。
**修复**：`days = Math.max(0, days)`

### 12. ErrorBoundary: 没有全局 error/unhandledrejection 监听
**文件**：`app/components/ErrorBoundary.tsx`
**问题**：ErrorBoundary 只捕获渲染期错误。async 错误、事件处理器错误、unhandled promise rejection 会静默失败或白屏。
**修复**：在 `page.tsx` 已有全局监听（✅ 已修复），但 ErrorBoundary 本身应考虑补充 reset 能力

### 13. DeskView: API key 默认明文显示
**文件**：`app/components/DeskView.tsx`
**问题**：`showApiKey` 初始化为 `true`，API key 默认可见。
**修复**：改为 `false`（注：根据历史记录，这是产品决策「默认明文 + 👁 切换」，降为 P2 提示）

---

## 🟢 P2 — 代码质量 / 可维护性

### 14. DeskView: scroll 事件未防抖
`window.scroll` 以 60fps 触发 `setScrollY`，每次触发重渲染。应用 `requestAnimationFrame` 防抖。

### 15. DeskView: `dismissTimersRef` 数组只增不减
Timer ID push 进去但从不移除。虽然不是内存泄漏（只是整数），但不优雅。

### 16. DeskView: `handleOpenSettings` 里 `getDataInfo` / `getAiSettings` 等串行调用
应该用 `Promise.allSettled`（已在 P1 #7 列出）。

### 17. xhs-client: 三个几乎相同的 export 函数
`exportNotes()` / `exportNotesMarkdown()` / `exportNotesHtml()` 只有路径和 header 不同，应参数化为一个函数。

### 18. xhs-client: 两个 SSE 订阅到同一端点
`subscribeToPipeline()` 和 `subscribeToUpdates()` 各自开一个 EventSource 连接到 `/events`。

### 19. xhs-client: `readNotes` 静默吞错
网络错误、500、JSON 格式错误全部静默回退到空数组，调用方无法区分「无笔记」和「服务器故障」。

### 20. ErrorBoundary: 硬编码中文
`页面出错了` / `发生了未知错误` / `重新加载` 未走 i18n 系统。

### 21. ErrorBoundary: 无 reset 能力
唯一的恢复方式是 `window.location.reload()`，丢失所有应用状态。应加「重试」按钮。

### 22. i18n: 缺少 TypeScript 类型
`.mjs` 文件无类型安全，`t('typo_key')` 静默返回 key 字符串无警告。

### 23. i18n: 缺失 key 无警告
`t()` 对不存在的 key 直接返回 key 字符串，无 dev-mode 警告。

### 24. markdown.tsx: `renderMarkdown` 无 XSS 防护
AI 生成的 markdown 直接渲染，如果 markdown 包含恶意 HTML 链接（如 `javascript:`），`<a href>` 会执行。当前用 `target="_blank" rel="noreferrer"` 缓解了部分风险，但 `javascript:` URI 仍可执行。

### 25. browser-extension: manifest.json context menu URL patterns 重复
`kanbox-save-link` 的 `targetUrlPatterns` 包含重复条目。

### 26. 副文件堆积
`src-tauri/target/release/` 下有大量 iCloud 同步产生的 ` 2.mjs` ` 3.mjs` ... 副本文件（~100+），占用磁盘空间。建议定期清理。

---

## 📊 统计

| 严重度 | 数量 | 说明 |
|--------|------|------|
| P0 | 4 | 闭包过期、null 检查缺失、类型撒谎、非空断言 |
| P1 | 9 | SSRF、性能、SSR hydration、BOM、函数键、负数日期、重渲染 |
| P2 | 13 | 防抖、代码重复、i18n、无障碍、副文件清理 |

## 🎯 优先修复建议

1. **P0 #1**：`onNoteChanged` 改函数式更新（5 分钟）
2. **P0 #2**：drop handler 加 null guard（5 分钟）
3. **P0 #3-4**：xhs-client 返回类型修复（15 分钟）
4. **P1 #5**：`openExternalUrl` 加 URL scheme 白名单（10 分钟）
5. **P1 #8-9**：i18n SSR + BOM 修复（15 分钟）
6. **P2 #26**：清理 `src-tauri/target/release/` 副文件
