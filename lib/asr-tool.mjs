/**
 * lib/asr-tool.mjs
 *
 * 模型工具：minimax_speech_to_text
 *
 * 把本地音频（经宿主 ResourceIO）或网络音频 URL 交给 MiniMax ASR-1.0 转写，
 * 返回纯文本 / 分段时间戳 / SRT / VTT。
 *
 * 三条硬约束（review 的 blocker 与约定）：
 *   - 本地文件路径**先 stat 再读、读后复校、计入传输预算**，超 `MAX_ASR_FILE_BYTES`
 *     明确报错。此前的语音插件既无 stat 预检也无预算（该常量是死代码），一个
 *     500MB 音频会被整读进内存并 base64 内联进 multipart。
 *   - `audio_url` 路径**显式声明 `timeoutMs`（≤30000）与 `maxResponseBytes`**：
 *     宿主会先把整个响应体读进内存，且单次 RPC 硬上限 30s。
 *   - `details` 只承载**可序列化原语**，`segments` 有上限（超出截断并标注）。
 *
 * 字节提取复用视频侧的唯一实现（lib/minimax-api.mjs 的 `extractBytes`）；
 * 凭证走视频插件唯一的解析器（lib/auth.mjs）。
 */
import {
  DEFAULT_ASR_MODEL,
  DEFAULT_ASR_RESPONSE_FORMAT,
  MAX_ASR_FILE_BYTES,
  AUDIO_DOWNLOAD_TIMEOUT_MS,
  SUPPORTED_ASR_MODELS,
  ASR_RESPONSE_FORMATS,
  SUPPORTED_AUDIO_FORMATS,
} from "./speech-api.mjs";
import { PROVIDER_ID, extractBytes } from "./minimax-api.mjs";
import { createCredentialResolver } from "./auth.mjs";
import { createMinimaxSpeechClient } from "./speech-client.mjs";

/** `details.segments` 的上限：长录音的逐段时戳会撑爆同一条 32MiB RPC 通道。 */
export const MAX_DETAIL_SEGMENTS = 200;

/** 音频文件的传输上限，与 ASR 单文件门限同口径。 */
export const MAX_ASR_TOTAL_BYTES = MAX_ASR_FILE_BYTES;

function tooLargeError(label, size) {
  const error = new Error(
    `音频文件超出传输限制（单文件 ≤${Math.floor(MAX_ASR_FILE_BYTES / (1024 * 1024))}MB，${label} 为 ${(
      size / (1024 * 1024)
    ).toFixed(1)}MB）：请压缩或裁剪后再试`,
  );
  error.code = "MINIMAX_ASR_FILE_TOO_LARGE";
  return error;
}

/** 从 `resources.stat` 的各种形态里取字节数；取不到返回 null（不把 null 当 0）。 */
function statSize(stat) {
  if (stat === undefined || stat === null) return null;
  const candidates = [stat.size, stat.bytes, stat.byteLength, stat.version?.size];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** 只保留 segments 里的可序列化原语，并把列表截断到上限。 */
function boundSegments(segments) {
  if (!Array.isArray(segments)) return { segments: [], truncated: false, total: 0 };
  const total = segments.length;
  const bounded = segments.slice(0, MAX_DETAIL_SEGMENTS).map((segment) => ({
    start: Number(segment?.start) || 0,
    end: Number(segment?.end) || 0,
    ...(segment?.speaker !== undefined ? { speaker: String(segment.speaker) } : {}),
    text: String(segment?.text ?? ""),
  }));
  return { segments: bounded, truncated: total > MAX_DETAIL_SEGMENTS, total };
}

function renderSegments(segments) {
  return segments
    .map((segment) => {
      const startStr = Number(segment.start ?? 0).toFixed(2);
      const endStr = Number(segment.end ?? 0).toFixed(2);
      const speakerStr = segment.speaker !== undefined ? `[${segment.speaker}] ` : "";
      return `[${startStr}s - ${endStr}s] ${speakerStr}${segment.text || ""}`;
    })
    .join("\n");
}

export function createAsrTool({ network, bus, resources, logger } = {}) {
  if (typeof network?.fetch !== "function") {
    throw new Error(
      "minimax_speech_to_text 需要注入的 network.fetch（本工具不回退 globalThis.fetch）",
    );
  }
  const client = createMinimaxSpeechClient({ fetch: (url, init) => network.fetch(url, init) });
  const { requireAuth } = createCredentialResolver({ bus, selfProviderId: PROVIDER_ID });

  /**
   * 读取本地音频并计入传输预算：stat 预检 → 读 → 读后复校 → 计总量。
   * 与视频参考素材读取同一条规则链（视频侧私有实现不可导出，此处按同一语义实现）。
   */
  async function readLocalAudio(filePath, budget) {
    const ref = { kind: "local-file", path: filePath };
    if (typeof resources?.stat === "function") {
      try {
        const size = statSize(await resources.stat(ref));
        if (size !== null && size > MAX_ASR_FILE_BYTES) throw tooLargeError(filePath, size);
      } catch (error) {
        if (error?.code === "MINIMAX_ASR_FILE_TOO_LARGE") throw error;
        // stat 不可用或形态不识别：落到读后复校。
      }
    }
    if (typeof resources?.read !== "function") {
      throw new Error("缺少 app/resources.read 授权，无法读取本地音频文件");
    }
    const payload = await resources.read(ref);
    const bytes = extractBytes(payload);
    if (bytes.length === 0) throw new Error(`本地音频内容为空：${filePath}`);
    if (bytes.length > MAX_ASR_FILE_BYTES) throw tooLargeError(filePath, bytes.length);
    budget.total += bytes.length;
    if (budget.total > MAX_ASR_TOTAL_BYTES) throw tooLargeError(filePath, budget.total);
    return bytes;
  }

  /** 下载网络音频：显式超时与响应上限，读后复校大小。 */
  async function downloadRemoteAudio(audioUrl, budget) {
    let response;
    try {
      response = await network.fetch(audioUrl, {
        method: "GET",
        timeoutMs: AUDIO_DOWNLOAD_TIMEOUT_MS,
        maxResponseBytes: MAX_ASR_FILE_BYTES,
      });
    } catch (error) {
      throw new Error(`拉取网络音频文件失败 (${audioUrl})：${error?.message || error}`);
    }
    if (!response?.ok) {
      throw new Error(`下载网络音频失败: HTTP ${response?.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`网络音频内容为空：${audioUrl}`);
    if (bytes.length > MAX_ASR_FILE_BYTES) throw tooLargeError(audioUrl, bytes.length);
    budget.total += bytes.length;
    if (budget.total > MAX_ASR_TOTAL_BYTES) throw tooLargeError(audioUrl, budget.total);
    return bytes;
  }

  return {
    name: "minimax_speech_to_text",
    description:
      `使用 MiniMax 语音识别模型 (ASR-1.0) 转录音频文件。支持本地音频路径（经宿主资源通道读取，单文件 ≤${Math.floor(
        MAX_ASR_FILE_BYTES / (1024 * 1024),
      )}MB）或网络音频 URL，可输出纯文本、分段时间戳列表或 SRT/VTT 字幕。支持的音频格式：${SUPPORTED_AUDIO_FORMATS.join(
        ", ",
      )}。`,
    parameters: {
      type: "object",
      properties: {
        audio_path: {
          type: "string",
          description: `本地音频文件路径（支持 ${SUPPORTED_AUDIO_FORMATS.join(
            ", ",
          )} 等格式）。与 audio_url 二选一。`,
        },
        audio_url: {
          type: "string",
          description:
            "可访问的音频文件 URL（须在 manifest allowedHosts 放行的域内）。与 audio_path 二选一。",
        },
        response_format: {
          type: "string",
          enum: ASR_RESPONSE_FORMATS,
          description:
            "输出结果格式：json（仅识别文本与总时长）、verbose_json（含各分段时间戳与角色段落）、srt（SRT 字幕）、vtt（VTT 字幕）。默认 json。",
          default: DEFAULT_ASR_RESPONSE_FORMAT,
        },
        model: {
          type: "string",
          enum: SUPPORTED_ASR_MODELS,
          description: "ASR 模型，默认 asr-1.0。",
          default: DEFAULT_ASR_MODEL,
        },
      },
    },

    async execute(args = {}) {
      const auth = await requireAuth(args, args.context);

      const budget = { total: 0 };
      let audioBuffer = null;
      let fileName = "input.m4a";

      if (args.audio_path) {
        const filePath = String(args.audio_path).trim();
        fileName = filePath.split(/[\\/]/).pop() || fileName;
        audioBuffer = await readLocalAudio(filePath, budget);
      } else if (args.audio_url) {
        const audioUrl = String(args.audio_url).trim();
        try {
          fileName = decodeURIComponent(new URL(audioUrl).pathname.split("/").pop() || "") || fileName;
        } catch {
          fileName = "downloaded.m4a";
        }
        audioBuffer = await downloadRemoteAudio(audioUrl, budget);
      } else {
        throw new Error("必须提供 audio_path 或 audio_url 其中之一");
      }

      const result = await client.transcribeSpeech({
        auth,
        audioBuffer,
        fileName,
        model: args.model || DEFAULT_ASR_MODEL,
        responseFormat: args.response_format || DEFAULT_ASR_RESPONSE_FORMAT,
      });

      await logger?.info?.(`minimax-video 语音识别完成：${fileName}（${budget.total} 字节）`);

      if (result.subtitleContent !== undefined) {
        return {
          content: [{ type: "text", text: result.subtitleContent }],
          details: {
            format: result.format,
            text: result.subtitleContent,
            bytes: budget.total,
          },
        };
      }

      const { segments, truncated, total } = boundSegments(result.segments);
      const duration = Number(result.duration) || 0;

      let displayText;
      if (segments.length > 0) {
        displayText = `【全文转写】\n${result.text || ""}\n\n【逐段切片】\n${renderSegments(segments)}`;
        if (truncated) {
          displayText += `\n…（共 ${total} 段，仅展示前 ${MAX_DETAIL_SEGMENTS} 段）`;
        }
      } else {
        displayText = result.text || "（未识别到有效语音文本）";
        if (duration) displayText = `【音频时长】${duration.toFixed(2)} 秒\n【转写内容】\n${displayText}`;
      }

      return {
        content: [{ type: "text", text: displayText }],
        // 只有可序列化原语：segments 已截断，绝不回传原始响应体。
        details: {
          text: result.text || "",
          duration,
          segmentCount: total,
          segments,
          segmentsTruncated: truncated,
          bytes: budget.total,
        },
      };
    },
  };
}
