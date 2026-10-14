/**
 * lib/tts-tool.mjs
 *
 * 模型工具：minimax_text_to_speech
 *
 * 把文本合成为 MiniMax 语音（T2A V2 / Speech-2.8-HD），音频写入与媒体管线一致
 * 的生成目录（`ctx.generatedDir`，缺省回落 `{dataDir}/generated`），并把落盘
 * 路径交回模型，使其可被后续工具（如视频参考音频 `referenceAudios`）直接引用。
 *
 * 两条硬约束（review 的 blocker 与约定）：
 *   - `details` 只承载**可序列化原语**，绝不携带原始 `Buffer` / `subtitles` /
 *     原始错误体。工具结果跨宿主 JSON-RPC 边界（单条消息上限 32MiB），一个原始
 *     Buffer 会在文件已写入后把整个调用打成失败。
 *   - `network.fetch` 由注入提供，缺失即抛错，绝不回退 `globalThis.fetch`
 *     （那会绕开宿主网络桥与 manifest `allowedHosts` 策略）。
 *
 * 凭证走视频插件唯一的解析器（lib/auth.mjs），本模块不引入语音自带的凭证模块。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  DEFAULT_TTS_FORMAT,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_ID,
  POPULAR_VOICE_PRESETS,
  SUPPORTED_TTS_MODELS,
  TTS_OUTPUT_FORMATS,
  normaliseTtsFormat,
  ttsFileExtension,
} from "./speech-api.mjs";
import { PROVIDER_ID } from "./minimax/constants.mjs";
import { createCredentialResolver } from "./auth.mjs";
import { createMinimaxSpeechClient } from "./speech-client.mjs";
import { loadVoices, listVoiceLabels, resolveVoiceInput } from "./voice-registry.mjs";

/** 字幕时间戳（毫秒）→ 可读行；非数组 / 空值一律忽略，绝不让它进 `details`。 */
function subtitleLines(subtitles) {
  if (Array.isArray(subtitles)) {
    return subtitles.map((item) => {
      const begin = Number(item?.time_begin);
      const end = Number(item?.time_end);
      const label =
        Number.isFinite(begin) && Number.isFinite(end)
          ? `[${(begin / 1000).toFixed(2)}s - ${(end / 1000).toFixed(2)}s] `
          : "";
      return `${label}${String(item?.text ?? "")}`;
    });
  }
  if (typeof subtitles === "string" && subtitles.trim()) return [subtitles.trim()];
  return [];
}

export function createTtsTool({ network, bus, logger, generatedDir, dataDir } = {}) {
  if (typeof network?.fetch !== "function") {
    throw new Error(
      "minimax_text_to_speech 需要注入的 network.fetch（本工具不回退 globalThis.fetch）",
    );
  }
  const client = createMinimaxSpeechClient({ fetch: (url, init) => network.fetch(url, init) });
  const { requireAuth } = createCredentialResolver({ bus, selfProviderId: PROVIDER_ID });

  /**
   * 合成音频的落点：优先调用上下文给的 `generatedDir`，其次 `apply(ctx)` 捕获的，
   * 最后回落 `{dataDir}/generated`——与媒体适配器同一口径，产物与视频同处一地。
   */
  function resolveOutputDir(context) {
    const fromCall = typeof context?.generatedDir === "string" ? context.generatedDir.trim() : "";
    if (fromCall) return fromCall;
    const fromApply = typeof generatedDir === "string" ? generatedDir.trim() : "";
    if (fromApply) return fromApply;
    return path.join(String(dataDir || "."), "generated");
  }

  return {
    name: "minimax_text_to_speech",
    description:
      "使用 MiniMax 语音大模型（Speech-2.8-HD / T2A V2）将文本合成为高品质语音。支持语速/音调调节、停顿标签 <#秒数#>、情绪语气词 (laughs)/(sighs) 以及字幕时间戳。合成音频会写入本应用的生成目录，返回的文件路径可直接作为视频参考音频（referenceAudios）引用。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "需要合成为语音的文本内容。可包含语气标记如 (laughs)、(sighs) 或停顿标记 <#1.0#>。",
        },
        voice_id: {
          type: "string",
          description: `发音人音色 ID。常用预设：${POPULAR_VOICE_PRESETS.map(
            (p) => `${p.id}(${p.name})`,
          ).join(", ")}，也支持自定义/复刻音色 ID。`,
          default: DEFAULT_VOICE_ID,
        },
        voiceRef: {
          type: "string",
          description:
            "按本 App 音色表引用一个克隆音色：可填其 voiceId 或 label（大小写敏感）。命中即用其 voiceId；未命中会报错并列出表中可用 label。与 voice_id 同时给出时 voiceRef 优先。",
        },
        model: {
          type: "string",
          enum: SUPPORTED_TTS_MODELS,
          description: "语音大模型版本，默认 speech-2.8-hd（旗舰高清）。可选快速版 speech-2.8-turbo。",
          default: DEFAULT_TTS_MODEL,
        },
        speed: {
          type: "number",
          description: "语速倍率，范围 0.5 到 2.0，默认 1.0。",
          default: 1.0,
        },
        vol: {
          type: "number",
          description: "音量大小，范围 0.1 到 10.0，默认 1.0。",
          default: 1.0,
        },
        pitch: {
          type: "number",
          description: "音调升降，范围 -12 到 12，默认 0。",
          default: 0,
        },
        format: {
          type: "string",
          enum: TTS_OUTPUT_FORMATS,
          description: "生成的音频文件格式，默认 mp3。",
          default: DEFAULT_TTS_FORMAT,
        },
        sound_effects: {
          type: "string",
          description: "可选空间音效，如 spacious_echo（空旷回声）等。",
        },
        subtitle_enable: {
          type: "boolean",
          description: "是否同时生成精确时间戳字幕（字幕随返回文本给出，不进结构化字段）。",
          default: false,
        },
      },
      required: ["text"],
    },

    async execute(args = {}) {
      const auth = await requireAuth(args, args.context);

      // `voiceRef` 按本 App 的音色表解析（voiceId 或 label）。命中用其 voiceId；
      // 未命中**报参数错误并列出表中可用 label**——不静默透传，那会把一个错字当成
      // 合法 voice_id 发给上游。不提供 voiceRef 时行为与既有一致（voice_id 路径不动）。
      let voiceId = args.voice_id || DEFAULT_VOICE_ID;
      if (typeof args.voiceRef === "string" && args.voiceRef.trim()) {
        const table = dataDir ? await loadVoices(dataDir) : { version: 1, voices: [] };
        const resolved = resolveVoiceInput(table, args.voiceRef);
        if (!resolved) {
          const labels = listVoiceLabels(table);
          const hint = labels.length
            ? `表中可用 label：${labels.join("、")}`
            : "本 App 音色表当前为空";
          throw new Error(
            `voiceRef 未命中："${args.voiceRef.trim()}"（${hint}）。可先用 scripts/ext-voice-clone.mjs 克隆一个音色。`,
          );
        }
        voiceId = resolved;
      }

      // 扩展名只由**归一化后**的格式派生（ticket 01 的 ttsFileExtension），
      // 与请求体 audio_setting.format 回显的值永远一致：拿原始入参拼扩展名会
      // 产出「容器 mp3、扩展名 .aac」的不一致产物。
      const format = normaliseTtsFormat(args.format);
      const result = await client.synthesizeSpeech({
        auth,
        text: args.text,
        model: args.model || DEFAULT_TTS_MODEL,
        voiceId,
        speed: args.speed,
        vol: args.vol,
        pitch: args.pitch,
        format,
        soundEffects: args.sound_effects,
        subtitleEnable: Boolean(args.subtitle_enable),
        outputFormat: "hex",
      });

      let filePath = null;
      let bytes = 0;
      if (result.audioBuffer) {
        const targetDir = resolveOutputDir(args.context);
        await fs.mkdir(targetDir, { recursive: true });
        const hash = crypto.randomBytes(6).toString("hex");
        const filename = `minimax-tts-${Date.now()}-${hash}${ttsFileExtension(format)}`;
        filePath = path.join(targetDir, filename);
        await fs.writeFile(filePath, result.audioBuffer);
        bytes = result.audioBuffer.length;
        await logger?.info?.(`minimax-video 语音合成已保存至：${filePath}`);
      }

      const durationSeconds = Number(((Number(result.audioLengthMs) || 0) / 1000).toFixed(2));
      const sampleRate = Number(result.sampleRate) || 0;
      const wordCount = Number(result.wordCount) || 0;

      const lines = [
        "MiniMax 语音合成成功！",
        `文件路径: ${filePath || "无本地文件"}`,
        `音频时长: ${durationSeconds} 秒`,
        `采样率: ${sampleRate} Hz`,
        `字数: ${wordCount}`,
        `格式: ${format}`,
      ];
      const subtitles = subtitleLines(result.subtitles);
      if (subtitles.length > 0) {
        lines.push("字幕时间戳：", ...subtitles);
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
        // 只放可序列化原语：原始 audioBuffer / subtitles / 错误体一律留在这里之外。
        details: {
          filePath,
          durationSeconds,
          sampleRate,
          wordCount,
          format,
          bytes,
        },
      };
    },
  };
}
