import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import {
  ASYNC_TTS_CREATE_PATH,
  ASYNC_TTS_QUERY_PATH,
  ASYNC_TTS_PURPOSE,
  ASYNC_TTS_DIRECT_TEXT_MAX_CHARS,
  ASYNC_TTS_SEGMENT_CHARS,
  QUERY_MIN_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_ASYNC_TIMEOUT_MS,
  mapAsyncTaskStatus,
  buildAsyncTtsRequestBody,
  planTextSegments,
  createAsyncTtsExtension,
} from "../lib/extensions/async-tts.mjs";
import { parseArgs, main as cliMain } from "../scripts/ext-async-tts.mjs";

/* ---------------------------------------------------------------- *
 * 响应替身 / 工具
 * ---------------------------------------------------------------- */

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok,
    status,
    async text() {
      return text;
    },
    async arrayBuffer() {
      const u8 = new TextEncoder().encode(text);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

function binaryResponse(bytes, { ok = true, status = 200, headers = {} } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    async text() {
      return Buffer.from(u8).toString("utf-8");
    },
    async arrayBuffer() {
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

function capture() {
  let buffer = "";
  return {
    stream: {
      write(chunk) {
        buffer += String(chunk);
        return true;
      },
    },
    text: () => buffer,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mms-async-tts-"));
}

const OK_ENVELOPE = { base_resp: { status_code: 0, status_msg: "success" } };

/* ---------------------------------------------------------------- *
 * 轮询状态映射（含 expired → 失败）
 * ---------------------------------------------------------------- */

test("mapAsyncTaskStatus: processing→pending / success→done / failed→failed / expired→failed", () => {
  assert.equal(mapAsyncTaskStatus("processing"), "pending");
  assert.equal(mapAsyncTaskStatus("Processing"), "pending");
  assert.equal(mapAsyncTaskStatus("success"), "done");
  assert.equal(mapAsyncTaskStatus("Success"), "done");
  assert.equal(mapAsyncTaskStatus("failed"), "failed");
  assert.equal(mapAsyncTaskStatus("Failed"), "failed");
  assert.equal(mapAsyncTaskStatus("expired"), "failed");
  assert.equal(mapAsyncTaskStatus("Expired"), "failed");
  assert.equal(mapAsyncTaskStatus(""), "pending");
});

/* ---------------------------------------------------------------- *
 * 提交体装配
 * ---------------------------------------------------------------- */

test("buildAsyncTtsRequestBody: 直传 text 装配 model / voice_setting / audio_setting", () => {
  const body = buildAsyncTtsRequestBody({
    text: "你好世界",
    model: "speech-2.8-hd",
    voiceSetting: { voiceId: "female-yujie", speed: 1.2 },
    audioSetting: { format: "mp3", sampleRate: 32000 },
  });
  assert.equal(body.model, "speech-2.8-hd");
  assert.equal(body.text, "你好世界");
  assert.equal(body.text_file_id, undefined);
  assert.equal(body.voice_setting.voice_id, "female-yujie");
  assert.equal(body.voice_setting.speed, 1.2);
  assert.equal(body.audio_setting.format, "mp3");
  assert.equal(body.subtitle_enable, undefined);
});

test("buildAsyncTtsRequestBody: subtitle_enable 时携带 subtitle_type", () => {
  const body = buildAsyncTtsRequestBody({ text: "abc", subtitleEnable: true, subtitleType: "word" });
  assert.equal(body.subtitle_enable, true);
  assert.equal(body.subtitle_type, "word");
});

test("buildAsyncTtsRequestBody: text_file_id 形态不携带 text", () => {
  const body = buildAsyncTtsRequestBody({ textFileId: "file-xyz", model: "speech-2.8-turbo" });
  assert.equal(body.text_file_id, "file-xyz");
  assert.equal(body.text, undefined);
});

test("buildAsyncTtsRequestBody: 既无 text 又无 textFileId 即抛错", () => {
  assert.throws(() => buildAsyncTtsRequestBody({}), /text/);
});

/* ---------------------------------------------------------------- *
 * 切片
 * ---------------------------------------------------------------- */

test("planTextSegments: 按章节与长度切片，逐片均不超上限", () => {
  const text = ["第一章 开始", "甲".repeat(30), "", "第二章 继续", "乙".repeat(30)].join("\n");
  const segments = planTextSegments(text, { maxChars: 40 });
  assert.ok(segments.length >= 2, `期望至少两片，实际 ${segments.length}`);
  for (const seg of segments) {
    assert.ok(seg.length <= 40, `切片长度 ${seg.length} 超过上限`);
  }
  assert.ok(segments.join("").includes("第一章"));
  assert.ok(segments.join("").includes("第二章"));
});

test("planTextSegments: 空文本返回空数组", () => {
  assert.deepEqual(planTextSegments("   "), []);
  assert.deepEqual(planTextSegments(undefined), []);
});

/* ---------------------------------------------------------------- *
 * 扩展工厂
 * ---------------------------------------------------------------- */

test("createAsyncTtsExtension: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", () => {
  assert.throws(() => createAsyncTtsExtension({}), /fetch/);
  assert.throws(() => createAsyncTtsExtension({ fetch: null }), /fetch/);
  assert.equal(typeof globalThis.fetch, "function");
});

test("submitSegments: 短文本直传 text，不触发上传", async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes(ASYNC_TTS_CREATE_PATH)) {
      return jsonResponse({ task_id: "t-direct", ...OK_ENVELOPE });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" } });
  const result = await ext.submitSegments({ text: "短文本", maxChars: 1000, directTextMaxChars: 10000 });

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].taskId, "t-direct");
  assert.equal(result.segments[0].viaUpload, false);

  const create = calls.find((c) => c.url.includes(ASYNC_TTS_CREATE_PATH));
  assert.equal(create.url, `https://api.minimax.cn${ASYNC_TTS_CREATE_PATH}`);
  assert.equal(create.options.method, "POST");
  const body = JSON.parse(create.options.body);
  assert.equal(body.text, "短文本");
  assert.equal(body.text_file_id, undefined);
  assert.equal(body.model, "speech-2.8-hd");
  assert.ok(body.voice_setting && body.audio_setting, "必须含 voice_setting / audio_setting");
});

test("submitSegments: 超长切片经 t2a_async_input 上传取 text_file_id", async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/v1/files/upload")) {
      return jsonResponse({ file: { file_id: "file-up-1", bytes: 12 }, ...OK_ENVELOPE });
    }
    if (url.includes(ASYNC_TTS_CREATE_PATH)) {
      return jsonResponse({ task_id: "t-upload", ...OK_ENVELOPE });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" } });
  const longText = "长".repeat(50);
  const result = await ext.submitSegments({ text: longText, maxChars: 1000, directTextMaxChars: 10 });

  assert.equal(result.segments[0].viaUpload, true);
  assert.equal(result.segments[0].taskId, "t-upload");

  const upload = calls.find((c) => c.url.includes("/v1/files/upload"));
  assert.ok(upload, "超长文本必须走上传");
  const uploadBody = Buffer.isBuffer(upload.options.body)
    ? upload.options.body.toString("utf-8")
    : String(upload.options.body);
  assert.match(uploadBody, new RegExp(`name="purpose"\\r\\n\\r\\n${ASYNC_TTS_PURPOSE}`));

  const create = calls.find((c) => c.url.includes(ASYNC_TTS_CREATE_PATH));
  const body = JSON.parse(create.options.body);
  assert.equal(body.text_file_id, "file-up-1");
  assert.equal(body.text, undefined);
});

test("submitSegments: 切片互不牵连——中间片失败不影响其余片", async () => {
  let createCount = 0;
  const mockFetch = async (url) => {
    if (url.includes(ASYNC_TTS_CREATE_PATH)) {
      createCount += 1;
      if (createCount === 2) {
        return jsonResponse({ base_resp: { status_code: 1004, status_msg: "boom" } });
      }
      return jsonResponse({ task_id: `t-${createCount}`, ...OK_ENVELOPE });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" } });
  const text = ["甲".repeat(20), "", "乙".repeat(20), "", "丙".repeat(20)].join("\n");
  const result = await ext.submitSegments({ text, maxChars: 25, directTextMaxChars: 1000 });

  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[0].taskId, "t-1");
  assert.ok(result.segments[1].error, "第二片应记录错误而不是抛出");
  assert.equal(result.segments[1].taskId, null);
  assert.equal(result.segments[2].taskId, "t-3");
  assert.equal(createCount, 3, "失败片不得阻止后续片提交");
});

/* ---------------------------------------------------------------- *
 * 信封语义（ticket 10 / D）：base_resp.status_code 缺失视为失败
 * ---------------------------------------------------------------- */

test("async-tts: base_resp.status_code 缺失（undefined）视为失败，不当作成功", async () => {
  const mockFetch = async (url) => {
    if (url.includes(ASYNC_TTS_CREATE_PATH)) {
      // HTTP 200 但没有 base_resp——不是 MiniMax 的成功响应。
      return jsonResponse({ task_id: "t-no-envelope" });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" } });
  const result = await ext.submitSegments({ text: "x", directTextMaxChars: 1000 });

  assert.ok(result.segments[0].error, "status_code 缺失必须记为失败");
  assert.equal(result.segments[0].taskId, null);
});

test("async-tts: 查询响应缺 base_resp 同样抛错（undefined → 失败）", async () => {
  const mockFetch = async () => jsonResponse({ task_id: "t", status: "Success", file_id: "a" });
  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" }, sleep: async () => {} });

  await assert.rejects(() => ext.pollTask({ taskId: "t" }), /异步 TTS 查询失败/);
});

test("async-tts: unwrapEnvelope 语义与 assertBaseRespOk 单源一致", async () => {
  const source = fs.readFileSync(path.join(appRoot, "lib", "extensions", "async-tts.mjs"), "utf8");
  assert.match(
    source,
    /assertBaseRespOk\(json, \{ label \}\)/,
    "async-tts 的 unwrapEnvelope 必须调用共享的 assertBaseRespOk",
  );
  assert.doesNotMatch(
    source,
    /code !== undefined && code !== null && code !== 0/,
    "旧的（把 undefined 当成功的）判定必须已删除",
  );
});

/* ---------------------------------------------------------------- *
 * 轮询
 * ---------------------------------------------------------------- */

test("pollTask: Expired 映射为 failed，查询 URL 与状态如实返回", async () => {
  const seen = [];
  const mockFetch = async (url, options) => {
    seen.push({ url, options });
    return jsonResponse({ task_id: "t-1", status: "Expired", ...OK_ENVELOPE });
  };

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" }, sleep: async () => {} });
  const polled = await ext.pollTask({ taskId: "t-1" });

  assert.equal(polled.status, "failed");
  assert.equal(polled.rawStatus, "Expired");
  assert.equal(
    seen[0].url,
    `https://api.minimax.cn${ASYNC_TTS_QUERY_PATH}?task_id=t-1`,
  );
});

test("pollTask: Success → done 并返回 file_id / subtitle_file_id", async () => {
  const mockFetch = async () =>
    jsonResponse({
      task_id: "t-2",
      status: "Success",
      file_id: "audio-9",
      subtitle_file_id: "sub-9",
      ...OK_ENVELOPE,
    });

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" }, sleep: async () => {} });
  const polled = await ext.pollTask({ taskId: "t-2" });

  assert.equal(polled.status, "done");
  assert.equal(polled.fileId, "audio-9");
  assert.equal(polled.subtitleFileId, "sub-9");
});

test("pollTask: processing 后 Success，轮询间隔不低于查询下限", async () => {
  let n = 0;
  const mockFetch = async () => {
    n += 1;
    if (n < 2) return jsonResponse({ task_id: "t-3", status: "Processing", ...OK_ENVELOPE });
    return jsonResponse({ task_id: "t-3", status: "Success", file_id: "a", ...OK_ENVELOPE });
  };
  const waits = [];
  const ext = createAsyncTtsExtension({
    fetch: mockFetch,
    auth: { apiKey: "k" },
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  const polled = await ext.pollTask({ taskId: "t-3", intervalMs: 5, timeoutMs: 60_000 });
  assert.equal(polled.status, "done");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= QUERY_MIN_INTERVAL_MS, `轮询间隔 ${waits[0]}ms 低于下限 ${QUERY_MIN_INTERVAL_MS}ms`);
});

/* ---------------------------------------------------------------- *
 * 出站预算
 * ---------------------------------------------------------------- */

test("所有出站请求显式声明 timeoutMs(≤30000) 与正整数 maxResponseBytes", async () => {
  const seen = [];
  const mockFetch = async (url, options) => {
    seen.push({ url, options });
    if (url.includes(ASYNC_TTS_CREATE_PATH)) return jsonResponse({ task_id: "t", ...OK_ENVELOPE });
    if (url.includes(ASYNC_TTS_QUERY_PATH)) {
      return jsonResponse({ task_id: "t", status: "Success", file_id: "a", ...OK_ENVELOPE });
    }
    if (url.includes("/v1/files/retrieve")) {
      return jsonResponse({ file: { download_url: "https://v.aliyuncs.com/a.mp3" }, ...OK_ENVELOPE });
    }
    return binaryResponse(new Uint8Array([1, 2, 3]));
  };

  const ext = createAsyncTtsExtension({ fetch: mockFetch, auth: { apiKey: "k" }, sleep: async () => {} });
  await ext.submitSegments({ text: "x", requestTimeoutMs: 999_999 });
  await ext.pollTask({ taskId: "t", requestTimeoutMs: 999_999 });

  assert.ok(seen.length >= 2);
  for (const { options } of seen) {
    assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0, "timeoutMs 必须为正整数");
    assert.ok(options.timeoutMs <= MAX_ASYNC_TIMEOUT_MS, `timeoutMs ${options.timeoutMs} 超过上限`);
    assert.ok(Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0);
  }
  assert.equal(MAX_ASYNC_TIMEOUT_MS, 30000);
  assert.ok(DEFAULT_POLL_INTERVAL_MS >= QUERY_MIN_INTERVAL_MS);
  assert.ok(ASYNC_TTS_DIRECT_TEXT_MAX_CHARS > 0);
  assert.ok(ASYNC_TTS_SEGMENT_CHARS > 0);
});

/* ---------------------------------------------------------------- *
 * CLI 参数与末行 JSON 契约
 * ---------------------------------------------------------------- */

test("parseArgs: 解析文本文件 / --text / 各选项", () => {
  const a = parseArgs([
    "book.txt",
    "--voice-id",
    "female-yujie",
    "--model",
    "speech-2.8-turbo",
    "--format",
    "wav",
    "--out-dir",
    "./out",
    "--subtitle",
    "--poll-interval",
    "3000",
    "--timeout",
    "120000",
  ]);
  assert.equal(a.textFile, "book.txt");
  assert.equal(a.voiceId, "female-yujie");
  assert.equal(a.model, "speech-2.8-turbo");
  assert.equal(a.format, "wav");
  assert.equal(a.outDir, "./out");
  assert.equal(a.subtitle, true);
  assert.equal(a.pollIntervalMs, 3000);
  assert.equal(a.timeoutMs, 120000);

  const b = parseArgs(["--text", "直接文本"]);
  assert.equal(b.text, "直接文本");
  assert.equal(b.textFile, undefined);
});

test("CLI: 成功时末行严格为单行 JSON {ok:true,tasks,files}，退出码 0", async () => {
  const outDir = tmpDir();
  const out = capture();
  const mockFetch = async (url, options) => {
    if (url.includes("/v1/files/upload")) return jsonResponse({ file: { file_id: "f1" }, ...OK_ENVELOPE });
    if (url.includes(ASYNC_TTS_CREATE_PATH)) return jsonResponse({ task_id: "task-1", ...OK_ENVELOPE });
    if (url.includes(ASYNC_TTS_QUERY_PATH)) {
      return jsonResponse({ task_id: "task-1", status: "Success", file_id: "audio-1", ...OK_ENVELOPE });
    }
    if (url.includes("/v1/files/retrieve?")) {
      return jsonResponse({ file: { download_url: "https://v.aliyuncs.com/a.mp3" }, ...OK_ENVELOPE });
    }
    if (url.includes("aliyuncs.com")) {
      return binaryResponse(new Uint8Array([9, 8, 7, 6]));
    }
    throw new Error(`unexpected url ${url}`);
  };

  const code = await cliMain({
    argv: ["--text", "你好", "--out-dir", outDir, "--poll-interval", "1000", "--timeout", "60000"],
    env: { MINIMAX_API_KEY: "test-key" },
    stdout: out.stream,
    stderr: capture().stream,
    fetch: mockFetch,
  });

  assert.equal(code, 0);
  const lines = out.text().split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  assert.equal(last.includes("\n"), false, "末行必须是单行");
  const parsed = JSON.parse(last);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.tasks) && parsed.tasks.length === 1);
  assert.ok(Array.isArray(parsed.files) && parsed.files.length >= 1);
  assert.equal(parsed.tasks[0].taskId, "task-1");
  assert.ok(fs.existsSync(parsed.tasks[0].audioFile));
  assert.ok(parsed.files.includes(parsed.tasks[0].audioFile));
});

test("CLI: 缺少 MINIMAX_API_KEY 时末行 JSON 为 {ok:false,error:{code,message}}，退出码 1", async () => {
  const out = capture();
  const err = capture();
  const code = await cliMain({
    argv: ["--text", "你好"],
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    fetch: async () => {
      throw new Error("must not be called");
    },
  });

  assert.equal(code, 1);
  const lines = out.text().split(/\r?\n/).filter((l) => l.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error.code, "string");
  assert.equal(typeof parsed.error.message, "string");
  assert.match(parsed.error.message, /MINIMAX_API_KEY/);
});

test("CLI: 切片部分失败时 ok:false 且退出码 1，成功片仍记录在 tasks", async () => {
  const outDir = tmpDir();
  const out = capture();
  let n = 0;
  const mockFetch = async (url) => {
    if (url.includes(ASYNC_TTS_CREATE_PATH)) {
      n += 1;
      if (n === 2) return jsonResponse({ base_resp: { status_code: 1004, status_msg: "boom" } });
      return jsonResponse({ task_id: `task-${n}`, ...OK_ENVELOPE });
    }
    if (url.includes(ASYNC_TTS_QUERY_PATH)) {
      return jsonResponse({ task_id: "task", status: "Success", file_id: "audio-1", ...OK_ENVELOPE });
    }
    if (url.includes("/v1/files/retrieve?")) {
      return jsonResponse({ file: { download_url: "https://v.aliyuncs.com/a.mp3" }, ...OK_ENVELOPE });
    }
    if (url.includes("aliyuncs.com")) return binaryResponse(new Uint8Array([1, 2, 3]));
    throw new Error(`unexpected url ${url}`);
  };

  const code = await cliMain({
    argv: ["--text", "甲乙丙丁戊己庚辛壬癸", "--out-dir", outDir, "--max-chars", "3"],
    env: { MINIMAX_API_KEY: "test-key" },
    stdout: out.stream,
    stderr: capture().stream,
    fetch: mockFetch,
  });

  assert.equal(code, 1);
  const lines = out.text().split(/\r?\n/).filter((l) => l.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error && typeof parsed.error.code === "string");
  assert.ok(Array.isArray(parsed.tasks));
  assert.ok(parsed.tasks.some((t) => t.audioFile), "成功片仍应写入 tasks");
});
