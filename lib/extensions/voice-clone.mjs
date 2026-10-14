/**
 * lib/extensions/voice-clone.mjs
 *
 * 隐藏扩展：把一段样本音克隆成可复用音色，并登记进本 App 的音色表。
 *
 * 刻意**不** `ctx.tools.register`——它不是模型工具，只经 `scripts/ext-voice-clone.mjs`
 * 暴露（CLI 是唯一出口）。因此本模块不做宿主 `ctx.*` 交互，只接受注入的 `fetch` 与
 * `dataDir`，可完全离线单测。
 *
 * 链路：本地校验样本 → 上传（purpose `voice_clone`）取 `file_id` →
 * `POST /v1/voice_clone`（`file_id` + `voice_id`）→ 登记 `{dataDir}/voices.json`。
 *
 * 样本约束（本地先校验，不满足绝不联网）：格式 mp3 / m4a / wav、时长 10 秒–5 分钟、
 * ≤20MB。时长从容器头读取，不依赖任何外部解码器。
 */
import { uploadFile } from "../files-client.mjs";
import { API_BASE_URL } from "../minimax/constants.mjs";
import { registerVoice } from "../voice-registry.mjs";
import { assertBaseRespOk, scrub, withAuth } from "../http-util.mjs";

export const VOICE_CLONE_PATH = "/v1/voice_clone";

/** 宿主单次出站请求的硬上限（毫秒）；克隆是短请求，明确落在上限内。 */
export const VOICE_CLONE_TIMEOUT_MS = 30000;

export const SAMPLE_FORMATS = {
  mp3: { mimeType: "audio/mpeg", extensions: [".mp3"] },
  m4a: { mimeType: "audio/mp4", extensions: [".m4a", ".mp4"] },
  wav: { mimeType: "audio/wav", extensions: [".wav"] },
};

export const SAMPLE_MIN_MS = 10_000;
export const SAMPLE_MAX_MS = 5 * 60 * 1000;
export const SAMPLE_MAX_BYTES = 20 * 1024 * 1024;

/** 由文件名扩展名识别格式；不认识即 null。 */
export function detectSampleFormat(fileName) {
  const lower = String(fileName ?? "").trim().toLowerCase();
  for (const [format, spec] of Object.entries(SAMPLE_FORMATS)) {
    if (spec.extensions.some((ext) => lower.endsWith(ext))) return format;
  }
  return null;
}

/** 从 44 字节 PCM WAV 头读时长（毫秒）；头不合法返回 null。 */
function wavDurationMs(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      byteRate = buffer.readUInt32LE(offset + 8 + 8);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

/** 从 MPEG 帧头读时长（毫秒，CBR 近似）；头不合法返回 null。 */
function mp3DurationMs(buffer) {
  const BITRATES = {
    0b0001: 32, 0b0010: 40, 0b0011: 48, 0b0100: 56, 0b0101: 64, 0b0110: 80,
    0b0111: 96, 0b1000: 112, 0b1001: 128, 0b1010: 160, 0b1011: 192, 0b1100: 224,
    0b1101: 256, 0b1110: 320,
  };
  const RATES = { 0: 44100, 1: 48000, 2: 32000 };
  // 允许 ID3v2 头：跳过其标注的字节数再找帧同步。
  let start = 0;
  if (buffer.length > 10 && buffer.toString("ascii", 0, 3) === "ID3") {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    start = 10 + size;
  }
  while (start + 4 <= buffer.length) {
    if (buffer[start] === 0xff && (buffer[start + 1] & 0xe0) === 0xe0) {
      const versionBits = (buffer[start + 1] >> 3) & 0x03;
      if (versionBits === 0b01) {
        start += 1; // reserved version, keep scanning
        continue;
      }
      const layerBits = (buffer[start + 1] >> 1) & 0x03;
      if (layerBits === 0) {
        start += 1;
        continue;
      }
      const bitrateIndex = (buffer[start + 2] >> 4) & 0x0f;
      const sampleRateIndex = (buffer[start + 2] >> 2) & 0x03;
      const kbps = BITRATES[bitrateIndex];
      const sampleRate = RATES[sampleRateIndex];
      if (!kbps || !sampleRate) {
        start += 1;
        continue;
      }
      const audioBytes = buffer.length - start;
      return Math.round((audioBytes * 8) / (kbps * 1000) * 1000);
    }
    start += 1;
  }
  return null;
}

/** 从 MP4/M4A 的 moov/mvhd 读时长（毫秒）；结构不符返回 null。 */
function m4aDurationMs(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (size < 8) return null;
    if (type === "moov") {
      let inner = offset + 8;
      const end = Math.min(offset + size, buffer.length);
      while (inner + 8 <= end) {
        const innerSize = buffer.readUInt32BE(inner);
        const innerType = buffer.toString("ascii", inner + 4, inner + 8);
        if (innerType === "mvhd") {
          const version = buffer[inner + 8];
          let timescale;
          let duration;
          if (version === 1) {
            timescale = buffer.readUInt32BE(inner + 8 + 4 + 8 + 8);
            duration = Number(buffer.readBigUInt64BE(inner + 8 + 4 + 8 + 8 + 4));
          } else {
            timescale = buffer.readUInt32BE(inner + 8 + 4 + 8);
            duration = buffer.readUInt32BE(inner + 8 + 4 + 8 + 4);
          }
          if (!timescale) return null;
          return Math.round((duration / timescale) * 1000);
        }
        if (innerSize < 8) break;
        inner += innerSize;
      }
      return null;
    }
    offset += size;
  }
  return null;
}

/** 按格式从容器头测量时长（毫秒）；无法测量返回 null。 */
export function measureAudioDurationMs(bytes, format) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  switch (format) {
    case "wav":
      return wavDurationMs(buffer);
    case "mp3":
      return mp3DurationMs(buffer);
    case "m4a":
      return m4aDurationMs(buffer);
    default:
      return null;
  }
}

/**
 * 本地校验样本。不通过即抛错（在联网之前）；通过则回带格式 / MIME / 时长 / 字节数。
 *
 * @returns {{format: string, mimeType: string, durationMs: number, bytes: number}}
 */
export function validateSample({ fileName, bytes } = {}) {
  const format = detectSampleFormat(fileName);
  if (!format) {
    throw new Error(
      `样本格式不受支持：${fileName ?? "(未命名)"}。仅支持 ${Object.keys(SAMPLE_FORMATS).join(" / ")}`,
    );
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length === 0) {
    throw new Error("样本文件为空");
  }
  if (buffer.length > SAMPLE_MAX_BYTES) {
    throw new Error(`样本大小超过上限（${buffer.length} > ${SAMPLE_MAX_BYTES} 字节，20MB）`);
  }

  const durationMs = measureAudioDurationMs(buffer, format);
  if (durationMs === null) {
    throw new Error(`无法从样本容器头读出时长（${fileName}），请提供有效的 ${format} 文件`);
  }
  if (durationMs < SAMPLE_MIN_MS) {
    throw new Error(`样本时长过短（${(durationMs / 1000).toFixed(1)}s < 10s）`);
  }
  if (durationMs > SAMPLE_MAX_MS) {
    throw new Error(`样本时长过长（${(durationMs / 1000).toFixed(1)}s > 5 分钟）`);
  }

  return { format, mimeType: SAMPLE_FORMATS[format].mimeType, durationMs, bytes: buffer.length };
}

/* ---------------------------------------------------------------- *
 * 网络信封
 * ---------------------------------------------------------------- */

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** HTTP 非 2xx 的错误（信封可选）；业务信封的判定统一走 assertBaseRespOk。 */
function formatHttpError(label, json, status) {
  const msg =
    json?.base_resp?.status_msg || json?.error?.message || json?.message || "未知状态错误";
  const err = new Error(scrub(`${label} (${status}): ${msg}`));
  err.status = status;
  return err;
}

/**
 * 创建隐藏的声音克隆扩展。
 *
 * @param {object} input
 * @param {Function} input.fetch      注入的 fetch（脚本传 globalThis.fetch）
 * @param {string}   input.dataDir    音色表落点（**只写这里**）
 * @param {string}   [input.baseUrl]  API 基址（默认 api.minimax.cn）
 */
export function createVoiceCloneExtension({ fetch: fetchImpl, dataDir, baseUrl = API_BASE_URL } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("声音克隆扩展需要一个注入的 fetch 实现（不会回退 globalThis.fetch）");
  }
  if (!dataDir) {
    throw new Error("声音克隆扩展需要 dataDir（音色表只写 dataDir，绝不写安装目录）");
  }

  /**
   * 克隆一段样本音并登记音色表。
   *
   * @returns {Promise<{voice: {voiceId: string, label: string, createdAt: string}, fileId: string}>}
   */
  async function cloneVoice({ auth, bytes, fileName, voiceId, label } = {}) {
    const validated = validateSample({ fileName, bytes });

    const uploaded = await uploadFile({
      fetch: fetchImpl,
      auth,
      purpose: "voice_clone",
      bytes,
      fileName,
      mimeType: validated.mimeType,
      timeoutMs: VOICE_CLONE_TIMEOUT_MS,
      baseUrl,
    });

    const resolvedVoiceId =
      (typeof voiceId === "string" && voiceId.trim()) || deriveVoiceId(uploaded.fileId);

    const response = await fetchImpl(`${baseUrl}${VOICE_CLONE_PATH}`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ file_id: uploaded.fileId, voice_id: resolvedVoiceId }),
      timeoutMs: VOICE_CLONE_TIMEOUT_MS,
      maxResponseBytes: 1024 * 1024,
    });

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw formatHttpError("声音克隆失败", parseJson(text), response.status);
    }
    // 信封语义单源：HTTP 2xx 且 base_resp.status_code === 0 才算成功；
    // status_code 缺失视为失败（MiniMax 成功响应总带 base_resp）。
    const json = assertBaseRespOk(parseJson(text), { label: "声音克隆失败" });

    const returnedId =
      (typeof json.voice_id === "string" && json.voice_id.trim()) || resolvedVoiceId;

    const stored = await registerVoice(dataDir, {
      voiceId: returnedId,
      label: (typeof label === "string" && label.trim()) || returnedId,
      sample: { fileName, bytes: validated.bytes, fileId: uploaded.fileId },
    });

    return { voice: { voiceId: stored.voiceId, label: stored.label, createdAt: stored.createdAt }, fileId: uploaded.fileId };
  }

  return { cloneVoice };
}

/** 无显式 voiceId 时由 file_id 派生一个稳定 id（去掉非法字符，加前缀）。 */
function deriveVoiceId(fileId) {
  const safe = String(fileId ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
  return `clone-${safe || Date.now().toString(36)}`;
}
