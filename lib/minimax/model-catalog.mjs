/**
 * lib/minimax/model-catalog.mjs
 *
 * MiniMax H3 视频模型目录：静态模型表与生成模式（含 2K 再生成）的构建。
 *
 * 纯函数与静态常量：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import {
  DEFAULT_DURATION,
  DEFAULT_RESOLUTION,
  PARAM_LABELS,
  PROTOCOL_ID,
  RATIOS_FULL,
  RATIOS_NO_ADAPTIVE,
  T2V_DEFAULT_RATIO,
} from "./constants.mjs";

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

/**
 * The Chinese display labels for the generation modes.
 *
 * Exported because `lib/minimax/request-body.mjs` labels its errors with them;
 * the table itself stays the single source here.
 */
export { MODE_LABELS };
