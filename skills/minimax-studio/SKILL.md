---
name: minimax-studio
description: "MiniMax 全模态音视频工作流：把「图像 → 配音 → 成片」的影视级链路、样本音克隆成可复用音色、以及整本书的有声化流水线串起来。当用户想用 MiniMax 做图文配音成片、克隆声音、把长文/整本书转成有声书与字幕，或提到声音克隆 / 异步 TTS / 有声化 / 全模态工作室时使用。"
metadata:
  default-enabled: true
---

# MiniMax 全模态工作室

本技能沉淀三条多模态工作流，把 `minimax-video` App 暴露的入口串成可复用的流水线。App 本身是后端的媒体提供方 + 模型工具集；生成走宿主的 `media_generate-*` 统一入口，精细控制与两条流水线走专用工具 / CLI 脚本。

## 这个 App 提供什么（先认清入口）

| 能力 | 调用入口 | 说明 |
|---|---|---|
| 图像生成 | 宿主 `media_generate-image`（provider `minimax`，模型 `image-01` / `image-01-live`） | 宿主内置，**不是**本 App 注册的；本 App 只负责后续音视频 |
| 视频生成 | 宿主 `media_generate-video`（模型 `MiniMax-H3` / `MiniMax-H3-Max`） | 文生 / 图生 / 首尾帧 / 多模态参考（图 + 视频 + 音频） |
| 宿主发音通道 | 宿主 `media_generate-speech` | 按 `speech_generation` 目录选 provider/model/voice；本 App 经运行时能力源发布 `speechGeneration` |
| 精细语音合成 | 工具 `minimax_text_to_speech` | 直连 `POST /v1/t2a_v2`，支持停顿标签与情绪词、字幕时间戳 |
| 语音识别 | 工具 `minimax_speech_to_text` | 直连 `POST /v1/speech_to_text`，输出 json / verbose_json / srt / vtt |
| 提示词增强 | 工具 `minimax_context_ir` | H3-Context-IR 多模态上下文理解，异步返回结构化提示词 |
| 声音克隆 | 脚本 `scripts/ext-voice-clone.mjs` | 隐藏扩展，不注册为模型工具，只经 CLI 暴露 |
| 长篇异步 TTS | 脚本 `scripts/ext-async-tts.mjs` | 隐藏扩展，分章切片 → 异步提交 → 批量取回音频与 SRT |

**素材引用与回落。** 本地参考图 / 视频 / 音频默认先经 MiniMax Files API 上传取 `file_id`，以云端引用提交。上传把字节从**模型请求体**挪进独立的 Files 调用（不再受内联 data URL 的 ≤12MB / ≤16MB 预算约束，单文件上限提至 20MB），但上传体仍经宿主 RPC 的 32MiB 信封（`bodyBase64`）。上传不可用（未授权、网络差异、接口拒绝）时**自动回落 base64 内联**，仍受单文件 ≤12MB、总量 ≤16MB 传输预算约束。回落是设计内的正常分支，不是失败。

---

## 工作流一：影视级图音视流（图像 → 配音 → 成片）

**目标**：一段文字 → 一张图 → 一段配音 → 一条带音轨的 H3 视频。

1. **出图**。调宿主 `media_generate-image`，provider 选 `minimax`，模型 `image-01`（或 `image-01-live`），把分镜描述作为 prompt。产物落进会话文件 / 生成目录，拿到本地路径或会话引用。
   - 失败处置：provider 未出现 → 确认宿主媒体运行时可用；出图报参数错 → 核对 prompt 与尺寸参数后重试。**不要**改走本 App 的接口，本 App 不提供图像生成。
2. **配音**（二选一）：
   - **走宿主通道**：调 `media_generate-speech`，在语音目录里显式选 MiniMax provider 与音色（宿主无默认时会要求显式选）；产物落到生成目录。
   - **走精细工具**：调 `minimax_text_to_speech`，需要停顿 / 情绪控制时用它（`<#秒数#>` 停顿、`(laughs)` 语气词）；记下返回的 `filePath`。
   - 失败处置：`media_generate-speech` 找不到 MiniMax → 确认 App 已装载且能力源 `refresh()` 未因凭证缺失抛错（配好 MiniMax Token Plan 供应商）；`minimax_text_to_speech` 报凭证错 → 见 README §3 的两个前置。
3. **成片**。调宿主 `media_generate-video`，模型 `MiniMax-H3`，模式选**多模态参考**（`multimodal2video`）：把第 1 步的图作为 `referenceImages`、第 2 步的音频作为 `referenceAudios` 一起传入。要更高清可直接带 `resolution: "2K"`，或先出 768P 再用 `regeneration` 模式升 2K（见 `minimax-2k-workflow` 技能）。
   - 失败处置：报「参考素材超出传输限制」→ 压缩素材到单文件 ≤12MB / 总量 ≤16MB；任务成功但一直 pending → 后台下载进行中，再等几轮；下载超时但远端已完成 → 用 `scripts/fetch-task.mjs` 直接找回。

**关键点**：图 + 音是**同一次** `multimodal2video` 提交里的两类参考，不要分两次生成再合成。

---

## 工作流二：声音克隆向导流（样本音 → 可复用音色）

**目标**：一段 10 秒–5 分钟的样本音 → 云端克隆 → 登记进本 App 音色表 → 用新音色合成。

1. **准备样本**。格式限 `mp3` / `m4a` / `wav`，时长 10 秒–5 分钟，体积 ≤20MB。脚本会**先本地校验**（读容器头测时长），不满足直接报错、不联网。
2. **跑克隆脚本**（需真实 key，从环境变量读）：

   ```powershell
   $env:MINIMAX_API_KEY="<你的key>"; node scripts/ext-voice-clone.mjs <sample> --voice-id my-voice [--label "我的音色"] [--data-dir <目录>]
   ```

   流程：上传样本（purpose `voice_clone`）取 `file_id` → `POST /v1/voice_clone` → **自动登记** `{data-dir}/voices.json`（缺省 `{HANA_HOME}/app-data/minimax-video`，与 App 运行时同一张表）。`--voice-id` 缺省时由 `file_id` 派生。
3. **读结果**。stdout **末行**严格为单行 JSON：成功 `{"ok":true,"voice":{"voiceId":"...","label":"..."}}`，失败 `{"ok":false,"error":{"code","message"}}`；退出码 0/1。用返回的 `voiceId` 作为后续合成参数。
4. **合成**。把 `voiceId` 传给 `minimax_text_to_speech` 的 `voice_id`，或宿主 `media_generate-speech` 的音色选择。

   - 失败处置：`invalid_sample` → 按报错信息改格式 / 时长 / 体积；`missing_api_key` → 设 `MINIMAX_API_KEY`；`clone_failed` → 错误文本已脱敏并带状态码，按提示检查凭证或稍后重试。样本约束详见 [docs/known-limitations.md](../../docs/known-limitations.md)。

**关键点**：音色表**只写 `--data-dir`**（运行时是 `ctx.dataDir`），绝不写安装目录；升级不丢、不违反只读约束。

---

## 工作流三：长篇有声化流水线（整本书 → 分章音频 + SRT）

**目标**：一份长文本 → 按章节切片 → 异步提交 → 静默等待 → 批量取回音频与字幕。

1. **准备文本**。给一个文本文件路径，或 `--text "…"`。脚本按章节标题（`第N章` / Markdown `#`）优先断开，并按字符上限贪心打包；超长行硬切。每片长度不超过 `--max-chars`（默认 20000）。
2. **跑异步脚本**（需真实 key）：

   ```powershell
   $env:MINIMAX_API_KEY="<key>"; node scripts/ext-async-tts.mjs book.txt --subtitle --voice-id <id> --out-dir <目录>
   ```

   流程：逐片提交 `POST /v1/t2a_async_v2`（超长片经 `t2a_async_input` 上传取 `text_file_id`）→ `GET /v1/query/t2a_async_query_v2?task_id=` 轮询 → 完成后 `GET /v1/files/retrieve_content?file_id=` 取音频，`--subtitle` 时另取 SRT。**切片之间互不牵连**：单片失败只记在该片，不影响其余片。
3. **等待与取回**。脚本自身轮询到终态（单片默认超时 10 分钟）；在 Agent 会话里，长任务可交给宿主 `wait_for_tasks` **静默等待**，不阻塞对话。成品音频与 SRT 批量落到 `--out-dir`。
4. **读结果**。stdout **末行**为单行 JSON：成功 `{"ok":true,"tasks":[...],"files":[...]}`，失败 `{"ok":false,"error":{"code","message"},"tasks":[...],"files":[...]}`；退出码 0/1。

   - 失败处置：`POLL_TIMEOUT` → 单次轮询超时，可提高 `--timeout` 或稍后重跑该片；`TASK_FAILED` → 上游任务失败，看 message 的状态码；`FETCH_FAILED` → 成品取回失败，若远端已完成可重跑该片（幂等提交会产生新任务）。查询接口限流上限 10 次/秒，轮询间隔下界 1000ms——**不要**把 `--poll-interval` 调到 1000 以下；成品下载 URL 有约 9 小时有效期，过期需重新取回。

**关键点**：异步 TTS 是**隐藏扩展**，不注册为模型工具——它只能经 `scripts/ext-async-tts.mjs` 调用，不要指望在模型工具列表里找到它。

---

## 通用约束（勿踩坑）

- **模型工具开关默认关闭**：`minimax_context_ir` / `minimax_text_to_speech` / `minimax_speech_to_text` 需在 设置 → 安全 → 应用能力 里为本应用打开，模型才能调用。
- **凭证只有一条 lane**：所有能力都借本机 **MiniMax Token Plan** 供应商的凭证，不在 App 内二次配置。
- **不写死私有 id**：模型 id、音色 id、路径都由调用时决定；本技能只固定公开的入口名与脚本名。
- 两条 CLI 流水线**随安装包分发于 `scripts/`**（安装后位于 `{HANA_HOME}/apps/minimax-video/scripts/`），仓库中亦可获取。
