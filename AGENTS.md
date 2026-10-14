# AGENTS.md — MiniMax Studio（仓库导航）

## 宿主契约事实
改 `manifest.json` 的 `capabilities` / 写文件选落点 / 网络·超时·取消 / 语音格式——凡「宿主会怎么处理」的假设，先查 [`docs/host-contract-notes.md`](docs/host-contract-notes.md) 再动手。该笔记是活文档，新验证的宿主行为追加于此。

## 模块地图
- `index.mjs` —— 唯一装配点：能力源、两个媒体适配器、三个模型工具全在此注册；新增入口改这里。
- `lib/minimax-api.mjs` —— 视频请求体与版本常量（`PROVIDER_ID` / `PROVIDER_VERSION` / `API_BASE_URL`）。
- `lib/files-client.mjs` —— Files 上传 / 检索 / 取内容（20MB 上传上限在此）。
- `lib/voice-registry.mjs` —— 音色表；只写 `ctx.dataDir`，绝不写安装目录。
- `lib/http-util.mjs` —— 脱敏 / 超时 / 响应信封判定的单源。新增横切逻辑先进这里，不要复制到别处。

## 发版
`scripts/pack-release.mjs`（12a 并行引入）；该脚本不在时配方见 [`docs/test-and-tools.md`](docs/test-and-tools.md) 与 VERIFY-REPORT 配方。**严禁从 worktree 目录直接打包**（`.git` 指针泄漏本机路径）。

## 测试
`node --test` 跑全量（<!-- test-count -->339<!-- /test-count --> 项，全离线，不需 Key）。pre-commit 钩子已跑 `check-clean` + 全量。
