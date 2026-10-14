/**
 * lib/minimax/request-body.mjs
 *
 * MiniMax H3 视频请求体组装：`POST /v2/video_generation` 的生成体，以及
 * `POST /v2/video_regeneration` 的 2K 再生成体。
 *
 * 参考素材读取经注入的 `readReference` / `statReference` / `upload` 回调——本模块
 * 不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import {
  DEFAULT_MODEL_ID,
  ERROR_CODES,
  MAX_REFERENCE_FILE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
  MAX_REQUEST_BODY_BYTES,
} from "./constants.mjs";
import { MODE_LABELS, MODEL_SPECS } from "./model-catalog.mjs";
import {
  audiosFromParams,
  filesFromParams,
  imagesFromParams,
  resolveDuration,
  resolveMode,
  resolveModelSpec,
  resolveRatio,
  resolveResolution,
  videosFromParams,
} from "./params.mjs";
import { toDataUrl } from "./reference-pipeline.mjs";

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

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
