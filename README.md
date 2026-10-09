# MiniMax 视频生成（Hana v2 App）

**这是什么。** 一个纯后端的 Hana 媒体 provider：把 MiniMax H3 的视频生成 REST 接口
（`POST /v2/video_generation`）接进 Hana 的媒体系统。装上并授权后，Agent 的
`media_describe-options` 能看到 `minimax-video` 的两个模型，`media_generate-video`
能直接调用它；提交 → 轮询 → 下载 → 发布全部由本 App 完成，成品落在宿主的
`generatedDir` 里。

没有 UI、没有设置页、没有卡片、没有工具 —— 它是一个媒体提供方，不是一个面板。
**凭证不由本 App 保存**：直接使用本机已配置的 **MiniMax Token Plan** 供应商凭证。

- **App id**：`minimax-video`
- **图标**：`assets/icon.svg`
- **当前版本**：`0.1.7`

---

## 1. 用途

- 让 Agent 用 MiniMax H3 / H3-Max 生成视频：文生视频、图生视频、首/尾帧生视频、
  多模态参考（图 + 视频 + 音频）。
- 由一个 adapter（`minimax-video-videos`）+ 一个运行时能力源（静态模型表）组成，
  不注册任何 Agent 工具、不贡献任何设置项。
- 不持有任何独立凭证：每次调用都从 **MiniMax Token Plan 供应商**取凭证（见 §3）。

## 2. 安装与启用

1. 用 Hana 的扩展安装入口安装本 App 的打包产物（`*.hana-app.zip`），或在开发目录里
   直接加载本插件目录。
2. 安装时按提示批准三项能力（见 §3）。`app/media.provide` 或
   `app/provider.credentials.read` 缺失时对应功能不可用（注册失败只记日志，不阻断 App）。
3. 在 设置 → 供应商 里确保 MiniMax Token Plan 已配置（见 §3）。

**验证。**

- 让 Agent 跑一次 `media_describe-options(kind:"video")`，确认返回的列表里出现
  `MiniMax-H3` / `MiniMax-H3-Max` 与 `minimax-video` provider。
- 用 `media_generate-video` 发一条最小的文生视频（4 秒、768P、16:9），确认任务
  从 pending 走到 success，成品出现在媒体库里。

**升级 / 卸载。**

- 升级：替换 App 目录或重装包，重新 `apply` 即重新注册适配器与能力源；App 进程退出、
  崩溃、停用或卸载时宿主自动撤销它们，不留孤儿。声明了**新的**能力时，宿主会要求用户
  先复核，取消则旧实例继续运行。
- 卸载：宿主会保留 `dataDir`（`{HANA_HOME}/app-data/minimax-video`），其中可能有
  下载中的 `.part` 临时文件与已发布的成品；确认不再需要后可手动清理。

## 3. 能力与权限

| 能力（manifest `capabilities`） | 为什么需要 |
|---|---|
| `app/media.provide` | 注册媒体适配器与运行时能力源（`ctx.media.registerAdapter` / `registerCapabilitySource`）。没有它，provider 不会出现。 |
| `app/provider.credentials.read` | 向宿主取回 MiniMax Token Plan 供应商的凭证（`provider:credentials`）。这是本 App 的**唯一**凭证来源，没有它无法生成。 |
| `app/resources.read` | 读取会话内的参考图 / 视频 / 音频（图生视频、多模态参考）。没有它，带参考素材的请求会明确报错。 |

三项都需要用户在 **设置 → 应用 → 应用权限**（安装时也会确认）里批准。`app/media.provide`
与 `app/provider.credentials.read` 是硬门：缺失时 provider 不出现或无凭证可用。

### 凭证怎么取

1. 在 **设置 → 供应商** 里配置好 **MiniMax Token Plan** 供应商（填好其 API Key）。
2. 授予本应用 `app/provider.credentials.read`。
3. 本 App 在每次 `submit` / `query` 时经宿主的 `provider:credentials` 门取回该供应商的
   凭证（可能返回 `apiKey`、也可能返回请求头）；**不落盘、不回显、不写日志**。
   本 App **不修改** MiniMax Token Plan 供应商本身，只借它的凭证。

三条取值途径都落空时，生成会明确报错，提示检查上面两步。

面板的凭证状态与「供应商未配置」提示的行为（灰灯/绿灯语义）由能力源探测驱动，
机制细节见 [docs/credential-mechanism.md](docs/credential-mechanism.md)。

## 4. 访问的外部服务

`network.allowedHosts` 声明的出站域：

| 域 | 用途 |
|---|---|
| `api.minimax.cn` / `*.minimax.cn` | 建任务、查任务（主接口） |
| `*.aliyuncs.com` | 成品视频 CDN 下载（实测域名 `algeng-video-infer.oss-cn-shanghai.aliyuncs.com`） |
| `*.hailuoai.com` / `*.minimax.chat` / `*.minimaxi.com` / `*.minimax.io` | 接口 / CDN 备用域 |

请求方式仅 `GET` / `POST`；单次 `network.fetch` 上限 30 秒、单条响应上限 512 MiB。
App 不向上述以外的任何主机发起请求，也不启动任何本地服务。

## 5. 能力矩阵

两个模型、各五种模式：

| 模型 | 分辨率 | 时长 | 默认 |
|---|---|---|---|
| `MiniMax-H3`（MiniMax H3） | 768P / 2K | 4–15 秒（整数） | 768P，5 秒 |
| `MiniMax-H3-Max`（MiniMax H3 Max） | 480P / 768P | 5–15 秒（整数） | 768P，5 秒 |

| 模式（mode id） | 说明 | 输入限制 |
|---|---|---|
| `text2video` | 文生视频 | 无参考文件；`ratio` 必填且不能是 `adaptive` |
| `image2video` | 首帧生视频（1 张图，`role=first_frame`） | 恰好 1 张图 |
| `last_frame2video` | 尾帧生视频（1 张图，`role=last_frame`） | 恰好 1 张图 |
| `frames2video` | 首尾帧生视频（2 张图，按数组顺序 = 首帧、尾帧） | 恰好 2 张图 |
| `multimodal2video` | 多模态参考（`reference_image` / `reference_video` / `reference_audio`） | 图 ≤9、视频 ≤3、音频 ≤3，合计 ≤12 |

图生视频与多模态参考互斥（由模式天然隔离）。比例：除文生视频外一律 `adaptive`
（i2v / 首尾帧由输入图决定；多模态参考缺省 `adaptive`，也可显式指定）。

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| provider 不出现 | `app/media.provide` 未授权，或媒体运行时未就绪 | 去 设置 → 应用 → 应用权限 批准后重载 App |
| 报「参考素材超出传输限制」 | 参考图/视频/音频过大 | 压缩到单文件 ≤12MB、总量 ≤16MB（详见 [docs/known-limitations.md](docs/known-limitations.md)） |
| 任务成功但一直 pending | 后台下载进行中（分片下载 + 轮询回传） | 再等几轮；连续 3 次下载失败才判失败 |
| 下载超时，或任务成功但产物一直没出现在媒体库 | 网络波动、CDN 不支持分段、或单次 RPC 超过 30 秒 | 稍后重试；若仍失败且远端任务已完成，用 [docs/user-scripts.md](docs/user-scripts.md) 的脚本直接找回 |
| 面板灰色/「未配置」，或生成报「未取得 MiniMax 凭证…」 | MiniMax Token Plan 未配置 / key 失效，或未授权 `app/provider.credentials.read` | 在 设置 → 供应商 里配好 Token Plan，确认已授权该能力，刷新面板即恢复（见 §3） |

## 7. 更多文档

- [docs/credential-mechanism.md](docs/credential-mechanism.md) — 凭证 lane 与面板状态的技术机制（为何 lane 只能写在运行时快照、面板三分语义）
- [docs/user-scripts.md](docs/user-scripts.md) — 用户脚本（冒烟测试、找回已完成任务的产物；脚本不在安装包内，需从仓库获取）
- [docs/known-limitations.md](docs/known-limitations.md) — 已知限制（传输预算、CDN 依赖、超时约束）
- [docs/test-report.md](docs/test-report.md) — 自测报告（环境、测试步骤与结果、已知问题）
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录

## 8. License

本项目采用 [MIT 许可证](LICENSE)。

Copyright (c) 2026 Doubi250
