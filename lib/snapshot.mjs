/**
 * lib/snapshot.mjs
 *
 * 运行期能力快照（runtime capability snapshot）：`refresh` 返回的
 * `{ providerId, media, version }`，聚合视频与语音两个目录的模型条目。
 *
 * 本模块是**唯一**允许同时 import 视频目录与语音目录的地方：视频域不再反向
 * 依赖语音域，两域可独立演进与测试。
 *
 * 纯函数与静态常量：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import {
  DEFAULT_MODEL_ID,
  FALLBACK_PROVIDER_ID,
  PROVIDER_ID,
  PROVIDER_VERSION,
} from "./minimax/constants.mjs";
import { MODEL_IDS, MODEL_SPECS, buildModelEntry } from "./minimax/model-catalog.mjs";
import { DEFAULT_TTS_MODEL } from "./speech-api.mjs";
import { SPEECH_MODEL_IDS, buildSpeechModelEntry } from "./speech/catalog.mjs";

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
