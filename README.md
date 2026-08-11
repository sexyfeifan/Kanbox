# 看看收藏

把用户拖入的小红书笔记匿名解析并保存到本地，自动分类后放进首页卡片分组。

当前版本只保留首页整理台，不包含知识库、图谱、流墙、AI 聊天或收藏夹批量同步。

## 导入方式

推荐使用 `browser-extension`：

1. 在 Chrome 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”，指向本项目的 `browser-extension`
4. 从小红书搜索页把一条笔记卡片拖进 App；也可以打开笔记详情后拖动右下角按钮

扩展只提供当前卡片已经显示的链接和标题，不具备打开后台标签页或读取 Cookie 的权限。本地 Sidecar 使用 `credentials: omit` 匿名请求这一条公开笔记页面，随后保存图片并调用 macOS Vision 完成本地 OCR；不需要 AI API。匿名解析失败时直接报错，不会回退到 Chrome 登录态，也不会扫描收藏夹。

App 不再显示导入表单或 API 配置。把笔记卡片拖到整个 App 画布，画布会依次显示识别、匿名解析、图片保存与 OCR、收录状态。

## 本地开发

```bash
npm run dev
npm run local-api
```

桌面开发：

```bash
npm run tauri:dev
```

## 校验

```bash
npm test
npm run lint
npm run build
```

## 本地接口

- `GET /health`
- `GET /notes`
- `POST /notes/import`
- `GET /media/:noteId/:file`

正式 App 数据目录：`~/Library/Application Support/com.patrick.kankanshoucang/`

笔记数据只存在这个本地目录里，仓库不包含任何收藏内容。

## License

[AGPL-3.0-or-later](LICENSE)

允许商用，但如果你修改本项目并对外分发，或用它提供网络服务，必须以同样的 AGPL 协议公开你的改动源码。
