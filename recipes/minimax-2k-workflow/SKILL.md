---
name: minimax-2k-workflow
description: "MiniMax 视频生成的 2K 高质量工作流：先用 minimax_context_ir 把粗提示词扩成结构化稿，再生成视频，需更高清晰度时用 regeneration 模式升为 2K。当用户想用 MiniMax 生成视频、提升成片画质、把已有成片升 2K，或提到提示词增强 / 2K / 超分时使用。"
profile: recipe
default-enabled: true
---

# MiniMax 2K 工作流

本技能引导 MiniMax 视频的三个能力怎样串起来用。这里的 App 是后端的媒体提供方（provider `minimax-video`）；生成经宿主 `media_generate-video`，提示词增强与再生成见下。

## 这个 App 提供什么

1. **视频生成**（宿主 `media_generate-video`，模型 `MiniMax-H3` / `MiniMax-H3-Max`）：文生视频、图生视频、首/尾帧生视频、多模态参考（图 + 视频 + 音频）。
2. **提示词增强**（工具 `minimax_context_ir`）：多模态上下文理解，把一段粗提示词扩成结构化成稿（分镜 / 声景 / 配乐）。
3. **2K 再生成**（`regeneration` 模式，仅 `MiniMax-H3`）：把已生成的 768P 成片升级为 2K。

## 推荐工作流

1. **先增强提示词**：把用户的粗提示词交给 `minimax_context_ir`，得到结构化成稿。
2. **再生成视频**：把增强稿喂给 `media_generate-video`（需要高清时可直接带 `resolution: "2K"`）。
3. **有必要时再升 2K**：若先说 768P 再要更高清，用 `regeneration` 模式把成片升为 2K；或直接用 `resolution: "2K"` 一步生成。

## 关键约束（勿踩坑）

- `minimax_context_ir` **只产提示词、不产视频**，且是异步的：调用后立即回执，增强稿稍后自动送达本会话——**先等它送来再引用，不要重复调用**。
- 再生成的两条输入路径**二选一**：`source_task_id`（需 MiniMax 白名单、零字节上传）或 `base_video`（无需白名单，但要重现生成原片时的 prompt 与素材）。两者都传 / 都不传都会报错。
- 模型工具开关**默认关闭**：需在 设置 → 安全 → 应用能力 里为本应用打开，模型才能调用 `minimax_context_ir`。
