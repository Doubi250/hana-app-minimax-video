/**
 * tests/speech-adapter.test.mjs — `node --test tests/speech-adapter.test.mjs`
 *
 * Ticket 02: MiniMax speech joins the host's global speech channel.
 *
 * Two seams are pinned here, both external:
 *   - the runtime capability source's published snapshot (`media.speechGeneration`)
 *     — the only door the host's speech provider directory reads;
 *   - the `types:["speech"]` adapter (`createMinimaxSpeechAdapter`) — the object
 *     the host routes `media_generate-speech` to, through its descriptor shape,
 *     its `submit` result and its `checkAuth` answer.
 *
 * The load-bearing fact (§0 of the SPEC): the host's known audio-format set is
 * `["mp3","wav","pcm","ogg_opus"]` and does NOT include `flac`, so every format
 * enum published here is `mp3/wav/pcm` and the adapter REJECTS `flac` outright
 * rather than silently downgrading it.
 *
 * Everything is offline: `network.fetch` and the bus are stubs, no key, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMinimaxSpeechAdapter } = await import(
  pathToFileURL(path.join(appRoot, "lib", "speech-adapter.mjs"))
);
const { buildCapabilitySnapshot } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax-api.mjs"))
);

/** The format set the host knows; `flac` is deliberately absent (bundle constant `mft`). */
const HOST_AUDIO_FORMATS = ["mp3", "wav", "pcm"];

function fakeLogger() {
  return {
    infos: [],
    warns: [],
    errors: [],
    async info(m) { this.infos.push(m); },
    async warn(m) { this.warns.push(m); },
    async error(m) { this.errors.push(m); },
  };
}

function fakeBus({ credentials = { apiKey: "k".repeat(10) } } = {}) {
  return {
    async request(verb) {
      if (verb === "provider:credentials") return credentials;
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
}

/** A fetch that answers the T2A endpoint with a hex audio payload. */
function ttsFetch({
  audioHex = Buffer.from("MiniMax-speech-adapter-bytes").toString("hex"),
  extraInfo = { audio_length: 1800, audio_sample_rate: 32000, audio_format: "mp3", word_count: 4 },
} = {}) {
  const calls = { count: 0, urls: [], bodies: [], inits: [] };
  const fetch = async (url, init = {}) => {
    calls.count += 1;
    calls.urls.push(String(url));
    calls.inits.push(init);
    calls.bodies.push(init.body ? JSON.parse(init.body) : null);
    const payload = {
      data: { audio: audioHex, status: 2 },
      extra_info: extraInfo,
      base_resp: { status_code: 0, status_msg: "success" },
      trace_id: "trace-speech",
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch, calls };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "minimax-speech-"));
}

/* 1. descriptor shape ---------------------------------------------- */

test("createMinimaxSpeechAdapter: 描述符形状——types 含 speech、协议 id 与能力上限", () => {
  const adapter = createMinimaxSpeechAdapter({});
  assert.equal(adapter.id, "minimax-speech-tts");
  assert.equal(adapter.protocolId, "minimax-speech-tts");
  assert.ok(Array.isArray(adapter.types) && adapter.types.includes("speech"));
  assert.equal(typeof adapter.name, "string");
  assert.ok(adapter.name.length > 0);
  assert.deepEqual(adapter.capabilities.formats, HOST_AUDIO_FORMATS);
  assert.equal(adapter.capabilities.speedMin, 0.5);
  assert.equal(adapter.capabilities.speedMax, 2);
  assert.equal(typeof adapter.submit, "function");
  assert.equal(typeof adapter.checkAuth, "function");
});

/* 2. capability snapshot ------------------------------------------- */

test("capability snapshot: media.speechGeneration 发布语音模型，format 枚举不含 flac", () => {
  const speech = buildCapabilitySnapshot().media.speechGeneration;
  assert.ok(speech, "media.speechGeneration 存在");
  assert.equal(speech.defaultModelId, "speech-2.8-hd");

  // 与视频共用同一凭证 lane。
  assert.deepEqual(speech.credentialLanes.map((lane) => lane.id), ["minimax-token-plan"]);

  const ids = speech.models.map((m) => m.id);
  assert.ok(ids.includes("speech-2.8-hd"), "至少发布 speech-2.8-hd");
  assert.ok(ids.includes("speech-2.8-turbo"), "2.8-turbo 一并发布");

  for (const model of speech.models) {
    assert.equal(model.protocolId, "minimax-speech-tts");
    assert.deepEqual(model.inputs, ["text"]);
    assert.deepEqual(model.outputs, ["audio"]);
    assert.equal(typeof model.defaultVoiceId, "string");
    assert.ok(model.voices.length > 0, "音色表非空");
    const mode = model.modes.find((m) => m.id === "text2speech");
    assert.ok(mode, "text2speech 模式存在");
    const enumValues = mode.parameterSchema.properties.format.enum;
    assert.deepEqual(enumValues, HOST_AUDIO_FORMATS);
    assert.ok(!enumValues.includes("flac"), "flac 绝不出现在宿主通道的 format 枚举里");
    assert.equal(mode.defaults.format, "mp3");
    assert.deepEqual(Object.keys(mode.defaults).sort(), ["format", "speed", "voice"]);
  }
});

/* 3. submit: writes the file and returns the host-facing shape ------ */

test("submit: 音频写入生成目录，返回 { taskId, files:[fileName] }", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const adapter = createMinimaxSpeechAdapter({
    network: { fetch },
    bus: fakeBus(),
    logger: fakeLogger(),
    generatedDir: dir,
  });

  const result = await adapter.submit(
    { text: "你好，宿主发音通道", voice: "female-yujie", speed: 1.2, format: "wav" },
    {},
  );

  assert.equal(typeof result.taskId, "string");
  assert.ok(result.taskId.length > 0);
  assert.equal(result.files.length, 1);
  const fileName = result.files[0];
  assert.ok(!fileName.includes("/") && !fileName.includes("\\"), "只返回文件名，不带路径分隔符");
  assert.ok(fileName.endsWith(".wav"));

  const written = await fs.readFile(path.join(dir, fileName));
  assert.deepEqual(written, Buffer.from("MiniMax-speech-adapter-bytes"));

  // 请求真的打到 T2A，且格式与音色透传。
  assert.match(calls.urls[0], /\/v1\/t2a_v2$/);
  assert.equal(calls.bodies[0].voice_setting.voice_id, "female-yujie");
  assert.equal(calls.bodies[0].audio_setting.format, "wav");
  assert.ok(calls.inits[0].timeoutMs <= 30000);
});

test("submit: generatedDir 缺省回落 {dataDir}/generated", async () => {
  const dir = await tempDir();
  const { fetch } = ttsFetch();
  const adapter = createMinimaxSpeechAdapter({ network: { fetch }, bus: fakeBus(), dataDir: dir });

  const result = await adapter.submit({ text: "测试" }, {});

  const stat = await fs.stat(path.join(dir, "generated", result.files[0]));
  assert.ok(stat.isFile());
});

/* 4. credential failure is explicit and early ----------------------- */

test("submit: 凭证缺失时在合成之前明确报错，且不发出任何请求", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const adapter = createMinimaxSpeechAdapter({
    network: { fetch },
    bus: fakeBus({ credentials: { error: "no_credentials" } }),
    generatedDir: dir,
  });

  await assert.rejects(() => adapter.submit({ text: "测试" }, {}), /凭证|供应商/);
  assert.equal(calls.count, 0, "无凭证时不发出任何请求");
  assert.deepEqual(await fs.readdir(dir), [], "无凭证时不落盘");
});

test("checkAuth: 凭证缺失返回 { ok:false, message }，可用返回 { ok:true }", async () => {
  const missing = createMinimaxSpeechAdapter({ bus: fakeBus({ credentials: { error: "no" } }) });
  const missingResult = await missing.checkAuth();
  assert.equal(missingResult.ok, false);
  assert.equal(typeof missingResult.message, "string");
  assert.ok(missingResult.message.length > 0);

  const ok = createMinimaxSpeechAdapter({ bus: fakeBus() });
  assert.deepEqual(await ok.checkAuth(), { ok: true });
});

/* 5. flac is rejected, not silently downgraded ---------------------- */

test("submit: flac 被明确拒绝（不静默降级），且不发出请求", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const adapter = createMinimaxSpeechAdapter({
    network: { fetch },
    bus: fakeBus(),
    generatedDir: dir,
  });

  await assert.rejects(
    () => adapter.submit({ text: "测试", format: "flac" }, {}),
    /flac/,
    "flac 必须报错，而不是被归一化成 mp3",
  );
  assert.equal(calls.count, 0, "被拒的格式不发出请求");
  assert.deepEqual(await fs.readdir(dir), []);
});

/* 6. cancellation signal is honoured -------------------------------- */

test("submit: ctx.attempt.signal 已中止时明确报错，不发出请求", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const adapter = createMinimaxSpeechAdapter({
    network: { fetch },
    bus: fakeBus(),
    generatedDir: dir,
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => adapter.submit({ text: "测试" }, { attempt: { signal: controller.signal } }),
    /取消|abort/i,
  );
  assert.equal(calls.count, 0);
});

/* 7. registration: apply(ctx) wires the speech adapter -------------- */

test("apply: 注册 types 含 speech 的语音适配器", async () => {
  const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;
  const adapters = [];
  const ctx = {
    bus: fakeBus(),
    logger: fakeLogger(),
    network: { fetch: ttsFetch().fetch },
    resources: { async read() { return Buffer.from("x"); }, async stat() { return { size: 1 }; } },
    dataDir: await tempDir(),
    media: {
      async registerCapabilitySource() {},
      async registerAdapter(adapter) { adapters.push(adapter); },
    },
    tools: { register() { return () => {}; } },
  };

  await apply(ctx);

  const speech = adapters.find((a) => a?.types?.includes("speech"));
  assert.ok(speech, "语音适配器被注册");
  assert.equal(speech.id, "minimax-speech-tts");
  assert.deepEqual(speech.capabilities.formats, HOST_AUDIO_FORMATS);
});

test("apply: 语音适配器注册失败只记日志，不阻断 App 加载", async () => {
  const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;
  const logger = fakeLogger();
  const ctx = {
    bus: fakeBus(),
    logger,
    network: { fetch: ttsFetch().fetch },
    resources: { async read() { return Buffer.from("x"); }, async stat() { return { size: 1 }; } },
    dataDir: await tempDir(),
    media: {
      async registerCapabilitySource() {},
      async registerAdapter(adapter) {
        if (adapter?.types?.includes("speech")) throw new Error("media runtime unavailable");
      },
    },
    tools: { register() { return () => {}; } },
  };

  await apply(ctx);
  assert.ok(logger.infos.some((line) => /minimax-video loaded/.test(line)), "App 仍然完成加载");
  assert.ok(logger.errors.some((line) => /注册失败/.test(line)), "注册失败被记录");
});
