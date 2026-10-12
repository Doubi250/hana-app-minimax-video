import test from "node:test";
import assert from "node:assert/strict";
import { createMinimaxSpeechClient } from "../lib/speech-client.mjs";
import { REQUEST_TIMEOUT_MS, MAX_ASR_FILE_BYTES } from "../lib/speech-api.mjs";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

test("createMinimaxSpeechClient: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", () => {
  assert.throws(() => createMinimaxSpeechClient(), /需要一个 fetch 实现/);
  assert.throws(() => createMinimaxSpeechClient({}), /需要一个 fetch 实现/);
  assert.throws(() => createMinimaxSpeechClient({ fetch: null }), /需要一个 fetch 实现/);
  // 即使宿主环境存在 globalThis.fetch，也绝不静默启用。
  assert.equal(typeof globalThis.fetch, "function");
  assert.throws(() => createMinimaxSpeechClient({ fetch: 123 }), /需要一个 fetch 实现/);
});

test("synthesizeSpeech: 成功发送并解析 hex 音频", async () => {
  let capturedUrl = "";
  let capturedBody = null;
  let capturedHeaders = null;
  let capturedInit = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedInit = options;
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;

    const mockRespData = {
      data: {
        audio: "4d696e694d617820545453", // "MiniMax TTS"
        status: 2,
      },
      extra_info: {
        audio_length: 2500,
        audio_sample_rate: 32000,
        audio_format: "mp3",
        word_count: 5,
      },
      base_resp: {
        status_code: 0,
        status_msg: "success",
      },
      trace_id: "trace-tts-001",
    };

    return jsonResponse(mockRespData);
  };

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  const result = await client.synthesizeSpeech({
    auth: { apiKey: "test-token" },
    text: "你好测试",
    voiceId: "female-yujie",
  });

  assert.match(capturedUrl, /\/v1\/t2a_v2$/);
  assert.equal(capturedHeaders["Authorization"], "Bearer test-token");
  assert.equal(capturedBody.text, "你好测试");
  assert.equal(capturedBody.voice_setting.voice_id, "female-yujie");

  // 每次出站请求都显式带超时与响应上限。
  assert.equal(capturedInit.timeoutMs, REQUEST_TIMEOUT_MS);
  assert.ok(capturedInit.timeoutMs <= 30000);
  assert.ok(Number.isFinite(capturedInit.maxResponseBytes) && capturedInit.maxResponseBytes > 0);

  assert.ok(result.audioBuffer);
  assert.equal(result.audioBuffer.toString("utf-8"), "MiniMax TTS");
  assert.equal(result.audioLengthMs, 2500);
  assert.equal(result.format, "mp3");
});

test("transcribeSpeech: 成功上传并解析识别结果", async () => {
  let capturedUrl = "";
  let capturedHeaders = null;
  let capturedInit = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    capturedInit = options;

    const mockRespData = {
      text: "今天天气很好",
      duration: 3.5,
      trace_id: "trace-asr-002",
      base_resp: {
        status_code: 0,
        status_msg: "success",
      },
    };

    return jsonResponse(mockRespData);
  };

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  const fakeAudio = Buffer.from("fake-mp3-stream");

  const result = await client.transcribeSpeech({
    auth: { apiKey: "test-token" },
    audioBuffer: fakeAudio,
    fileName: "speech.mp3",
    responseFormat: "json",
  });

  assert.match(capturedUrl, /\/v1\/speech_to_text$/);
  assert.equal(capturedHeaders["Authorization"], "Bearer test-token");
  assert.equal(result.text, "今天天气很好");
  assert.equal(result.duration, 3.5);

  // ASR 同样显式声明超时（≤30000）与响应上限。
  assert.ok(capturedInit.timeoutMs <= 30000);
  assert.ok(Number.isFinite(capturedInit.maxResponseBytes) && capturedInit.maxResponseBytes > 0);
});

test("transcribeSpeech srt: 错误信封在返回字幕之前被拦截", async () => {
  // HTTP 200 + 非 0 base_resp.status_code：绝不能把错误 JSON 当成功字幕返回。
  const mockFetch = async () =>
    jsonResponse({
      base_resp: { status_code: 1002, status_msg: "rate limit exceeded" },
    });

  const client = createMinimaxSpeechClient({ fetch: mockFetch });

  await assert.rejects(
    () =>
      client.transcribeSpeech({
        auth: { apiKey: "t" },
        audioBuffer: Buffer.from("audio"),
        fileName: "speech.mp3",
        responseFormat: "srt",
      }),
    (err) => {
      assert.match(err.message, /MiniMax ASR 错误/);
      assert.match(err.message, /1002/);
      assert.match(err.message, /rate limit exceeded/);
      assert.equal(err.code, 1002);
      // 关键：错误对象上没有 subtitleContent —— 错误从未被当作字幕内容。
      assert.equal(err.subtitleContent, undefined);
      return true;
    },
  );
});

test("transcribeSpeech vtt: 错误信封同样被拦截，且不返回字幕", async () => {
  const mockFetch = async () =>
    jsonResponse({
      base_resp: { status_code: 2013, status_msg: "invalid audio" },
    });

  const client = createMinimaxSpeechClient({ fetch: mockFetch });

  await assert.rejects(
    () =>
      client.transcribeSpeech({
        audioBuffer: Buffer.from("audio"),
        responseFormat: "vtt",
      }),
    /MiniMax ASR 错误.*2013/,
  );
});

test("transcribeSpeech srt: 非错误信封的 JSON 也不当作字幕返回", async () => {
  // 字幕是纯文本；此分支出现 JSON 即非预期，报错而非把 JSON 原样当字幕。
  const mockFetch = async () => jsonResponse({ message: "unexpected json body" });
  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  await assert.rejects(
    () => client.transcribeSpeech({ audioBuffer: Buffer.from("audio"), responseFormat: "srt" }),
    /却收到 JSON 响应/,
  );
});

test("transcribeSpeech srt: 正常字幕文本（非 JSON）照常返回", async () => {
  const srt = "1\n00:00:00,000 --> 00:00:02,000\n你好\n";
  const mockFetch = async () => jsonResponse(srt);

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  const result = await client.transcribeSpeech({
    audioBuffer: Buffer.from("audio"),
    responseFormat: "srt",
  });

  assert.equal(result.format, "srt");
  assert.equal(result.subtitleContent, srt);
});

test("transcribeSpeech json: 非 JSON body 报错，不伪装成转写文本", async () => {
  const mockFetch = async () => jsonResponse("<html>502 Bad Gateway</html>");

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  await assert.rejects(
    () =>
      client.transcribeSpeech({
        audioBuffer: Buffer.from("audio"),
        responseFormat: "json",
      }),
    /无效的 JSON 响应/,
  );
});

test("transcribeSpeech: JSON 错误信封在 json 分支同样报错", async () => {
  const mockFetch = async () =>
    jsonResponse({ base_resp: { status_code: 1004, status_msg: "invalid api key" } });

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  await assert.rejects(
    () => client.transcribeSpeech({ audioBuffer: Buffer.from("audio") }),
    /MiniMax ASR 错误.*1004/,
  );
});

test("synthesizeSpeech: 错误信封报错且错误文本脱敏", async () => {
  const mockFetch = async () =>
    jsonResponse({
      base_resp: { status_code: 1004, status_msg: "invalid key Bearer sk-abcdef123456" },
    });

  const client = createMinimaxSpeechClient({ fetch: mockFetch });
  await assert.rejects(
    () => client.synthesizeSpeech({ auth: { apiKey: "k" }, text: "hi" }),
    (err) => {
      assert.match(err.message, /MiniMax TTS 错误.*1004/);
      assert.match(err.message, /Bearer \[redacted\]/);
      assert.doesNotMatch(err.message, /sk-abcdef123456/);
      return true;
    },
  );
});

test("transcribeSpeech: 缺少音频二进制即抛错", async () => {
  const client = createMinimaxSpeechClient({ fetch: async () => jsonResponse({}) });
  await assert.rejects(() => client.transcribeSpeech({}), /音频二进制 Buffer/);
});

test("buildMultipartFormData: 字段与文件按 RFC 7578 装配", async () => {
  const { buildMultipartFormData } = await import("../lib/speech-client.mjs");
  const { bodyBuffer, contentType } = buildMultipartFormData({
    fields: { model: "asr-1.0", response_format: "json" },
    files: [{ name: "file", filename: "a.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("XYZ") }],
  });
  const text = bodyBuffer.toString("utf-8");
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.match(text, /name="model"\r\n\r\nasr-1\.0/);
  assert.match(text, /filename="a\.mp3"/);
  assert.match(text, /Content-Type: audio\/mpeg/);
  assert.ok(text.includes("XYZ"));
  assert.match(text, /--\r\n$/);
});

test("预算常量可被工具层消费：MAX_ASR_FILE_BYTES 不再是死代码", () => {
  assert.equal(MAX_ASR_FILE_BYTES, 12 * 1024 * 1024);
});
