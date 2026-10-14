# 自测报告

| 项 | 值 |
|---|---|
| Hana 版本 | server `1.0.16-beta`（win32-x64；离线单测环境 Node v25.9.0） |
| 应用版本 | `0.3.2`（全模态音视频套件） |
| 操作系统 | Windows 11（`Windows_NT 10.0.22631`，win32-x64） |
| 安装产物 | 待发布；对应仓库 Release 的 `app-minimax-video-0.3.2.zip`（客户端按 SHA-256 校验） |
| 发布者 | `Doubi250` |

## 测试步骤与结果

1. **静态校验**：`validate_app.mjs --dir .` → **0 error / 0 warning**。
2. **单元测试**：`node --test` → **<!-- test-count -->339<!-- /test-count -->/<!-- test-count -->339<!-- /test-count --> 通过**（视频侧 126 + 语音侧 57 + Studio 156）。
   全部离线，不需要 Key，不联网。视频侧：请求体 / 参数归一化 43 + 下载状态机 9 + Context-IR
   请求体 26 + Context-IR 工具 18 + 再生成提交 5 + 能力源探测 9 + 凭证 / 清单 16。语音侧：
   语音协议 10 + 语音客户端 13 + TTS 工具 16 + ASR 工具 16 + 音视频联动 2。Studio 新增：
   Files 客户端 16 + 上传回落 11 + 上传上限 3 + 语音适配器 14 + 音色表 18 + 克隆扩展 15 +
   异步 TTS 扩展 22 + CLI 契约 10 + CLI 脱敏单源与超时 10 + http 工具 11 + 发版流水线 26。
3. **真机发现**（自 0.2.0 基线延续）：`media_describe-options(kind:"video")` → `MiniMax-H3`
   **六模式**（含「2K 再生成」）/ `MiniMax-H3-Max` **五模式**（不含）。
4. **真机 · 2K 再生成（`source_task_id`）**（自 0.2.0）：以已成功的历史任务为源提交 →
   下载成功（**7,032,561 字节**），成品 **2560×1440**。
5. **真机 · 2K 再生成（`base_video`）**（自 0.2.0）：以本地历史视频为源（经 `video` 参数）→
   下载成功（**7,113,670 字节**），成品 **2560×1440**。
6. **真机 · H3-Context-IR 工具**（自 0.2.0）：会话内调用 `minimax_context_ir` → 立即回执 →
   后台约 30 秒完成 → 增强提示词（含分镜 / 声景 / 配乐）自动投递回会话。
7. **真机 · 文本直达 2K（附带观察，自 0.2.0）**：`media_generate-video` 以 `resolution:"2K"`
   **直接文本生成**成功（未走官方两步链），成品 2560×1440 且含音轨；
   **仅单次验证，未测多 prompt 稳定性**。
8. **真机凭证链路**（自 0.2.0）：无任何应用内 Key，凭证仍由 MiniMax Token Plan 供应商提供
   （经宿主 `provider:credentials` 门）。
9. **面板行为**（自 0.2.0）：Token Plan key 配置时面板报「已配置」；清空 key 后刷新面板，
   provider 置灰并显示「未在 设置 → 供应商 中配置可用的 MiniMax Token Plan 供应商」；
   重新填入 key 后刷新即恢复（用户在真机确认）。
10. **语音工具（0.3.0，离线验证）**：TTS / ASR 两个工具及其协议、客户端、字节提取、预算、
    错误分支均由离线单测覆盖（**离线，未走真机 API**）。真机 TTS / ASR 调用（真实音频 / 真实 key）
    留待发布前在真机跑通（见下文已知问题）。
11. **Studio 新增（0.3.1，离线验证）**：Files 上传与回落、宿主发音通道适配器、音色表读写、
    声音克隆与长篇异步 TTS 两条链路、两个 CLI 的末行 JSON 契约，均由离线单测覆盖（**均未真机联网**）。

## 已知问题

- 传输与下载限制见 [known-limitations.md](known-limitations.md)；语音双通道、克隆与异步 TTS 的约束同页。
- 面板「已配置」字样不反映真实凭证状态（设计代价，见
  [credential-mechanism.md](credential-mechanism.md) §5）。
- 视频侧真实生成已完成验收：2K 再生成 `source_task_id` / `base_video` 两路径、
  H3-Context-IR 工具、文本直达 2K（见步骤 4–7）。
- **语音工具（TTS / ASR）目前只有离线单测**，未做真机联网验证：真实 TTS 合成落盘、
  真实 ASR 转写、以及「TTS 产物 → 作为 H3 参考音频」的端到端链路均需在真机跑一次（需真实 key）。
- **本次（0.3.2）未真机验证项（如实标注）**：
  - **Files API 在 `.cn` 站的可用性与 `mm_file://` 兼容性**未真机验证。故上传路径带
    回落设计（上传不可用时自动回落 base64），回落分支由离线单测锁定。
  - **声音克隆**（`scripts/ext-voice-clone.mjs`）未真机跑：真实样本上传、`POST /v1/voice_clone`、
    音色表落盘均只有离线替身验证。
  - **长篇异步 TTS**（`scripts/ext-async-tts.mjs`）未真机跑：真实长文提交、轮询、成品音频与
    SRT 取回均只有离线替身验证。
  - **宿主 `media_generate-speech`** 对 MiniMax 语音适配器的真实选中未真机验证（适配器注册形状
    与 `submit` 落盘由离线单测锁定）。
- 未测报错路径：`source_task_id` 与 `base_video` 二选一冲突 / 超预算 / 无效 task_id。
- 文本直达 2K 仅单次验证，未测多 prompt 稳定性。

## 版本历史

见 [CHANGELOG.md](../CHANGELOG.md)。
