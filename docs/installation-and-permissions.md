# 安装、权限与凭证机制

本文档说明 MiniMax Studio（`minimax-video`）的安装前置条件、宿主六项权限声明以及 Token Plan 凭证借权机制。

---

## 1. 安装与启用

1. **安装**：使用 Hana 的扩展管理入口安装应用打包产物（`*.zip`），或直接加载开发目录；
2. **授权**：安装时平台会弹出权限复核面板，按提示批准六项应用能力（见下表）；
3. **供应商配置**：在 Hana 系统的 **设置 → 供应商** 中确保已配置并启用了 **MiniMax Token Plan**。

### 验证生效状态
- 执行 `media_describe-options(kind: "video")`，确认返回列表中出现 `minimax-video` 以及 `MiniMax-H3` / `MiniMax-H3-Max`；
- 执行 `media_describe-options(kind: "speech")`，确认语音列表中出现 `minimax-video` 以及 `speech-2.8-hd` / `speech-2.8-turbo`；
- 调用模型工具 `minimax_context_ir`，确认可正常派发异步增强任务。

---

## 2. 权限声明详解

套件在 `manifest.json` 中恰好声明了以下 6 项标准能力，无任何越权声明：

| 能力（manifest `capabilities`） | 必须性 | 作用与物理边界 |
|---|---|---|
| `app/media.provide` | **硬前置** | 注册视频与语音媒体适配器及运行时能力源。缺失时媒体提供商不会出现在系统目录中。 |
| `app/provider.credentials.read` | **硬前置** | 向宿主借用 MiniMax Token Plan 凭据。本套件不自持密钥，缺失时所有出站调用均无法完成。 |
| `app/resources.read` | **重要** | 经受控资源通道读取本地素材（图生视频、多模态参考、ASR 音频读取）。受宿主传输预算约束。 |
| `app/tools.expose-to-model` | **功能性** | 将 `minimax_context_ir`、`minimax_text_to_speech`、`minimax_speech_to_text` 暴露给模型调用。 |
| `app/tasks.manage` | **功能性** | 管理 Context-IR 等异步任务状态机。 |
| `app/session.start-turn` | **功能性** | 异步生成与增强任务完成时唤醒会话并交付结果。 |

---

## 3. Token Plan 凭证借权机制

本套件严格遵循宿主安全沙箱的零凭据存储设计：

```
[MiniMax Studio]
       │
       ▼ (ctx.bus.request("provider:credentials", { providerId: "minimax-token-plan" }))
[Hana 宿主安全凭据总线]
       │
       ▼ 动态校验调用者身份与权限授权
[本机 MiniMax Token Plan 凭据] ───► 返回临时内存引用 ───► 出站调用携带
```

* **无二次配置**：用户只需在宿主全局配置一次 MiniMax Key，本套件所有子模块（视频、语音、克隆、识别）自动无缝共享；
* **非持久化原则**：代码从不在磁盘写入任何 Key 或 Token，进程退出后内存引用即刻销毁；
* **日志脱敏防线**：全套脚本与模块统一接入 `lib/http-util.mjs` 中的 `scrub` 函数，异常报错与进度输出中的 Bearer 及 `sk-` 字段被统一掩码为 `[redacted]`。
