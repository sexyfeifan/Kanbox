# Kanbox 部署与打包现状

## v0.8.4 存储迁移验收

- 存储切换必须以当前活动资料库为源，不得固定使用本机默认目录。
- 本机、iCloud、自定义目录的七种方向组合均由自动化测试覆盖。
- 目标已有资料时执行笔记、工作区、删除墓碑、媒体与备份的并集合并；当前资料库设置优先。
- 迁移先写目标旁暂存目录，校验成功后原子提交；源目录永不删除，旧目标保留为 `.kanbox-before-migration-*` 快照。
- 迁移中断保留 `.kanbox-migration-in-progress.json`，目标和源资料不变；重新执行可安全恢复。
- Developer ID 公证和 Chrome Web Store 正式发布继续暂缓，不作为 v0.8.4 发布门槛。

## 当前形态

- Tauri 桌面应用（macOS 13+，Apple Silicon / Intel）
- Next.js 首页整理台
- Node 本地 sidecar
- 安装包内置 Node 运行时
- Chrome Quick Import 扩展
- 本地 `notes.json` + `workspace.json` 数据存储（支持 iCloud / 本机默认 / 自定义三种位置）

## 打包命令

```bash
npm run tauri:build
```

## 浏览器扩展

开发阶段从 `browser-extension` 加载已解压扩展。正式分发前需要单独发布或打包扩展；Tauri 不会自动替用户安装 Chrome 扩展。

## 当前数据边界

- 扩展只读取拖动卡片已有的链接和标题，不具备 `tabs` 或 `cookies` 权限
- Sidecar 不带 Cookie 匿名解析单篇公开笔记页面，保存配图并调用 macOS Vision OCR
- 视频保存到本地，由 macOS Speech 分段离线转写
- App 不保存小红书 Cookie
- App 不调用收藏夹或评论接口，也不回退到 Chrome 登录态
- App 不做定时抓取；批量导入仅处理用户主动粘贴的最多 50 条单篇公开笔记链接
- 默认不联网做 AI；仅当用户主动填 API key 开启在线摘要/拓展/转写增强时，才单条、按需发往用户指定的服务商

## 当前风险

- 小红书页面 DOM 变化时，扩展选择器可能需要更新
- 匿名页面拒绝访问或结构变化时，导入会失败，但不会改用账号登录态
- 小红书公开页面状态结构变化时，正文和完整配图解析规则可能需要同步更新
- 当前使用 ad-hoc 签名，未公证版本首次运行需要用户在”隐私与安全性”中点”仍要打开”
