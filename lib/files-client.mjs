/**
 * lib/files-client.mjs
 *
 * MiniMax Files API 网络客户端：上传本地素材取 `file_id`、检索文件元信息、
 * 取回文件二进制内容（异步 TTS 成品音频 / SRT 等）。
 *
 * `fetch` **由注入提供**（adapter / 工具层传 `ctx.network.fetch`）：缺失或非函数即抛错，
 * 绝不回退 `globalThis.fetch`——那会绕开宿主网络桥与 manifest `allowedHosts` 策略。
 * 每次出站请求都显式声明 `timeoutMs`（缺省 `MAX_HOST_TIMEOUT_MS`，硬性 ≤ 30000，
 * 宿主 RPC 上限）与正整数 `maxResponseBytes`：宿主会先把整个响应体读进内存再返回。
 *
 * multipart 组装复用共享实现 `lib/multipart.mjs`（与 ASR 上传同一函数）。
 */

import { API_BASE_URL } from "./minimax/constants.mjs";
import { buildMultipartFormData } from "./multipart.mjs";
import {
  assertBaseRespOk,
  clampHostTimeout,
  hasBaseResp,
  httpError,
  parseJsonSafe,
  readResponseText,
  scrub,
  withAuth,
} from "./http-util.mjs";

export const FILE_UPLOAD_PATH = "/v1/files/upload";
export const FILE_RETRIEVE_PATH = "/v1/files/retrieve";
export const FILE_RETRIEVE_CONTENT_PATH = "/v1/files/retrieve_content";

export const FILE_PURPOSES = [
  "video_generation_input",
  "voice_clone",
  "prompt_audio",
  "t2a_async_input",
];

/** 宿主 RPC 单次出站请求的硬性超时上限（毫秒）。 */
export const MAX_HOST_TIMEOUT_MS = 30000;

/** JSON 信封响应体预算（上传 / 检索的元信息都很小）。 */
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
/** 文件内容响应体预算（异步 TTS 成品音频 / SRT 可能较大）。 */
const MAX_CONTENT_RESPONSE_BYTES = 32 * 1024 * 1024;

/** fetch 必须由注入提供；缺失或非函数即抛错，绝不回退 globalThis.fetch。 */
function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Files 客户端需要一个注入的 fetch 实现（不会回退 globalThis.fetch）");
  }
}

/**
 * 校验 Files 信封：返回解析后的 JSON，任何错误形态都抛错（已脱敏）。
 * 要求 HTTP 2xx 且信封状态码为 0（语义单源 `assertBaseRespOk`）。
 */
function unwrapEnvelope(response, text, label) {
  if (!response.ok) {
    throw httpError({ label, status: response.status, text, defaultLabel: label });
  }
  return assertBaseRespOk(parseJsonSafe(text), { label });
}

/**
 * 上传本地素材，返回云端 `file_id` 与元信息。
 *
 * @returns {Promise<{fileId: string, bytes: number, filename: string|undefined, purpose: string}>}
 */
export async function uploadFile({
  fetch: fetchImpl,
  auth,
  purpose,
  bytes,
  fileName = "file.bin",
  mimeType = "application/octet-stream",
  timeoutMs,
  baseUrl = API_BASE_URL,
} = {}) {
  requireFetch(fetchImpl);

  // purpose 白名单必须在任何网络调用之前校验。
  if (!FILE_PURPOSES.includes(purpose)) {
    throw new Error(
      `Files 上传失败：未知 purpose "${purpose}"，允许值：${FILE_PURPOSES.join(", ")}`,
    );
  }
  if (bytes === undefined || bytes === null) {
    throw new Error("Files 上传失败：必须提供要上传的字节 (bytes)");
  }

  const { bodyBuffer, contentType } = buildMultipartFormData({
    fields: { purpose },
    files: [{ name: "file", filename: fileName, mimeType, buffer: bytes }],
  });

  const headers = withAuth(
    {
      "Content-Type": contentType,
      "Content-Length": String(bodyBuffer.length),
    },
    auth,
  );

  const response = await fetchImpl(`${baseUrl}${FILE_UPLOAD_PATH}`, {
    method: "POST",
    headers,
    body: bodyBuffer,
    timeoutMs: clampHostTimeout(timeoutMs, MAX_HOST_TIMEOUT_MS),
    maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
  });

  const text = await readResponseText(response);
  const json = unwrapEnvelope(response, text, "Files 上传失败");

  const file = json.file;
  if (!file || !file.file_id) {
    throw new Error(scrub("Files 上传失败：响应缺少 file.file_id"));
  }

  return {
    fileId: file.file_id,
    bytes: typeof file.bytes === "number" ? file.bytes : Buffer.byteLength(bytes),
    filename: file.filename ?? fileName,
    purpose: file.purpose ?? purpose,
  };
}

/**
 * 检索文件元信息（含 `download_url`）。
 *
 * @returns {Promise<{downloadUrl: string|undefined, bytes: number|undefined, filename: string|undefined, purpose: string|undefined}>}
 */
export async function retrieveFile({
  fetch: fetchImpl,
  auth,
  fileId,
  timeoutMs,
  baseUrl = API_BASE_URL,
} = {}) {
  requireFetch(fetchImpl);
  if (!fileId) {
    throw new Error("Files 检索失败：必须提供 fileId");
  }

  const url = `${baseUrl}${FILE_RETRIEVE_PATH}?file_id=${encodeURIComponent(fileId)}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: withAuth({}, auth),
    timeoutMs: clampHostTimeout(timeoutMs, MAX_HOST_TIMEOUT_MS),
    maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
  });

  const text = await readResponseText(response);
  const json = unwrapEnvelope(response, text, "Files 检索失败");
  const file = json.file || {};

  return {
    downloadUrl: file.download_url,
    bytes: file.bytes,
    filename: file.filename,
    purpose: file.purpose,
  };
}

/**
 * 取回文件二进制内容（异步 TTS 成品音频 / SRT 等）。
 *
 * @returns {Promise<Buffer>}
 */
export async function retrieveContent({
  fetch: fetchImpl,
  auth,
  fileId,
  timeoutMs,
  baseUrl = API_BASE_URL,
} = {}) {
  requireFetch(fetchImpl);
  if (!fileId) {
    throw new Error("Files 取内容失败：必须提供 fileId");
  }

  const url = `${baseUrl}${FILE_RETRIEVE_CONTENT_PATH}?file_id=${encodeURIComponent(fileId)}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: withAuth({}, auth),
    timeoutMs: clampHostTimeout(timeoutMs, MAX_HOST_TIMEOUT_MS),
    maxResponseBytes: MAX_CONTENT_RESPONSE_BYTES,
  });

  if (!response.ok) {
    const text = await readResponseText(response);
    throw httpError({ label: "Files 取内容失败", status: response.status, text, defaultLabel: "Files 取内容失败" });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 某些失败以 HTTP 200 + JSON 错误信封返回；不能把错误信封当成音频字节。
  // 内容主体是二进制、可以合法地不带信封，因此仅当信封存在时才校验。
  const maybeJson = parseJsonSafe(buffer.toString("utf-8"));
  if (hasBaseResp(maybeJson)) {
    assertBaseRespOk(maybeJson, { label: "Files 取内容失败" });
  }

  return buffer;
}
