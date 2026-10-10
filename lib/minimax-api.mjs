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

export const PROVIDER_ID = "minimax-video";
export const PROTOCOL_ID = "minimax-video-videos";
export const PROVIDER_VERSION = "0.1.7";
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
export function hasSourceTaskId(params = {}) {
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
    ERROR_CODES.referenceTooLarge,
  );
}

async function toDataUrl(localPath, label, deps) {
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
 * Build the `POST /v2/video_regeneration` body from a source task id.
 *
 * The source task supplies prompt, content, duration and ratio — the API
 * ignores them for this path — so the body carries only the source reference,
 * the fixed 2K resolution and, when the caller set it explicitly, the
 * watermark flag.
 */
function buildRegenerationRequestBody(params, spec) {
  const sourceTaskId = String(params?.source_task_id ?? "").trim();
  if (!sourceTaskId) {
    throw fail("2K 再生成需要 source_task_id（源任务 ID）");
  }
  const rawResolution = String(params?.video_resolution ?? params?.resolution ?? "").trim();
  if (rawResolution && rawResolution !== "2K") {
    throw fail(`2K 再生成只支持分辨率 "2K"（收到 "${rawResolution}"）`);
  }
  const body = {
    model: spec.id,
    source_task_id: sourceTaskId,
    resolution: "2K",
  };
  // Carried only when the caller gave a value: an omitted key stays omitted
  // (null/undefined both count as omitted, matching the resolve* helpers).
  if (params?.aigc_watermark !== undefined && params?.aigc_watermark !== null) {
    body.aigc_watermark = Boolean(params.aigc_watermark);
  }
  return body;
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
} = {}) {
  // A `modelId`/`model` in params wins and is validated; otherwise the caller's spec.
  const spec = params?.modelId ?? params?.model ? resolveModelSpec(params) : modelSpec;
  const mode = resolveMode(params, spec);

  // 2K regeneration submits through its own endpoint with a source-task body;
  // nothing below applies (no prompt, no content, no duration/ratio).
  if (mode === "regeneration") {
    return buildRegenerationRequestBody(params, spec);
  }

  const prompt = requirePrompt(params);
  const duration = resolveDuration(params, spec);
  const resolution = resolveResolution(params, spec);
  const ratio = resolveRatio(params, mode);

  const images = imagesFromParams(params);
  const videos = videosFromParams(params);
  const audios = audiosFromParams(params);

  const deps = { readReference, statReference, budget: { total: 0 } };
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

/** Reference ceilings for a Context-IR request (the API's own counts). */
const CONTEXT_IR_REF_LIMITS = { images: 9, videos: 3, audios: 3 };

/**
 * Normalise one reference value into an open ResourceRef the injected readers
 * understand, or a `{ kind: "url" }` marker that never touches them.
 *
 * Accepted shapes mirror the media pipeline's refs: `{ kind: "session-file",
 * fileId }`, `{ kind: "local-file", path }`, a `{ kind: "url", url }` object,
 * or a bare http(s) URL string (passed through untouched — the API can fetch
 * it, so there is no reason to burn transport budget on the bytes).
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
  if (kind === "url") {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (!url) throw fail(`${label}缺少 url`);
    return { kind: "url", url };
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
    throw fail(`H3-Context-IR 最多支持 9 张参考图片（收到 ${images.length} 张）`);
  }
  if (videos.length > CONTEXT_IR_REF_LIMITS.videos) {
    throw fail(`H3-Context-IR 最多支持 3 个参考视频（收到 ${videos.length} 个）`);
  }
  if (audios.length > CONTEXT_IR_REF_LIMITS.audios) {
    throw fail(`H3-Context-IR 最多支持 3 段参考音频（收到 ${audios.length} 段）`);
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
