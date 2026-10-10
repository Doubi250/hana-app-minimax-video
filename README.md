# MiniMax 视频生成（Hana v2 App）

**这是什么。** 一个纯后端的 Hana 媒体 provider：把 MiniMax H3 的视频生成 REST 接口
（`POST /v2/video_generation`）接进 Hana 的媒体系统。装上并授权后，Agent 的
`media_describe-options` 能看到 `minimax-video` 的两个模型，`media_generate-video`
能直接调用它；提交 → 轮询 → 下载 → 发布全部由本 App 完成，成品落在宿主的
`generatedDir` 里。

没有 UI、没有设置页、没有卡片 —— 它是一个媒体提供方，另带一个模型工具
（`minimax_context_ir`，见 §7），不是一个面板。
**凭证不由本 App 保存**：直接使用本机已配置的 **MiniMax Token Plan** 供应商凭证。

- **App id**：`minimax-video`
- **图标**：`assets/icon.svg`
- **当前版本**：`0.1.7`

---

## 1. 用途

- 让 Agent 用 MiniMax H3 / H3-Max 生成视频：文生视频、图生视频、首/尾帧生视频、
  多模态参考（图 + 视频 + 音频）；并支持把已生成的 768P 成片**升级为 2K**（§6）。
- 用模型工具 `minimax_context_ir` 把粗糙提示词交给 H3-Context-IR **增强**，
  增强结果自动回到会话，可用于后续生成或再生成（§7）。
- 由一个 adapter（`minimax-video-videos`）+ 一个运行时能力源（静态模型表）+
  一个模型工具组成，不贡献任何设置项。
- 不持有任何独立凭证：每次调用都从 **MiniMax Token Plan 供应商**取凭证（见 §3）。

## 2. 安装与启用

1. 用 Hana 的扩展安装入口安装本 App 的打包产物（`*.hana-app.zip`），或在开发目录里
   直接加载本插件目录。
2. 安装时按提示批准六项能力（见 §3）。`app/media.provide` 或
   `app/provider.credentials.read` 缺失时对应功能不可用（注册失败只记日志，不阻断 App）；
   `minimax_context_ir` 依赖新增的三项能力，其中模型工具开关默认关闭（见 §3 / §7）。
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
| `app/tools.expose-to-model` | 将 `minimax_context_ir` 暴露给模型调用（模型工具通道）。开关默认关闭，需在 设置 → 安全 → 应用能力 里为本应用单独打开，模型才能主动调用它。 |
| `app/tasks.manage` | 增强工具创建 / 结算宿主任务（异步增强结果的承载通道）。 |
| `app/session.start-turn` | 增强任务完成时把结果投递回会话（会话唤醒）。 |

六项都需要用户在 **设置 → 应用 → 应用权限**（安装时也会确认）里批准。`app/media.provide`
与 `app/provider.credentials.read` 是硬门：缺失时 provider 不出现或无凭证可用。后三项
服务于 `minimax_context_ir`（§7）：其中 `app/tools.expose-to-model` 的模型工具开关
**默认关闭**，要在 **设置 → 安全 → 应用能力** 中为本应用单独打开，模型才能调用该工具。

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

## 8. 常见问题

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
| 模型无法调用 `minimax_context_ir` | 模型工具开关默认关闭 | 在 设置 → 安全 → 应用能力 里为本应用打开开关（见 §3 / §7） |

## 9. 更多文档

- [docs/credential-mechanism.md](docs/credential-mechanism.md) — 凭证 lane 与面板状态的技术机制（为何 lane 只能写在运行时快照、面板三分语义）
- [docs/user-scripts.md](docs/user-scripts.md) — 用户脚本（冒烟测试、找回已完成任务的产物；脚本不在安装包内，需从仓库获取）
- [docs/known-limitations.md](docs/known-limitations.md) — 已知限制（传输预算、再生成与增强工具约束、CDN 依赖、超时约束）
- [docs/test-report.md](docs/test-report.md) — 自测报告（环境、测试步骤与结果、已知问题）
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录

## 10. License

本项目采用 [MIT 许可证](LICENSE)。

Copyright (c) 2026 Doubi250
