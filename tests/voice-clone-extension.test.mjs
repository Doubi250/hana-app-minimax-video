/**
 * tests/extensions.test.mjs — `node --test tests/extensions.test.mjs`
 *
 * The hidden `voice_clone` extension, through the seam the ticket pre-agreed:
 * local sample validation, the two-call network flow (upload → clone), and the
 * registry write. This extension is deliberately NOT a model tool — it only
 * reaches the world through `scripts/ext-voice-clone.mjs` — so nothing here
 * touches `ctx.tools`.
 *
 * All offline: synthetic container headers stand in for real audio, and the
 * fetch implementation is a stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = await import(pathToFileURL(path.join(appRoot, "lib", "extensions", "voice-clone.mjs")));
const { detectSampleFormat, measureAudioDurationMs, validateSample, createVoiceCloneExtension } = ext;
const { VOICES_FILE_NAME, voicesFilePath } = await import(
  pathToFileURL(path.join(appRoot, "lib", "voice-registry.mjs"))
);

/* ---------------------------------------------------------------- *
 * 合成音频容器（离线夹具）
 * ---------------------------------------------------------------- */

/** 标准 44 字节 PCM WAV 头 + 静音数据段。 */
function wavBytes(seconds, { sampleRate = 8000, channels = 1, bits = 16 } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** MPEG1 Layer III CBR 128kbps / 44.1kHz，单帧头 + 填充到目标时长。 */
function mp3Bytes(seconds, { bitrate = 128000 } = {}) {
  const total = Math.round((bitrate / 8) * seconds);
  const buf = Buffer.alloc(Math.max(total, 4));
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90; // bitrate index 9 (128k), sample rate index 0 (44.1k)
  buf[3] = 0x00;
  return buf;
}

/** 最小 M4A：ftyp + moov/mvhd(version 0)，时长由 timescale/duration 表达。 */
function m4aBytes(seconds, { timescale = 1000 } = {}) {
  const mvhdSize = 108;
  const mvhd = Buffer.alloc(mvhdSize);
  mvhd.writeUInt32BE(mvhdSize, 0);
  mvhd.write("mvhd", 4);
  mvhd[8] = 0; // version 0
  mvhd.writeUInt32BE(0, 12); // creation
  mvhd.writeUInt32BE(0, 16); // modification
  mvhd.writeUInt32BE(timescale, 20);
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 24);

  const moovSize = 8 + mvhdSize;
  const moov = Buffer.alloc(moovSize);
  moov.writeUInt32BE(moovSize, 0);
  moov.write("moov", 4);
  mvhd.copy(moov, 8);

  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write("ftyp", 4);
  ftyp.write("M4A ", 8);

  return Buffer.concat([ftyp, moov]);
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mms-ext-"));
}

/* ---------------------------------------------------------------- *
 * 本地校验
 * ---------------------------------------------------------------- */

test("detectSampleFormat: 按扩展名识别 mp3/m4a/wav，其余为 null", () => {
  assert.equal(detectSampleFormat("a.mp3"), "mp3");
  assert.equal(detectSampleFormat("a.M4A"), "m4a");
  assert.equal(detectSampleFormat("dir/b.wav"), "wav");
  assert.equal(detectSampleFormat("a.flac"), null);
  assert.equal(detectSampleFormat("noext"), null);
});

test("measureAudioDurationMs: wav/mp3/m4a 三种容器都能测出时长", () => {
  assert.equal(Math.round(measureAudioDurationMs(wavBytes(30), "wav") / 1000), 30);
  assert.equal(Math.round(measureAudioDurationMs(mp3Bytes(30), "mp3") / 1000), 30);
  assert.equal(Math.round(measureAudioDurationMs(m4aBytes(30), "m4a") / 1000), 30);
});

test("validateSample: 合法 wav 通过并回带格式与 MIME", () => {
  const result = validateSample({ fileName: "ok.wav", bytes: wavBytes(30) });
  assert.equal(result.format, "wav");
  assert.equal(result.mimeType, "audio/wav");
  assert.ok(Math.abs(result.durationMs - 30000) < 500);
});

test("validateSample: 不支持的格式被拒（上传前）", () => {
  assert.throws(() => validateSample({ fileName: "a.flac", bytes: wavBytes(30) }), /格式|format/);
  assert.throws(() => validateSample({ fileName: "a.txt", bytes: Buffer.from("hi") }), /格式|format/);
});

test("validateSample: 超过 20MB 被拒", () => {
  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  assert.throws(() => validateSample({ fileName: "big.wav", bytes: big }), /20|大小|size/i);
});

test("validateSample: 短于 10 秒 / 长于 5 分钟被拒", () => {
  assert.throws(() => validateSample({ fileName: "s.wav", bytes: wavBytes(5) }), /10|时长|duration/i);
  assert.throws(() => validateSample({ fileName: "l.wav", bytes: wavBytes(301) }), /5 ?分钟|300|时长|duration/i);
});

/* ---------------------------------------------------------------- *
 * cloneVoice：上传 → 克隆 → 登记
 * ---------------------------------------------------------------- */

function cloneFetch({ uploadOk = true, cloneOk = true } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/v1/files/upload")) {
      const payload = uploadOk
        ? { file: { file_id: "file-clone-1", bytes: 44, filename: "s.wav", purpose: "voice_clone" }, base_resp: { status_code: 0, status_msg: "success" } }
        : { base_resp: { status_code: 1004, status_msg: "bad key" } };
      return jsonResponse(payload);
    }
    if (String(url).includes("/v1/voice_clone")) {
      const sent = (() => {
        try {
          return JSON.parse(String(init.body));
        } catch {
          return {};
        }
      })();
      const payload = cloneOk
        ? { voice_id: sent.voice_id || "custom-voice-1", base_resp: { status_code: 0, status_msg: "success" } }
        : { base_resp: { status_code: 1002, status_msg: "voice already exists" } };
      return jsonResponse(payload);
    }
    return jsonResponse({ message: "unexpected" }, { ok: false, status: 404 });
  };
  return { fetch, calls };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(payload);
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

test("createVoiceCloneExtension: 只暴露 cloneVoice（不注册模型工具）", () => {
  const ext = createVoiceCloneExtension({ fetch: cloneFetch().fetch, dataDir: os.tmpdir() });
  assert.deepEqual(Object.keys(ext), ["cloneVoice"]);
});

test("cloneVoice: 上传样本后调用 voice_clone 并登记音色表", async () => {
  const dir = await tempDir();
  const { fetch, calls } = cloneFetch();
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  const result = await extension.cloneVoice({
    auth: { apiKey: "test-key" },
    bytes: wavBytes(30),
    fileName: "s.wav",
    voiceId: "custom-voice-1",
    label: "我的音色",
  });

  assert.equal(calls.length, 2, "应是上传 + 克隆两次调用");
  assert.match(calls[0].url, /\/v1\/files\/upload$/);
  assert.match(calls[0].url, /^https:\/\/api\.minimax\.cn/);
  assert.match(calls[1].url, /\/v1\/voice_clone$/);
  assert.equal(calls[1].init.method, "POST");

  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.file_id, "file-clone-1");
  assert.equal(body.voice_id, "custom-voice-1");

  for (const call of calls) {
    assert.ok(Number.isInteger(call.init.timeoutMs) && call.init.timeoutMs <= 30000);
  }

  assert.equal(result.voice.voiceId, "custom-voice-1");
  assert.equal(result.voice.label, "我的音色");

  const stored = JSON.parse(await fs.readFile(voicesFilePath(dir), "utf8"));
  assert.equal(stored.voices.length, 1);
  assert.equal(stored.voices[0].voiceId, "custom-voice-1");
  assert.equal(stored.voices[0].sample.fileId, "file-clone-1");
});

test("cloneVoice: 样本格式非法时在联网之前报错", async () => {
  const dir = await tempDir();
  const { fetch, calls } = cloneFetch();
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  await assert.rejects(
    () => extension.cloneVoice({ auth: { apiKey: "k" }, bytes: Buffer.from("hi"), fileName: "a.txt", voiceId: "v" }),
    /格式|format/,
  );
  assert.equal(calls.length, 0, "本地校验失败不得发起任何网络调用");
});

test("cloneVoice: 上游克隆信封报错即抛出，且不写音色表", async () => {
  const dir = await tempDir();
  const { fetch } = cloneFetch({ cloneOk: false });
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  await assert.rejects(
    () => extension.cloneVoice({ auth: { apiKey: "k" }, bytes: wavBytes(30), fileName: "s.wav", voiceId: "v1" }),
    /1002/,
  );
  assert.equal(
    await fs.access(voicesFilePath(dir)).then(() => true, () => false),
    false,
    "克隆失败不得登记音色",
  );
});

test("cloneVoice: 上传失败即抛出，不进入克隆调用", async () => {
  const dir = await tempDir();
  const { fetch, calls } = cloneFetch({ uploadOk: false });
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  await assert.rejects(
    () => extension.cloneVoice({ auth: { apiKey: "k" }, bytes: wavBytes(30), fileName: "s.wav", voiceId: "v1" }),
    /1004/,
  );
  assert.equal(calls.length, 1, "上传失败后不应再调用 voice_clone");
});

test("cloneVoice: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", () => {
  assert.throws(() => createVoiceCloneExtension({ dataDir: os.tmpdir() }), /fetch/);
  assert.throws(() => createVoiceCloneExtension({ fetch: null, dataDir: os.tmpdir() }), /fetch/);
});

/* ---------------------------------------------------------------- *
 * 信封语义（ticket 10 / D）：base_resp.status_code 缺失视为失败
 * ---------------------------------------------------------------- */

test("cloneVoice: base_resp.status_code 缺失（undefined）视为失败，不登记音色", async () => {
  const dir = await tempDir();
  const fetch = async (url) => {
    if (String(url).includes("/v1/files/upload")) {
      return jsonResponse({
        file: { file_id: "file-clone-1", bytes: 44, filename: "s.wav", purpose: "voice_clone" },
        base_resp: { status_code: 0, status_msg: "success" },
      });
    }
    // HTTP 200 + 有 voice_id，但没有 base_resp——不是 MiniMax 的成功响应。
    return jsonResponse({ voice_id: "sneaky" });
  };
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  await assert.rejects(
    () => extension.cloneVoice({ auth: { apiKey: "k" }, bytes: wavBytes(30), fileName: "s.wav", voiceId: "v1" }),
    /声音克隆失败/,
  );
  assert.equal(
    await fs.access(voicesFilePath(dir)).then(() => true, () => false),
    false,
    "status_code 缺失不得登记音色",
  );
});

test("cloneVoice: 信封判定与 assertBaseRespOk 单源一致", async () => {
  const source = await fs.readFile(
    path.join(appRoot, "lib", "extensions", "voice-clone.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /assertBaseRespOk\(parseJsonSafe\(text\), \{ label: "声音克隆失败" \}\)/,
    "voice-clone 必须调用共享的 assertBaseRespOk",
  );
  assert.doesNotMatch(
    source,
    /json\.base_resp\?\.status_code !== 0/,
    "旧的本地信封判定必须已删除",
  );
});

test("cloneVoice: voiceId 缺省由 file_id 派生，且落进音色表", async () => {
  const dir = await tempDir();
  const { fetch, calls } = cloneFetch();
  const extension = createVoiceCloneExtension({ fetch, dataDir: dir });

  const result = await extension.cloneVoice({
    auth: { apiKey: "k" },
    bytes: wavBytes(30),
    fileName: "s.wav",
    label: "无名",
  });
  assert.ok(result.voice.voiceId, "缺省 voiceId 必须被派生");
  assert.equal(JSON.parse(calls[1].init.body).voice_id, result.voice.voiceId);
  assert.equal(VOICES_FILE_NAME, "voices.json");
});
