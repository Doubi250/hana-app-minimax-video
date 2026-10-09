# 用户脚本

两个独立调试脚本，位于仓库 `scripts/` 目录。**它们不在安装包内**——需要时从仓库
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
