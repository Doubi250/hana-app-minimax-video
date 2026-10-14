/**
 * lib/minimax-client.mjs
 *
 * The HTTP half: create a task, query a task, and download the finished video.
 *
 * `fetch` is injected (the adapter passes `ctx.network.fetch`) so the module has
 * no host dependency of its own. Every outbound call carries an explicit
 * `timeoutMs` / `maxResponseBytes`: the host reads the whole body into memory
 * before returning, and a single `network.fetch` RPC must finish in under 30s.
 */
import fs from "node:fs";
import path from "node:path";
import {
  contextIrCreateUrl,
  createTaskUrl,
  queryTaskUrl,
  regenerationTaskUrl,
} from "./minimax/constants.mjs";
import { mapRemoteStatus } from "./minimax/naming.mjs";
import { withAuth } from "./http-util.mjs";

/** One ranged request: 8 MiB keeps "connect + read whole body" inside 25s. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
export const MIN_CHUNK_BYTES = 1024 * 1024;
export const CHUNK_TIMEOUT_MS = 25000;
export const FULL_DOWNLOAD_TIMEOUT_MS = 28000;
export const FULL_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const API_JSON_MAX_BYTES = 8 * 1024 * 1024;

function headerOf(response, name) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) ?? "");
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return String(value ?? "");
  }
  return "";
}

async function readText(response) {
  try {
    return String(await response.text());
  } catch {
    return "";
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiError(status, text) {
  const json = parseJson(text);
  const message =
    json?.error?.message ||
    json?.message ||
    (json?.base_resp?.status_msg ? json.base_resp.status_msg : "") ||
    text.trim().slice(0, 400) ||
    "未知错误";
  const error = new Error(`MiniMax API 错误 ${status}: ${message}`);
  error.status = status;
  return error;
}

function credentialOf({ auth, apiKey } = {}) {
  if (auth && typeof auth === "object") return auth;
  if (apiKey) return { apiKey };
  return null;
}

export function createMinimaxClient({ fetch: fetchImpl } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createMinimaxClient 需要一个 fetch 实现");
  }

  /** POST a create-style body to `url` and read back the task id. */
  async function postTask(url, { auth, apiKey, body }) {
    const credential = credentialOf({ auth, apiKey });
    const response = await fetchImpl(url, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }, credential),
      body: JSON.stringify(body),
      timeoutMs: 30000,
      maxResponseBytes: API_JSON_MAX_BYTES,
    });
    const text = await readText(response);
    if (!response.ok) throw apiError(response.status, text);
    const json = parseJson(text) || {};
    const taskId = json.task_id ?? json.taskId ?? json.task?.id;
    if (taskId === undefined || taskId === null || String(taskId).trim() === "") {
      throw new Error("MiniMax 未返回 task_id");
    }
    return { taskId: String(taskId).trim() };
  }

  /**
   * Shared GET envelope for both query paths: fetch the task, parse the JSON,
   * and derive the pieces every caller needs — the raw status string, the
   * task object, its `content` payload, and the normalised failReason. The
   * payload pick stays with the caller: a video task reads `content.url`, a
   * context-ir task reads `content.prompt`.
   */
  async function readQueryEnvelope(url, { auth, apiKey }) {
    const credential = credentialOf({ auth, apiKey });
    const response = await fetchImpl(url, {
      method: "GET",
      headers: withAuth({}, credential),
      timeoutMs: 30000,
      maxResponseBytes: API_JSON_MAX_BYTES,
    });
    const text = await readText(response);
    if (!response.ok) throw apiError(response.status, text);
    const json = parseJson(text) || {};
    const task = json.task || {};
    const rawStatus = String(task.status ?? json.status ?? "").trim();
    const failReason =
      task.error?.message ||
      (typeof task.error === "string" ? task.error : "") ||
      json.error?.message ||
      (rawStatus ? `MiniMax 任务状态：${rawStatus}` : "MiniMax 任务失败");
    return { rawStatus, task, content: task.content, failReason };
  }

  return {
    /** POST /v2/video_generation → { taskId }. */
    async createTask({ auth, apiKey, body }) {
      return postTask(createTaskUrl(), { auth, apiKey, body });
    },

    /** POST /v2/video_regeneration → { taskId } (the 2K re-generation path). */
    async createRegenerationTask({ auth, apiKey, body }) {
      return postTask(regenerationTaskUrl(), { auth, apiKey, body });
    },

    /** GET /v2/query/video_generation/{taskId} → normalised task state. */
    async queryTask({ auth, apiKey, taskId }) {
      const { rawStatus, task, content, failReason } = await readQueryEnvelope(
        queryTaskUrl(taskId),
        { auth, apiKey },
      );
      const url =
        (content && typeof content === "object" && !Array.isArray(content) ? content.url : null) ||
        (Array.isArray(content) ? content.find((item) => item?.url)?.url : null) ||
        task.url ||
        null;
      return {
        status: rawStatus,
        mapped: mapRemoteStatus(rawStatus),
        url: typeof url === "string" && url.trim() ? url.trim() : null,
        failReason: String(failReason),
        raw: task,
      };
    },

    /**
     * POST /v2/h3_context_ir → { taskId }.
     *
     * Creates a prompt-enhancement task (no video): the caller polls it via
     * `queryContextIrTask`. Same transport envelope as `createTask`.
     */
    async createContextIrTask({ auth, apiKey, body }) {
      return postTask(contextIrCreateUrl(), { auth, apiKey, body });
    },

    /**
     * GET /v2/query/video_generation/{taskId} → normalised Context-IR state.
     *
     * The shared query endpoint answers, but the payload is different: an
     * enhancement result is `task.content.prompt` — it must NOT be read through
     * the video path, which looks for `content.url` (a context-ir task never
     * has a url, so reusing that parser would always come back empty).
     */
    async queryContextIrTask({ auth, apiKey, taskId }) {
      const { rawStatus, task, content, failReason } = await readQueryEnvelope(
        queryTaskUrl(taskId),
        { auth, apiKey },
      );
      const prompt =
        (content && typeof content === "object" && !Array.isArray(content) ? content.prompt : null) ||
        (Array.isArray(content) ? content.find((item) => item?.prompt)?.prompt : null) ||
        null;
      return {
        status: rawStatus,
        mapped: mapRemoteStatus(rawStatus),
        prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : null,
        failReason: String(failReason),
        raw: task,
      };
    },
  };
}

async function probeOnce(fetchImpl, url, start, size) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Range: `bytes=${start}-${start + size - 1}` },
    timeoutMs: CHUNK_TIMEOUT_MS,
    maxResponseBytes: size + 2 * 1024 * 1024,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

function parseContentRangeTotal(contentRange) {
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(contentRange || ""));
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Download `url` into `partPath`.
 *
 * Probe with `Range: bytes=0-(chunk-1)`:
 *  - 206 + Content-Range → chunked mode; append each ranged slice, on a slice
 *    failure halve the slice once (floor 1 MiB), then give up.
 *  - 200 → the server ignored Range; that response is the whole file (a
 *    truncated read is refetched once with a 512 MB ceiling).
 *
 * @returns {Promise<number>} bytes written
 */
export async function downloadToFile({
  fetch: fetchImpl,
  url,
  partPath,
  chunk = DEFAULT_CHUNK_BYTES,
}) {
  await fs.promises.mkdir(path.dirname(partPath), { recursive: true });

  let probe;
  try {
    probe = await probeOnce(fetchImpl, url, 0, chunk);
  } catch (error) {
    throw new Error(`下载失败：${error?.message || error}`);
  }

  const status = probe.response.status;
  const contentRange = headerOf(probe.response, "content-range");

  if (status !== 200 && status !== 206) {
    throw new Error(`下载失败：HTTP ${status}`);
  }

  if (status === 200 && !contentRange) {
    let buffer = probe.buffer;
    const contentLength = Number(headerOf(probe.response, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0 && buffer.length < contentLength) {
      // The host capped the probe body; refetch the whole file with the big ceiling.
      const full = await fetchImpl(url, {
        method: "GET",
        timeoutMs: FULL_DOWNLOAD_TIMEOUT_MS,
        maxResponseBytes: FULL_DOWNLOAD_MAX_BYTES,
      });
      if (!full.ok) throw new Error(`下载失败：HTTP ${full.status}`);
      buffer = Buffer.from(await full.arrayBuffer());
    }
    if (buffer.length === 0) throw new Error("下载失败：响应为空");
    if (buffer.length > MAX_VIDEO_BYTES) throw new Error("视频超过 1GB 上限，已中止下载");
    await fs.promises.writeFile(partPath, buffer);
    return buffer.length;
  }

  let total = parseContentRangeTotal(contentRange);
  let received = probe.buffer.length;
  await fs.promises.writeFile(partPath, probe.buffer);
  if (received > MAX_VIDEO_BYTES) throw new Error("视频超过 1GB 上限，已中止下载");

  let size = chunk;
  let halved = false;

  while (total === null || received < total) {
    if (received > MAX_VIDEO_BYTES) throw new Error("视频超过 1GB 上限，已中止下载");
    let slice;
    try {
      slice = await probeOnce(fetchImpl, url, received, size);
    } catch (error) {
      if (!halved && size > MIN_CHUNK_BYTES) {
        halved = true;
        size = Math.max(MIN_CHUNK_BYTES, Math.floor(size / 2));
        continue;
      }
      throw new Error(`下载失败：${error?.message || error}`);
    }
    const sliceStatus = slice.response.status;
    if (sliceStatus === 416) break;
    if (sliceStatus !== 200 && sliceStatus !== 206) {
      throw new Error(`下载失败：HTTP ${sliceStatus}`);
    }
    const buffer = slice.buffer;
    if (buffer.length === 0) break;
    await fs.promises.appendFile(partPath, buffer);
    received += buffer.length;
    halved = false;
    if (total === null) {
      const sliceRange = headerOf(slice.response, "content-range");
      total = parseContentRangeTotal(sliceRange);
      if (total === null && buffer.length < size) break;
      if (total === null) {
        size = chunk;
      }
    }
  }

  return received;
}
