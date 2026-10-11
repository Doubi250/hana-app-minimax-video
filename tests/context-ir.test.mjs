/**
 * tests/context-ir.test.mjs — `node --test tests/context-ir.test.mjs`
 *
 * Offline coverage for the H3-Context-IR seams this ticket adds:
 *   1. `buildContextIrRequestBody` — the `POST /v2/h3_context_ir` body builder
 *      (model, text content, per-scenario duration/ratio rules) and its
 *      multimodal references: first/last frames, reference_* lists, the
 *      session-file / local-file / URL shapes and the shared transport budget;
 *   2. `createMinimaxClient().createContextIrTask` / `queryContextIrTask` — the
 *      submit POST and the shared query endpoint, whose result is read from
 *      `task.content.prompt` (NOT the video-style `content.url`).
 *
 * No key and no network: `fetch` is an injected stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildContextIrRequestBody, RATIOS_NO_ADAPTIVE } from "../lib/minimax-api.mjs";
import { createMinimaxClient } from "../lib/minimax-client.mjs";

/* 1. request body -------------------------------------------------- */

test("context-ir body: defaults — MiniMax-H3, single text item, duration 5, ratio 16:9", async () => {
  const body = await buildContextIrRequestBody({ prompt: "一只猫在窗台上打盹" });
  assert.deepEqual(body, {
    model: "MiniMax-H3",
    content: [{ type: "text", text: "一只猫在窗台上打盹" }],
    duration: 5,
    ratio: "16:9",
  });
  assert.equal(body.prompt, undefined, "prompt rides inside content[], not at top level");
});

test("context-ir body: explicit duration/ratio pass through, prompt is trimmed", async () => {
  const body = await buildContextIrRequestBody({ prompt: "  日落时分  ", duration: 15, ratio: "9:16" });
  assert.equal(body.content[0].text, "日落时分");
  assert.equal(body.duration, 15);
  assert.equal(body.ratio, "9:16");
});

test("context-ir body: ratio must be one of the six literal options", async () => {
  assert.deepEqual(RATIOS_NO_ADAPTIVE, ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  for (const ratio of RATIOS_NO_ADAPTIVE) {
    const body = await buildContextIrRequestBody({ prompt: "x", ratio });
    assert.equal(body.ratio, ratio);
  }
});

test("context-ir body: adaptive is rejected (a text scenario has no source frame)", async () => {
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "x", ratio: "adaptive" }), /adaptive/);
});

test("context-ir body: an unknown ratio is rejected with the supported list", async () => {
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "x", ratio: "3:2" }), /3:2/);
});

test("context-ir body: empty prompt is rejected", async () => {
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "   " }), /prompt/);
  await assert.rejects(() => buildContextIrRequestBody({}), /prompt/);
});

test("context-ir body: duration must be an integer within 4-15", async () => {
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "x", duration: 16 }), /4-15/);
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "x", duration: 3 }), /4-15/);
  await assert.rejects(() => buildContextIrRequestBody({ prompt: "x", duration: 4.5 }), /整数/);
});

/* 1b. first/last frames -------------------------------------------- */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test("context-ir body: first+last frame refs become first_frame/last_frame data URLs; ratio pins to adaptive", async () => {
  const reads = [];
  const body = await buildContextIrRequestBody({
    prompt: "从清晨到黄昏",
    firstFrame: { kind: "local-file", path: "C:/tmp/a.png" },
    lastFrame: { kind: "local-file", path: "C:/tmp/b.jpg" },
    ratio: "16:9",
    readReference: async (ref) => {
      reads.push(ref);
      return ref.path.endsWith(".png") ? PNG_BYTES : JPEG_BYTES;
    },
  });
  assert.deepEqual(reads, [
    { kind: "local-file", path: "C:/tmp/a.png" },
    { kind: "local-file", path: "C:/tmp/b.jpg" },
  ]);
  assert.equal(body.content[0].type, "text");
  assert.equal(body.content.length, 3);
  assert.equal(body.content[1].role, "first_frame");
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(body.content[2].role, "last_frame");
  assert.ok(body.content[2].image_url.url.startsWith("data:image/jpeg;base64,"));
  assert.equal(body.ratio, "adaptive", "the input image decides the aspect ratio");
});

test("context-ir body: a public URL string passes through untouched and never reads bytes", async () => {
  let reads = 0;
  const readReference = async () => {
    reads += 1;
    return PNG_BYTES;
  };
  const body = await buildContextIrRequestBody({
    prompt: "x",
    firstFrame: "https://cdn.example.com/a.png",
    readReference,
  });
  assert.equal(body.content[1].image_url.url, "https://cdn.example.com/a.png");
  assert.equal(body.content[1].role, "first_frame");
  assert.equal(reads, 0, "a public URL is passed through, not fetched");
});

test("context-ir body: a session-file frame reads through the open ref and takes its MIME from the host reply", async () => {
  const reads = [];
  const body = await buildContextIrRequestBody({
    prompt: "x",
    lastFrame: { kind: "session-file", fileId: "f-1" },
    readReference: async (ref) => {
      reads.push(ref);
      return { filePath: "C:/cache/f-1-photo.webp", content: PNG_BYTES };
    },
  });
  assert.deepEqual(reads, [{ kind: "session-file", fileId: "f-1" }]);
  assert.equal(body.content[1].role, "last_frame");
  assert.ok(body.content[1].image_url.url.startsWith("data:image/webp;base64,"));
});

test("context-ir body: frames reject an unknown ratio but always emit adaptive", async () => {
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", lastFrame: "https://cdn.example.com/a.png", ratio: "3:2" }),
    /3:2/,
  );
  const body = await buildContextIrRequestBody({
    prompt: "x",
    lastFrame: "https://cdn.example.com/a.png",
    ratio: "adaptive",
  });
  assert.equal(body.ratio, "adaptive");
});

test("context-ir body: malformed single refs are rejected with the accepted shapes", async () => {
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", firstFrame: { kind: "nope" } }),
    /session-file/,
  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", firstFrame: { kind: "session-file" } }),
    /fileId/,
  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", firstFrame: "C:/tmp/a.png" }),
    /http\(s\)/,
  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", firstFrame: ["https://cdn.example.com/a.png"] }),
    /单个引用/,
  );
  // The object form is not part of the advertised surface: the schema lists
  // exactly session-file / local-file, and a public URL travels as a plain
  // http(s) string. `{ kind: "url" }` is therefore rejected, not accepted.
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        firstFrame: { kind: "url", url: "https://cdn.example.com/a.png" },
      }),
    /引用形状无效/,
  );
});

/* 1c. reference materials ------------------------------------------ */

test("context-ir body: reference lists map to reference_image/video/audio roles in order", async () => {
  const body = await buildContextIrRequestBody({
    prompt: "参考素材合成",
    referenceImages: ["https://cdn.example.com/a.png", { kind: "session-file", fileId: "f-2" }],
    referenceVideos: ["https://cdn.example.com/clip.mp4"],
    referenceAudios: [{ kind: "local-file", path: "C:/tmp/voice.wav" }],
    readReference: async (ref) =>
      ref.kind === "session-file" ? { filePath: "C:/cache/f-2.webp", content: PNG_BYTES } : Buffer.from([0x52, 0x49, 0x46, 0x46]),
  });
  const items = body.content.slice(1);
  assert.deepEqual(items.map((item) => item.role), [
    "reference_image",
    "reference_image",
    "reference_video",
    "reference_audio",
  ]);
  assert.deepEqual(items.map((item) => item.type), ["image_url", "image_url", "video_url", "audio_url"]);
  assert.equal(items[0].image_url.url, "https://cdn.example.com/a.png");
  assert.ok(items[1].image_url.url.startsWith("data:image/webp;base64,"));
  assert.ok(items[3].audio_url.url.startsWith("data:audio/wav;base64,"));
  assert.equal(body.ratio, "adaptive", "a pure reference scenario defaults to adaptive");
});

test("context-ir body: a pure reference scenario may pick a concrete ratio", async () => {
  const body = await buildContextIrRequestBody({
    prompt: "x",
    referenceImages: ["https://cdn.example.com/a.png"],
    ratio: "9:16",
  });
  assert.equal(body.ratio, "9:16");
});

test("context-ir body: first/last frame mixed with reference materials is rejected", async () => {
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        firstFrame: "https://cdn.example.com/a.png",
        referenceImages: ["https://cdn.example.com/b.png"],
      }),
    /互斥/,
  );
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        lastFrame: "https://cdn.example.com/a.png",
        referenceAudios: ["https://cdn.example.com/v.wav"],
      }),
    /互斥/,
  );
});

test("context-ir body: caps — images ≤9, videos ≤3, audios ≤3, with the exact Chinese messages", async () => {
  const urls = (ext, count) =>
    Array.from({ length: count }, (_, i) => `https://cdn.example.com/${i}.${ext}`);
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", referenceImages: urls("png", 10) }),
    (error) => error.message === "H3-Context-IR 最多支持 9 张参考图片（收到 10 张）",
  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", referenceVideos: urls("mp4", 4) }),
    (error) => error.message === "H3-Context-IR 最多支持 3 个参考视频（收到 4 个）",
  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", referenceAudios: urls("wav", 4) }),
    (error) => error.message === "H3-Context-IR 最多支持 3 段参考音频（收到 4 段）",
  );
  const body = await buildContextIrRequestBody({
    prompt: "x",
    referenceImages: urls("png", 9),
    referenceVideos: urls("mp4", 3),
    referenceAudios: urls("wav", 3),
  });
  assert.equal(body.content.length, 1 + 9 + 3 + 3);
});

test("context-ir body: a single-file read over 12MB is rejected with the shared budget message", async () => {
  const oversized = Buffer.alloc(12 * 1024 * 1024 + 1);
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        referenceImages: [{ kind: "local-file", path: "C:/tmp/big.png" }],
        readReference: async () => oversized,
      }),
    /单文件 ≤12MB、总量 ≤16MB/,
  );
});

test("context-ir body: cumulative reads over 16MB are rejected even when each file fits", async () => {
  const sixMb = Buffer.alloc(6 * 1024 * 1024);
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        referenceImages: [
          { kind: "local-file", path: "C:/tmp/a.png" },
          { kind: "local-file", path: "C:/tmp/b.png" },
          { kind: "local-file", path: "C:/tmp/c.png" },
        ],
        readReference: async () => sixMb,
      }),
    /总量 ≤16MB/,
  );
});

test("context-ir body: URL references are exempt from the byte budget", async () => {
  let reads = 0;
  const body = await buildContextIrRequestBody({
    prompt: "x",
    referenceImages: Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/${i}.png`),
    readReference: async () => {
      reads += 1;
      return Buffer.alloc(12 * 1024 * 1024);
    },
  });
  assert.equal(body.content.length, 10);
  assert.equal(reads, 0, "URLs never touch the byte reader");
});

test("context-ir body: a stat bigger than the per-file cap is rejected before any read", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      buildContextIrRequestBody({
        prompt: "x",
        referenceVideos: [{ kind: "local-file", path: "C:/tmp/big.mp4" }],
        readReference: async () => {
          reads += 1;
          return Buffer.alloc(1);
        },
        statReference: async () => ({ version: { size: 13 * 1024 * 1024 } }),
      }),
    /单文件 ≤12MB/,
  );
  assert.equal(reads, 0);
});

test("context-ir body: an empty reference list entry is rejected", async () => {
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", referenceImages: ["   "] }),
    /空/,  );
  await assert.rejects(
    () => buildContextIrRequestBody({ prompt: "x", referenceVideos: [{ kind: "local-file", path: "  " }] }),
    /path/,
  );
});

test("manifest: the three new capabilities are declared and the version is 0.2.0", () => {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const capability of ["app/tools.expose-to-model", "app/tasks.manage", "app/session.start-turn"]) {
    assert.ok(manifest.capabilities.includes(capability), `missing capability: ${capability}`);
  }
  assert.equal(manifest.version, "0.2.0", "v0.2.0 release");
});

/* 2. client: submit + query ---------------------------------------- */

function mockFetch(responder) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    },
  };
}

test("client: createContextIrTask POSTs to /v2/h3_context_ir and returns the task id", async () => {
  const { calls, fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task_id: "ci-1" }),
  }));
  const client = createMinimaxClient({ fetch });
  const { taskId } = await client.createContextIrTask({ auth: { apiKey: "k" }, body: { model: "MiniMax-H3" } });
  assert.equal(taskId, "ci-1");
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].url.endsWith("/v2/h3_context_ir"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "MiniMax-H3" });
});

test("client: queryContextIrTask hits the shared query endpoint and reads task.content.prompt", async () => {
  const { calls, fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "success", content: { prompt: "增强后的提示词" } } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci 1" });
  assert.ok(calls[0].url.endsWith("/v2/query/video_generation/ci%201"));
  assert.equal(remote.mapped, "success");
  assert.equal(remote.prompt, "增强后的提示词");
  assert.equal(remote.status, "success");
});

test("client: queryContextIrTask maps a running task to pending, no prompt yet", async () => {
  const { fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "running" } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci-2" });
  assert.equal(remote.mapped, "pending");
  assert.equal(remote.prompt, null);
});

test("client: queryContextIrTask surfaces a failed task's reason", async () => {
  const { fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "failed", error: { message: "内容审核未通过" } } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci-3" });
  assert.equal(remote.mapped, "failed");
  assert.match(remote.failReason, /内容审核未通过/);
});
