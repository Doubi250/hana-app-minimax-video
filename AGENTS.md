# AGENTS.md — MiniMax Studio（仓库导航）

## 宿主契约事实
改 `manifest.json` 的 `capabilities` / 写文件选落点 / 网络·超时·取消 / 语音格式——凡「宿主会怎么处理」的假设，先查 [`docs/host-contract-notes.md`](docs/host-contract-notes.md) 再动手。该笔记是活文档，新验证的宿主行为追加于此。

## 模块地图
- `index.mjs` —— 唯一装配点：一个能力源、两个媒体适配器（视频 / 语音）、三个模型工具全在此注册；新增入口改这里。

视频域
- `lib/minimax/constants.mjs` —— provider / protocol 标识、接口路径、传输预算常量、比例与默认参数、参数标签、`ERROR_CODES` 注册表。
- `lib/minimax/model-catalog.mjs` —— H3 模型目录与生成模式（含 2K 再生成）的静态构建。
- `lib/minimax/params.mjs` —— 参数归一化：参考素材键位优先级、模式推断与校验、模型 / 分辨率 / 时长 / 比例解析。
- `lib/minimax/reference-pipeline.mjs` —— 参考素材字节管线：读成 data URL 或上传成 `mm_file://`，执行 ≤12MB/≤16MB 内联与 ≤20MB 上传预算。
- `lib/minimax/request-body.mjs` —— `/v2/video_generation` 生成体与 `/v2/video_regeneration` 2K 再生成体组装。
- `lib/minimax/context-ir-body.mjs` —— `/v2/h3_context_ir` 请求体组装、首 / 尾帧与参考素材的互斥校验。
- `lib/minimax/naming.mjs` —— 任务 / URL 摘要、成品文件名、下载状态键、在途分片文件名、远端状态映射。
- `lib/minimax-adapter.mjs` —— 宿主媒体适配器（视频通道）：`checkAuth` / `submit` / `query` 与后台下载状态机。
- `lib/minimax-client.mjs` —— 视频 HTTP 半边：创建 / 查询任务、分片下载成品（下载前校验 host）。
- `lib/auth.mjs` —— 视频侧凭证选择（`FALLBACK_PROVIDER_ID` 由 `constants.mjs` re-export）。

语音域
- `lib/speech/catalog.mjs` —— 宿主语音通道发布的 TTS 模型目录：音频格式白名单、语速边界、参数标签、模型条目构建。
- `lib/speech-api.mjs` —— 语音纯逻辑与协议帮助（TTS 专有标记、格式归一、字节提取口径）。
- `lib/speech-client.mjs` —— 语音网络通信层：`synthesizeSpeech` / `transcribeSpeech`。
- `lib/speech-adapter.mjs` —— 宿主全局发音入口 `media_generate-speech` 的适配器。
- `lib/tts-tool.mjs` / `lib/asr-tool.mjs` —— 模型工具 `minimax_text_to_speech` / `minimax_speech_to_text`。

共享与基础设施
- `lib/snapshot.mjs` —— 运行期能力快照：聚合视频与语音两个目录，是唯一同时 import 两域的地方。
- `lib/files-client.mjs` —— Files 上传 / 检索 / 取内容（20MB 上传上限在此）。
- `lib/context-ir-tool.mjs` —— 模型工具 `minimax_context_ir`：提交增强任务、回执、经宿主任务系统投递结果。
- `lib/context-ir-pending.mjs` —— 在途任务簿：读写 `{dataDir}/context-ir-pending.json`，重载后恢复轮询。
- `lib/voice-registry.mjs` —— 音色表；只写 `ctx.dataDir`，绝不写安装目录。
- `lib/atomic-file.mjs` —— `dataDir` 持久化原语：原子写（tmp+rename）与损坏备份重建。
- `lib/http-util.mjs` —— 脱敏 / HTTP 管道（文本读取、JSON 解析、错误拼装、超时钳制）/ 响应信封判定的单源。新增横切逻辑先进这里，不要复制到别处。
- `lib/download-host.mjs` —— 下载 URL 的 host 纵深校验；白名单唯一可扩常量 `DOWNLOAD_HOST_SUFFIXES`。
- `lib/multipart.mjs` —— 单一 multipart/form-data 组装实现，供 ASR 与 Files 上传共用。
- `lib/extensions/async-tts.mjs` / `lib/extensions/voice-clone.mjs` —— 隐藏扩展（只经 CLI 暴露，不 `ctx.tools.register`）：长篇异步 TTS 与声音克隆。

## 发版
`scripts/pack-release.mjs`（12a 并行引入）；该脚本不在时配方见 [`docs/test-and-tools.md`](docs/test-and-tools.md) 与 VERIFY-REPORT 配方。**严禁从 worktree 目录直接打包**（`.git` 指针泄漏本机路径）。

## 测试
`node --test` 跑全量（<!-- test-count -->402<!-- /test-count --> 项，全离线，不需 Key）。pre-commit 钩子（`.githooks/pre-commit`）跑三道门禁：`node scripts/check-clean.mjs`（泄漏扫描）+ `node scripts/sync-doc-counts.mjs --check`（文档计数）+ `node --test`（全量单测），任一不过即拒绝提交。
