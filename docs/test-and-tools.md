# 测试、验证与独立脚本手册

本文档汇总 MiniMax Studio 的自动化测试套件指标、实机真机验证记录，以及 `scripts/` 下 5 个独立命令行工具的调用规范。

---

## 第一部分：自动化测试与实机验证

### 1. 脱机单元测试套件
套件包含完整的脱机单元测试，不依赖外部网络与实际 API Key：
* **执行命令**：`node --test`
* **实测指标**：**281 / 281 全绿（100% 通过）**，耗时约 2.9 秒；
* **测试覆盖面**：
  * 基础视频模型表与请求体序列化断言（125 项）；
  * 语音 TTS / ASR 参数装配与回执提取（50 项）；
  * Files API 上传优先与 Base64 优雅回落（25 项）；
  * 语音适配器 `speechGeneration` 协议校验与格式拒绝（18 项）；
  * 音色表原子写入与损坏文件自动备份机制（12 项）；
  * CLI 脚本退出码与末行单行结构化 JSON 契约断言（15 项）；
  * 凭据脱敏防线与防回归自省测试（10 项）；
  * 其他边界与错误信封转换（26 项）。

### 2. 宿主实机接入核验
* **媒体双通道登记**：宿主 `media_describe-options` 命令成功枚举 `video`（H3/H3-Max）与 `speech`（2.8-HD/2.8-Turbo）；
* **凭证动态借权**：与宿主 `minimax-token-plan` 联动，`checkAuth()` 握手正常；
* **未真机验证部分（诚实标注）**：
  Files API 在 `.cn` 国内站与各场景的兼容性、声音克隆与长篇异步 TTS 真实额度扣费端到端消耗、以及宿主原生 `media_generate-speech` 的实际朗读命中。

---

## 第二部分：独立 CLI 脚本（`scripts/`）

套件在安装包中附带了 5 个独立 Node 命令行脚本，用于脱机流水线调度与运维调试。脚本均接入了统一安全脱敏与 `AbortSignal.timeout` 真实超时拦截。

### 1. `scripts/ext-voice-clone.mjs`（声音克隆与入库）
* **用途**：本地样本预检、云端提取声音表征、并将新音色写入持久化音色表；
* **调用示例**：
  ```bash
  node scripts/ext-voice-clone.mjs --audio sample.wav --voice-id my_voice --name "发音人名称"
  ```
* **退出码与输出契约**：
  * 退出码：成功为 `0`，失败或缺参为 `1`；
  * 末行输出标准 JSON：`{"ok":true,"action":"voice_clone","voice_id":"my_voice","duration_ms":12500}`。

### 2. `scripts/ext-async-tts.mjs`（长篇异步合成流水线）
* **用途**：超长文本智能分片、异步任务派发、进度轮询与批量取回；
* **调用示例**：
  ```bash
  node scripts/ext-async-tts.mjs --file novel.txt --voice-id male-qn-qingse --out-dir ./output
  ```
* **退出码与输出契约**：
  * 退出码：成功为 `0`，失败为 `1`；
  * 末行输出标准 JSON：`{"ok":true,"action":"async_tts","status":"success","audioPath":"...","subtitlesPath":"..."}`。

### 3. `scripts/check-clean.mjs`（白名单合规扫描）
* **用途**：打包前扫描工程中的绝对路径、私有密钥、`.git` 残留与敏感形态；
* **调用示例**：`node scripts/check-clean.mjs`

### 4. `scripts/fetch-task.mjs`（云端视频任务救援）
* **用途**：若会话中途断开，使用此脚本直接根据 Task ID 轮询并下载云端成片；
* **调用示例**：`node scripts/fetch-task.mjs <task_id> [output.mp4]`

### 5. `scripts/smoke.mjs`（端到端冒烟测试）
* **用途**：全链路真实生成冒烟测试（提交 → 轮询 → 下载成片）。
