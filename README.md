# MiniMax 音视频生成（Hana v2 App）

**这是什么。** 一个纯后端的 Hana 全模态音视频套件：把 MiniMax H3 的视频生成 REST 接口
（`POST /v2/video_generation`）接进 Hana 的媒体系统，并以模型工具形式暴露
H3-Context-IR 提示词增强、Speech-2.8-HD 语音合成（TTS）与 ASR-1.0 语音识别（STT）。
装上并授权后，Agent 的 `media_describe-options` 能看到 `minimax-video` 的两个模型，
`media_generate-video` 能直接调用它；同时模型可以调用 `minimax_context_ir` /
`minimax_text_to_speech` / `minimax_speech_to_text` 三个工具。视频的
提交 → 轮询 → 下载 → 发布全部由本 App 完成，成品落在宿主的 `generatedDir` 里；
TTS 产物写入同一生成目录，可被后续的视频 / Context-IR 请求直接引用。

除模型工具外，本 App 还：把语音经**宿主发音通道**发布（`media_generate-speech` 能选到
MiniMax 音色）；本地大素材默认**先经 Files API 上传取 `file_id`**（上传不可用时回落
base64）；并提供**声音克隆**与**长篇异步 TTS** 两条 CLI 流水线（隐藏扩展，不注册为模型工具）。
三条多模态工作流见 App Skill `minimax-studio`。

没有 UI、没有设置页、没有卡片 —— 它是一个媒体提供方，另带三个模型工具
（`minimax_context_ir` / `minimax_text_to_speech` / `minimax_speech_to_text`）与两个 CLI 脚本。
**凭证不由本 App 保存**：视频与语音都直接使用本机已配置的 **MiniMax Token Plan**
供应商凭证，无需二次配置。

- **App id**：`minimax-video`
- **图标**：`assets/icon.svg`
- **当前版本**：`0.3.1`（全模态音视频套件：视频 + 语音双通道 + 克隆 + 异步 TTS）

---

## 1. 用途

- 让 Agent 用 MiniMax H3 / H3-Max 生成视频：文生视频、图生视频、首/尾帧生视频、
  多模态参考（图 + 视频 + 音频）；并支持把已生成的 768P 成片**升级为 2K**（§6）。
- 用模型工具 `minimax_context_ir` 把粗糙提示词交给 H3-Context-IR **增强**，
  增强结果自动回到会话，可用于后续生成或再生成（§7）。
- 用模型工具 `minimax_text_to_speech` 合成语音（Speech-2.8-HD / T2A V2），产物写入
  生成目录，返回的本地路径可直接作为视频参考音频（§8）。
- 用模型工具 `minimax_speech_to_text` 把本地音频或公网 URL 转写为文本 / 分段时间戳
  / SRT / VTT（§8）。
- 把语音经**宿主全局发音通道**发布：`media_generate-speech` 能在语音目录里选到 MiniMax
  音色与模型，用户不必知道有专用工具（§8.1）。
- 本地参考素材**默认先上传**（Files API）取 `file_id`，以 `mm_file://{file_id}` 云端引用
  提交，字节不再进宿主 RPC；上传不可用时**自动回落 base64 内联**（§4.1）。
- 用 CLI `scripts/ext-voice-clone.mjs` 把一段样本音**克隆**成可复用音色并登记音色表
  （§8.2）；用 `scripts/ext-async-tts.mjs` 把整本书**分章异步合成**为音频与 SRT（§8.3）。
- 由一个 adapter（`minimax-video-videos`）+ 一个语音 adapter（`minimax-speech-tts`）+ 一个
  运行时能力源（静态模型表 + 语音能力）+ 三个模型工具组成，不贡献任何设置项。
- 不持有任何独立凭证：视频与语音每次调用都从 **MiniMax Token Plan 供应商**取凭证
  （见 §3）。

## 2. 安装与启用

1. 用 Hana 的扩展安装入口安装本 App 的打包产物（`*.hana-app.zip`），或在开发目录里
   直接加载本插件目录。
2. 安装时按提示批准六项能力（见 §3）。`app/media.provide` 或
   `app/provider.credentials.read` 缺失时对应功能不可用（注册失败只记日志，不阻断 App）；
   三个模型工具（`minimax_context_ir` / `minimax_text_to_speech` / 
   `minimax_speech_to_text`）依赖 `app/tools.expose-to-model` 等能力，其中模型工具开关
   默认关闭（见 §3 / §7 / §8）。
3. 在 设置 → 供应商 里确保 MiniMax Token Plan 已配置（见 §3）。

**验证。**

- 让 Agent 跑一次 `media_describe-options(kind:"video")`，确认返回的列表里出现
  `MiniMax-H3` / `MiniMax-H3-Max` 与 `minimax-video` provider。
- 用 `media_generate-video` 发一条最小的文生视频（4 秒、768P、16:9），确认任务
  从 pending 走到 success，成品出现在媒体库里。
- （可选）让 Agent 用 `minimax_context_ir` 提交一条提示词增强（先在
  设置 → 安全 → 应用能力 打开本应用的模型工具开关），确认立即返回「已提交」，
  稍后收到「H3-Context-IR 增强提示词：…」。

**升级 / 卸载。**

- 升级：替换 App 目录或重装包，重新 `apply` 即重新注册适配器与能力源；App 进程退出、
  崩溃、停用或卸载时宿主自动撤销它们，不留孤儿。声明了**新的**能力时，宿主会要求用户
  先复核，取消则旧实例继续运行。
- 卸载：宿主会保留 `dataDir`（`{HANA_HOME}/app-data/minimax-video`），其中可能有
  下载中的 `.part` 临时文件与已发布的成品；确认不再需要后可手动清理。

## 3. 能力与权限

| 能力（manifest `capabilities`） | 为什么需要 |
|---|---|
| `app/media.provide` | 注册媒体适配器与运行时能力源（`ctx.media.registerAdapter` / `registerCapabilitySource`）。没有它，provider 不会出现。 |
| `app/provider.credentials.read` | 向宿主取回 MiniMax Token Plan 供应商的凭证（`provider:credentials`）。这是本 App 的**唯一**凭证来源，没有它无法生成。 |
| `app/resources.read` | 读取会话内的参考图 / 视频 / 音频（图生视频、多模态参考、再生成与增强工具的素材读取）。没有它，带参考素材的请求会明确报错。 |
| `app/tools.expose-to-model` | 将 `minimax_context_ir` / `minimax_text_to_speech` / `minimax_speech_to_text` 暴露给模型调用（模型工具通道）。开关默认关闭，需在 设置 → 安全 → 应用能力 里为本应用单独打开，模型才能主动调用它们。 |
| `app/tasks.manage` | 增强工具创建 / 结算宿主任务（异步增强结果的承载通道）。 |
| `app/session.start-turn` | 增强任务完成时把结果投递回会话（会话唤醒）。 |

六项都需要用户在 **设置 → 应用 → 应用权限**（安装时也会确认）里批准。`app/media.provide`
与 `app/provider.credentials.read` 是硬门：缺失时 provider 不出现或无凭证可用。后三项
服务于三个模型工具（§7 / §8）：其中 `app/tools.expose-to-model` 的模型工具开关
**默认关闭**，要在 **设置 → 安全 → 应用能力** 中为本应用单独打开，模型才能调用这些工具。
语音工具（TTS / ASR）复用视频侧已有的 `app/resources.read`（本地音频读取）与
`app/provider.credentials.read`（共享凭证）。

**本次（0.3.1）未新增任何能力。** 宿主发音通道、声音克隆、长篇异步 TTS 与 Files 上传
全部复用上表六项：发音通道走既有的 `app/media.provide` 与凭证读取，两条 CLI 流水线
在 App 之外运行（不占 App 能力），Files 上传走既有的网络白名单（`api.minimax.cn`）。
因此**已装用户升级到 0.3.1 时不会被要求重新复核能力**（manifest `capabilities` 数组
逐字不变）。

### 凭证怎么取

1. 在 **设置 → 供应商** 里配置好 **MiniMax Token Plan** 供应商（填好其 API Key）。
2. 授予本应用 `app/provider.credentials.read`。
3. 本 App 在每次 `submit` / `query` 时经宿主的 `provider:credentials` 门取回该供应商的
   凭证（可能返回 `apiKey`、也可能返回请求头）；**不落盘、不回显、不写日志**。
   本 App **不修改** MiniMax Token Plan 供应商本身，只借它的凭证。

三条取值途径都落空时，生成会明确报错，提示检查上面两步。

面板的凭证状态与「供应商未配置」提示的行为（灰灯/绿灯语义）由能力源探测驱动，
机制细节见 [docs/credential-mechanism.md](docs/credential-mechanism.md)。

## 4. 访问的外部服务

`network.allowedHosts` 声明的出站域：

| 域 | 用途 |
|---|---|
| `api.minimax.cn` / `*.minimax.cn` | 建任务、查任务（主接口） |
| `*.aliyuncs.com` | 成品视频 CDN 下载（实测域名 `algeng-video-infer.oss-cn-shanghai.aliyuncs.com`） |
| `*.hailuoai.com` / `*.minimax.chat` / `*.minimaxi.com` / `*.minimax.io` | 接口 / CDN 备用域 |

请求方式仅 `GET` / `POST`；单次 `network.fetch` 上限 30 秒、单条响应上限 512 MiB。
App 不向上述以外的任何主机发起请求，也不启动任何本地服务。

语音工具复用同一组出站域：TTS（`POST /v1/t2a_v2`）与 ASR（`POST /v1/speech_to_text`）
均落在 `api.minimax.cn`，无需新增白名单。

### 4.1 Files 上传与回落

本地参考图 / 视频 / 音频（含 2K 再生成的源片）**默认先经 Files API 上传**
（`POST /v1/files/upload`，purpose `video_generation_input`）取 `file_id`，再以
`mm_file://{file_id}` 云端引用提交——字节**不进**宿主 RPC，因此**不占**≤12MB / ≤16MB
的内联传输预算。

**回落语义。** 上传路径被接受需同时满足：HTTP 2xx、`base_resp.status_code === 0`、
响应含 `file.file_id`。任一不满足（未授权、网络差异、接口拒绝、4xx/5xx）→ 记一条
`logger.warn`，**本素材自动回落 base64 内联**（仍受传输预算约束），**不使整单失败**。
回落是设计内的正常分支，不是错误。Files 上传与 `mm_file://` 兼容性在多站点的差异
见 [docs/known-limitations.md](docs/known-limitations.md)。

Files API 同样落 `api.minimax.cn`（已在白名单），不需新增出站域。

## 5. 能力矩阵

两个模型、共六种模式；五种生成模式两者共有，「2K 再生成」仅 `MiniMax-H3` 支持：

| 模型 | 分辨率 | 时长 | 默认 |
|---|---|---|---|
| `MiniMax-H3`（MiniMax H3） | 768P / 2K | 4–15 秒（整数） | 768P，5 秒 |
| `MiniMax-H3-Max`（MiniMax H3 Max） | 480P / 768P | 5–15 秒（整数） | 768P，5 秒 |

| 模式（mode id） | 说明 | 输入限制 |
|---|---|---|
| `text2video` | 文生视频 | 无参考文件；`ratio` 必填且不能是 `adaptive` |
| `image2video` | 首帧生视频（1 张图，`role=first_frame`） | 恰好 1 张图 |
| `last_frame2video` | 尾帧生视频（1 张图，`role=last_frame`） | 恰好 1 张图 |
| `frames2video` | 首尾帧生视频（2 张图，按数组顺序 = 首帧、尾帧） | 恰好 2 张图 |
| `multimodal2video` | 多模态参考（`reference_image` / `reference_video` / `reference_audio`） | 图 ≤9、视频 ≤3、音频 ≤3，合计 ≤12 |
| `regeneration` | 2K 再生成（把已有 768P 成片升级为 2K；仅 `MiniMax-H3`） | 二选一：`source_task_id` 或 1 个源视频（`video`）；可随附重现的原素材（图 ≤9、视频 ≤3、音频 ≤3） |

图生视频与多模态参考互斥（由模式天然隔离）。比例：除文生视频外一律 `adaptive`
（i2v / 首尾帧由输入图决定；多模态参考缺省 `adaptive`，也可显式指定）；再生成
没有时长 / 比例参数，由源片决定。

### 语音能力矩阵（模型工具）

| 模型工具 | 能力 | 端点 | 备注 |
|---|---|---|---|
| `minimax_text_to_speech` | TTS 语音合成 | `POST /v1/t2a_v2` | 模型 `speech-2.8-hd`（默认）/ `speech-2.8-turbo` 等；支持语速 / 音调 / 音量、停顿标签 `<#秒数#>`、语气词 `(laughs)`、字幕时间戳；产物格式 `mp3` / `wav` / `flac` / `pcm` |
| `minimax_speech_to_text` | ASR 语音识别 | `POST /v1/speech_to_text` | 模型 `asr-1.0`；输入本地音频（≤12MB，经宿主资源通道）或公网 URL；输出 `json` / `verbose_json` / `srt` / `vtt` |

两个工具共享视频侧的唯一凭证解析器与字节提取实现，并同样受传输预算与 30 秒 RPC 上限约束
（详见 [docs/known-limitations.md](docs/known-limitations.md)）。

### 宿主发音通道与两条流水线

除模型工具外，本次新增三个能力面（均**零新增权限**，见 §3）：

| 能力 | 入口 | 形态 |
|---|---|---|
| **宿主发音通道** | 宿主 `media_generate-speech` | 语音经**运行时能力源**发布 `speechGeneration`，并注册一个 `types:["speech"]` 适配器（`minimax-speech-tts`）；宿主语音目录里即可选到 MiniMax 音色 / 模型 |
| **声音克隆** | `scripts/ext-voice-clone.mjs` | 隐藏扩展（**不**注册为模型工具）：上传样本（purpose `voice_clone`）→ `POST /v1/voice_clone` → 登记音色表 |
| **长篇异步 TTS** | `scripts/ext-async-tts.mjs` | 隐藏扩展（**不**注册为模型工具）：分章切片 → `POST /v1/t2a_async_v2` → 轮询 → 取回音频与 SRT |

宿主语音通道的已知音频格式集合为 `["mp3","wav","pcm","ogg_opus"]`，**不含 `flac`**；
故经 `media_generate-speech` 暴露的语音模型只声明 `mp3` / `wav` / `pcm`，`flac` 仅保留在
模型工具 `minimax_text_to_speech` 直连路径。三条工作流的完整用法见 App Skill
`minimax-studio`。

## 6. 视频再生成（2K）

把已经生成的 768P 成片升级为 2K（`POST /v2/video_regeneration`）。在
`media_generate-video` 里选 `MiniMax-H3` 的 **「2K 再生成」**（`regeneration`）模式；
**仅 `MiniMax-H3` 支持**（H3-Max 没有 2K 输出）。成品与普通生成一样经下载 / 发布
管线落入媒体库。

两种输入方式二选一：

| 方式 | 怎么给 | 前提与代价 |
|---|---|---|
| `source_task_id`（源任务 ID） | 调用时在 `options.source_task_id` 里给出源任务 ID | 需 MiniMax 白名单；源任务须属本账号、状态 succeeded、且在 7 天内（服务端强制）。**零字节上传**。 |
| `base_video`（源视频） | 把源视频经 `video` 参数传入（本会话的视频引用） | 无白名单要求；须**重现**生成原片时的提示词与全部素材（官方要求，App 只透传）。源视频走本地字节，受传输预算约束（单文件 ≤12MB、总量 ≤16MB）。 |

- 再生成输出固定 2K；时长与比例由源片决定，不需要指定。
- `source_task_id` 方式下服务端会忽略提示词，但工具调用仍要求提供 `prompt`——
  建议原样传入原提示词，方便在两种方式间切换。
- 两种方式都提供、或都不提供，都会得到明确报错。

## 7. H3-Context-IR 增强提示词

模型工具 **`minimax_context_ir`**：把一段粗糙提示词（可附首 / 尾帧或参考素材）交给
H3-Context-IR 做多模态上下文理解，产出结构化的**增强提示词**——官方 2K 高质量链路
（**增强提示词 → 生成 768P → 再生成 2K**）的第一步。它只产出提示词、不产生视频；
要出片请把送回的提示词交给 `media_generate-video`。

**异步语义。** 调用立即返回「已提交」；增强任务在后台运行，完成后增强提示词以
「H3-Context-IR 增强提示词：…」的标注自动送达本会话，可直接引用到后续生成或再生成。

**输入。** `prompt` 必填；可选 `duration`（规划时长 4–15 秒，默认 5）与 `ratio`
（规划比例）。素材二选一且**互斥**：

- 首 / 尾帧：`firstFrame` / `lastFrame`（各单张图）；
- 参考素材：`referenceImages` ≤9、`referenceVideos` ≤3、`referenceAudios` ≤3。

每个素材引用支持会话文件、本地文件或公网 http(s) URL；本地引用按传输预算读取
（单文件 ≤12MB、总量 ≤16MB），URL 直通、不读字节、不占预算。

**前提。** 需要 `app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`
三项能力（见 §3）；其中模型工具开关**默认关闭**，先在 **设置 → 安全 → 应用能力**
为本应用打开，模型才能调用。工具仅支持在会话中调用。

## 8. 语音合成与语音识别

本 App 在视频能力之外，另提供两个语音模型工具，与视频共用同一凭证与同一生成目录：

- **`minimax_text_to_speech`（TTS）**：用 MiniMax 语音大模型（Speech-2.8-HD / T2A V2）
  把文本合成为语音。参数：`text` 必填；可选 `voice_id`（内置常用音色预设，也可传自定义/复刻
  音色 ID）、`model`、`speed` / `vol` / `pitch`、`format`（`mp3` / `wav` / `flac` / `pcm`）、
  `sound_effects`、`subtitle_enable`。文本可含停顿标签 `<#秒数#>` 与语气词 `(laughs)` /
  `(sighs)` 等。产物写入生成目录，返回的 `filePath` 可直接作为视频参考音频引用。
- **`minimax_speech_to_text`（ASR）**：用 ASR-1.0 转录音频。参数：`audio_path`（本地文件，
  经宿主资源通道读取，单文件 ≤12MB）或 `audio_url`（须在 `allowedHosts` 放行的域内）
  二选一；`response_format` 可取 `json` / `verbose_json` / `srt` / `vtt`；`model` 默认 `asr-1.0`。

两个工具与视频一样：`network.fetch` 由宿主注入（缺失即报错，**不回退** `globalThis.fetch`）；
`details` 只返回可序列化原语（不含原始 `Buffer` / 原始错误体），长转写的分段会截断并标注；
所有出站请求的 `timeoutMs` ≤ 30 秒。

### 推荐用法：先配音 → 作为 H3 参考音频

把 TTS 产出的本地路径直接回喂给视频链路，无需任何中间适配器：

1. 用 `minimax_text_to_speech` 合成一段旁白，记下返回的 `filePath`；
2. 在 `media_generate-video` 的**多模态参考**（`multimodal2video`）里，把该路径作为
   `referenceAudios` 传入；或在 `minimax_context_ir` 里以 `{ kind: "local-file", path }`
   引用其作为 `referenceAudios` 做分镜规划。

产物落在与视频同一生成目录，字节受相同的传输预算约束（单文件 ≤12MB、总量 ≤16MB）；
该链路由一个离线单测 `tests/audio-video-linkage.test.mjs` 锁定（媒体生成与 Context-IR 两个
消费端都覆盖）。

### 8.1 宿主发音通道

除模型工具外，语音还以**运行时能力源**发布 `speechGeneration`，并注册一个
`types:["speech"]` 适配器（`minimax-speech-tts`）。宿主的全局发音入口
`media_generate-speech` 会按 `speech_generation` 目录选中它，用户无需知道有专用工具。

- 适配器描述符声明 `formats: ["mp3","wav","pcm"]`、`speedMin: 0.5` / `speedMax: 2`；
  `submit` 复用既有 `speech-client.mjs` 的合成实现，产物写 `ctx.generatedDir`，
  返回 `{ taskId, files:[fileName] }`。
- 宿主通道只支持 `mp3` / `wav` / `pcm`（不含 `flac`）；请求 `flac` 会**明确报错**，
  不会静默降级。需要 `flac` 时用模型工具 `minimax_text_to_speech`。
- 凭证与视频共用 `minimax-token-plan` lane；注册失败只记日志，不阻断 App 加载。

### 8.2 声音克隆（CLI）

用脚本 `scripts/ext-voice-clone.mjs` 把一段样本音克隆为可复用音色：

```powershell
$env:MINIMAX_API_KEY="<你的key>"; node scripts/ext-voice-clone.mjs <sample> --voice-id my-voice [--label "名"] [--data-dir <目录>]
```

样本格式限 `mp3` / `m4a` / `wav`，时长 10 秒–5 分钟，体积 ≤20MB（**本地先校验**，不满足
直接报错、不联网）；流程：上传（purpose `voice_clone`）取 `file_id` → `POST /v1/voice_clone`
→ 登记 `{data-dir}/voices.json`（默认脚本旁 `./.minimax-data`；运行时为 `ctx.dataDir`）。
stdout **末行**为单行 JSON（`{"ok":true,"voice":{...}}` / `{"ok":false,"error":{...}}`），
退出码 0/1。用返回的 `voiceId` 作为 `minimax_text_to_speech` 的 `voice_id`。

### 8.3 长篇异步 TTS（CLI）

用脚本 `scripts/ext-async-tts.mjs` 把整本书分章异步合成：

```powershell
$env:MINIMAX_API_KEY="<key>"; node scripts/ext-async-tts.mjs book.txt --subtitle --voice-id <id> --out-dir <目录>
```

流程：按章节标题切片 → 逐片 `POST /v1/t2a_async_v2`（超长片经 `t2a_async_input` 上传）
→ `GET /v1/query/t2a_async_query_v2?task_id=` 轮询 → 完成后 `GET /v1/files/retrieve_content`
取音频（`--subtitle` 时另取 SRT）。**切片互不牵连**：单片失败只记在该片。stdout 末行为
单行 JSON。轮询间隔下界 1000ms（查询接口限流 10 次/秒）；成品下载 URL 约 9 小时有效。

两个脚本都**不在安装包内**，需从仓库 `scripts/` 获取；均只从 `MINIMAX_API_KEY`
环境变量读 key，不落盘、不回显。完整工作流（含失败处置）见 App Skill `minimax-studio`。

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| provider 不出现 | `app/media.provide` 未授权，或媒体运行时未就绪 | 去 设置 → 应用 → 应用权限 批准后重载 App |
| 报「参考素材超出传输限制」 | 参考图/视频/音频过大 | 压缩到单文件 ≤12MB、总量 ≤16MB（详见 [docs/known-limitations.md](docs/known-limitations.md)） |
| 任务成功但一直 pending | 后台下载进行中（分片下载 + 轮询回传） | 再等几轮；连续 3 次下载失败才判失败 |
| 下载超时，或任务成功但产物一直没出现在媒体库 | 网络波动、CDN 不支持分段、或单次 RPC 超过 30 秒 | 稍后重试；若仍失败且远端任务已完成，用 [docs/user-scripts.md](docs/user-scripts.md) 的脚本直接找回 |
| 面板灰色/「未配置」，或生成报「未取得 MiniMax 凭证…」 | MiniMax Token Plan 未配置 / key 失效，或未授权 `app/provider.credentials.read` | 在 设置 → 供应商 里配好 Token Plan，确认已授权该能力，刷新面板即恢复（见 §3） |
| 2K 再生成报「白名单」或「源任务不符」类错误 | `source_task_id` 方式要求 MiniMax 白名单、源任务属本账号且已成功、且在 7 天内（服务端强制） | 核对源任务；或改用 `base_video` 方式（带源视频并重现原 prompt 与素材，见 §6） |
| 2K 再生成报「源视频超出传输限制」 | 源视频按本地字节内联，超出单文件 ≤12MB 预算 | 改用 `source_task_id`（零上传），或压缩源视频（见 §6） |
| 增强工具返回「已提交」后一直没收到增强提示词 | 增强是异步的，结果稍后自动送达；期间 App 重载会中断在途轮询 | 再等一会儿；若 App 重载过，重新提交一次（见 §7） |
| 模型无法调用 `minimax_context_ir` / TTS / ASR 工具 | 模型工具开关默认关闭 | 在 设置 → 安全 → 应用能力 里为本应用打开开关（见 §3 / §7 / §8） |
| TTS 返回了文件路径，但合成报错或未落盘 | 上游 `base_resp.status_code != 0`（限流 / 余额等），或凭证不可用 | 错误文本已脱敏并带状态码；按提示检查供应商凭证或稍后重试（见 §3） |
| ASR 报「音频文件超出传输限制」 | 本地 / 远端音频超过单文件 ≤12MB | 压缩或裁剪音频后再试（见 §8 / [docs/known-limitations.md](docs/known-limitations.md)） |
| ASR 的 `minimax_speech_to_text` 用公网 URL 失败 | `audio_url` 仅在 `allowedHosts` 放行的域内可取回 | 改用本地路径，或确认 URL 落在声明域内（见 §4 / §8） |
| `media_generate-speech` 选不到 MiniMax | 语音能力源未就绪（凭证 lane 抛错）或 App 未装载 | 配好 MiniMax Token Plan 供应商；确认 App 已装载且未因凭证缺失置灰（见 §3 / §8.1） |
| 参考素材上传后仍报「超出传输限制」 | 上传不可用，已回落 base64，本素材仍受 ≤12MB / ≤16MB 预算 | 压缩素材；或确认 Files API 在所用站点可用（见 §4.1 / [docs/known-limitations.md](docs/known-limitations.md)） |
| `ext-voice-clone.mjs` 报 `invalid_sample` | 样本格式 / 时长 / 体积不满足约束 | 改 mp3/m4a/wav、10 秒–5 分钟、≤20MB（见 §8.2） |
| `ext-async-tts.mjs` 报 `POLL_TIMEOUT` / `FETCH_FAILED` | 单片轮询超时 / 成品取回失败 | 提高 `--timeout`，或重跑该片；下载 URL 约 9 小时过期后需重新取回（见 §8.3） |

## 10. 更多文档

- [skills/minimax-studio/SKILL.md](skills/minimax-studio/SKILL.md) — App Skill：三条多模态工作流（图音视流 / 声音克隆向导 / 长篇有声化）
- [skills/minimax-2k-workflow/SKILL.md](skills/minimax-2k-workflow/SKILL.md) — App Skill：2K 高质量链路（增强提示词 → 生成 → 升 2K）
- [docs/credential-mechanism.md](docs/credential-mechanism.md) — 凭证 lane 与面板状态的技术机制（为何 lane 只能写在运行时快照、面板三分语义）
- [docs/user-scripts.md](docs/user-scripts.md) — 用户脚本（冒烟测试、找回已完成任务的产物；脚本不在安装包内，需从仓库获取）
- [docs/known-limitations.md](docs/known-limitations.md) — 已知限制（传输预算与 Files 回落、语音双通道、克隆与异步 TTS 约束、CDN 依赖）
- [docs/test-report.md](docs/test-report.md) — 自测报告（环境、测试步骤与结果、已知问题）
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录

## 11. License

本项目采用 [MIT 许可证](LICENSE)。

Copyright (c) 2026 Doubi250
