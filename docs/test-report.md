# 自测报告

| 项 | 值 |
|---|---|
| Hana 版本 | server `1.0.11-beta`（win32-x64） |
| 应用版本 | `0.2.0` |
| 操作系统 | Windows 11（`Windows_NT 10.0.22631`，win32-x64） |
| 安装产物 | 本仓库 Release 附带的 `app-minimax-video-0.2.0.zip`（客户端按 SHA-256 校验） |
| 发布者 | `Doubi250` |

## 测试步骤与结果

1. **静态校验**：`validate_app.mjs --dir .` → **0 error / 0 warning**。
2. **单元测试**：`node --test` → **125/125 通过**（请求体/参数归一化 43 条 + 下载状态机
   9 条 + Context-IR 请求体 26 条 + Context-IR 工具 18 条 + 再生成提交 5 条 + 能力源探测
   9 条 + 凭证选择/请求头/凭证 lane/manifest 15 条），全部离线，不需要 Key，不联网。
3. **真机发现**：`media_describe-options(kind:"video")` → `MiniMax-H3` **六模式**
   （含「2K 再生成」）/ `MiniMax-H3-Max` **五模式**（不含）。
4. **真机 · 2K 再生成（`source_task_id`）**：以已成功的历史任务为源提交 →
   下载成功（**7,032,561 字节**），成品 **2560×1440**。
5. **真机 · 2K 再生成（`base_video`）**：以本地历史视频为源（经 `video` 参数）→
   下载成功（**7,113,670 字节**），成品 **2560×1440**。
6. **真机 · H3-Context-IR 工具**：会话内调用 `minimax_context_ir` → 立即回执 →
   后台约 30 秒完成 → 增强提示词（含分镜 / 声景 / 配乐）自动投递回会话。
7. **真机 · 文本直达 2K（附带观察）**：`media_generate-video` 以 `resolution:"2K"`
   **直接文本生成**成功（未走官方两步链），成品 2560×1440 且含音轨；
   **仅单次验证，未测多 prompt 稳定性**。
8. **真机凭证链路**：无任何应用内 Key，凭证仍由 MiniMax Token Plan 供应商提供
   （经宿主 `provider:credentials` 门）。
9. **面板行为**：Token Plan key 配置时面板报「已配置」；清空 key 后刷新面板，
   provider 置灰并显示「未在 设置 → 供应商 中配置可用的 MiniMax Token Plan 供应商」；
   重新填入 key 后刷新即恢复（用户在真机确认）。

## 已知问题

- 传输与下载限制见 [known-limitations.md](known-limitations.md)。
- 面板「已配置」字样不反映真实凭证状态（设计代价，见
  [credential-mechanism.md](credential-mechanism.md) §5）。
- 真实生成已完成验收：2K 再生成 `source_task_id` / `base_video` 两路径、
  H3-Context-IR 工具、文本直达 2K（见步骤 4–7）。
- 未测报错路径：`source_task_id` 与 `base_video` 二选一冲突 / 超预算 / 无效 task_id。
- 文本直达 2K 仅单次验证，未测多 prompt 稳定性。

## 版本历史

见 [CHANGELOG.md](../CHANGELOG.md)。
