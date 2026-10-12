# 用户脚本

四个独立调试脚本，位于仓库 `scripts/` 目录。**它们不在安装包内**——需要时从仓库
获取（clone 或直接下载对应文件）。

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
- 流程：上传（purpose `voice_clone`）取 `file_id` → `POST /v1/voice_clone` → 登记 `{data-dir}/voices.json`（默认脚本旁 `./.minimax-data`）。`--voice-id` 缺省时由 `file_id` 派生。
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
