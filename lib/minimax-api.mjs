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

export const MODE_IDS = [
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
};

/**
 * Chinese display labels for the three media parameters.
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
};

const MODE_INPUT_LIMITS = {
  text2video: { referenceImages: { min: 0, max: 0 } },
  image2video: { referenceImages: { min: 1, max: 1 } },
  last_frame2video: { referenceImages: { min: 1, max: 1 } },
  frames2video: { referenceImages: { min: 2, max: 2 } },
  multimodal2video: {
    referenceImages: { min: 0, max: 9 },
    referenceVideos: { min: 0, max: 3 },
    referenceAudios: { min: 0, max: 3 },
  },
};

/** Static per-model facts (the API's own documented matrix). */
export const MODEL_SPECS = {
  "MiniMax-H3": {
    id: "MiniMax-H3",
    displayName: "MiniMax H3",
    resolutions: ["768P", "2K"],
    duration: { min: 4, max: 15 },
  },
  "MiniMax-H3-Max": {
    id: "MiniMax-H3-Max",
    displayName: "MiniMax H3 Max",
    resolutions: ["480P", "768P"],
    duration: { min: 5, max: 15 },
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

function buildMode(modelSpec, modeId) {
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
    modes: MODE_IDS.map((modeId) => buildMode(modelSpec, modeId)),
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

export function resolveMode(params = {}) {
  const explicit = typeof params?.mode === "string" ? params.mode.trim() : "";
  const mode = explicit || inferMode(params);
  if (!MODE_IDS.includes(mode)) {
    throw fail(`MiniMax 视频不支持模式 "${mode}"；可选：${MODE_IDS.join(", ")}`);
  }
  return mode;
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
  const candidates = [stat.size, stat.bytes, stat.byteLength];
  for (const candidate of candidates) {
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
  if (typeof statReference === "function") {
    try {
      const stat = await statReference(filePath);
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
  const payload = await readReference(filePath);
  const bytes = extractBytes(payload);
  if (bytes.length === 0) throw fail(`参考${label}内容为空：${filePath}`);
  if (bytes.length > MAX_REFERENCE_FILE_BYTES) throw referenceTooLarge();
  budget.total += bytes.length;
  if (budget.total > MAX_REFERENCE_TOTAL_BYTES) throw referenceTotalTooLarge();
  return `data:${mimeForPath(filePath)};base64,${bytes.toString("base64")}`;
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
 * Build the MiniMax `POST /v2/video_generation` body.
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
  const prompt = requirePrompt(params);
  const mode = resolveMode(params);
  // A `modelId`/`model` in params wins and is validated; otherwise the caller's spec.
  const spec = params?.modelId ?? params?.model ? resolveModelSpec(params) : modelSpec;
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
