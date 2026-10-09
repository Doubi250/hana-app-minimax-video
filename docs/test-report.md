# 自测报告

| 项 | 值 |
|---|---|
| Hana 版本 | server `1.0.6-beta` |
| 操作系统 | Windows 11（`Windows_NT 10.0.22631`，win32-x64） |
| 安装产物 | 本仓库 Release 附带的 `app-minimax-video-0.1.7.zip`（客户端按 SHA-256 校验） |
| 发布者 | `Doubi250` |

## 测试步骤与结果

1. **静态校验**：`validate_app.mjs --dir .` → **0 error / 0 warning**。
2. **归档校验**：`validate_app.mjs --archive <zip> --json` → **0 error / 0 warning**；
   `--smoke` 启动校验 `backend: loaded`。
3. **单元测试**：`node --test tests/request-body.test.mjs tests/credentials.test.mjs
   tests/apply-probe.test.mjs`
   → **46/46 通过**（请求体/参数归一化 22 条 + 凭证选择/请求头/凭证 lane/manifest 15 条
   + 能力源探测 9 条），全部离线，不需要 Key，不联网。
4. **真机发现**：`media_describe-options(kind:"video")` → 列表出现
   `minimax-video` 与其两个模型（`MiniMax-H3` / `MiniMax-H3-Max`），五种模式齐全。
5. **真机凭证链路**：无任何应用内 Key，探针 `checkAuth()` → `{"ok":true}`，
   凭证完全来自 MiniMax Token Plan 供应商（经宿主 `provider:credentials` 门）。
6. **真机链路**：装机态实测任务提交（`POST /v2/video_generation`）→ 轮询 →
   CDN 下载成功，成品落入宿主 `generatedDir`（宿主日志有据）。
7. **面板行为**：Token Plan key 配置时面板报「已配置」；清空 key 后刷新面板，
   provider 置灰并显示「未在 设置 → 供应商 中配置可用的 MiniMax Token Plan 供应商」；
   重新填入 key 后刷新即恢复（用户在真机确认）。

## 已知问题

- 传输与下载限制见 [known-limitations.md](known-limitations.md)。
- 面板「已配置」字样不反映真实凭证状态（设计代价，见
  [credential-mechanism.md](credential-mechanism.md) §5）。
- 未做消耗额度的端到端真实生成作为最终验收（避免花费）；链路各环节均有独立证据
  （步骤 5、6）。

## 版本历史

见 [CHANGELOG.md](../CHANGELOG.md)。
