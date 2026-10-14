# 测试、验证与独立脚本手册

本文档汇总 MiniMax Studio 的自动化测试套件指标、实机真机验证记录，以及 `scripts/` 下 6 个独立命令行工具的调用规范。

---

## 第一部分：自动化测试与实机验证

### 1. 脱机单元测试套件
套件包含完整的脱机单元测试，不依赖外部网络与实际 API Key：
* **执行命令**：`npm test`（等价 `node --test`）
* **门禁快捷命令**：`npm run check`（等价 `node scripts/check-clean.mjs`）
* **新克隆启用钩子（每克隆一次）**：`git config core.hooksPath .githooks`——启用后 `pre-commit` 会在提交前跑脱机套件与合规扫描
* **实测指标**：**339 / 339 全绿（100% 通过）**（全离线，不联网、不需 Key）；
* **测试覆盖面（339 项）**：
  * 视频侧：请求体 / 参数归一化 43、下载状态机 9、Context-IR 请求体 26 与工具 18、2K 再生成提交 5、能力源探测 9、凭证 / 清单 16；
  * 语音侧：语音协议 10、语音客户端 13、TTS 工具 16、ASR 工具 16、音视频联动 2；
  * Studio 侧：Files 客户端 16、上传回落 11、上传上限 3、语音适配器 14、音色表 18、克隆扩展 15、异步 TTS 扩展 22、CLI 契约 10、CLI 脱敏单源与超时 10、http 工具 11、**发版流水线 26**。

### 2. 宿主实机接入核验
* **媒体双通道登记**：宿主 `media_describe-options` 命令成功枚举 `video`（H3/H3-Max）与 `speech`（2.8-HD/2.8-Turbo）；
* **凭证动态借权**：与宿主 `minimax-token-plan` 联动，`checkAuth()` 握手正常；
* **未真机验证部分（诚实标注）**：
  Files API 在 `.cn` 国内站与各场景的兼容性、声音克隆与长篇异步 TTS 真实额度扣费端到端消耗、以及宿主原生 `media_generate-speech` 的实际朗读命中。

---

## 第二部分：独立 CLI 脚本（`scripts/`）

套件在安装包中附带了 6 个独立 Node 命令行脚本，用于脱机流水线调度与运维调试。脚本均接入了统一安全脱敏与 `AbortSignal.timeout` 真实超时拦截。

### 1. `scripts/ext-voice-clone.mjs`（声音克隆与入库）
* **用途**：本地样本预检、云端提取声音表征、并将新音色写入持久化音色表；
* **调用示例**：
  ```bash
  node scripts/ext-voice-clone.mjs sample.wav --voice-id my_voice --label "发音人名称"
  ```
* **退出码与输出契约**：
  * 退出码：成功为 `0`，失败或缺参为 `1`；
  * 末行输出标准 JSON：`{"ok":true,"voice":{"voiceId":"my_voice","label":"发音人名称"}}`。

### 2. `scripts/ext-async-tts.mjs`（长篇异步合成流水线）
* **用途**：超长文本智能分片、异步任务派发、进度轮询与批量取回；
* **调用示例**：
  ```bash
  node scripts/ext-async-tts.mjs novel.txt --voice-id male-qn-qingse --out-dir ./output
  ```
* **退出码与输出契约**：
  * 退出码：成功为 `0`，失败为 `1`；
  * 末行输出标准 JSON：成功 `{"ok":true,"tasks":[...],"files":[...]}`；失败 `{"ok":false,"error":{"code","message"},"tasks":[...],"files":[...]}`。

### 3. `scripts/check-clean.mjs`（白名单合规扫描）
* **用途**：打包前扫描工程中的绝对路径、私有密钥、`.git` 残留与敏感形态；
* **调用示例**：`node scripts/check-clean.mjs`

### 4. `scripts/fetch-task.mjs`（云端视频任务救援）
* **用途**：若会话中途断开，使用此脚本直接根据 Task ID 轮询并下载云端成片；
* **调用示例**：`node scripts/fetch-task.mjs <task_id> [output.mp4]`

### 5. `scripts/smoke.mjs`（端到端冒烟测试）
* **用途**：全链路真实生成冒烟测试（提交 → 轮询 → 下载成片）。

### 6. `scripts/pack-release.mjs`（发版流水线固化）
* **用途**：把手工重复了多次的发版配方固化成一条命令——`git archive` 干净副本 → `node --test` → `validate-app.mjs --dir` → `extension-pack.mjs` → zip 严格扫描 → `validate-app.mjs --archive --smoke` →（可选）git bundle。**绝不从 worktree / 克隆目录直接打包**（worktree 的 `.git` 指针携带本机绝对路径，`git ls-files` 不收录、packer 却会打进包）；干净副本由 `git archive` 导出、断言无 `.git` 后才继续，陷阱从「文档警告」变成「结构上不可能」。
* **调用示例**：
  ```bash
  node scripts/pack-release.mjs --ref HEAD --out ./release --bundle
  ```
* **选项**：
  * `--ref <ref>`：要发布的 ref（缺省 `HEAD`）；
  * `--out <dir>`：产物落点（缺省 `./release`）；
  * `--tools-root <dir>`：宿主工具根（缺省 `env HANA_APP_TOOLS_ROOT`，否则 `{HANA_HOME}/artifacts/server` 下最新版本目录；须含 `scripts/validate-app.mjs` 与 `scripts/extension-pack.mjs`）；
  * `--bundle`：同时导出 git bundle（`base = --bundle-base`，缺省 `0696115`）；
  * `--skip-tests`：跳过干净副本上的 `node --test`。
* **退出码与输出契约**：
  * 退出码：成功为 `0`，任一步失败为 `1`（打印失败步与原因，每步失败即停）；
  * 末行输出单行 JSON：成功 `{"ok":true,"zip":…,"bytes":…,"sha256":…,"entries":…,"entryJson":…,"scan":"clean","bundle":…,"bundleSha256":…,"commits":N}`；失败 `{"ok":false,"failedStep":…,"error":{"code","message"}}`。
* **冒烟运行时**：`validate-app.mjs --smoke` 需宿主 Node ≥ 26。脚本按 `env HANA_NODE_RUNTIME` > `{HANA_HOME}/.cache/node-runtime/*` 的顺序解析并透传；宿主缓存运行时缺失时，直接以 `HANA_NODE_RUNTIME` 指向平台的 Node ≥ 26 即可。
