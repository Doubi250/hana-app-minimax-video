/**
 * tests/asr-tool.test.mjs — `node --test tests/asr-tool.test.mjs`
 *
 * The `minimax_speech_to_text` model tool, through the seams this ticket
 * pre-agreed.
 *
 * (The audio → video linkage lock — a TTS output path fed back in as reference
 * audio — lives in `tests/audio-video-linkage.test.mjs`, which covers both
 * consumers: the media-generation body and the H3-Context-IR body.)
 *
 * The three review blockers pinned here:
 *   - the local-file path must `resources.stat` first, reject over
 *     `MAX_ASR_FILE_BYTES`, re-check after read and charge a total budget
 *     (previously stat-less and unbounded: a 500MB file went straight into
 *     memory and into multipart);
 *   - the `audio_url` path must declare an explicit `timeoutMs` (≤30000) and a
 *     `maxResponseBytes` (previously `fetchImpl(url)` bare, `arrayBuffer()`
 *     unbounded);
 *   - `details` must carry only serialisable primitives, with a bounded
 *     `segments` list.
 *
 * Byte extraction is the video lib's single `extractBytes` (not the speech
 * plugin's divergent copy), so this file also proves the ASR tool consumes it
 * across every host reply shape.
 *
 * Everything is offline: `resources`, `network.fetch` and the bus are stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createAsrTool, MAX_DETAIL_SEGMENTS } = await import(
  pathToFileURL(path.join(appRoot, "lib", "asr-tool.mjs"))
);
const { MAX_ASR_FILE_BYTES, AUDIO_DOWNLOAD_TIMEOUT_MS } = await import(
  pathToFileURL(path.join(appRoot, "lib", "speech-api.mjs"))
);

function fakeBus({ credentials = { apiKey: "k".repeat(10) } } = {}) {
  return {
    async request(verb) {
      if (verb === "provider:credentials") return credentials;
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
}

/** An ASR fetch answering the speech_to_text endpoint; records the init it got. */
function asrFetch({ payload = { text: "今天天气很好", duration: 3.5 } } = {}) {
  const calls = { count: 0, urls: [], inits: [], bodies: [] };
  const fetch = async (url, init = {}) => {
    calls.count += 1;
    calls.urls.push(String(url));
    calls.inits.push(init);
    calls.bodies.push(init.body);
    // A string payload is the raw body (the srt/vtt branch returns plain
    // text); anything else is JSON-encoded.
    return {
      ok: true,
      status: 200,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { fetch, calls };
}

/** A ResourceIO stub: stat reports `size`; read returns `payload`. */
function fakeResources({ size = 1024, payload = Buffer.from("fake-audio-bytes") } = {}) {
  return {
    stats: [],
    reads: [],
    async stat(ref) {
      this.stats.push(ref);
      return { size };
    },
    async read(ref) {
      this.reads.push(ref);
      return typeof payload === "function" ? payload(ref) : payload;
    },
  };
}

async function tempFile(name, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-asr-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

/* 1. construction -------------------------------------------------- */

test("createAsrTool: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", () => {
  assert.throws(() => createAsrTool({ bus: fakeBus() }), /network\.fetch|fetch 实现/);
  assert.throws(
    () => createAsrTool({ network: { fetch: null }, bus: fakeBus() }),
    /network\.fetch|fetch 实现/,
  );
  assert.equal(typeof globalThis.fetch, "function");
});

/* 2. local-file path: stat → read → re-check → budget --------------- */

test("execute: 本地文件先 stat 后读，details 只含可序列化原语", async () => {
  const file = await tempFile("speech.mp3", Buffer.from("fake-audio-bytes"));
  const resources = fakeResources({ payload: { content: Buffer.from("fake-audio-bytes") } });
  const { fetch, calls } = asrFetch({ payload: { text: "今天天气很好", duration: 3.5 } });
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  const result = await tool.execute({ audio_path: file });

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");

  // stat 预检发生在 read 之前。
  assert.equal(resources.stats.length, 1);
  assert.equal(resources.stats[0].kind, "local-file");
  assert.equal(resources.reads.length, 1);
  assert.equal(resources.reads[0].path, file);

  assert.equal(result.details.text, "今天天气很好");
  assert.equal(result.details.duration, 3.5);
  assert.equal(result.details.segmentCount, 0);
  assert.deepEqual(result.details.segments, []);
  for (const [key, value] of Object.entries(result.details)) {
    if (Array.isArray(value)) continue;
    assert.notEqual(typeof value, "object", `${key} 必须是可序列化原语`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result.details)), result.details);
  assert.equal(result.details.raw, undefined);

  // 请求体是 multipart，且带显式超时 / 响应上限。
  assert.equal(calls.count, 1);
  assert.ok(calls.inits[0].timeoutMs <= 30000);
  assert.ok(Number.isFinite(calls.inits[0].maxResponseBytes));
  assert.match(String(calls.inits[0].headers["Content-Type"]), /^multipart\/form-data; boundary=/);
});

test("execute: 本地文件超 MAX_ASR_FILE_BYTES 在 stat 处即被拒绝（不读入内存）", async () => {
  const resources = fakeResources({ size: MAX_ASR_FILE_BYTES + 1 });
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  await assert.rejects(
    () => tool.execute({ audio_path: "C:/audio/huge.wav" }),
    (error) => {
      assert.equal(error.code, "MINIMAX_ASR_FILE_TOO_LARGE");
      assert.match(error.message, /超出传输限制/);
      assert.match(error.message, /12MB/);
      return true;
    },
  );
  assert.equal(resources.reads.length, 0, "stat 已足够拒绝，绝不读入内存");
  assert.equal(calls.count, 0, "不发出任何 API 请求");
});

test("execute: stat 报告偏小但实际读取超限——读后复校仍拒绝", async () => {
  const resources = fakeResources({
    size: 10,
    payload: Buffer.alloc(MAX_ASR_FILE_BYTES + 1),
  });
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  await assert.rejects(
    () => tool.execute({ audio_path: "C:/audio/liar.wav" }),
    /超出传输限制/,
  );
  assert.equal(calls.count, 0);
});

test("execute: stat 不可用时仍靠读后复校拒绝超限文件", async () => {
  const resources = fakeResources({ payload: Buffer.alloc(MAX_ASR_FILE_BYTES + 1) });
  resources.stat = undefined;
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  await assert.rejects(
    () => tool.execute({ audio_path: "C:/audio/nostat.wav" }),
    /超出传输限制/,
  );
  assert.equal(calls.count, 0);
});

test("execute: 空文件明确报错，而非当作成功转写", async () => {
  const resources = fakeResources({ size: 0, payload: { content: Buffer.alloc(0) } });
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  await assert.rejects(() => tool.execute({ audio_path: "C:/audio/empty.wav" }), /内容为空/);
  assert.equal(calls.count, 0);
});

test("execute: 缺少 resources.read 授权时报错", async () => {
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources: { async stat() { return { size: 1 }; } } });

  await assert.rejects(
    () => tool.execute({ audio_path: "C:/audio/a.wav" }),
    /resources\.read|资源通道/,
  );
  assert.equal(calls.count, 0);
});

/* 3. byte extraction across host reply shapes ----------------------- */

test("execute: 字节提取复用视频侧实现，覆盖 Buffer / Uint8Array / base64 / $bytes / type:Buffer / content 各形态", async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
  const shapes = {
    Buffer: bytes,
    Uint8Array: new Uint8Array(bytes),
    ArrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    base64String: bytes.toString("base64"),
    $bytesBuffer: { $bytes: bytes },
    $bytesBase64: { $bytes: bytes.toString("base64") },
    typeBuffer: { type: "Buffer", data: [...bytes] },
    contentBuffer: { content: bytes },
    dataArray: { data: [...bytes] },
  };

  for (const [label, payload] of Object.entries(shapes)) {
    const resources = fakeResources({ size: bytes.length, payload });
    const { fetch, calls } = asrFetch();
    const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

    const result = await tool.execute({ audio_path: `C:/audio/${label}.mp3` });

    assert.equal(calls.count, 1, `${label}: 请求已发出`);
    assert.ok(result.details.bytes >= bytes.length, `${label}: 字节数已计入`);
    // 上传的 multipart 里确实含有这些字节。
    assert.ok(Buffer.isBuffer(calls.bodies[0]), `${label}: body 是 Buffer`);
    assert.ok(calls.bodies[0].includes(bytes), `${label}: 上传体包含原始字节`);
  }
});

test("execute: 无法识别的资源形态给出顶层键诊断", async () => {
  const resources = fakeResources({ size: 8, payload: { nope: 1, other: 2 } });
  const { fetch } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  await assert.rejects(() => tool.execute({ audio_path: "C:/audio/x.mp3" }), /nope, other/);
});

/* 4. audio_url path: explicit bounds -------------------------------- */

test("execute: audio_url 显式设 timeoutMs（≤30000）与 maxResponseBytes", async () => {
  const audioBytes = Buffer.from("remote-audio-bytes");
  const calls = { count: 0, inits: [] };
  const fetch = async (url, init = {}) => {
    calls.count += 1;
    calls.inits.push({ url: String(url), init });
    if (String(url).includes("/v1/speech_to_text")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: "hi", duration: 1 }) };
    }
    // 音频下载
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength),
    };
  };
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus() });

  const result = await tool.execute({ audio_url: "https://cdn.example.com/voice.mp3" });

  const download = calls.inits[0];
  assert.equal(download.url, "https://cdn.example.com/voice.mp3");
  assert.equal(download.init.method, "GET");
  assert.equal(download.init.timeoutMs, AUDIO_DOWNLOAD_TIMEOUT_MS);
  assert.ok(download.init.timeoutMs <= 30000, "音频下载超时 ≤ 宿主硬上限");
  assert.ok(
    Number.isFinite(download.init.maxResponseBytes) && download.init.maxResponseBytes > 0,
    "下载显式设响应上限",
  );
  assert.equal(download.init.maxResponseBytes, MAX_ASR_FILE_BYTES);

  assert.equal(result.details.bytes, audioBytes.length);
  assert.equal(calls.count, 2, "一次下载 + 一次转写");
});

test("execute: audio_url 下载超限被拒绝", async () => {
  const calls = { count: 0 };
  const fetch = async (url) => {
    calls.count += 1;
    if (String(url).includes("/v1/speech_to_text")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: "hi" }) };
    }
    const big = Buffer.alloc(MAX_ASR_FILE_BYTES + 1);
    return { ok: true, status: 200, arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) };
  };
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus() });

  await assert.rejects(
    () => tool.execute({ audio_url: "https://cdn.example.com/big.mp3" }),
    /超出传输限制/,
  );
  assert.equal(calls.count, 1, "只有下载，没有转写");
});

test("execute: audio_url 下载失败（HTTP 非 2xx）明确报错", async () => {
  const fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus() });

  await assert.rejects(
    () => tool.execute({ audio_url: "https://cdn.example.com/missing.mp3" }),
    /HTTP 404/,
  );
});

/* 5. details bounding ----------------------------------------------- */

test("execute: verbose_json 的 segments 被截断到上限并在文本中标注", async () => {
  const segments = Array.from({ length: MAX_DETAIL_SEGMENTS + 25 }, (_, index) => ({
    start: index,
    end: index + 1,
    text: `片段 ${index}`,
  }));
  const resources = fakeResources({ size: 16, payload: Buffer.from("audio-bytes-here") });
  const { fetch } = asrFetch({ payload: { text: "全文", duration: 30, segments } });
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  const result = await tool.execute({
    audio_path: "C:/audio/long.mp3",
    response_format: "verbose_json",
  });

  assert.equal(result.details.segmentCount, segments.length);
  assert.equal(result.details.segments.length, MAX_DETAIL_SEGMENTS, "列表有上限");
  assert.equal(result.details.segmentsTruncated, true);
  assert.match(result.content[0].text, new RegExp(`共 ${segments.length} 段`));
  assert.deepEqual(JSON.parse(JSON.stringify(result.details)), result.details);
});

/* 6. srt / vtt path -------------------------------------------------- */

test("execute: srt 字幕原样作为 content 文本返回", async () => {
  const srt = "1\n00:00:00,000 --> 00:00:02,000\n你好\n";
  const resources = fakeResources({ size: 16, payload: Buffer.from("audio-bytes-here") });
  const { fetch } = asrFetch({ payload: srt });
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus(), resources });

  const result = await tool.execute({ audio_path: "C:/audio/a.mp3", response_format: "srt" });

  assert.equal(result.content[0].text, srt);
  assert.equal(result.details.format, "srt");
});

/* 7. credential gate ------------------------------------------------- */

test("execute: 凭证不可用时在任何读取之前报错", async () => {
  const resources = fakeResources({});
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({
    network: { fetch },
    bus: fakeBus({ credentials: { error: "no_credentials" } }),
    resources,
  });

  await assert.rejects(
    () => tool.execute({ audio_path: "C:/audio/a.mp3" }),
    /凭证|供应商/,
  );
  assert.equal(resources.reads.length, 0);
  assert.equal(calls.count, 0);
});

test("execute: 既无 audio_path 也无 audio_url 时明确报错", async () => {
  const { fetch, calls } = asrFetch();
  const tool = createAsrTool({ network: { fetch }, bus: fakeBus() });

  await assert.rejects(() => tool.execute({}), /audio_path 或 audio_url/);
  assert.equal(calls.count, 0);
});
