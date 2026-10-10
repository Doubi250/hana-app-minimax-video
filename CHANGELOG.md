# Changelog

本 App 的所有重要变更记录在此文件。版本遵循 [SemVer](https://semver.org/)。

## [Unreleased]

### 新增

- **2K 视频再生成**：`MiniMax-H3` 新增 `regeneration` 模式（「2K 再生成」）——把已生成的 768P 成片升级为 2K。两种输入二选一：`source_task_id`（需 MiniMax 白名单；源任务属本账号且 `succeeded`、7 天内；零字节上传）或 `base_video`（源视频经 `video` 参数传入，须重现原 prompt 与素材，受传输预算约束）。成品照常经下载 / 发布管线落入媒体库。
- **H3-Context-IR 增强提示词工具**：新增模型工具 `minimax_context_ir`——异步提交提示词增强任务（首 / 尾帧与参考素材二选一互斥），立即返回「已提交」，增强后的提示词在后台完成时自动送达会话，可直接用于后续生成或再生成。

### 修正

- **下载状态内存泄漏**：媒体适配器的下载状态表 `downloads` 原来只增不删，长跑进程下会持续堆积。现加入终态 TTL 回收（默认 5 分钟）+ 上限淘汰（256 条，只淘汰已结算条目，在飞下载永不淘汰）+ 磁盘存在性检查（成品已落盘时直接复用，不重下）。修复后状态表内存有界。

### 变更

- manifest 新增三项能力声明：`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`（供 `minimax_context_ir` 的工具暴露与异步结果投递）。**已安装用户重载 App 时会被要求复核这些新能力**（取消则旧实例继续运行）；其中模型工具开关默认关闭，需在 设置 → 安全 → 应用能力 中为本应用打开。
- 新增 `scripts/check-clean.mjs` 与 `.githooks/pre-commit`（本地泄漏守卫）：提交前扫描 tracked 文件中的本机路径 / 密钥形态，命中即拒绝提交，并同时跑离线单测。
- `lib/minimax-api.mjs`：删除从未被读取的 `budget.knownSizes` 字段（死代码）。
- `lib/minimax-adapter.mjs`：为「排除指向自身的凭证 provider 提示」补注释，说明当前无自填 key 通道、若将来增加需重审。

### 测试

- 新增 `tests/download-state.test.mjs`（9 条下载状态机生命周期用例）、`tests/context-ir.test.mjs`（26 条 Context-IR 请求体与素材映射用例）、`tests/context-ir-tool.test.mjs`（18 条工具注册与异步生命周期用例）、`tests/regeneration-submit.test.mjs`（5 条再生成提交用例）；`tests/request-body.test.mjs` 扩充至 42 条。全套 **124/124**。

## [0.1.7] - 2026-10-09

### 修正

- **面板「供应商未配置」提示真正生效**：0.1.6 的「成功快照附加 error 字段」方案经宿主源码核实无效（宿主对成功 refresh 只存 `media`/`version`/`fingerprint`，`status` 硬编码 `ready`，附加字段被丢弃，到不了面板）。0.1.7 改为 **Token Plan 无可用 key 时 capability `refresh()` 直接抛错**（`code: no_credentials` + 中文提示），宿主据此把 provider 置为非就绪，面板显示灰灯 + `unavailableReason` / `unavailableMessage`（与即梦未装 CLI 同款）。用户已在真机确认生效。
- 权限或环境问题（`app/provider.credentials.read` 未授权、宿主无此门、探测异常）**不抛错、保持绿灯**——不把权限问题伪装成供应商配置问题，生成时的报错会说明原因。

### 测试

- 新增 `tests/apply-probe.test.mjs`（9 条）：锁定「取到凭证 / 真没配（抛错）/ 权限或环境问题（不抛错）」三分语义。全套 **46/46**。

## [0.1.6] - 2026-10-09

### 新增

- **能力源探测 Token Plan lane**：每次被宿主询问都探一次 `provider:credentials`（无缓存）。（0.1.7 保留此机制，改为抛错语义。）

## [0.1.5] - 2026-10-09

### 修正

- **媒体面板不再误报 `no credentials`**：宿主 1.0.6-beta 的面板只读 provider entry 的凭证 lane，且从不读运行时快照里的 lane；唯一 App 侧手段是把 manifest `authType` 从 `api-key` 改为 **`none`**（含义是「宿主凭证存储不是本 provider 的凭证权威，凭证由 App 自行解析」，内置 `jimeng-cli` 同型）。面板凭证状态随之恒报「已配置」；「Token Plan 是否真的配好」由 0.1.6/0.1.7 的能力源探测透传。
- manifest 增加守卫测试，锁定 `authType: "none"` 且无设置页。

## [0.1.4] - 2026-10-09

### 变更

- **移除应用设置页**（`contributes.settings`）与自填 Key——凭证**只**从供应商侧取。
- 凭证解析重写为「宿主上下文 > 宿主暗示的 provider > MiniMax Token Plan」，经 `provider:credentials` 门取回；`apiKey` 与 `headers` 两种返回都处理，不落盘 / 不回显 / 不写日志。
- 凭证 lane 收敛为单条 `minimax-token-plan`。
- `lib/auth.mjs` 抽出为纯函数模块（可离线单测）。
- NOT_CONFIGURED 提示更新：明确指向「配置 MiniMax Token Plan 供应商 + 授予 `app/provider.credentials.read`」两个前置。

### 测试

- 凭证/请求头/lane 用例扩充，全套 36/36。

## [0.1.3] - 2026-10-09

### 新增

- **未填 key 时回退到 MiniMax Token Plan 供应商凭证**：`lib/auth.mjs`（新）实现「宿主上下文 > 应用设置 key > 供应商回退」优先级；适配器 `readApiKey/requireApiKey` 改为 `resolveAuth/requireAuth`，回退经宿主 `provider:credentials` 门（新增能力声明 `app/provider.credentials.read`）；`lib/minimax-client.mjs` 支持自定义请求头逐字透传（token-plan 可能用非 Bearer 头）。

### 文档

- README 补齐市场上架所需材料：用途、图标、自测报告（Hana 版本 / OS / 测试步骤与结果 / 已知问题）、权限与外部服务说明。

### 测试

- 全套 35/35（22 请求体 + 13 凭证）。

## [0.1.2] - 2026-10-08

### 新增

- 首个可公开版本：MiniMax H3 视频生成接入 Hana 媒体系统（文生视频 / 图生视频 / 尾帧 / 首尾帧 / 多模态参考五种模式；`MiniMax-H3` 与 `MiniMax-H3-Max` 两模型）。
- 纯后端媒体 provider App：无 UI、无卡片、无工具；运行时能力源 + 媒体适配器双注册。
- 参考素材传输预算（网络层 JSON-RPC 双重 base64 编码 ×1.78，单文件 ≤12MB、总量 ≤16MB）。
- 后台分片下载成品视频 + 轮询回传进度。
- 真机验证：任务提交 → 轮询 → CDN 下载全链路成功。
- 全套 22/22 离线单测。
