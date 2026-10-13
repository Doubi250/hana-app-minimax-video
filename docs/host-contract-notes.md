# 宿主契约笔记

> **活文档**：新验证的宿主行为**追加于此**，勿散落各处。每条 = 一句事实 + 验证方式（哪张票、怎么核的）+ 最后验证（票号 / 日期 / 宿主版本）。
> 凡对「宿主会怎么处理」的假设——manifest capabilities、文件落点、网络 / 超时 / 取消、语音格式——先在此查证再动手。

最后验证宿主版本：**1.1.0-beta**（`server`）。

## 清单与能力发布

- **manifest 静态 provider 贡献白名单只认 `imageGeneration` / `videoGeneration`**；`contributes.providers[].capabilities.media` 写其它键，**整应用在清单读取阶段即 `failed`**。验证：02 号票，对照宿主实现核实（2026-10-14，宿主 1.1.0-beta）。
- **语音能力走运行时能力源发布**：`media.speechGeneration` 由 `registerCapabilitySource` 运行时发布，不经 manifest 静态贡献。验证：02 号票，与上条同批核实（2026-10-14，宿主 1.1.0-beta）。
- **宿主语音通道已知音频格式为 `mp3` / `wav` / `pcm` / `ogg_opus`，无 `flac`**；请求 `flac` 须明确报错、不得静默降级。验证：02 号票（2026-10-14，宿主 1.1.0-beta）。

## 传输信封

- **`serializeNetworkFetch` 走 `bodyBase64` 进 32MiB 单条 RPC 信封**——上传体仍经宿主 RPC，Files 上传的 20MB 单文件上限即按此信封算术设。验证：07 号票，源码核实（2026-10-14，宿主 1.1.0-beta）。
- **`serializeResponse` 对网络响应走 `bodyStreamId` 64KiB 流式分片**，**不受 32MiB 信封约束**——响应可设更宽的字节上限。验证：07 号票核实，并**推翻过一次「响应同受 32MiB 约束」的误报**（2026-10-14，宿主 1.1.0-beta）。
- **`timeoutMs` 是宿主私有参数，原生 `fetch` 不识别**；真实超时要用 `AbortSignal.timeout`（宿主 `network.fetch` 单次硬上限 30 秒）。验证：08 号票（2026-10-14，宿主 1.1.0-beta）。

## 文件系统与取消

- **安装目录对 App 进程只读**；可写面只有 `ctx.dataDir`（= `{HANA_HOME}/app-data/<appId>`）。一切持久化落 `dataDir`。验证：10 号票，端到端核实（2026-10-14，宿主 1.1.0-beta）。
- **`ctx.attempt.signal` 的网络层传播未被宿主文档化**：适配器只能做**飞行前检查**（`signal.aborted` 即抛），飞行中取消依赖宿主未来支持。验证：12b 号票，与 `docs/known-limitations.md` 同步（2026-10-14，宿主 1.1.0-beta）。
- **`mm_file://` 云端引用在 `.cn` 站未真机验证**（形态取自国际站 `api.minimax.io` 文档）：上传设计带 base64 回落，**未验证，非已证事实**。验证：01b 号票设计决策（2026-10-14，宿主 1.1.0-beta）。
