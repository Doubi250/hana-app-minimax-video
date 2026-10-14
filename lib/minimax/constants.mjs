/**
 * lib/minimax/constants.mjs
 *
 * MiniMax H3 视频提供方的静态常量与端点 URL 构建器：provider / protocol 标识、
 * 接口路径、传输预算常量、比例与默认参数、参数标签、错误码注册表。
 *
 * 纯常量与纯函数：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import { FALLBACK_PROVIDER_ID } from "../auth.mjs";

export const PROVIDER_ID = "minimax-video";
export const PROTOCOL_ID = "minimax-video-videos";
/** The protocol id the host speech channel routes to the speech adapter. */
export const SPEECH_PROTOCOL_ID = "minimax-speech-tts";
export const PROVIDER_VERSION = "0.3.2";
export { FALLBACK_PROVIDER_ID };

export const API_BASE_URL = "https://api.minimax.cn";
export const CREATE_PATH = "/v2/video_generation";
/** 2K re-generation lives on its own endpoint; querying reuses the video path. */
export const REGENERATION_PATH = "/v2/video_regeneration";
export const QUERY_PATH_PREFIX = "/v2/query/video_generation/";

/**
 * `POST /v2/h3_context_ir` — prompt enhancement only: the task returns an
 * enriched prompt and never a video. The query side reuses the shared
 * `/v2/query/video_generation/{id}` endpoint.
 */
export const CONTEXT_IR_PATH = "/v2/h3_context_ir";

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

/** Error codes that callers may branch on. */
export const ERROR_CODES = {
  referenceTooLarge: "MINIMAX_REFERENCE_TOO_LARGE",
  referenceTotalTooLarge: "MINIMAX_REFERENCE_TOTAL_TOO_LARGE",
  bodyTooLarge: "MINIMAX_REQUEST_BODY_TOO_LARGE",
  unknownMime: "MINIMAX_UNKNOWN_MIME",
  unknownShape: "MINIMAX_UNKNOWN_RESOURCE_SHAPE",
};

export function createTaskUrl() {
  return `${API_BASE_URL}${CREATE_PATH}`;
}

export function regenerationTaskUrl() {
  return `${API_BASE_URL}${REGENERATION_PATH}`;
}

export function queryTaskUrl(providerTaskId) {
  return `${API_BASE_URL}${QUERY_PATH_PREFIX}${encodeURIComponent(String(providerTaskId))}`;
}

export function contextIrCreateUrl() {
  return `${API_BASE_URL}${CONTEXT_IR_PATH}`;
}
