# 已知限制

- **本地参考素材经 base64 内联**进请求体。受宿主 RPC 传输预算约束：**单文件 ≤12MB、
  总量 ≤16MB**，超出会明确报错提示压缩。参考素材越大，提交越慢。
- **Files 上传优先与回落（多站差异）**：本地参考图 / 视频 / 音频与 2K 再生成的源片
  **默认先经 Files API 上传**（`POST /v1/files/upload`）取 `file_id`，以 `mm_file://{file_id}`
  云端引用提交（字节从**模型请求体**挪进独立的 Files 调用，不再受内联 data URL 预算约束；
  上传体仍经宿主 RPC 的 32MiB 信封）。上传路径被接受需同时满足：HTTP 2xx、
  `base_resp.status_code === 0`、响应含 `file.file_id`。任一不满足（未授权、网络差异、
  接口拒绝、4xx/5xx）→ 记一条 `logger.warn`，**本素材自动回落 base64 内联**（仍受
  ≤12MB / ≤16MB 预算约束），**不使整单失败**。
  - **多站差异（未真机验证）**：`mm_file://` 是 `api.minimax.io`（国际站）文档的形态；
    本 App 的基址是 `api.minimax.cn`。Files API 在 `.cn` 站的可用性与 `mm_file://`
    兼容性**未经真机验证**——因此回落分支是设计内的正常形态，不是失败。若站点不接受
    Files，所有素材自动走 base64，功能不失效（只是不再省 RPC 字节）。
  - 上传失败**不会**降级为“整单失败”，也不会回退 `globalThis.fetch` 绕开宿主网络桥。
  - **上传路径单文件上限（20MB）**：上传路径的单文件上限是 20MB，且这是**宿主 RPC 信封**约束（不是 MiniMax API 限制）。宿主 `ctx.network.fetch` 的请求体是整段 base64 进单条 RPC 信封（上限 32 MiB，base64 膨胀 1.33x，原始字节天花板约 24 MiB，取 20MB 留余量）。API 自身对 `video_generation_input` 的图/视频/音频分别允许 30/50/15MB，但在单条信封下无法送达。超限时明确报错且不回落。
- **网络响应走流式分片（64KiB）**：宿主 `serializeResponse` 对网络响应采用 `bodyStreamId` 流式分片（64KiB），响应体不受单条 32 MiB 信封约束，因此 Files API 检索内容（如异步 TTS 的成品音频与字幕）采用 32MB 响应上限安全合理。
- **2K 再生成（`regeneration` 模式，仅 `MiniMax-H3`）**：输出固定 2K，时长与比例由
  源片决定。`source_task_id` 方式有三个服务端硬条件——账号在 MiniMax 白名单内、
  源任务属本账号、且为 **7 天内**已成功（`succeeded`）的任务；不满足时 API 报错
  如实透传。`base_video` 方式须重现原 prompt 与全部素材，源视频经本地字节内联，
  受**单文件 ≤12MB** 预算约束（总量仍 ≤16MB）；超限时请改用 `source_task_id`
  （零字节上传）或压缩源视频。
- **H3-Context-IR 增强工具是异步的**：调用立即返回「已提交」，增强提示词稍后自动
  送达会话（后台轮询上限约 20 分钟，超时会明确报错）。**在途轮询已持久化，重载后自动
  恢复（凭证每轮重解析）**：任务一经远端接受即登记到 `{dataDir}/context-ir-pending.json`
  （原子写 + 损坏备份重建），App 重载时读回并接续轮询，宿主任务不再悬挂；凭证每轮重新
  从供应商 lane 解析，换 key 后恢复的任务仍能结算。已过期超过 24 小时的条目在恢复时
  直接判失败并清出簿子（宿主任务不永久挂着）。首 / 尾帧与参考素材互斥；本地素材沿用
  ≤12MB / ≤16MB 传输预算，公网 URL 不占预算。
- **下载依赖 CDN 支持 Range 分片**（8MB 一片）。服务器忽略 `Range` 时走整段下载，
  单次 RPC 仍受 30 秒限制 —— 大文件可能因此超时失败，可稍后重试。
- **语音工具（TTS / ASR）的预算与超时约束**：
  - 单次 `network.fetch` 硬上限 30 秒同样适用于语音：TTS（`/v1/t2a_v2`）与 ASR
    （`/v1/speech_to_text`）的请求超时均为 30000ms，`audio_url` 下载为 28000ms。
  - ASR 本地音频经宿主的 `resources.stat` → 读 → 读后复校 → 总量预算链，**单文件
    ≤12MB**；超限时在 stat 处即报错（不读入内存）。`audio_url` 也按同一上限约束。
  - TTS 合成音频内联在响应体里（hex），响应上限放宽但仍在 `MAX_TTS_RESPONSE_BYTES`
    之内；返回的 `filePath` 作为后续参考音频时，与其他素材共享 ≤12MB / ≤16MB 预算。
- **语音合成取消仅在开始前生效**：宿主契约未文档化网络层 abort 传播（`ctx.attempt.signal` 无网络层语义保证）。适配器做**飞行前检查**（`signal.aborted` 为真即抛，不发出请求）；**飞行中**的取消依赖宿主未来支持，当前无法中断在途请求。
- 下载总大小保护上限 1GB。
- **声音克隆的样本约束**：格式限 `mp3` / `m4a` / `wav`，时长 **10 秒–5 分钟**，体积 **≤20MB**。
  样本在**本地先校验**（读容器头测时长，不依赖外部解码器），不满足直接报错、不联网。
  克隆后的音色登记在 `{dataDir}/voices.json`（CLI 缺省 `{HANA_HOME}/app-data/minimax-video`，与 App 运行时同一张表），
  **只写 `dataDir`**，绝不写安装目录。
- **长篇异步 TTS 的轮询与有效期约束**：
  - 查询接口（`GET /v1/query/t2a_async_query_v2`）限流上限 **10 次/秒**，轮询间隔下界为
    **1000ms**（即 1 次/秒）；调用方不得把间隔调到 1000ms 以下。
  - 单片轮询默认总超时 10 分钟；超时返回 `POLL_TIMEOUT`，可提高 `--timeout` 或重跑该片。
  - 成品下载 URL（`download_url`）有约 **9 小时有效期**；过期后需重新取回（重新查询任务
    取新的 URL，或经 `files/retrieve_content` 直接取内容）。
  - 切片之间互不牵连：单片提交 / 轮询 / 取回失败只记在该片记录上，不影响其余片。
- **成品视频从 MiniMax 侧 CDN 下载**（实测为 `*.aliyuncs.com`），故 `network.allowedHosts`
  需覆盖该域；CDN 域名变更时须同步更新白名单（出站域清单见 README §4）。
- 单次 RPC 上限 30 秒：这是宿主进程间的硬约束，不是可以调优的参数。
- **面板凭证状态恒为「已配置」**（`authType: none` 的设计代价）：「Token Plan 是否真的
  配好」由能力源探测透传为灰灯/提示，但面板上的「已配置」字样本身不反映真实凭证状态。
  机制详见 [credential-mechanism.md](credential-mechanism.md)。
