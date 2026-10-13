# 图音视全模态联动指南

本文档介绍 MiniMax Studio 上层编排技能（`minimax-studio`）的设计理念与三大端到端实战工作流。

---

## 1. 全模态中枢架构

在传统管线中，生图、生音、生视频往往处于割裂状态。MiniMax Studio 通过上层 Skill 将分散的能力串联为一条自洽的数据传送带：

```
[分镜策划 / 提示词]
       │
       ▼
[第一步：画面定妆] ───► 调用宿主内置 MiniMax Image-01 绘制关键首帧
       │
       ▼
[第二步：台词拟真] ───► 调用 minimax_text_to_speech 合成精准对齐音频
       │
       ▼
[第三步：音画合成] ───► 将首帧与音频同时喂给 MiniMax-H3 (multimodal2video)
       │
       ▼
[最终交付] ───► 输出音画同步、人物一致的完整短片
```

---

## 2. 三大典型联动工作流

### 工作流一：影视级图音视制作流
* **应用场景**：角色短剧、动态解说、分镜故事短片；
* **执行步骤**：
  1. **定妆出图**：使用宿主内置 `media_generate-image(provider: "minimax", model: "image-01")` 生成一张 16:9 横版角色场景图；
  2. **剧本配音**：使用 `minimax_text_to_speech` 输入角色台词，利用 `<#1.0#>` 与 `(laughs)` 调整表演节奏，获取落盘音频路径；
  3. **运镜扩写**：使用 `minimax_context_ir` 输入视频意图，同时附带第一步的图片与第二步的音频，获取结构化分镜提示词；
  4. **终合成片**：调用 `media_generate-video`，注入首帧图与参考音频，生成最终成片。

### 工作流二：声音克隆与音色入库流
* **应用场景**：为 Agent 录制定制音色或复刻真人发音人；
* **执行步骤**：
  1. **录制并校验**：准备一段 10 秒至 5 分钟、小于 20MB 的干净无背景音干声音频（WAV / MP3）；
  2. **脱机克隆脚本**：调用 `node scripts/ext-voice-clone.mjs --audio sample.wav --voice-id my_voice`；
  3. **沙箱持久化**：脚本提取声学表征后，自动在 `ctx.dataDir`（`<HANA_HOME>/app-data/minimax-video/voices.json`）完成原子写录入；
  4. **全套件复用**：后续调用 `minimax_text_to_speech` 或发音通道时，可直接指定 `voice_id: "my_voice"`。

### 工作流三：整本长篇有声书制作流
* **应用场景**：小说批量朗读、数十万字报告有声化；
* **执行步骤**：
  1. **智能分章**：脚本按标点与自然段将长文切片为约 20,000 字的独立段落；
  2. **异步批量派发**：调用 `node scripts/ext-async-tts.mjs --file novel.txt --voice-id presenter_male`；
  3. **任务轮询管理**：脚本通过 Files API 上传文本，自动维持 1000ms 频率的云端排队轮询；
  4. **双轨产物交付**：成片就绪后，流式拉取 MP3 音频并自动抓取同步 SRT 字幕文件。
