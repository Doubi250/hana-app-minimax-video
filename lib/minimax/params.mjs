/**
 * lib/minimax/params.mjs
 *
 * MiniMax H3 视频参数归一化：参考素材键位优先级、模式推断与校验、模型 / 分辨率 /
 * 时长 / 比例解析。
 *
 * 纯函数：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import {
  DEFAULT_DURATION,
  DEFAULT_MODEL_ID,
  DEFAULT_RESOLUTION,
  RATIOS_FULL,
  RATIOS_NO_ADAPTIVE,
  T2V_DEFAULT_RATIO,
} from "./constants.mjs";
import { MODEL_IDS, MODEL_SPECS } from "./model-catalog.mjs";

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

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
