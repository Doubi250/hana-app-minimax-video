/**
 * tests/tts-tool.test.mjs — `node --test tests/tts-tool.test.mjs`
 *
 * The `minimax_text_to_speech` model tool, through the seams this ticket
 * pre-agreed: the tool's `execute` return shape (content + details) and the
 * hardened behaviour the review demanded.
 *
 * The #1 review blocker lives here: `details` used to spread the whole client
 * result, carrying the raw audio `Buffer` and the `subtitles` payload across the
 * host's 32 MiB JSON-RPC boundary — after the file had already been written, so
 * a successful synthesis reported as a failure. These cases pin `details` to
 * serialisable primitives only.
 *
 * Everything is offline: `network.fetch` and the bus are stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createTtsTool } = await import(
  pathToFileURL(path.join(appRoot, "lib", "tts-tool.mjs"))
);

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
  audioHex = Buffer.from("MiniMax-TTS-audio-bytes").toString("hex"),
  extraInfo = { audio_length: 2500, audio_sample_rate: 32000, audio_format: "mp3", word_count: 5 },
  subtitles = null,
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
      ...(subtitles ? { subtitle: subtitles } : {}),
      trace_id: "trace-tts",
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch, calls };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "minimax-tts-"));
}

test("createTtsTool: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", () => {
  assert.throws(() => createTtsTool({ bus: fakeBus() }), /network\.fetch|fetch 实现/);
  assert.throws(() => createTtsTool({ network: {}, bus: fakeBus() }), /network\.fetch|fetch 实现/);
  assert.throws(
    () => createTtsTool({ network: { fetch: null }, bus: fakeBus() }),
    /network\.fetch|fetch 实现/,
  );
  // 即便宿主存在 globalThis.fetch，也绝不静默启用。
  assert.equal(typeof globalThis.fetch, "function");
});

test("execute: 合成音频写入生成目录，details 只含可序列化原语（无 Buffer / 无 subtitles）", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch({
    subtitles: [{ time_begin: 0, time_end: 1000, text: "你好" }],
  });
  const tool = createTtsTool({
    network: { fetch },
    bus: fakeBus(),
    logger: fakeLogger(),
    generatedDir: dir,
  });

  const result = await tool.execute({ text: "你好，测试语音", format: "wav" });

  // content 严格为 [{ type: "text", text }]
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");
  assert.match(result.content[0].text, /语音合成成功/);
  // 字幕以文本给出，而非结构化字段。
  assert.match(result.content[0].text, /你好/);

  // details 恰好是这六个可序列化原语。
  assert.deepEqual(Object.keys(result.details).sort(), [
    "bytes",
    "durationSeconds",
    "filePath",
    "format",
    "sampleRate",
    "wordCount",
  ]);
  assert.equal(result.details.format, "wav");
  assert.equal(result.details.sampleRate, 32000);
  assert.equal(result.details.wordCount, 5);
  assert.equal(result.details.durationSeconds, 2.5);
  assert.equal(result.details.bytes, Buffer.from("MiniMax-TTS-audio-bytes").length);

  // 关键 blocker 断言：details 里没有任何 Buffer / 原始音频字段 / 原始错误体。
  assert.equal(result.details.audioBuffer, undefined);
  assert.equal(result.details.subtitles, undefined);
  assert.equal(result.details.raw, undefined);
  for (const [key, value] of Object.entries(result.details)) {
    assert.notEqual(typeof value, "object", `${key} 必须是可序列化原语`);
    assert.ok(!Buffer.isBuffer(value), `${key} 不能是 Buffer`);
  }
  // 整个 details 可无损 JSON 往返（跨宿主 RPC 边界的前提）。
  assert.deepEqual(JSON.parse(JSON.stringify(result.details)), result.details);

  // 文件真的落盘，扩展名由归一化格式派生。
  assert.ok(result.details.filePath.startsWith(dir), "写入生成目录");
  assert.ok(result.details.filePath.endsWith(".wav"));
  const written = await fs.readFile(result.details.filePath);
  assert.deepEqual(written, Buffer.from("MiniMax-TTS-audio-bytes"));

  // 请求体里的格式与扩展名同源。
  assert.equal(calls.bodies[0].audio_setting.format, "wav");
  assert.ok(calls.inits[0].timeoutMs <= 30000);
});

test("execute: 非法 format 归一化——扩展名跟随请求体回显，不跟随原始入参", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const tool = createTtsTool({ network: { fetch }, bus: fakeBus(), generatedDir: dir });

  const result = await tool.execute({ text: "测试", format: "aac" });

  assert.equal(calls.bodies[0].audio_setting.format, "mp3", "请求体回落 mp3");
  assert.equal(result.details.format, "mp3");
  assert.ok(result.details.filePath.endsWith(".mp3"), "扩展名跟随归一化格式");
  assert.doesNotMatch(result.details.filePath, /\.aac$/);
});

test("execute: generatedDir 缺省回落 {dataDir}/generated", async () => {
  const dir = await tempDir();
  const { fetch } = ttsFetch();
  const tool = createTtsTool({ network: { fetch }, bus: fakeBus(), dataDir: dir });

  const result = await tool.execute({ text: "测试" });

  assert.ok(result.details.filePath.startsWith(path.join(dir, "generated")));
  const stat = await fs.stat(result.details.filePath);
  assert.ok(stat.isFile());
});

test("execute: 调用上下文里的 generatedDir 覆盖 apply 时的默认值", async () => {
  const defaultDir = await tempDir();
  const callDir = await tempDir();
  const { fetch } = ttsFetch();
  const tool = createTtsTool({
    network: { fetch },
    bus: fakeBus(),
    generatedDir: defaultDir,
  });

  const result = await tool.execute({ text: "测试", context: { generatedDir: callDir } });

  assert.ok(result.details.filePath.startsWith(callDir));
});

test("execute: 凭证不可用时在合成之前明确报错", async () => {
  const dir = await tempDir();
  const { fetch, calls } = ttsFetch();
  const tool = createTtsTool({
    network: { fetch },
    bus: fakeBus({ credentials: { error: "no_credentials" } }),
    generatedDir: dir,
  });

  await assert.rejects(() => tool.execute({ text: "测试" }), /凭证|供应商/);
  assert.equal(calls.count, 0, "无凭证时不发出任何请求");
});

test("execute: 上游错误信封报错，且不落盘、不返回 Buffer", async () => {
  const dir = await tempDir();
  const fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ base_resp: { status_code: 1002, status_msg: "rate limit" } }),
  });
  const tool = createTtsTool({ network: { fetch }, bus: fakeBus(), generatedDir: dir });

  await assert.rejects(() => tool.execute({ text: "测试" }), /1002|rate limit/);
  assert.deepEqual(await fs.readdir(dir), [], "错误路径不产生文件");
});

/* 注册：入口 apply(ctx) 把两个语音工具接上工具注册表 --------------- */

test("apply: 在 apply(ctx) 中注册 TTS 与 ASR 工具，与 context-ir 并列", async () => {
  const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;
  const registered = [];
  const ctx = {
    bus: fakeBus(),
    logger: fakeLogger(),
    network: { fetch: ttsFetch().fetch },
    resources: { async read() { return Buffer.from("x"); }, async stat() { return { size: 1 }; } },
    dataDir: await tempDir(),
    media: { async registerCapabilitySource() {}, async registerAdapter() {} },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
    },
  };

  await apply(ctx);

  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["minimax_context_ir", "minimax_speech_to_text", "minimax_text_to_speech"]);
  for (const tool of registered) {
    assert.equal(typeof tool.execute, "function", `${tool.name} 可执行`);
  }
});

test("apply: 工具注册失败只记日志，不阻断 App 加载", async () => {
  const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;
  const logger = fakeLogger();
  const ctx = {
    bus: fakeBus(),
    logger,
    network: { fetch: ttsFetch().fetch },
    resources: { async read() { return Buffer.from("x"); }, async stat() { return { size: 1 }; } },
    dataDir: await tempDir(),
    media: { async registerCapabilitySource() {}, async registerAdapter() {} },
    tools: {
      register() {
        throw new Error("tools registry unavailable");
      },
    },
  };

  // apply 必须 resolve（而非 reject）：注册失败只记日志。
  await apply(ctx);
  assert.ok(logger.infos.some((line) => /minimax-video loaded/.test(line)), "App 仍然完成加载");
  assert.ok(logger.errors.some((line) => /注册失败/.test(line)), "注册失败被记录");
});
