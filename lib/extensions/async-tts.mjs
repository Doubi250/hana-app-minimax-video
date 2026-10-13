/**
 * lib/extensions/async-tts.mjs
 *
 * 长篇异步 TTS 扩展（隐藏能力：**不** `ctx.tools.register`，只经 CLI 暴露）。
 *
 * 流程：长文按章节/长度切片 → 每片独立提交一个任务（`POST /v1/t2a_async_v2`），
 * 文本可直传 `text`，超长片经 `t2a_async_input` 上传取 `text_file_id`（避开请求体与
 * 宿主 RPC 上限）→ `GET /v1/query/t2a_async_query_v2?task_id=` 轮询（状态映射
 * processing→pending / success→done / failed|expired→failed）→ 完成后
 * `GET /v1/files/retrieve_content?file_id=`（或经 `download_url` 分片下载）取音频，
 * `subtitle_enable` 时另取 SRT。
 *
 * 切片之间互不牵连：单片提交 / 轮询 / 取回失败只记在该片记录上，不影响其余片。
 *
 * `fetch` 由注入提供，缺失即抛错（绝不回退 `globalThis.fetch`）；每次出站请求显式
 * 声明 `timeoutMs`（≤ `MAX_ASYNC_TIMEOUT_MS` = 30000，宿主 RPC 硬上限）与正整数
 * `maxResponseBytes`。
 */

import fs from "node:fs";
import path from "node:path";

import { API_BASE_URL } from "../minimax-api.mjs";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_ID,
  DEFAULT_TTS_FORMAT,
  normaliseTtsFormat,
  ttsFileExtension,
} from "../speech-api.mjs";
import {
  uploadFile,
  retrieveFile,
  retrieveContent,
} from "../files-client.mjs";
import { assertBaseRespOk, scrub, withAuth } from "../http-util.mjs";
import { downloadToFile } from "../minimax-client.mjs";

/* ------------------------------------------------------------------ *
 * 接口路径与常量
 * ------------------------------------------------------------------ */

export const ASYNC_TTS_CREATE_PATH = "/v1/t2a_async_v2";
export const ASYNC_TTS_QUERY_PATH = "/v1/query/t2a_async_query_v2";
export const ASYNC_TTS_PURPOSE = "t2a_async_input";

/** 宿主 RPC 单次出站请求的硬性超时上限（毫秒）。 */
export const MAX_ASYNC_TIMEOUT_MS = 30000;
/** JSON 信封响应预算。 */
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * 轮询下界：查询接口上限 10 次/秒，轮询间隔必须严格高于该限制（取 1000ms = 1 次/秒）。
 */
export const QUERY_MIN_INTERVAL_MS = 1000;
export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** 单次直传 `text` 的字符上限；超过即改走上传。 */
export const ASYNC_TTS_DIRECT_TEXT_MAX_CHARS = 10000;
/** 单切片目标字符上限（切片前）。 */
export const ASYNC_TTS_SEGMENT_CHARS = 20000;

const CHAPTER_HEADING_RE = /^\s*(第[0-9一二三四五六七八九十百千零两]+[章节回卷篇]|#{1,6}\s)/;

/* ------------------------------------------------------------------ *
 * 纯逻辑
 * ------------------------------------------------------------------ */

/**
 * 把上游异步任务状态映射为内部三态。
 *
 * processing → pending；success → done；failed / expired → failed；未知/空 → pending。
 */
export function mapAsyncTaskStatus(status) {
  const raw = String(status ?? "").trim().toLowerCase();
  if (raw === "processing" || raw === "pending" || raw === "running" || raw === "queued") {
    return "pending";
  }
  if (raw === "success" || raw === "succeeded" || raw === "completed" || raw === "done") {
    return "done";
  }
  if (raw === "failed" || raw === "expired" || raw === "cancelled" || raw === "canceled") {
    return "failed";
  }
  return "pending";
}

/**
 * 组装 `POST /v1/t2a_async_v2` 请求体。文本可直传 `text`，或给 `textFileId`。
 */
export function buildAsyncTtsRequestBody({
  text,
  textFileId,
  model = DEFAULT_TTS_MODEL,
  voiceSetting = {},
  audioSetting = {},
  subtitleEnable = false,
  subtitleType = "sentence",
} = {}) {
  const hasText = typeof text === "string" && text.trim().length > 0;
  if (!hasText && !textFileId) {
    throw new Error("异步 TTS 需要 text 或 textFileId（二者至少提供一个）");
  }

  const body = {
    model: model || DEFAULT_TTS_MODEL,
  };
  if (textFileId) {
    body.text_file_id = String(textFileId);
  } else {
    body.text = text.trim();
  }

  body.voice_setting = {
    voice_id: voiceSetting.voiceId || DEFAULT_VOICE_ID,
    speed: Math.max(0.5, Math.min(2.0, Number(voiceSetting.speed) || 1.0)),
    vol: Math.max(0.1, Math.min(10.0, Number(voiceSetting.vol) || 1.0)),
    pitch: Math.max(-12, Math.min(12, Number(voiceSetting.pitch) || 0)),
  };

  body.audio_setting = {
    format: normaliseTtsFormat(audioSetting.format || DEFAULT_TTS_FORMAT),
    sample_rate: Number(audioSetting.sampleRate) || 32000,
    bitrate: Number(audioSetting.bitrate) || 128000,
    channel: 1,
  };

  if (subtitleEnable) {
    body.subtitle_enable = true;
    body.subtitle_type = subtitleType === "word" ? "word" : "sentence";
  }

  return body;
}

/**
 * 把长文切成若干片：优先在章节标题处断开，并按 `maxChars` 贪心打包；
 * 单行超过上限时硬切。返回的每一片长度都不超过 `maxChars`。
 */
export function planTextSegments(text, { maxChars = ASYNC_TTS_SEGMENT_CHARS } = {}) {
  if (typeof text !== "string" || !text.trim()) return [];

  const limit = Math.max(1, Math.floor(Number(maxChars)) || ASYNC_TTS_SEGMENT_CHARS);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  let current = "";

  const flush = () => {
    if (current.trim()) segments.push(current);
    current = "";
  };

  for (const line of lines) {
    if (!line.trim()) {
      if (current) current += "\n";
      continue;
    }
    if (CHAPTER_HEADING_RE.test(line) && current.trim()) flush();

    let rest = line;
    while (rest.length > 0) {
      if (current.length === 0 && rest.length > limit) {
        segments.push(rest.slice(0, limit));
        rest = rest.slice(limit);
        continue;
      }
      const sep = current.length > 0 ? "\n" : "";
      const room = limit - current.length - sep.length;
      if (room <= 0) {
        flush();
        continue;
      }
      if (rest.length <= room) {
        current += sep + rest;
        rest = "";
      } else {
        flush();
      }
    }
  }
  flush();
  return segments;
}

/* ------------------------------------------------------------------ *
 * 网络小工具
 * ------------------------------------------------------------------ */

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("异步 TTS 扩展需要一个注入的 fetch 实现（不会回退 globalThis.fetch）");
  }
}

function resolveTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  const candidate = Number.isFinite(n) && n > 0 ? n : MAX_ASYNC_TIMEOUT_MS;
  return Math.min(Math.floor(candidate), MAX_ASYNC_TIMEOUT_MS);
}

async function parseText(response) {
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

function unwrapEnvelope(response, text, label) {
  const json = parseJson(text);
  if (!response.ok) {
    const msg =
      json?.base_resp?.status_msg || json?.error?.message || json?.message || text.trim().slice(0, 300);
    const err = new Error(scrub(`${label} (${response.status}): ${msg || "未知错误"}`));
    err.status = response.status;
    throw err;
  }
  // 信封语义单源（lib/http-util.mjs 的 assertBaseRespOk）：HTTP 2xx 且
  // base_resp.status_code === 0 才算成功；status_code 缺失视为失败。
  // 此前本地实现把 undefined 当成功，与 voice-clone 相反。
  return assertBaseRespOk(json, { label });
}

/* ------------------------------------------------------------------ *
 * 扩展工厂
 * ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {Function} deps.fetch   注入的 fetch（必填）
 * @param {object}  [deps.auth]   凭证（{apiKey} 或 {headers}）
 * @param {Function}[deps.sleep]  可注入的 sleep（测试用；缺省 setTimeout）
 * @param {string}  [deps.baseUrl]
 */
export function createAsyncTtsExtension({
  fetch: fetchImpl,
  auth = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  baseUrl = API_BASE_URL,
} = {}) {
  requireFetch(fetchImpl);

  async function createTask({ body, requestTimeoutMs }) {
    const response = await fetchImpl(`${baseUrl}${ASYNC_TTS_CREATE_PATH}`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify(body),
      timeoutMs: resolveTimeout(requestTimeoutMs),
      maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
    });
    const text = await parseText(response);
    const json = unwrapEnvelope(response, text, "异步 TTS 创建失败");
    const taskId = json.task_id ?? json.task?.id ?? json.data?.task_id;
    if (!taskId) throw new Error(scrub("异步 TTS 创建失败：响应缺少 task_id"));
    return String(taskId);
  }

  async function queryOnce({ taskId, requestTimeoutMs }) {
    const url = `${baseUrl}${ASYNC_TTS_QUERY_PATH}?task_id=${encodeURIComponent(taskId)}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: withAuth({}, auth),
      timeoutMs: resolveTimeout(requestTimeoutMs),
      maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
    });
    const text = await parseText(response);
    const json = unwrapEnvelope(response, text, "异步 TTS 查询失败");
    const task = json.task && typeof json.task === "object" ? json.task : {};
    const rawStatus = json.status ?? task.status ?? "";
    const fileId = json.file_id ?? task.file_id ?? null;
    const subtitleFileId = json.subtitle_file_id ?? task.subtitle_file_id ?? null;
    const message = json.base_resp?.status_msg || task.error?.message || json.error?.message || "";
    return {
      status: mapAsyncTaskStatus(rawStatus),
      rawStatus: String(rawStatus),
      fileId: fileId ? String(fileId) : null,
      subtitleFileId: subtitleFileId ? String(subtitleFileId) : null,
      message: String(message ?? ""),
    };
  }

  /**
   * 逐片提交（每片一个任务）。单片失败只记在该片上，不抛出、不牵连其余片。
   */
  async function submitSegments({
    text,
    model = DEFAULT_TTS_MODEL,
    voiceId,
    format = DEFAULT_TTS_FORMAT,
    subtitleEnable = false,
    maxChars = ASYNC_TTS_SEGMENT_CHARS,
    directTextMaxChars = ASYNC_TTS_DIRECT_TEXT_MAX_CHARS,
    requestTimeoutMs,
  } = {}) {
    const pieces = planTextSegments(text, { maxChars });
    const directMax = Math.max(0, Math.floor(Number(directTextMaxChars)) || 0);
    const segments = [];

    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const record = { index, taskId: null, viaUpload: false, error: null };
      try {
        let textFileId;
        if (piece.length > directMax) {
          const uploaded = await uploadFile({
            fetch: fetchImpl,
            auth,
            purpose: ASYNC_TTS_PURPOSE,
            bytes: Buffer.from(piece, "utf-8"),
            fileName: `segment-${index + 1}.txt`,
            mimeType: "text/plain",
            timeoutMs: requestTimeoutMs,
            baseUrl,
          });
          textFileId = uploaded.fileId;
          record.viaUpload = true;
        }

        const body = buildAsyncTtsRequestBody({
          text: textFileId ? undefined : piece,
          textFileId,
          model,
          voiceSetting: { voiceId },
          audioSetting: { format },
          subtitleEnable,
        });
        record.taskId = await createTask({ body, requestTimeoutMs });
      } catch (error) {
        record.error = { code: error?.code ?? "SUBMIT_FAILED", message: scrub(error?.message || String(error)) };
      }
      segments.push(record);
    }

    return { segments };
  }

  /**
   * 轮询单个任务到终态（首个查询立即执行，其后按 `intervalMs` 等待）。
   */
  async function pollTask({
    taskId,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    requestTimeoutMs,
  } = {}) {
    const interval = Math.max(QUERY_MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const total = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + total;

    for (;;) {
      const polled = await queryOnce({ taskId, requestTimeoutMs });
      if (polled.status !== "pending") return polled;
      if (Date.now() + interval > deadline) {
        return { ...polled, status: "timeout", message: polled.message || "轮询超时" };
      }
      await sleep(interval);
    }
  }

  /**
   * 取回成品的音频与（可选）字幕，落盘到 `outDir`。
   */
  async function fetchArtifacts({
    fileId,
    subtitleFileId,
    outDir,
    format = DEFAULT_TTS_FORMAT,
    index = 0,
    requestTimeoutMs,
  } = {}) {
    const dir = path.resolve(outDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const audioFile = path.join(dir, `segment-${index + 1}${ttsFileExtension(format)}`);

    let written = false;
    try {
      const meta = await retrieveFile({ fetch: fetchImpl, auth, fileId, timeoutMs: requestTimeoutMs, baseUrl });
      if (meta?.downloadUrl) {
        await downloadToFile({ fetch: fetchImpl, url: meta.downloadUrl, partPath: audioFile });
        written = true;
      }
    } catch {
      written = false;
    }
    if (!written) {
      const buffer = await retrieveContent({ fetch: fetchImpl, auth, fileId, timeoutMs: requestTimeoutMs, baseUrl });
      await fs.promises.writeFile(audioFile, buffer);
    }

    let subtitleFile;
    if (subtitleFileId) {
      subtitleFile = path.join(dir, `segment-${index + 1}.srt`);
      const srt = await retrieveContent({
        fetch: fetchImpl,
        auth,
        fileId: subtitleFileId,
        timeoutMs: requestTimeoutMs,
        baseUrl,
      });
      await fs.promises.writeFile(subtitleFile, srt);
    }

    return { audioFile, subtitleFile };
  }

  /**
   * 端到端跑一整篇：提交 → 逐片轮询 → 取回。返回 `{ok, tasks, files, error?}`。
   */
  async function runJob({
    text,
    model = DEFAULT_TTS_MODEL,
    voiceId,
    format = DEFAULT_TTS_FORMAT,
    subtitleEnable = false,
    maxChars = ASYNC_TTS_SEGMENT_CHARS,
    directTextMaxChars = ASYNC_TTS_DIRECT_TEXT_MAX_CHARS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    requestTimeoutMs,
    outDir,
    logger = () => {},
  } = {}) {
    const { segments } = await submitSegments({
      text,
      model,
      voiceId,
      format,
      subtitleEnable,
      maxChars,
      directTextMaxChars,
      requestTimeoutMs,
    });
    logger(`共 ${segments.length} 片，已提交 ${segments.filter((s) => s.taskId).length} 片`);

    const tasks = [];
    const files = [];
    let firstError = null;

    for (const segment of segments) {
      if (segment.error || !segment.taskId) {
        const error = segment.error ?? { code: "SUBMIT_FAILED", message: "该片未取得 task_id" };
        tasks.push({ index: segment.index, taskId: null, viaUpload: segment.viaUpload, error });
        firstError = firstError ?? error;
        logger(`第 ${segment.index + 1} 片提交失败：${error.message}`);
        continue;
      }

      let polled;
      try {
        polled = await pollTask({
          taskId: segment.taskId,
          intervalMs: pollIntervalMs,
          timeoutMs: pollTimeoutMs,
          requestTimeoutMs,
        });
      } catch (error) {
        const err = { code: error?.code ?? "POLL_FAILED", message: scrub(error?.message || String(error)) };
        tasks.push({ index: segment.index, taskId: segment.taskId, error: err });
        firstError = firstError ?? err;
        logger(`第 ${segment.index + 1} 片轮询失败：${err.message}`);
        continue;
      }

      if (polled.status !== "done") {
        const err = {
          code: polled.status === "timeout" ? "POLL_TIMEOUT" : "TASK_FAILED",
          message: polled.message || `任务状态：${polled.rawStatus || polled.status}`,
        };
        tasks.push({ index: segment.index, taskId: segment.taskId, error: err });
        firstError = firstError ?? err;
        logger(`第 ${segment.index + 1} 片未成功（${polled.rawStatus || polled.status}）`);
        continue;
      }

      try {
        const { audioFile, subtitleFile } = await fetchArtifacts({
          fileId: polled.fileId,
          subtitleFileId: subtitleEnable ? polled.subtitleFileId : undefined,
          outDir,
          format,
          index: segment.index,
          requestTimeoutMs,
        });
        const record = { index: segment.index, taskId: segment.taskId, audioFile };
        if (subtitleFile) record.subtitleFile = subtitleFile;
        tasks.push(record);
        files.push(audioFile);
        if (subtitleFile) files.push(subtitleFile);
        logger(`第 ${segment.index + 1} 片完成：${audioFile}`);
      } catch (error) {
        const err = { code: error?.code ?? "FETCH_FAILED", message: scrub(error?.message || String(error)) };
        tasks.push({ index: segment.index, taskId: segment.taskId, error: err });
        firstError = firstError ?? err;
        logger(`第 ${segment.index + 1} 片取回失败：${err.message}`);
      }
    }

    const ok = !firstError && tasks.length > 0 && tasks.every((t) => !t.error);
    if (ok) return { ok: true, tasks, files };
    return {
      ok: false,
      error: firstError ?? { code: "NO_SEGMENTS", message: "没有可提交的文本切片" },
      tasks,
      files,
    };
  }

  return {
    submitSegments,
    pollTask,
    fetchArtifacts,
    runJob,
  };
}
