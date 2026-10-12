/**
 * lib/minimax-api.mjs
 *
 * Pure helpers for the MiniMax H3 video provider: the static model table, the
 * published capability snapshot, request-body assembly and parameter parsing.
 *
 * Nothing in this file touches host APIs (`ctx.*`) or the network, and every
 * reference-file read goes through an injected `readReference` / `statReference`
 * callback — so the whole module is unit-testable with `node --test` and no key.
 */
import crypto from "node:crypto";
import { FALLBACK_PROVIDER_ID } from "./auth.mjs";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_ID,
  POPULAR_VOICE_PRESETS,
} from "./speech-api.mjs";

export const PROVIDER_ID = "minimax-video";
export const PROTOCOL_ID = "minimax-video-videos";
/** The protocol id the host speech channel routes to the speech adapter. */
export const SPEECH_PROTOCOL_ID = "minimax-speech-tts";
export const PROVIDER_VERSION = "0.3.1";
export { FALLBACK_PROVIDER_ID };

/**
 * Credential lanes published with the runtime capability snapshot.
 *
 * This app keeps no credential of its own: the MiniMax Token Plan provider is
 * the sole lane. Lanes can only be declared here — a static manifest
 * contribution may not carry `credentialLanes`.
 */
export const CREDENTIAL_LANES = [
  { id: FALLBACK_PROVIDER_ID, providerId: FALLBACK_PROVIDER_ID, label: "MiniMax Token Plan" },
];

export const API_BASE_URL = "https://api.minimax.cn";
export const CREATE_PATH = "/v2/video_generation";
/** 2K re-generation lives on its own endpoint; querying reuses the video path. */
export const REGENERATION_PATH = "/v2/video_regeneration";
export const QUERY_PATH_PREFIX = "/v2/query/video_generation/";

/**
 * Transport budget. `network.fetch` bodies are JSON-RPC-encoded (base64 of the
 * request, then base64 again inside the RPC envelope: ~1.78x), against the
 * host's 32 MiB per-message cap. A data URL adds another 1.33x, so 16 MiB of
 * raw reference bytes is the safe ceiling for a whole request; 12 MiB for a
 * single file keeps one `resources.read` reply under the same cap.
 */
export const MAX_REFERENCE_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024;
/** The API refuses a request body over 64 MB; stay under it. */
export const MAX_REQUEST_BODY_BYTES = 60 * 1024 * 1024;

/**
 * 上传路径的单文件上限。与内联路径的 MAX_REFERENCE_FILE_BYTES（12MB）不是同一个口径：
 * 上传的请求体是整段 base64 进单条 RPC 信封，宿主上限 32 MiB，base64 占 1.33x，
 * 故原始字节的硬天花板约 24 MiB；取 20 MiB 留余量。
 * 这是**信封**约束，不是 MiniMax API 自身的限制（API 对 video_generation_input
 * 的图/视频/音频分别允许 30/50/15MB，但那些在单条 RPC 信封下根本到不了）。
 */
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;

export const RATIOS_FULL = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
export const RATIOS_NO_ADAPTIVE = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export const DEFAULT_MODEL_ID = "MiniMax-H3";
export const DEFAULT_DURATION = 5;
export const DEFAULT_RESOLUTION = "768P";
export const T2V_DEFAULT_RATIO = "16:9";

/**
 * The five generation modes both models share. Regeneration is model-specific
 * (only MiniMax-H3 outputs 2K), so each model carries its own `modeIds` list
 * and the capability snapshot no longer reuses one global mode list.
 */
const GENERATION_MODE_IDS = [
  "text2video",
  "image2video",
  "last_frame2video",
  "frames2video",
  "multimodal2video",
];

const MODE_LABELS = {
  text2video: "文生视频",
  image2video: "图生视频",
  last_frame2video: "尾帧生视频",
  frames2video: "首尾帧生视频",
  multimodal2video: "多模态参考",
  regeneration: "2K 再生成",
};

/**
 * Chinese display labels for the media parameters.
 *
 * The host's media settings modal renders each `parameterSchema.properties[key]`
 * as a control whose label is `property.title || key`; without a `title` the
 * raw key (`duration` / `ratio` / `video_resolution`) is shown. Enum option
 * values keep their literal text (`768P`, `16:9`), which is what we want here.
 */
export const PARAM_LABELS = {
  duration: "生成视频时长（秒）",
  ratio: "宽高比",
  video_resolution: "分辨率",
  source_task_id: "源任务 ID",
  aigc_watermark: "AIGC 水印",
};

/** Reference-input ceilings shared by the multimodal and regeneration modes. */
const MULTIMODAL_REFERENCE_LIMITS = {
  referenceImages: { min: 0, max: 9 },
  referenceVideos: { min: 0, max: 3 },
  referenceAudios: { min: 0, max: 3 },
};

const MODE_INPUT_LIMITS = {
  text2video: { referenceImages: { min: 0, max: 0 } },
  image2video: { referenceImages: { min: 1, max: 1 } },
  last_frame2video: { referenceImages: { min: 1, max: 1 } },
  frames2video: { referenceImages: { min: 2, max: 2 } },
  multimodal2video: MULTIMODAL_REFERENCE_LIMITS,
  // Regeneration republishes the source task's assets (base_video path), so it
  // carries the same reference ceilings as multimodal 2 video.
  regeneration: MULTIMODAL_REFERENCE_LIMITS,
};

/** Static per-model facts (the API's own documented matrix). */
export const MODEL_SPECS = {
  "MiniMax-H3": {
    id: "MiniMax-H3",
    displayName: "MiniMax H3",
    resolutions: ["768P", "2K"],
    duration: { min: 4, max: 15 },
    modeIds: [...GENERATION_MODE_IDS, "regeneration"],
  },
  "MiniMax-H3-Max": {
    id: "MiniMax-H3-Max",
    displayName: "MiniMax H3 Max",
    resolutions: ["480P", "768P"],
    duration: { min: 5, max: 15 },
    modeIds: [...GENERATION_MODE_IDS],
  },
};

export const MODEL_IDS = Object.keys(MODEL_SPECS);

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/** Error codes that callers may branch on. */
export const ERROR_CODES = {
  referenceTooLarge: "MINIMAX_REFERENCE_TOO_LARGE",
  referenceTotalTooLarge: "MINIMAX_REFERENCE_TOTAL_TOO_LARGE",
  bodyTooLarge: "MINIMAX_REQUEST_BODY_TOO_LARGE",
  unknownMime: "MINIMAX_UNKNOWN_MIME",
  unknownShape: "MINIMAX_UNKNOWN_RESOURCE_SHAPE",
};

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/* ------------------------------------------------------------------ *
 * Model table + capability snapshot
 * ------------------------------------------------------------------ */

/**
 * The `regeneration` mode: the source task fixes duration and ratio, so its
 * schema only offers the 2K resolution switch and the opt-in watermark. The
 * source_task_id key must be declared here or the host drops it while filtering
 * `options` against this schema.
 */
function buildRegenerationMode() {
  return {
    id: "regeneration",
    label: MODE_LABELS.regeneration,
    parameterSchema: {
      type: "object",
      properties: {
        source_task_id: {
          type: "string",
          title: PARAM_LABELS.source_task_id,
        },
        video_resolution: {
          type: "string",
          title: PARAM_LABELS.video_resolution,
          enum: ["2K"],
          default: "2K",
        },
        aigc_watermark: {
          type: "boolean",
          title: PARAM_LABELS.aigc_watermark,
          default: false,
        },
      },
    },
    defaults: {
      video_resolution: "2K",
      aigc_watermark: false,
    },
    inputLimits: MODE_INPUT_LIMITS.regeneration,
  };
}

function buildMode(modelSpec, modeId) {
  if (modeId === "regeneration") return buildRegenerationMode();
  const durationSchema = {
    type: "integer",
    title: PARAM_LABELS.duration,
    minimum: modelSpec.duration.min,
    maximum: modelSpec.duration.max,
    default: DEFAULT_DURATION,
  };
  const isText = modeId === "text2video";
  const ratioEnum = isText ? RATIOS_NO_ADAPTIVE : RATIOS_FULL;
  const ratioDefault = isText ? T2V_DEFAULT_RATIO : "adaptive";
  return {
    id: modeId,
    label: MODE_LABELS[modeId],
    parameterSchema: {
      type: "object",
      properties: {
        duration: durationSchema,
        ratio: {
          type: "string",
          title: PARAM_LABELS.ratio,
          enum: ratioEnum,
          default: ratioDefault,
        },
        video_resolution: {
          type: "string",
          title: PARAM_LABELS.video_resolution,
          enum: modelSpec.resolutions,
          default: DEFAULT_RESOLUTION,
        },
      },
    },
    defaults: {
      duration: DEFAULT_DURATION,
      ratio: ratioDefault,
      video_resolution: DEFAULT_RESOLUTION,
    },
    inputLimits: MODE_INPUT_LIMITS[modeId],
  };
}

/** One runtime capability-source model entry (shape matches the host's video models). */
export function buildModelEntry(modelSpec) {
  return {
    id: modelSpec.id,
    displayName: modelSpec.displayName,
    protocolId: PROTOCOL_ID,
    inputs: ["text", "image", "video", "audio"],
    outputs: ["video"],
    supportsAsync: true,
    modes: modelSpec.modeIds.map((modeId) => buildMode(modelSpec, modeId)),
    ratios: RATIOS_FULL,
    resolutions: [...modelSpec.resolutions],
    duration: { min: modelSpec.duration.min, max: modelSpec.duration.max },
  };
}

/* ------------------------------------------------------------------ *
 * Speech models (the host speech channel)
 * ------------------------------------------------------------------ */

/**
 * The audio formats the HOST's speech channel knows — and therefore the only
 * ones this app may publish or accept through it.
 *
 * The host constant is `["mp3","wav","pcm","ogg_opus"]` and does NOT include
 * `flac`: a `flac` value would be rejected by the host at call time
 * (`speech format "flac" is not a known audio format`). `flac` therefore stays
 * on the model-tool (`minimax_text_to_speech`) direct path only, and the
 * adapter REJECTS it outright rather than silently downgrading to mp3.
 */
export const SPEECH_FORMATS = ["mp3", "wav", "pcm"];
export const SPEECH_SPEED_MIN = 0.5;
export const SPEECH_SPEED_MAX = 2;

/** Human-facing labels for the speech model's mode parameters. */
export const SPEECH_PARAM_LABELS = {
  voice: "音色",
  speed: "语速",
  format: "音频格式",
};

/** The speech models published through the runtime capability source. */
export const SPEECH_MODEL_IDS = ["speech-2.8-hd", "speech-2.8-turbo"];

const SPEECH_MODEL_DISPLAY_NAMES = {
  "speech-2.8-hd": "Speech 2.8 HD",
  "speech-2.8-turbo": "Speech 2.8 Turbo",
};

/** The preset voices published for one speech model (id + label, host shape). */
function buildSpeechVoices() {
  return POPULAR_VOICE_PRESETS.map((preset) => ({
    id: preset.id,
    displayName: preset.name,
    description: preset.description,
  }));
}

/** The single `text2speech` mode shared by every speech model. */
function buildSpeechMode() {
  return {
    id: "text2speech",
    label: "文字转语音",
    parameterSchema: {
      type: "object",
      properties: {
        voice: {
          type: "string",
          title: SPEECH_PARAM_LABELS.voice,
          default: DEFAULT_VOICE_ID,
        },
        speed: {
          type: "number",
          title: SPEECH_PARAM_LABELS.speed,
          minimum: SPEECH_SPEED_MIN,
          maximum: SPEECH_SPEED_MAX,
          default: 1,
        },
        format: {
          type: "string",
          title: SPEECH_PARAM_LABELS.format,
          enum: [...SPEECH_FORMATS],
          default: "mp3",
        },
      },
    },
    defaults: {
      voice: DEFAULT_VOICE_ID,
      speed: 1,
      format: "mp3",
    },
  };
}

/** One speech model entry published in `media.speechGeneration.models`. */
export function buildSpeechModelEntry(modelId) {
  return {
    id: modelId,
    displayName: SPEECH_MODEL_DISPLAY_NAMES[modelId] || modelId,
    protocolId: SPEECH_PROTOCOL_ID,
    inputs: ["text"],
    outputs: ["audio"],
    defaultVoiceId: DEFAULT_VOICE_ID,
    voices: buildSpeechVoices(),
    modes: [buildSpeechMode()],
  };
}

/** The full `{ providerId, media, version }` snapshot `refresh` returns. */
export function buildCapabilitySnapshot() {
  return {
    providerId: PROVIDER_ID,
    media: {
      videoGeneration: {
        defaultModelId: DEFAULT_MODEL_ID,
        credentialLanes: CREDENTIAL_LANES.map((lane) => ({ ...lane })),
        models: MODEL_IDS.map((id) => buildModelEntry(MODEL_SPECS[id])),
      },
      speechGeneration: {
        defaultModelId: DEFAULT_TTS_MODEL,
        credentialLanes: CREDENTIAL_LANES.map((lane) => ({ ...lane })),
        models: SPEECH_MODEL_IDS.map((id) => buildSpeechModelEntry(id)),
      },
    },
    version: PROVIDER_VERSION,
  };
}

/** The hint shown on the panel when the borrowed provider has no usable key. */
export const TOKEN_PLAN_HINT =
  "未在 设置 → 供应商 中配置可用的 MiniMax Token Plan 供应商";

/**
 * Throw this from a capability-source `refresh()` when the borrowed provider has
 * no usable key: the host catches it and reports the provider as not ready with
 * exactly this code and message (`unavailableReason` / `unavailableMessage`).
 *
 * Throwing is the ONLY transport: the host stores just `media`/`version`/
 * `fingerprint` from a successful refresh and hard-codes `status: "ready"`,
 * so extra fields on the return value never reach the panel.
 *
 * @param {object} [detail]
 * @param {string} [detail.reason]   host-facing code (e.g. "no_credentials")
 * @param {string} [detail.message]  human-facing hint
 * @returns {never}
 */
export function throwLaneUnavailable({
  reason = "no_credentials",
  message = TOKEN_PLAN_HINT,
} = {}) {
  const error = new Error(message);
  error.code = reason;
  throw error;
}

/* ------------------------------------------------------------------ *
 * Parameter normalisation
 * ------------------------------------------------------------------ */

/** `referenceImages > images > image`, then audio, then video (the jimeng precedence). */
export function filesFromParams(params, keys) {
  for (const key of keys) {
    const input = params?.[key];
    if (input === undefined || input === null || input === "") continue;
    const list = (Array.isArray(input) ? input : [input])
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
    return list;
  }
  return [];
}

export function imagesFromParams(params = {}) {
  return filesFromParams(params, ["referenceImages", "images", "image"]);
}

export function audiosFromParams(params = {}) {
  return filesFromParams(params, ["referenceAudios", "audios", "audio"]);
}

export function videosFromParams(params = {}) {
  return filesFromParams(params, ["referenceVideos", "videos", "video"]);
}

/** Infer the mode from the reference payload when the caller did not name one. */
export function inferMode(params = {}) {
  const images = imagesFromParams(params);
  const videos = videosFromParams(params);
  const audios = audiosFromParams(params);
  if (audios.length > 0 || videos.length > 0 || images.length > 1) return "multimodal2video";
  if (images.length === 1) return "image2video";
  return "text2video";
}

/** Reject a mode the given model does not carry (per-model mode lists). */
function assertModeSupported(modelSpec, mode) {
  if (!modelSpec.modeIds.includes(mode)) {
    throw fail(
      `模型 "${modelSpec.id}" 不支持模式 "${mode}"；可选：${modelSpec.modeIds.join(", ")}`,
    );
  }
}

export function resolveMode(params = {}, modelSpec = MODEL_SPECS[DEFAULT_MODEL_ID]) {
  const explicit = typeof params?.mode === "string" ? params.mode.trim() : "";
  // Regeneration is identified two ways (either signal suffices): the explicit
  // mode, or a source_task_id riding the params — the direct-call path, where
  // the caller does not name a mode.
  const mode =
    explicit === "regeneration" || hasSourceTaskId(params)
      ? "regeneration"
      : explicit || inferMode(params);
  assertModeSupported(modelSpec, mode);
  return mode;
}

/** True when the caller passed a usable `source_task_id` (the 2K source task). */
function hasSourceTaskId(params = {}) {
  const value = params?.source_task_id;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function resolveModelSpec(params = {}) {
  const raw = String(params?.modelId ?? params?.model ?? "").trim();
  if (!raw) return MODEL_SPECS[DEFAULT_MODEL_ID];
  const spec = MODEL_SPECS[raw];
  if (!spec) {
    throw fail(`MiniMax 视频模型 "${raw}" 不受支持；可选：${MODEL_IDS.join(", ")}`);
  }
  return spec;
}

export function resolveResolution(params = {}, modelSpec) {
  const raw = String(params?.video_resolution ?? params?.resolution ?? "").trim();
  const value = raw || DEFAULT_RESOLUTION;
  if (!modelSpec.resolutions.includes(value)) {
    throw fail(
      `模型 "${modelSpec.id}" 不支持分辨率 "${value}"；支持：${modelSpec.resolutions.join(", ")}`,
    );
  }
  return value;
}

export function resolveDuration(params = {}, modelSpec) {
  const raw = params?.duration ?? params?.seconds;
  const value = raw === undefined || raw === null || raw === "" ? DEFAULT_DURATION : Number(raw);
  if (!Number.isInteger(value)) {
    throw fail(`视频时长 "${raw}" 必须是整数秒`);
  }
  const { min, max } = modelSpec.duration;
  if (value < min || value > max) {
    throw fail(`模型 "${modelSpec.id}" 的时长需在 ${min}-${max} 秒之间（收到 ${value}）`);
  }
  return value;
}

export function resolveRatio(params = {}, mode) {
  const raw = typeof params?.ratio === "string" ? params.ratio.trim() : "";
  if (mode === "text2video") {
    const value = raw || T2V_DEFAULT_RATIO;
    if (value === "adaptive") throw fail("文生视频不支持 adaptive 比例");
    if (!RATIOS_NO_ADAPTIVE.includes(value)) {
      throw fail(`文生视频不支持比例 "${value}"；支持：${RATIOS_NO_ADAPTIVE.join(", ")}`);
    }
    return value;
  }
  if (mode === "multimodal2video") {
    const value = raw || "adaptive";
    if (!RATIOS_FULL.includes(value)) {
      throw fail(`多模态参考不支持比例 "${value}"；支持：${RATIOS_FULL.join(", ")}`);
    }
    return value;
  }
  // image2video / last_frame2video / frames2video: the API always treats the
  // input image as the authority, so `ratio` is pinned to adaptive.
  return "adaptive";
}

/* ------------------------------------------------------------------ *
 * Reference bytes → data URL
 * ------------------------------------------------------------------ */

/** Tolerant byte extraction across every shape a `resources.read` reply may take. */
export function extractBytes(value) {
  if (value === undefined || value === null) {
    throw fail("参考文件读取结果为空（null/undefined）", ERROR_CODES.unknownShape);
  }
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return decodeStringBytes(value);
  }
  if (typeof value === "object") {
    if (value.$bytes !== undefined && value.$bytes !== null) {
      const inner = value.$bytes;
      if (typeof inner === "string") return decodeStringBytes(inner);
      return extractBytes(inner);
    }
    if (value.type === "Buffer" && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    if (Array.isArray(value.data)) return Buffer.from(value.data);
    if (value.bytes !== undefined) return extractBytes(value.bytes);
    if (value.buffer !== undefined) return extractBytes(value.buffer);
    if (value.content !== undefined) return extractBytes(value.content);
  }
  const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 12) : [];
  throw fail(
    `无法从参考文件读取结果中提取字节（顶层键：${keys.length ? keys.join(", ") : "无"}）`,
    ERROR_CODES.unknownShape,
  );
}

function decodeStringBytes(text) {
  const trimmed = text.trim();
  if (trimmed.length > 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length % 4 === 0) {
    return Buffer.from(trimmed, "base64");
  }
  return Buffer.from(text, "utf8");
}

export function mimeForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  const mime = MIME_BY_EXTENSION[ext];
  if (!mime) {
    throw fail(
      `不支持的参考文件类型 "${ext || "(无扩展名)"}"；支持：${Object.keys(MIME_BY_EXTENSION).join(", ")}`,
      ERROR_CODES.unknownMime,
    );
  }
  return mime;
}

function statSize(stat) {
  if (stat === undefined || stat === null) return null;
  // `version.size` is where the host's ResourceIO stat puts the byte count;
  // the top-level candidates cover older / simpler shapes. Null-ish values
  // mean "unknown" and must not be read as 0 (Number(null) === 0).
  const candidates = [stat.size, stat.bytes, stat.byteLength, stat.version?.size];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function referenceTooLarge() {
  return fail(
    `参考素材超出传输限制（单文件 ≤${Math.floor(MAX_REFERENCE_FILE_BYTES / (1024 * 1024))}MB、总量 ≤${Math.floor(MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024))}MB），请压缩后再试`,
    ERROR_CODES.referenceTooLarge,
  );
}

function referenceTotalTooLarge() {
  return fail(
    `参考素材超出传输限制（单文件 ≤${Math.floor(MAX_REFERENCE_FILE_BYTES / (1024 * 1024))}MB、总量 ≤${Math.floor(MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024))}MB），请压缩后再试`,
    ERROR_CODES.referenceTotalTooLarge,
  );
}

/** The bare file name of a local reference path (handles both `/` and `\`). */
function baseName(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * The existing inline path: one local reference → a `data:` URL, charged to the
 * shared ≤12MB/≤16MB transport budget. This is the fallback whenever upload is
 * unavailable or refused.
 */
async function toBase64DataUrl(localPath, label, deps) {
  const { readReference, statReference, budget } = deps;
  if (typeof localPath !== "string" || !localPath.trim()) {
    throw fail(`参考${label}路径无效`);
  }
  const filePath = localPath.trim();
  const { bytes } = await readBytesWithinBudget({
    ref: filePath,
    label,
    position: `：${filePath}`,
    readReference,
    statReference,
    budget,
  });
  return `data:${mimeForPath(filePath)};base64,${bytes.toString("base64")}`;
}

/** Read one reference's bytes for upload — no inline budget charge (see below). */
async function readBytesForUpload(filePath, label, { readReference }) {
  if (typeof readReference !== "function") {
    throw fail("参考文件读取通道不可用（缺少 app/resources.read 授权）");
  }
  const payload = await readReference(filePath);
  const bytes = extractBytes(payload);
  if (bytes.length === 0) throw fail(`参考${label}内容为空：${filePath}`);
  if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
    throw fail(
      `参考${label}上传超出单文件上限（${bytes.length} > ${MAX_UPLOAD_FILE_BYTES} 字节，20MB）：${filePath}`,
    );
  }
  return bytes;
}

/** One `logger.warn` on an upload fallback; logging never fails the request. */
async function warnUploadFallback(logger, label, error) {
  const reason = error?.message || String(error);
  try {
    await logger?.warn?.(`minimax-video 参考${label}上传失败，回落 base64 内联：${reason}`);
  } catch {
    // A broken logger must not turn a recoverable upload miss into a hard error.
  }
}

/**
 * Resolve one local reference into the URL that rides in content[].
 *
 * Upload-first: when an `upload` dependency is injected and it yields a
 * `fileId`, the material is referenced by `mm_file://{fileId}` and its bytes
 * never enter the request body — so they do NOT count against the ≤12MB/≤16MB
 * inline transport budget. Any failure (upload missing, throwing, or returning
 * no `fileId`) falls back to the existing base64 data URL path (still
 * budget-checked) and records exactly one `logger.warn`; it never fails the
 * request. With no `upload` injected, behaviour is byte-for-byte the 0.3.0
 * inline path.
 */
async function toDataUrl(localPath, label, deps) {
  if (typeof localPath !== "string" || !localPath.trim()) {
    throw fail(`参考${label}路径无效`);
  }
  const filePath = localPath.trim();

  if (typeof deps.upload === "function") {
    // A read failure or an unknown extension is a hard error, not an upload
    // miss: surface it before the try so it never masquerades as a fallback.
    const bytes = await readBytesForUpload(filePath, label, deps);
    const mimeType = mimeForPath(filePath);
    try {
      const result = await deps.upload({
        purpose: "video_generation_input",
        bytes,
        fileName: baseName(filePath),
        mimeType,
      });
      const fileId =
        result && result.fileId !== undefined && result.fileId !== null
          ? String(result.fileId).trim()
          : "";
      if (!fileId) throw new Error("上传响应缺少 fileId");
      return `mm_file://${fileId}`;
    } catch (error) {
      await warnUploadFallback(deps.logger, label, error);
    }
  }

  return toBase64DataUrl(filePath, label, deps);
}

/**
 * Read one reference's bytes and charge them to the shared transport budget.
 *
 * Both reference paths go through here — the generation modes' local paths
 * (a string `ref`) and the Context-IR refs (an open ResourceRef object) — so
 * the ≤12MB/≤16MB rules and their messages live in exactly one place. `ref`
 * is handed to the injected readers untouched.
 */
async function readBytesWithinBudget({
  ref,
  label,
  position = "",
  readReference,
  statReference,
  budget,
}) {
  if (typeof statReference === "function") {
    try {
      const stat = await statReference(ref);
      const size = statSize(stat);
      if (size !== null && size > MAX_REFERENCE_FILE_BYTES) throw referenceTooLarge();
    } catch (error) {
      if (error?.code === ERROR_CODES.referenceTooLarge) throw error;
      // stat unavailable or unrecognised shape: fall through and check after read.
    }
  }
  if (typeof readReference !== "function") {
    throw fail("参考文件读取通道不可用（缺少 app/resources.read 授权）");
  }
  const payload = await readReference(ref);
  const bytes = extractBytes(payload);
  if (bytes.length === 0) throw fail(`参考${label}内容为空${position}`);
  if (bytes.length > MAX_REFERENCE_FILE_BYTES) throw referenceTooLarge();
  budget.total += bytes.length;
  if (budget.total > MAX_REFERENCE_TOTAL_BYTES) throw referenceTotalTooLarge();
  return { bytes, payload };
}

/* ------------------------------------------------------------------ *
 * Content array + create request body
 * ------------------------------------------------------------------ */

function requirePrompt(params) {
  const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) throw fail("提示词（prompt）不能为空");
  return prompt;
}

function assertNoReferences(mode, modeLabel, { images, videos, audios }) {
  const count = images.length + videos.length + audios.length;
  if (count > 0) {
    throw fail(`${modeLabel}（${mode}）不接受参考图片 / 视频 / 音频`);
  }
}

function assertNoVideoOrAudio(modeLabel, { videos, audios }) {
  if (videos.length > 0 || audios.length > 0) {
    throw fail(`${modeLabel}不接受参考视频或音频（如需参考素材请用多模态参考模式）`);
  }
}

/**
 * Carry `aigc_watermark` only when the caller gave a value: an omitted key
 * stays omitted (null/undefined both count as omitted, matching the resolve*
 * helpers). An explicit `false` is a real choice and is kept.
 */
function applyWatermark(body, params) {
  if (params?.aigc_watermark !== undefined && params?.aigc_watermark !== null) {
    body.aigc_watermark = Boolean(params.aigc_watermark);
  }
  return body;
}

/**
 * The host mirrors a non-empty `referenceVideos` / `referenceAudios` /
 * `referenceImages` list onto the singular `video` / `audio` / `image` key
 * when the caller left that key out (the same list, copied by reference
 * before it reaches the adapter). A mirrored copy therefore arrives as an
 * ARRAY that equals the reference list verbatim, while an explicit singular
 * value is a single string. Telling the two apart keeps a reference-only
 * call from masquerading as a base video (and vice versa).
 */
function isMirroredSingular(params, key, referenceList) {
  if (!Array.isArray(params?.[key])) return false;
  const singular = filesFromParams(params, [key]);
  return (
    singular.length === referenceList.length &&
    singular.every((item, index) => item === referenceList[index])
  );
}

/**
 * Build the `POST /v2/video_regeneration` body. The endpoint takes exactly one
 * of two inputs:
 *
 *  - `source_task_id`: the server replays the source task's own prompt and
 *    content, so the body carries only the source reference, the fixed 2K
 *    resolution and the optional watermark flag.
 *  - the base_video path (`video`): the caller reproduces the original prompt
 *    and materials and hands in the source video itself. The API wants the
 *    whole original content plus exactly one `role: "base_video"` video item,
 *    placed after the materials (the official script's shape).
 */
async function buildRegenerationRequestBody(
  params,
  spec,
  { readReference, statReference, upload, logger } = {},
) {
  const sourceTaskId = String(params?.source_task_id ?? "").trim();
  const referenceVideos = filesFromParams(params, ["referenceVideos"]);
  const videoItems = filesFromParams(params, ["video"]);
  const baseVideos = isMirroredSingular(params, "video", referenceVideos) ? [] : videoItems;

  if (sourceTaskId && baseVideos.length > 0) {
    throw fail("2K 再生成的两种输入只能二选一：source_task_id（源任务 ID）与 video（源视频）请只提供一种");
  }
  if (!sourceTaskId && baseVideos.length === 0) {
    throw fail("2K 再生成需要二选一的输入：source_task_id（源任务 ID）或 video（源视频）");
  }

  const rawResolution = String(params?.video_resolution ?? params?.resolution ?? "").trim();
  if (rawResolution && rawResolution !== "2K") {
    throw fail(`2K 再生成只支持分辨率 "2K"（收到 "${rawResolution}"）`);
  }

  if (sourceTaskId) {
    return applyWatermark(
      { model: spec.id, source_task_id: sourceTaskId, resolution: "2K" },
      params,
    );
  }

  if (baseVideos.length !== 1) {
    throw fail(`2K 再生成的源视频（video）需要恰好 1 个（收到 ${baseVideos.length} 个）`);
  }

  const deps = { readReference, statReference, budget: { total: 0 }, upload, logger };
  const content = [{ type: "text", text: requirePrompt(params) }];

  // Reproduce the original materials first; the base video closes the list.
  const imageItems = filesFromParams(params, ["image"]);
  const referenceImages = filesFromParams(params, ["referenceImages"]);
  const firstFrames = isMirroredSingular(params, "image", referenceImages) ? [] : imageItems;
  for (const path of firstFrames) {
    content.push({
      type: "image_url",
      image_url: { url: await toDataUrl(path, "图片（首帧）", deps) },
      role: "first_frame",
    });
  }
  for (const path of referenceImages) {
    content.push({
      type: "image_url",
      image_url: { url: await toDataUrl(path, "图片", deps) },
      role: "reference_image",
    });
  }
  for (const path of referenceVideos) {
    content.push({
      type: "video_url",
      video_url: { url: await toDataUrl(path, "视频", deps) },
      role: "reference_video",
    });
  }
  const referenceAudios = filesFromParams(params, ["referenceAudios"]);
  const audioItems = filesFromParams(params, ["audio"]);
  const aliasAudios = isMirroredSingular(params, "audio", referenceAudios) ? [] : audioItems;
  for (const path of [...referenceAudios, ...aliasAudios]) {
    content.push({
      type: "audio_url",
      audio_url: { url: await toDataUrl(path, "音频", deps) },
      role: "reference_audio",
    });
  }
  // The source video rides the same transport budget as every other material.
  // The dedicated source_task_id hint is scoped to the single-file overflow:
  // only there does swapping inputs actually help (zero upload). A
  // total-budget overflow keeps the standard budget message — the source
  // video may fit fine and the other materials pushed the sum over. The two
  // cases carry different codes, so this catch only rewrites the single-file
  // one (`referenceTooLarge`; the total case is `referenceTotalTooLarge`).
  let baseVideoUrl;
  try {
    baseVideoUrl = await toDataUrl(baseVideos[0], "源视频", deps);
  } catch (error) {
    if (error?.code === ERROR_CODES.referenceTooLarge) {
      throw fail(
        `源视频超出传输限制（单文件 ≤${Math.floor(MAX_REFERENCE_FILE_BYTES / (1024 * 1024))}MB、总量 ≤${Math.floor(MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024))}MB），无法内联上传：请改用 source_task_id 方式（零上传），或压缩源视频后重试`,
        ERROR_CODES.referenceTooLarge,
      );
    }
    throw error;
  }
  content.push({ type: "video_url", video_url: { url: baseVideoUrl }, role: "base_video" });

  return applyWatermark({ model: spec.id, content, resolution: "2K" }, params);
}

/**
 * Build the MiniMax `POST /v2/video_generation` body — or, for the
 * `regeneration` mode, the `POST /v2/video_regeneration` body (see
 * `buildRegenerationRequestBody`).
 *
 * @param {object} input
 * @param {object} input.params      resolved parameters from the host
 * @param {object} input.modelSpec   one of `MODEL_SPECS`
 * @param {(path: string) => Promise<unknown>} input.readReference
 * @param {(path: string) => Promise<unknown>} [input.statReference]
 * @returns {Promise<object>} the JSON body
 */
export async function buildCreateRequestBody({
  params = {},
  modelSpec = MODEL_SPECS[DEFAULT_MODEL_ID],
  readReference,
  statReference,
  upload,
  logger,
} = {}) {
  // A `modelId`/`model` in params wins and is validated; otherwise the caller's spec.
  const spec = params?.modelId ?? params?.model ? resolveModelSpec(params) : modelSpec;
  const mode = resolveMode(params, spec);

  // 2K regeneration submits through its own endpoint with its own body shapes;
  // nothing below applies (no duration/ratio, and no prompt for the
  // source_task_id path).
  if (mode === "regeneration") {
    return buildRegenerationRequestBody(params, spec, { readReference, statReference, upload, logger });
  }

  const prompt = requirePrompt(params);
  const duration = resolveDuration(params, spec);
  const resolution = resolveResolution(params, spec);
  const ratio = resolveRatio(params, mode);

  const images = imagesFromParams(params);
  const videos = videosFromParams(params);
  const audios = audiosFromParams(params);

  const deps = { readReference, statReference, budget: { total: 0 }, upload, logger };
  const content = [{ type: "text", text: prompt }];

  if (mode === "text2video") {
    assertNoReferences(mode, MODE_LABELS[mode], { images, videos, audios });
  } else if (mode === "image2video" || mode === "last_frame2video") {
    const label = MODE_LABELS[mode];
    assertNoVideoOrAudio(label, { videos, audios });
    if (images.length !== 1) {
      throw fail(`${label}需要恰好 1 张图片（收到 ${images.length} 张）`);
    }
    content.push({
      type: "image_url",
      image_url: { url: await toDataUrl(images[0], "图片", deps) },
      role: mode === "image2video" ? "first_frame" : "last_frame",
    });
  } else if (mode === "frames2video") {
    const label = MODE_LABELS[mode];
    assertNoVideoOrAudio(label, { videos, audios });
    if (images.length !== 2) {
      throw fail(`${label}需要恰好 2 张图片（按数组顺序：首帧、尾帧），收到 ${images.length} 张`);
    }
    content.push({
      type: "image_url",
      image_url: { url: await toDataUrl(images[0], "图片（首帧）", deps) },
      role: "first_frame",
    });
    content.push({
      type: "image_url",
      image_url: { url: await toDataUrl(images[1], "图片（尾帧）", deps) },
      role: "last_frame",
    });
  } else {
    // multimodal2video
    const label = MODE_LABELS[mode];
    if (images.length > 9) throw fail(`${label}最多支持 9 张参考图片（收到 ${images.length} 张）`);
    if (videos.length > 3) throw fail(`${label}最多支持 3 个参考视频（收到 ${videos.length} 个）`);
    if (audios.length > 3) throw fail(`${label}最多支持 3 段参考音频（收到 ${audios.length} 段）`);
    const total = images.length + videos.length + audios.length;
    if (total === 0) throw fail(`${label}至少需要 1 个参考文件`);
    if (total > 12) throw fail(`${label}最多支持 12 个参考文件（收到 ${total} 个）`);
    for (const path of images) {
      content.push({
        type: "image_url",
        image_url: { url: await toDataUrl(path, "图片", deps) },
        role: "reference_image",
      });
    }
    for (const path of videos) {
      content.push({
        type: "video_url",
        video_url: { url: await toDataUrl(path, "视频", deps) },
        role: "reference_video",
      });
    }
    for (const path of audios) {
      content.push({
        type: "audio_url",
        audio_url: { url: await toDataUrl(path, "音频", deps) },
        role: "reference_audio",
      });
    }
  }

  const body = {
    model: spec.id,
    content,
    resolution,
    duration,
    ratio,
  };

  const estimated = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (estimated > MAX_REQUEST_BODY_BYTES) {
    throw fail(
      `请求体过大（约 ${(estimated / (1024 * 1024)).toFixed(1)}MB，上限 ${Math.floor(MAX_REQUEST_BODY_BYTES / (1024 * 1024))}MB），请减少参考素材`,
      ERROR_CODES.bodyTooLarge,
    );
  }

  return body;
}

/* ------------------------------------------------------------------ *
 * Task naming, URLs, status mapping
 * ------------------------------------------------------------------ */

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Stable per-task digest: same task → same hash, other tasks → different hash. */
export function taskHash({ localTaskId = "", providerTaskId = "" } = {}) {
  return sha256Hex(
    JSON.stringify({ adapterType: "video", localTaskId, providerTaskId }),
  ).slice(0, 32);
}

export function urlHash(url) {
  return sha256Hex(String(url ?? "")).slice(0, 24);
}

/** The published file name (no path separators — it lands in generatedDir's root). */
export function videoFileName({ localTaskId = "", providerTaskId = "", url = "" } = {}) {
  return `minimax-${taskHash({ localTaskId, providerTaskId })}-${urlHash(url)}.mp4`;
}

/** A per-task download-state key; two tasks never share one. */
export function downloadStateKey({ localTaskId = "", providerTaskId = "" } = {}) {
  return `${localTaskId}::${providerTaskId}`;
}

/** The in-flight part file inside generatedDir (hidden, per-task, no collision). */
export function partFileName(taskDigest) {
  return `.minimax-${taskDigest}.part`;
}

export function createTaskUrl() {
  return `${API_BASE_URL}${CREATE_PATH}`;
}

export function regenerationTaskUrl() {
  return `${API_BASE_URL}${REGENERATION_PATH}`;
}

export function queryTaskUrl(providerTaskId) {
  return `${API_BASE_URL}${QUERY_PATH_PREFIX}${encodeURIComponent(String(providerTaskId))}`;
}

/** Remote status → adapter status. */
export function mapRemoteStatus(status) {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "queued" || value === "running" || value === "pending" || value === "created") {
    return "pending";
  }
  if (value === "succeeded" || value === "success" || value === "completed") return "success";
  if (value === "failed" || value === "cancelled" || value === "canceled" || value === "error") {
    return "failed";
  }
  return "pending";
}

/* ------------------------------------------------------------------ *
 * H3-Context-IR（模型工具 minimax_context_ir 的纯半数）
 * ------------------------------------------------------------------ */

/**
 * `POST /v2/h3_context_ir` — prompt enhancement only: the task returns an
 * enriched prompt and never a video. The query side reuses the shared
 * `/v2/query/video_generation/{id}` endpoint.
 */
export const CONTEXT_IR_PATH = "/v2/h3_context_ir";

export function contextIrCreateUrl() {
  return `${API_BASE_URL}${CONTEXT_IR_PATH}`;
}

/**
 * Ratio rules by scenario, mirroring the API:
 *   - text-only: a concrete ratio is required (default 16:9); `adaptive` is
 *     rejected — there is no source frame to adapt to;
 *   - first/last frame (i2va): the input image decides, so the API pins
 *     `adaptive`; another valid ratio is accepted but ignored;
 *   - reference materials (r2va): optional, defaults to `adaptive`, and any
 *     concrete ratio may be chosen explicitly.
 */
export function resolveContextIrRatio(params = {}, scenario = "text") {
  const raw = typeof params?.ratio === "string" ? params.ratio.trim() : "";
  if (scenario === "frames") {
    if (raw && !RATIOS_FULL.includes(raw)) {
      throw fail(`H3-Context-IR 不支持比例 "${raw}"；支持：${RATIOS_FULL.join(", ")}`);
    }
    return "adaptive";
  }
  if (scenario === "references") {
    const value = raw || "adaptive";
    if (!RATIOS_FULL.includes(value)) {
      throw fail(`H3-Context-IR 不支持比例 "${value}"；支持：${RATIOS_FULL.join(", ")}`);
    }
    return value;
  }
  const value = raw || T2V_DEFAULT_RATIO;
  if (value === "adaptive") throw fail("H3-Context-IR 不支持 adaptive 比例（纯文本场景无源帧）");
  if (!RATIOS_NO_ADAPTIVE.includes(value)) {
    throw fail(`H3-Context-IR 不支持比例 "${value}"；支持：${RATIOS_NO_ADAPTIVE.join(", ")}`);
  }
  return value;
}

/**
 * Reference ceilings for a Context-IR request (the API's own counts).
 *
 * The single source for these caps: the builder's error text below and the
 * tool's schema `maxItems` / description all derive from this object, so a
 * cap change can never leave a stale number behind.
 */
export const CONTEXT_IR_REF_LIMITS = { images: 9, videos: 3, audios: 3 };

/**
 * Normalise one reference value into an open ResourceRef the injected readers
 * understand, or a `{ kind: "url" }` marker that never touches them.
 *
 * Accepted shapes are exactly what the tool schema advertises: `{ kind:
 * "session-file", fileId }`, `{ kind: "local-file", path }`, or a bare
 * http(s) URL string (passed through untouched — the API can fetch it, so
 * there is no reason to burn transport budget on the bytes). The `{ kind:
 * "url" }` marker is internal to this module: it is how a pass-through string
 * is carried to the caller, never an accepted input shape.
 */
function normaliseContextIrRef(value, label) {
  if (Array.isArray(value)) throw fail(`${label}仅支持单个引用（不能传数组）`);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) throw fail(`${label}为空`);
    if (!/^https?:\/\//i.test(text)) {
      throw fail(`${label}仅支持 http(s) 公网 URL 或 session-file / local-file 引用`);
    }
    return { kind: "url", url: text };
  }
  const kind =
    value && typeof value === "object" && typeof value.kind === "string" ? value.kind.trim() : "";
  if (kind === "session-file") {
    const fileId = typeof value.fileId === "string" ? value.fileId.trim() : "";
    if (!fileId) throw fail(`${label}缺少 fileId`);
    return { kind: "session-file", fileId };
  }
  if (kind === "local-file") {
    const path = typeof value.path === "string" ? value.path.trim() : "";
    if (!path) throw fail(`${label}缺少 path`);
    return { kind: "local-file", path };
  }
  throw fail(`${label}引用形状无效；支持 session-file / local-file 引用或 http(s) URL`);
}

/** Normalise a list parameter; a single value counts as a one-entry list. */
function normaliseContextIrRefList(value, label) {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => normaliseContextIrRef(entry, `${label}第 ${index + 1} 项`));
}

/** One reference → the URL that rides in content[]: pass-through or data URL. */
async function contextIrRefToUrl(ref, label, deps) {
  if (ref.kind === "url") return ref.url;
  const { bytes, payload } = await readBytesWithinBudget({
    ref,
    label,
    readReference: deps.readReference,
    statReference: deps.statReference,
    budget: deps.budget,
  });
  // A local path names its own extension; a session file's MIME comes from the
  // host read reply (`filePath` / `resource`), because the ref itself carries
  // no path.
  const resource = payload && typeof payload === "object" ? payload.resource : null;
  const mimePath =
    (typeof ref.path === "string" && ref.path.trim()) ||
    (payload && typeof payload === "object" && typeof payload.filePath === "string" && payload.filePath) ||
    (resource && typeof resource === "object" && typeof resource.filePath === "string" && resource.filePath) ||
    (resource && typeof resource === "object" && typeof resource.displayName === "string" && resource.displayName) ||
    "";
  return `data:${mimeForPath(mimePath)};base64,${bytes.toString("base64")}`;
}

/**
 * Build the MiniMax `POST /v2/h3_context_ir` body.
 *
 * Content is text-first, then the frame images (first_frame / last_frame) or
 * the reference materials (reference_image / reference_video /
 * reference_audio) — the API forbids mixing the two groups, so this builder
 * rejects it offline with a Chinese error. Local bytes are read through the
 * injected readers under the shared transport budget; public URLs pass
 * through untouched and are never read.
 *
 * @param {object} input
 * @param {string} input.prompt       the prompt to enhance
 * @param {number} [input.duration]   4-15 seconds (default 5); the video the prompt is planned for
 * @param {string} [input.ratio]      scenario rule: text needs a concrete ratio (default 16:9),
 *                                    frames pin adaptive, references default adaptive
 * @param {unknown} [input.firstFrame]        single image ref (i2va first frame)
 * @param {unknown} [input.lastFrame]         single image ref (i2va last frame)
 * @param {unknown} [input.referenceImages]   ≤9 image refs (r2va)
 * @param {unknown} [input.referenceVideos]   ≤3 video refs (r2va)
 * @param {unknown} [input.referenceAudios]   ≤3 audio refs (r2va)
 * @param {(ref: unknown) => Promise<unknown>} [input.readReference]
 * @param {(ref: unknown) => Promise<unknown>} [input.statReference]
 * @returns {Promise<object>} the JSON body
 */
export async function buildContextIrRequestBody({
  prompt,
  duration,
  ratio,
  firstFrame,
  lastFrame,
  referenceImages,
  referenceVideos,
  referenceAudios,
  readReference,
  statReference,
} = {}) {
  const text = requirePrompt({ prompt });
  const resolvedDuration = resolveDuration({ duration }, MODEL_SPECS[DEFAULT_MODEL_ID]);

  const frames = [];
  if (firstFrame !== undefined && firstFrame !== null) {
    frames.push({
      ref: normaliseContextIrRef(firstFrame, "H3-Context-IR 首帧"),
      role: "first_frame",
      label: "图片（首帧）",
    });
  }
  if (lastFrame !== undefined && lastFrame !== null) {
    frames.push({
      ref: normaliseContextIrRef(lastFrame, "H3-Context-IR 尾帧"),
      role: "last_frame",
      label: "图片（尾帧）",
    });
  }
  const images = normaliseContextIrRefList(referenceImages, "H3-Context-IR 参考图片");
  const videos = normaliseContextIrRefList(referenceVideos, "H3-Context-IR 参考视频");
  const audios = normaliseContextIrRefList(referenceAudios, "H3-Context-IR 参考音频");

  // The API forbids mixing the two input groups; fail before any byte is read.
  if (frames.length > 0 && images.length + videos.length + audios.length > 0) {
    throw fail("H3-Context-IR 首/尾帧与参考素材互斥，不能混用：请二选一（首/尾帧 或 参考素材）");
  }
  if (images.length > CONTEXT_IR_REF_LIMITS.images) {
    throw fail(
      `H3-Context-IR 最多支持 ${CONTEXT_IR_REF_LIMITS.images} 张参考图片（收到 ${images.length} 张）`,
    );
  }
  if (videos.length > CONTEXT_IR_REF_LIMITS.videos) {
    throw fail(
      `H3-Context-IR 最多支持 ${CONTEXT_IR_REF_LIMITS.videos} 个参考视频（收到 ${videos.length} 个）`,
    );
  }
  if (audios.length > CONTEXT_IR_REF_LIMITS.audios) {
    throw fail(
      `H3-Context-IR 最多支持 ${CONTEXT_IR_REF_LIMITS.audios} 段参考音频（收到 ${audios.length} 段）`,
    );
  }

  const scenario =
    frames.length > 0 ? "frames" : images.length + videos.length + audios.length > 0 ? "references" : "text";
  const resolvedRatio = resolveContextIrRatio({ ratio }, scenario);

  const deps = { readReference, statReference, budget: { total: 0 } };
  const content = [{ type: "text", text }];
  for (const frame of frames) {
    content.push({
      type: "image_url",
      image_url: { url: await contextIrRefToUrl(frame.ref, frame.label, deps) },
      role: frame.role,
    });
  }
  for (const ref of images) {
    content.push({
      type: "image_url",
      image_url: { url: await contextIrRefToUrl(ref, "图片", deps) },
      role: "reference_image",
    });
  }
  for (const ref of videos) {
    content.push({
      type: "video_url",
      video_url: { url: await contextIrRefToUrl(ref, "视频", deps) },
      role: "reference_video",
    });
  }
  for (const ref of audios) {
    content.push({
      type: "audio_url",
      audio_url: { url: await contextIrRefToUrl(ref, "音频", deps) },
      role: "reference_audio",
    });
  }

  return {
    model: DEFAULT_MODEL_ID,
    content,
    duration: resolvedDuration,
    ratio: resolvedRatio,
  };
}
