/**
 * lib/speech-client.mjs
 *
 * MiniMax 语音网络通信层：
 * - synthesizeSpeech: 文本转语音 (T2A / TTS)
 * - transcribeSpeech: 语音转文本 (ASR / STT)
 *
 * `fetch` **由注入提供**（adapter / 工具层传 `ctx.network.fetch`）：缺失即抛错，
 * 绝不回退 `globalThis.fetch`——那会绕开宿主网络桥与 manifest `allowedHosts` 策略。
 * 每次出站请求都显式声明 `timeoutMs`（≤ 30000，宿主 RPC 硬上限）与
 * `maxResponseBytes`：宿主会先把整个响应体读进内存再返回。
 *
 * 采用原生 Buffer 手动组装 RFC 7578 标准 multipart/form-data，
 * 彻底避免跨进程 JSON-RPC 沙箱将 FormData 序列化为空对象的问题。
 */

import {
  API_BASE_URL,
  TTS_PATH,
  ASR_PATH,
  REQUEST_TIMEOUT_MS,
  MAX_JSON_RESPONSE_BYTES,
  MAX_TTS_RESPONSE_BYTES,
  buildTtsRequestBody,
  decodeHexAudio,
  validateAsrParams,
} from "./speech-api.mjs";

// multipart 组装已抽成共享实现（lib/multipart.mjs）：此处导入供本模块内部调用，
// 并再导出以保持导出名与外部行为不变（tests/speech-client.test.mjs 仍从本模块取该函数）。
import { buildMultipartFormData } from "./multipart.mjs";
export { buildMultipartFormData } from "./multipart.mjs";
import { scrub, withAuth } from "./http-util.mjs";

async function parseResponseText(response) {
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

function formatApiError(status, text, defaultLabel = "MiniMax API 错误") {
  const json = parseJson(text);
  const msg =
    json?.base_resp?.status_msg ||
    json?.error?.message ||
    json?.message ||
    text.trim().slice(0, 300) ||
    defaultLabel;
  const err = new Error(scrub(`${defaultLabel} (${status}): ${msg}`));
  err.status = status;
  return err;
}

/** 上游以 HTTP 200 + `base_resp.status_code != 0` 表达的业务错误。 */
function formatEnvelopeError(label, json) {
  const code = json?.base_resp?.status_code;
  const msg = json?.base_resp?.status_msg || json?.error?.message || json?.message || "未知状态错误";
  const err = new Error(scrub(`${label} (${code}): ${msg}`));
  err.code = code;
  return err;
}

/** 判断一个 JSON 体是否为错误信封（携带非 0 的 base_resp.status_code）。 */
function isErrorEnvelope(json) {
  const code = json?.base_resp?.status_code;
  return code !== undefined && code !== null && code !== 0;
}

export function createMinimaxSpeechClient({ fetch: fetchImpl, baseUrl = API_BASE_URL } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createMinimaxSpeechClient 需要一个 fetch 实现（不会回退 globalThis.fetch）");
  }

  /**
   * 同步调用 TTS 语音合成
   */
  async function synthesizeSpeech({ auth, ...ttsParams } = {}) {
    const body = buildTtsRequestBody(ttsParams);
    const url = `${baseUrl}${TTS_PATH}`;

    const headers = withAuth({ "Content-Type": "application/json" }, auth);

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_TTS_RESPONSE_BYTES,
    });

    const text = await parseResponseText(response);
    if (!response.ok) {
      throw formatApiError(response.status, text, "语音合成失败");
    }

    const json = parseJson(text);
    if (!json) {
      throw new Error("语音合成接口返回了无效的 JSON 响应");
    }

    if (isErrorEnvelope(json)) {
      throw formatEnvelopeError("MiniMax TTS 错误", json);
    }

    const data = json.data || {};
    const extraInfo = json.extra_info || {};

    let audioBuffer = null;
    let audioUrl = data.audio_url || null;

    if (data.audio) {
      audioBuffer = decodeHexAudio(data.audio);
    }

    return {
      audioBuffer,
      audioUrl,
      audioLengthMs: extraInfo.audio_length || 0,
      sampleRate: extraInfo.audio_sample_rate || body.audio_setting.sample_rate,
      format: extraInfo.audio_format || body.audio_setting.format,
      wordCount: extraInfo.word_count || 0,
      subtitles: json.subtitle || null,
      traceId: json.trace_id,
    };
  }

  /**
   * 调用 ASR 语音识别
   */
  async function transcribeSpeech({
    auth,
    audioBuffer,
    fileName = "input.m4a",
    mimeType = "audio/mp4",
    ...asrParams
  } = {}) {
    if (!audioBuffer || !(audioBuffer instanceof Uint8Array || Buffer.isBuffer(audioBuffer))) {
      throw new Error("语音识别必须提供有效的音频二进制 Buffer (audioBuffer)");
    }

    const params = validateAsrParams(asrParams);
    const url = `${baseUrl}${ASR_PATH}`;

    // 使用原生 Buffer 组装 multipart，确保跨沙箱 RPC 传输安全
    const { bodyBuffer, contentType } = buildMultipartFormData({
      fields: {
        model: params.model,
        response_format: params.response_format,
        timestamp_level: params.timestamp_level,
        stream: params.stream,
      },
      files: [
        {
          name: "file",
          filename: fileName,
          mimeType,
          buffer: audioBuffer,
        },
      ],
    });

    const headers = withAuth(
      {
        "Content-Type": contentType,
        "Content-Length": String(bodyBuffer.length),
      },
      auth,
    );

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: bodyBuffer,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
    });

    const text = await parseResponseText(response);
    if (!response.ok) {
      throw formatApiError(response.status, text, "语音识别失败");
    }

    const json = parseJson(text);

    if (params.response_format === "srt" || params.response_format === "vtt") {
      // 先校验错误信封，再做格式返回：字幕是纯文本，任何 JSON 体都只能是错误信封，
      // 绝不能被当作「成功字幕」交给模型。此前该分支在校验之前 return，
      // 一个 HTTP 200 的错误信封会被原样当作转写结果。
      if (json) {
        if (isErrorEnvelope(json)) throw formatEnvelopeError("MiniMax ASR 错误", json);
        throw new Error(
          scrub(
            `MiniMax ASR 错误：期望 ${params.response_format} 字幕文本，却收到 JSON 响应 ${
              json?.message ? `(${json.message})` : ""
            }`,
          ),
        );
      }
      return {
        format: params.response_format,
        subtitleContent: text,
      };
    }

    if (!json) {
      // 非 JSON 体（HTML 错误页 / 网关通告）不是转写结果，报错而不是伪装成文本。
      throw new Error(
        scrub(`语音识别接口返回了无效的 JSON 响应：${text.trim().slice(0, 200) || "(空响应)"}`),
      );
    }

    if (isErrorEnvelope(json)) {
      throw formatEnvelopeError("MiniMax ASR 错误", json);
    }

    return {
      text: json.text || "",
      duration: json.duration || 0,
      segments: json.segments || [],
      traceId: json.trace_id,
    };
  }

  return {
    synthesizeSpeech,
    transcribeSpeech,
  };
}
