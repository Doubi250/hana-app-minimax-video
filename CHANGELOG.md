# Changelog

本 App 的所有重要变更记录在此文件。版本遵循 [SemVer](https://semver.org/)。

## [0.3.1] - 2026-10-13

### 新增

- **Files 上传基建（默认先上传，失败回落）**：新增 `lib/files-client.mjs`（上传 / 检索 / 取内容）与共享的 `lib/multipart.mjs`。本地参考图 / 视频 / 音频（含 2K 再生成的源片）默认先经 `POST /v1/files/upload` 取 `file_id`，以 `mm_file://{file_id}` 云端引用提交，字节不再进宿主 RPC、不占 ≤12MB / ≤16MB 内联预算。上传不可用（未授权 / 网络差异 / 接口拒绝 / 4xx / 5xx）时**自动回落 base64 内联**，记一条 `logger.warn`，不使整单失败；未注入上传依赖时行为与 0.3.0 逐字节一致。
- **宿主发音通道**：语音以**运行时能力源**发布 `media.speechGeneration`，并注册一个 `types:["speech"]` 适配器（`minimax-speech-tts`，`formats: mp3/wav/pcm`，`speed 0.5–2`）。宿主 `media_generate-speech` 能在语音目录里选中 MiniMax 音色；`flac` 不在宿主格式白名单内，请求即明确报错、不静默降级（需 `flac` 用模型工具 `minimax_text_to_speech`）。
- **声音克隆（隐藏扩展 + CLI）**：新增 `lib/voice-registry.mjs`（音色表，只写 `dataDir`，原子写 + 损坏备份重建）与 `lib/extensions/voice-clone.mjs`；新增脚本 `scripts/ext-voice-clone.mjs`。样本限 mp3/m4a/wav、10 秒–5 分钟、≤20MB（本地先校验，不联网）。
- **长篇异步 TTS（隐藏扩展 + CLI）**：新增 `lib/extensions/async-tts.mjs` 与脚本 `scripts/ext-async-tts.mjs`。按章节切片 → `POST /v1/t2a_async_v2` → 轮询 → `files/retrieve_content` 取音频（`--subtitle` 另取 SRT）；切片互不牵连。
- **App Skill `minimax-studio`**：沉淀三条多模态工作流（影视级图音视流 / 声音克隆向导流 / 长篇有声化流水线），每步写明调用入口与失败处置。

### 变更

- **manifest**：`version` 升至 `0.3.1`；`name` / `description` 更新以反映全模态（宿主发音通道、声音克隆、长篇异步 TTS、Files 上传优先）。**`capabilities` 数组逐字不变**（本次零新增能力，已装用户升级免复核）；`contributes.providers[].capabilities.media` **只保留 `videoGeneration`**（写入 `speechGeneration` / `speechSynthesis` 会让整应用在清单读取阶段 `failed`）；`allowedHosts` 不变（语音与 Files 均落 `api.minimax.cn`）。
- **README**：能力矩阵加入「宿主发音通道」「声音克隆」「长篇异步 TTS」；新增 §4.1 Files 引用与回落说明；§3 权限表如实标注本次**未新增能力**；§8 补 §8.1 宿主发音通道 / §8.2 声音克隆 / §8.3 长篇异步 TTS；文档索引加入两个 Skill。
- **docs**：`known-limitations.md` 补 Files 上传的多站差异与回落语义、异步 TTS 的轮询限制（10 次/秒）与成品下载 URL 约 9 小时有效期、克隆样本约束（mp3/m4a/wav，10 秒–5 分钟，≤20MB）；`test-report.md` 如实标注未真机验证项。
- **user-scripts.md**：补入两个新 CLI 脚本（`ext-voice-clone.mjs` / `ext-async-tts.mjs`）。

### 修正

- **Code Review 双轴收口**：上传路径引入 20MB 单文件上限护栏（防止超限爆 RPC 错误且明确提示）、`PROVIDER_VERSION` 常量同步至 0.3.1 并增加快照与清单一致性断言、请求头装配与错误脱敏（`withAuth` / `scrub`）单源化至 `lib/http-util.mjs`。

### 测试

- 新增离线单测：`files-client.test.mjs`（上传 / 检索 / 错误信封）、`upload-fallback.test.mjs`（上传成功写 `mm_file://`、失败回落 base64、未注入时与 0.3.0 一致）、`speech-adapter.test.mjs`（注册形状、submit 落盘、凭证缺失报错）、`voice-registry.test.mjs`（原子写、损坏恢复、只写 dataDir）、`voice-clone-extension.test.mjs`、`extensions.test.mjs`（克隆与异步两条链路离线）、`cli-contract.test.mjs`（末行 JSON 契约）。
- `tests/context-ir.test.mjs` 的 manifest 守卫随版本递增同步更新为 `0.3.1`（该断言与 manifest `version` 是硬耦合：历史上每次版本递增都同时改这一行）。
- 全套 **261/261** 离线绿灯（视频 125 + 语音 50 + Studio 新增 86）。

### 未真机验证的边界

- Files API 在 `.cn` 站的可用性与 `mm_file://` 兼容性未真机验证——故回落分支为设计内的正常形态（见 `docs/known-limitations.md`）。
- 声音克隆与长篇异步 TTS 两条链路仅有离线单测，真实 key 下的端到端未跑。
- 宿主 `media_generate-speech` 对 MiniMax 语音适配器的真实选中未真机验证。

## [0.3.0] - 2026-10-12

### 新增

- **语音合成工具 `minimax_text_to_speech`（TTS）**：并入原 `minimax-speech` 实验插件的语音输出能力，采用 MiniMax Speech-2.8-HD / T2A V2（`POST /v1/t2a_v2`）。支持语速 / 音调 / 音量、停顿标签 `<#秒数#>`、语气词 `(laughs)` / `(sighs)`、字幕时间戳；产物写入与媒体管线同一生成目录（`ctx.generatedDir`），返回的本地路径可直接作为视频参考音频。
- **语音识别工具 `minimax_speech_to_text`（ASR）**：转入 ASR-1.0（`POST /v1/speech_to_text`）。输入本地音频（经宿主资源通道，单文件 ≤12MB）或公网 URL，输出 `json` / `verbose_json` / `srt` / `vtt`。
- **音视频联动**：TTS 产物路径可直接回喂为 H3 视频生成（`referenceAudios`）或 H3-Context-IR 的参考音频，**无需新增媒体适配器**；由新增测试 `tests/audio-video-linkage.test.mjs` 锁定（媒体生成 + Context-IR 两消费端）。

### 修正

并入时修复了独立 review 确认的语音插件缺陷（详见 `outputs/2026-10/minimax-speech/REVIEW.md`）：

- **`details` 携带原始 `Buffer` 的 blocker**：TTS 工具曾把客户端结果整体 spread 进 `details`，把原始音频 `Buffer` 与 `subtitles` 跨宿主 32MiB JSON-RPC 边界——文件已落盘却报失败。现 `details` 只承载可序列化原语（`filePath` / `durationSeconds` / `sampleRate` / `wordCount` / `format` / `bytes`）。
- **ASR 本地 / 远端音频无输入大小约束**：`MAX_ASR_FILE_BYTES` 曾是死代码。现先 `resources.stat` 预检 → 读 → 读后复校 → 计入总量预算，超限明确报错。
- **网络桥绕行**：两个工具缺注入 `fetch` 时曾回退 `globalThis.fetch`（绕开宿主网络桥与 `allowedHosts`）。现缺失即抛错，不回退。
- **srt/vtt 把 API 错误当成功字幕**：格式分支曾在 `base_resp.status_code` 校验之前返回。现先校验错误信封再做格式分支。
- **60000ms 超时**：超出宿主硬 30s RPC 上限。现 manifest `defaultTimeoutMs` 与所有 `timeoutMs` 均 ≤30000，音频下载为 28000。
- **字节提取 / 凭证解析去重**：丢弃语音自带的 `auth.mjs` 与分歧的 `extractBytes`，两工具改用视频侧的唯一实现；ASR/TTS 扩展名由归一化格式派生，避免容器与扩展名不一致。

### 变更

- **manifest**：`name` / `description` 更新以反映音视频双能力；`version` 升至 `0.3.0`。能力集**经核对无需增补**（两个语音工具复用视频已有的 `app/tools.expose-to-model` / `app/provider.credentials.read` / `app/resources.read`）；`network.allowedHosts` 不变（语音落在已有的 `api.minimax.cn`）。
- **README**：新增“§8 语音合成与语音识别”，补入语音能力矩阵与“先配音 → 作为 H3 参考音频”推荐用法；能力 / 权限与凭证说明按合并后更新。
- **docs**：`known-limitations` / `test-report` 补注语音的传输预算与超时约束。

### 测试

- 新增 `tests/audio-video-linkage.test.mjs`（2 条音视频联动用例）；`tests/context-ir.test.mjs` 的 manifest 守卫更新为 0.3.0 + 六项能力 + 超时上限。全套 **175/175** 离线绿灯（视频 125 + 语音 50）。

## [0.2.0] - 2026-10-11

### 新增

- **2K 视频再生成**：`MiniMax-H3` 新增 `regeneration` 模式（「2K 再生成」）——把已生成的 768P 成片升级为 2K。两种输入二选一：`source_task_id`（需 MiniMax 白名单；源任务属本账号且 `succeeded`、7 天内；零字节上传）或 `base_video`（源视频经 `video` 参数传入，须重现原 prompt 与素材，受传输预算约束）。成品照常经下载 / 发布管线落入媒体库。
- **H3-Context-IR 增强提示词工具**：新增模型工具 `minimax_context_ir`——异步提交提示词增强任务（首 / 尾帧与参考素材二选一互斥），立即返回「已提交」，增强后的提示词在后台完成时自动送达会话，可直接用于后续生成或再生成。
- **工作流引导（App Skill）**：新增 App Skill `minimax-2k-workflow`，引导「先增强提示词 → 再生成 → 需要时升 2K」的推荐链路，随 App 装载对当前 Agent 生效。

### 修正

- **下载状态内存泄漏**：媒体适配器的下载状态表 `downloads` 原来只增不删，长跑进程下会持续堆积。现加入终态 TTL 回收（默认 5 分钟）+ 上限淘汰（256 条，只淘汰已结算条目，在飞下载永不淘汰）+ 磁盘存在性检查（成品已落盘时直接复用，不重下）。修复后状态表内存有界。

### 变更

- manifest 新增三项能力声明：`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`（供 `minimax_context_ir` 的工具暴露与异步结果投递）。**已安装用户重载 App 时会被要求复核这些新能力**（取消则旧实例继续运行）；其中模型工具开关默认关闭，需在 设置 → 安全 → 应用能力 中为本应用打开。
- 新增 `scripts/check-clean.mjs` 与 `.githooks/pre-commit`（本地泄漏守卫）：提交前扫描 tracked 文件中的本机路径 / 密钥形态，命中即拒绝提交，并同时跑离线单测。
- `lib/minimax-api.mjs`：删除从未被读取的 `budget.knownSizes` 字段（死代码）。
- `lib/minimax-adapter.mjs`：为「排除指向自身的凭证 provider 提示」补注释，说明当前无自填 key 通道、若将来增加需重审。

### 测试

- 新增 `tests/download-state.test.mjs`（9 条下载状态机生命周期用例）、`tests/context-ir.test.mjs`（26 条 Context-IR 请求体与素材映射用例）、`tests/context-ir-tool.test.mjs`（18 条工具注册与异步生命周期用例）、`tests/regeneration-submit.test.mjs`（5 条再生成提交用例）；`tests/request-body.test.mjs` 扩充至 43 条。全套 **125/125**。

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
