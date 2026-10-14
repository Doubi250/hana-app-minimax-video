/**
 * lib/minimax/naming.mjs
 *
 * MiniMax H3 任务的命名与状态映射：稳定的任务摘要 / URL 摘要、成品文件名、
 * 下载状态键、在途分片文件名、远端状态 → 适配器状态。
 *
 * 纯函数（仅用 node:crypto）：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import crypto from "node:crypto";

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
