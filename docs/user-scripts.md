# 用户脚本

五个独立调试 / 批处理脚本，位于 `scripts/` 目录。**它们已随应用安装包分发**——安装后位于
`{HANA_HOME}/apps/minimax-video/scripts/`（即 App 安装目录下的 `scripts/`，可用 `HANA_HOME`
环境变量定位），仓库中亦可获取。

所有脚本都**只从 `MINIMAX_API_KEY` 环境变量读 key**，不落盘、不回显，并**不经宿主的
`provider:credentials` 门取凭据**（与 App 运行时取凭证的路径不同）：它们是独立工具，
可在 App 未加载时单独使用。

## 1. 冒烟测试（scripts/smoke.mjs）

```powershell
$env:MINIMAX_API_KEY="<你的key>"; node scripts/smoke.mjs
```

脚本**只从环境变量读 key**，不落盘、不回显（打印里出现的 `Authorization` 一律掩码）。
流程：POST 建任务 → 每 10 秒轮询（上限 10 分钟）→ 成功后把 mp4 下到
`scripts/minimax-smoke-<时间戳>.mp4`，并打印绝对路径与体积。不给 key 时打印用法并以
退出码 1 结束。这是**独立的调试脚本**，与 App 运行时取凭证的路径无关（App 走宿主的
`provider:credentials` 门，见 [credential-mechanism.md](credential-mechanism.md)）。

## 2. 找回任务产物（scripts/fetch-task.mjs）

**用途。** 任务在远端**已完成**、但产物没能落盘时用它直接把成品找回——例如提交后下载
被网络白名单拦截、或下载超时。修好环境（如补上 CDN 白名单）后直接找回，不必重新生成。

```powershell
$env:MINIMAX_API_KEY="<你的key>"; node scripts/fetch-task.mjs <taskId> [outPath]
```

- `taskId` 远端任务 id（必填）；`outPath` 输出路径（可选，默认 `scripts/minimax-task-<taskId>.mp4`）。
- 脚本**只从环境变量读 key**，不落盘、不回显。
- 退出码：`0` 已下载；`1` 用法/查询错误；`2` 任务未完成或已失败。

## 3. 声音克隆（scripts/ext-voice-clone.mjs）

**用途。** 把一段样本音克隆成可复用音色，并登记进本 App 的音色表。

```powershell
$env:MINIMAX_API_KEY="<你的key>"; node scripts/ext-voice-clone.mjs <sample> --voice-id my-voice [--label "名"] [--data-dir <目录>]
```

- 样本格式限 `mp3` / `m4a` / `wav`，时长 10 秒–5 分钟，体积 ≤20MB（**本地先校验**，不满足直接报错、不联网）。
- 流程：上传（purpose `voice_clone`）取 `file_id` → `POST /v1/voice_clone` → 登记 `{data-dir}/voices.json`（缺省 `{HANA_HOME}/app-data/minimax-video`，即 App 运行时同一张表；`HANA_HOME` 缺省回落 `~/.hanako`）。`--voice-id` 缺省时由 `file_id` 派生。
- stdout **末行**为单行 JSON（`{"ok":true,"voice":{...}}` / `{"ok":false,"error":{...}}`）；退出码 `0` 成功 / `1` 失败。
- 脚本**只从环境变量读 key**，不落盘、不回显。

## 4. 长篇异步 TTS（scripts/ext-async-tts.mjs）

**用途。** 把整本书 / 长文分章切片、异步合成为音频与 SRT。

```powershell
$env:MINIMAX_API_KEY="<key>"; node scripts/ext-async-tts.mjs book.txt --subtitle --voice-id <id> --out-dir <目录>
```

- 文本来源：一个文本文件路径，或 `--text "…"`。按章节标题切片，按字符上限贪心打包。
- 流程：逐片 `POST /v1/t2a_async_v2`（超长片经 `t2a_async_input` 上传）→ 轮询 → 完成后 `GET /v1/files/retrieve_content` 取音频（`--subtitle` 时另取 SRT）。
- 常用选项：`--voice-id` / `--model` / `--format` / `--out-dir` / `--subtitle` / `--poll-interval <ms>`（下界 1000）/ `--timeout <ms>`（单片默认 600000）/ `--max-chars <n>`（默认 20000）。
- stdout **末行**为单行 JSON（`{"ok":true,"tasks":[...],"files":[...]}` / `{"ok":false,"error":{...}}`）；退出码 `0`/`1`。
- 脚本**只从环境变量读 key**，不落盘、不回显。

## 5. 泄漏扫描（scripts/check-clean.mjs）

**用途。** 扫描全部已跟踪文件（`git ls-files`），逐行查本机路径与常见凭据形态，防止
本地机器信息或密钥被提交进这个公开仓库。仓库的 pre-commit 钩子会调用它。

```powershell
node scripts/check-clean.mjs             # 扫描；有命中则退出码 1
node scripts/check-clean.mjs --verbose   # 另外列出每个被扫描的文件
```

- 检测项：盘符用户目录路径、本机 checkout 布局、本机配置目录与漫游数据目录路径，以及
  `sk-` API key、GitHub token、JWT、PEM 私钥头、Bearer token。
- 退出码：`0` 干净；`1` 存在命中（会列出 `文件:行号 [规则] 片段`）；`2` 不在 git 仓库内运行。
- 无末行 JSON 契约——它只打印一行汇总或命中列表。
- 误报豁免：在命中行（或上一行）写 `check-clean:allow` 并说明理由。
- 需要 `git` 在 PATH 上；不读 `MINIMAX_API_KEY`。

## 6. 脚本的共性契约

- **脱敏单源**：五个脚本的 `scrub` 全部来自 `lib/http-util.mjs`（`Bearer …` 与长度 ≥6 的
  `sk-…` 一律替为 `[redacted]`），不再各自维护副本。
- **真实超时**：两个 CLI 在注入 `fetch` 前统一经 `withTimeout` 包装——原生 `fetch` 不识别
  宿主的 `timeoutMs`，故用 `AbortSignal.timeout` 兜底（缺省 30 秒），避免网络假死时永久阻塞。
- **末行 JSON**：除 `check-clean.mjs` 外，其余四个脚本的 stdout 末行均为单行 JSON，
  便于 Agent 直接读取。
