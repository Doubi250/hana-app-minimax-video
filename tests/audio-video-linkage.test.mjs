/**
 * tests/audio-video-linkage.test.mjs — `node --test tests/audio-video-linkage.test.mjs`
 *
 * The audio → video linkage lock for the merged 0.3.0 app: a TTS output path is
 * fed straight back in as reference audio, with no new media adapter in between.
 *
 * The claim under test is the one the app's user story rests on — "先配音，再作为
 * H3 参考音频" — and it has two consumers in this app, both of which must accept
 * the very path `minimax_text_to_speech` returns:
 *   1. the video-generation body (`buildCreateRequestBody`, the `referenceAudios`
 *      string list the media pipeline passes); and
 *   2. the H3-Context-IR body (`buildContextIrRequestBody`, the open
 *      `{ kind: "local-file", path }` ref the tool schema advertises).
 *
 * Both must synthesise first (the tool really writes a file), then read that
 * exact file back and inline its bytes as a `role: "reference_audio"` data URL.
 *
 * Everything is offline: `fetch`, the bus and the readers are stubs; the only
 * real I/O is the temp file the TTS tool itself writes.
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
const { buildCreateRequestBody, buildContextIrRequestBody, MODEL_SPECS } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax-api.mjs"))
);

const AUDIO_BYTES = Buffer.from("synthesised-voice-bytes");

function fakeBus() {
  return {
    async request(verb) {
      if (verb === "provider:credentials") return { apiKey: "k".repeat(10) };
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
}

/** A TTS fetch answering the T2A endpoint with a hex audio payload. */
function ttsFetch(format = "mp3") {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: { audio: AUDIO_BYTES.toString("hex"), status: 2 },
        extra_info: {
          audio_length: 1000,
          audio_sample_rate: 32000,
          audio_format: format,
          word_count: 3,
        },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
  });
}

/** Synthesise a clip into a fresh temp dir and hand back the tool's result. */
async function synthesise(format = "mp3") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-link-"));
  const tool = createTtsTool({
    network: { fetch: ttsFetch(format) },
    bus: fakeBus(),
    generatedDir: dir,
  });
  const result = await tool.execute({ text: "旁白文本", format });
  return result;
}

/** Read a local-file path off disk; the readers receive the ref untouched. */
function readerFor(getPath) {
  return async (ref) => {
    const filePath = getPath(ref);
    return { content: await fs.readFile(filePath) };
  };
}

test("linkage: TTS 产物路径可直接作为媒体生成工具的参考音频（referenceAudios）", async () => {
  const synth = await synthesise("mp3");
  const ttsPath = synth.details.filePath;
  assert.ok(ttsPath, "TTS 返回本地路径");
  assert.equal(synth.details.format, "mp3");

  const body = await buildCreateRequestBody({
    params: {
      prompt: "配上刚合成的旁白",
      mode: "multimodal2video",
      referenceAudios: [ttsPath],
    },
    modelSpec: MODEL_SPECS["MiniMax-H3"],
    readReference: readerFor((ref) => ref),
    statReference: async () => null,
  });

  const audioItem = body.content.find((item) => item.role === "reference_audio");
  assert.ok(audioItem, "参考音频进入媒体生成请求体");
  assert.equal(audioItem.type, "audio_url");
  assert.ok(audioItem.audio_url.url.startsWith("data:audio/mpeg;base64,"));
  // 内联字节正是 TTS 写下的音频，端到端只有一份字节。
  const inlined = Buffer.from(audioItem.audio_url.url.split(",")[1], "base64");
  assert.deepEqual(inlined, AUDIO_BYTES);
});

test("linkage: TTS 产物路径同样可作为 H3-Context-IR 的参考音频（local-file 引用）", async () => {
  const synth = await synthesise("wav");
  const ttsPath = synth.details.filePath;
  assert.ok(ttsPath, "TTS 返回本地路径");
  assert.ok(ttsPath.endsWith(".wav"));

  const body = await buildContextIrRequestBody({
    prompt: "把这段旁白的语气纳入分镜规划",
    referenceAudios: [{ kind: "local-file", path: ttsPath }],
    readReference: readerFor((ref) => ref.path),
    statReference: async () => null,
  });

  const audioItem = body.content.find((item) => item.role === "reference_audio");
  assert.ok(audioItem, "参考音频进入 H3-Context-IR 请求体");
  assert.equal(audioItem.type, "audio_url");
  // MIME 由产物扩展名派生，容器与扩展名同源（.wav → audio/wav）。
  assert.ok(audioItem.audio_url.url.startsWith("data:audio/wav;base64,"));
  const inlined = Buffer.from(audioItem.audio_url.url.split(",")[1], "base64");
  assert.deepEqual(inlined, AUDIO_BYTES);
});
