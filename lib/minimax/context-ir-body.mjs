/**
 * lib/minimax/context-ir-body.mjs
 *
 * `POST /v2/h3_context_ir` 请求体组装（模型工具 `minimax_context_ir` 的纯半数）：
 * 提示词增强任务的 content[] 组装、首/尾帧与参考素材的互斥校验、比例规则与传输预算。
 *
 * 参考素材读取经注入的 `readReference` / `statReference` 回调——本模块不触宿主 API
 * （`ctx.*`）、不做网络 I/O，可离线单测。
 */
import { DEFAULT_MODEL_ID, RATIOS_FULL, RATIOS_NO_ADAPTIVE, T2V_DEFAULT_RATIO } from "./constants.mjs";
import { MODEL_SPECS } from "./model-catalog.mjs";
import { resolveDuration } from "./params.mjs";
import { mimeForPath, readBytesWithinBudget } from "./reference-pipeline.mjs";

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
