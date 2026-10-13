# 语音合成与识别手册

本文档介绍 MiniMax Studio 的语音合成（TTS）双通道发音机制、模型工具高阶富文本控制与语音识别（ASR）技术规范。

---

## 1. 语音生成双通道设计

套件提供两条定位明确的发音通道：

```
                    ┌──► 通道 A：宿主语音适配器 (media_generate-speech)
                    │    • 满足系统级全局朗读与通用播音需求
[文本输入] ─────────┤    • 统一容器输出 (mp3 / wav / pcm)，支持 8 套预设音色
                    │
                    └──► 通道 B：智能体模型工具 (minimax_text_to_speech)
                         • 满足创作级富文本精细控制需求
                         • 毫秒停顿 <#x#>、拟声词 (laughs)、字幕时戳
                         • 产物直接写入生成目录，可直接用作视频参考
```

---

## 2. 宿主语音生成通道（Media Runtime）

通过系统通用命令 `media_generate-speech` 驱动：
* **支持的模型**：
  * `speech-2.8-hd`：旗舰高清大模型，情感表现力最丰富；
  * `speech-2.8-turbo`：低延迟快速版，适合大批量朗读。
* **支持的容器格式**：`mp3`、`wav`、`pcm`（宿主语音通道明确拒绝 `flac`，`flac` 仅留于模型工具直连路径）。
* **内置经典音色**：`male-qn-qingse` (青涩男声)、`female-yujie` (御姐女声)、`female-tianmei` (甜美女声)、`presenter_male` (专业男播)、`presenter_female` (专业女播)、`audiobook_male_1` (评书男声)、`audiobook_female_1` (故事女声)、`English_expressive_narrator` (英文生动解说)。

---

## 3. 高阶模型工具：`minimax_text_to_speech`

专为 Agent 剧本配音与复杂台词编排定制：

* **精准停顿控制**：在文本中嵌入 `<#秒数#>`，如 `"你好，<#1.5#> 很高兴认识你。"`；
* **情感语气词注入**：支持 `(laughs)`、`(sighs)`、`(giggles)` 等拟声词；
* **字幕与时间戳提取**：开启 `subtitle_enable: true` 时，返回的文本中将附带毫秒级字/词时间轴标记；
* **音画直连**：合成音频写入 `ctx.generatedDir`，返回的绝对路径可直接无缝传给后续的 `media_generate-video` 作为 `referenceAudios`。

---

## 4. 语音识别感知：`minimax_speech_to_text`

基于 MiniMax ASR-1.0 引擎，将音频二进制转写为文本：

* **支持的输入格式**：`mp3`、`wav`、`flac`、`pcm`、`aac`、`m4a`、`opus`；
* **输出格式选项 (`response_format`)**：
  * `json`：提取纯转写文本；
  * `verbose_json`：带分段时间戳与角色切分列表；
  * `srt` / `vtt`：直接输出标准外挂字幕格式；
* **传输物理门禁（单文件 ≤12MB）**：
  ASR 接口为单次同步的 Multipart 表单调用，受制于宿主出站 30s 硬超时以及 32MiB RPC 消息信封，工具层在读取本地文件时严格执行 `stat` 尺寸预检（12MB 门禁），确保同步请求在 30 秒内高鲁棒性完成。超大长录音建议使用流媒体工具先做切片转码。
