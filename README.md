# MiniMax 多媒体套件

一个纯后端的 Hana 全模态多媒体套件：把 MiniMax 视频生成与语音大模型接入 Hana 媒体子系统，并以模型工具形式暴露 H3-Context-IR 提示词增强、Speech-2.8-HD 语音合成与 ASR-1.0 语音识别。

套件为无 UI、无设置页的纯服务型插件。不自持任何独立凭据，视频与语音统一复用本机已配置的 **MiniMax Token Plan** 供应商凭证。

- **App ID**：`minimax-video`
- **当前版本**：`0.3.2`

---

## 组成与能力

套件由以下四个核心层级组成：

### 1. 宿主媒体提供方（Media Runtime）
- **视频生成（`media_generate-video`）**：支持 MiniMax-H3 与 H3-Max（文生视频、图生视频、首尾帧控镜、多模态参考、2K 旗舰画质超分再生成），本地素材默认走云端 Files API 上传暂存；
- **语音合成（`media_generate-speech`）**：接入宿主语音生成通道，注册 Speech 媒体适配器，支持以统一媒体命令驱动 Speech-2.8-HD 与 Speech-2.8-Turbo 发音引擎。

### 2. 智能体模型工具（Model Tools）
- **`minimax_context_ir`**：提交影视级镜头语言扩写与分镜节奏规划任务，增强结果自动回投会话；
- **`minimax_text_to_speech`**：高阶富文本语音合成，支持 `<#1.5#>` 毫秒停顿、拼音音素校正、情绪拟声词注入与字级时间戳提取，产物可直接作为视频参考音频；
- **`minimax_speech_to_text`**：ASR-1.0 语音感知引擎，支持本地音频（≤12MB）与网络音频流转录为纯文本、时间戳段落或 SRT/VTT 字幕。

### 3. 全模态编排技能（Skill）
- **`minimax-studio`**：固化三大联动工作流：
  1. 影视级图音视全模态流（调度内置 Image-01 → Speech-2.8-HD 拟真配音 → H3 音画成片）；
  2. 声音克隆向导流（录制样本 → 云端克隆 → 自动入库持久化）；
  3. 整本长篇有声书流（分章切片 → 异步提交 → 批量下载）。

### 4. 独立 CLI 扩展脚本（`scripts/`）
- 提供声音克隆（`ext-voice-clone.mjs`）与超长文本异步分发（`ext-async-tts.mjs`）两条脱机流水线，支持超时拦截与单行 JSON 机器契约输出。

---

## 文档索引

关于各能力的调用规范、接口参数与架构细节，请参阅 `docs/` 专题文档：

- [安装、权限与凭证机制](docs/installation-and-permissions.md) — 安装流程、六项权限声明与 Token Plan 凭证借权说明
- [视频生成与 2K 工作流](docs/video-generation.md) — H3 视频模型规格、Files API 上传回落、2K 超分与 Context-IR 提示词增强
- [语音合成与识别手册](docs/speech-and-audio.md) — 语音适配器协议、TTS 专有标记（停顿/情绪/拼音）与 ASR 传输门禁
- [图音视全模态联动指南](docs/audio-video-workflow.md) — Studio Skill 调度架构与端到端音画制作流水线
- [测试、验证与调试脚本](docs/test-and-tools.md) — <!-- test-count -->401<!-- /test-count --> 项单测报告、真机双通道注册记录与 7 个 CLI 独立脚本用法
- [已知限制与物理边界](docs/known-limitations.md) — 30s 硬超时、32MiB RPC 信封与网络边界说明

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
