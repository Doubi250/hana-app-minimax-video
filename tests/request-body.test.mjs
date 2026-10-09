/**
 * tests/request-body.test.mjs — `node --test tests`
 *
 * Every case here is offline: reference reads are injected stubs, so no API key
 * and no network are involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SPECS,
  buildCreateRequestBody,
  buildCapabilitySnapshot,
  extractBytes,
  inferMode,
  mimeForPath,
  taskHash,
  videoFileName,
} from "../lib/minimax-api.mjs";

const H3 = MODEL_SPECS["MiniMax-H3"];
const H3_MAX = MODEL_SPECS["MiniMax-H3-Max"];

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const readPng = async () => PNG_BYTES;

function build(params, modelSpec = H3, readReference = readPng) {
  return buildCreateRequestBody({ params, modelSpec, readReference });
}

/* 1. text2video ---------------------------------------------------- */

test("t2v: content is a single text item; ratio/resolution/duration pass through", async () => {
  const body = await build({
    prompt: "一只猫在窗台上打盹",
    modelId: "MiniMax-H3",
    duration: 6,
    ratio: "16:9",
    video_resolution: "2K",
  });
  assert.equal(body.model, "MiniMax-H3");
  assert.deepEqual(body.content, [{ type: "text", text: "一只猫在窗台上打盹" }]);
  assert.equal(body.duration, 6);
  assert.equal(body.resolution, "2K");
  assert.equal(body.ratio, "16:9");
  assert.equal(body.callback_url, undefined);
  assert.equal(body.aigc_watermark, undefined);
  assert.equal(body.prompt, undefined, "prompt rides inside content[], not at top level");
});

test("t2v: defaults — ratio 16:9, resolution 768P, duration 5", async () => {
  const body = await build({ prompt: "日出" });
  assert.equal(body.ratio, "16:9");
  assert.equal(body.resolution, "768P");
  assert.equal(body.duration, 5);
});

/* 2. t2v + adaptive ------------------------------------------------ */

test("t2v: ratio=adaptive is rejected", async () => {
  await assert.rejects(() => build({ prompt: "日出", ratio: "adaptive" }), /adaptive/);
});

/* 3. image2video --------------------------------------------------- */

test("i2v: one image becomes role=first_frame with a png data URL", async () => {
  const body = await build({
    prompt: "镜头缓慢推进",
    modelId: "MiniMax-H3",
    mode: "image2video",
    image: "C:/tmp/first.png",
  });
  assert.equal(body.content.length, 2);
  assert.equal(body.content[0].type, "text");
  assert.equal(body.content[1].type, "image_url");
  assert.equal(body.content[1].role, "first_frame");
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(body.ratio, "adaptive");
});

/* 4. last_frame2video ---------------------------------------------- */

test("last_frame2video: the single image becomes role=last_frame", async () => {
  const body = await build({
    prompt: "回到起点",
    mode: "last_frame2video",
    image: "C:/tmp/last.jpg",
  });
  assert.equal(body.content.length, 2);
  assert.equal(body.content[1].role, "last_frame");
  assert.ok(body.content[1].image_url.url.startsWith("data:image/jpeg;base64,"));
});

/* 5. frames2video -------------------------------------------------- */

test("frames2video: two images map to first_frame then last_frame in array order", async () => {
  const body = await build({
    prompt: "从白天到夜晚",
    mode: "frames2video",
    referenceImages: ["C:/tmp/a.png", "C:/tmp/b.png"],
  });
  assert.equal(body.content.length, 3);
  assert.equal(body.content[1].role, "first_frame");
  assert.equal(body.content[2].role, "last_frame");
});

test("frames2video: one image is rejected", async () => {
  await assert.rejects(
    () => build({ prompt: "x", mode: "frames2video", referenceImages: ["C:/tmp/a.png"] }),
    /恰好 2 张/,
  );
});

/* 6. multimodal2video ---------------------------------------------- */

test("multimodal2video: images/videos/audio get reference_* roles", async () => {
  const body = await build({
    prompt: "参考素材合成",
    mode: "multimodal2video",
    referenceImages: ["C:/tmp/a.png", "C:/tmp/b.webp"],
    referenceVideos: ["C:/tmp/clip.mp4"],
    referenceAudios: ["C:/tmp/voice.wav"],
  });
  const roles = body.content.slice(1).map((item) => item.role);
  assert.deepEqual(roles, ["reference_image", "reference_image", "reference_video", "reference_audio"]);
  assert.equal(body.content[1].type, "image_url");
  assert.equal(body.content[3].type, "video_url");
  assert.equal(body.content[4].type, "audio_url");
  assert.ok(body.content[4].audio_url.url.startsWith("data:audio/wav;base64,"));
  assert.equal(body.ratio, "adaptive");
});

test("inferMode: 1 image → image2video, 2+ or video/audio → multimodal2video", () => {
  assert.equal(inferMode({ prompt: "x" }), "text2video");
  assert.equal(inferMode({ prompt: "x", image: "C:/tmp/a.png" }), "image2video");
  assert.equal(inferMode({ prompt: "x", referenceImages: ["a.png", "b.png"] }), "multimodal2video");
  assert.equal(inferMode({ prompt: "x", audio: "a.mp3" }), "multimodal2video");
});

/* 7. validation ---------------------------------------------------- */

test("validation: empty prompt is rejected", async () => {
  await assert.rejects(() => build({ prompt: "   " }), /prompt/);
});

test("validation: H3-Max duration=4 is out of range", async () => {
  await assert.rejects(
    () => build({ prompt: "x", modelId: "MiniMax-H3-Max", duration: 4 }, H3_MAX),
    /5-15/,
  );
});

test("validation: H3 duration=16 is out of range", async () => {
  await assert.rejects(() => build({ prompt: "x", duration: 16 }), /4-15/);
});

test("validation: H3 does not accept 480P", async () => {
  await assert.rejects(() => build({ prompt: "x", video_resolution: "480P" }), /480P/);
});

test("validation: H3-Max does not accept 2K", async () => {
  await assert.rejects(
    () => build({ prompt: "x", modelId: "MiniMax-H3-Max", video_resolution: "2K" }, H3_MAX),
    /2K/,
  );
});

test("validation: an unknown model id is rejected", async () => {
  await assert.rejects(() => build({ prompt: "x", modelId: "MiniMax-H4" }), /MiniMax-H4/);
});

test("validation: r2va with 13 reference files is rejected", async () => {
  const images = Array.from({ length: 9 }, (_, i) => `C:/tmp/i${i}.png`);
  const videos = Array.from({ length: 3 }, (_, i) => `C:/tmp/v${i}.mp4`);
  await assert.rejects(
    () =>
      build({
        prompt: "x",
        mode: "multimodal2video",
        referenceImages: images,
        referenceVideos: videos,
        referenceAudios: ["C:/tmp/a.wav"],
      }),
    /12/,
  );
});

test("validation: an unknown extension is rejected", async () => {
  await assert.rejects(
    () => build({ prompt: "x", mode: "image2video", image: "C:/tmp/a.gif" }),
    /不支持的参考文件类型/,
  );
});

/* 8. file naming --------------------------------------------------- */

test("file name: stable per task, distinct across tasks, no path separators", () => {
  const a1 = videoFileName({ localTaskId: "t1", providerTaskId: "999", url: "https://cdn/x.mp4" });
  const a2 = videoFileName({ localTaskId: "t1", providerTaskId: "999", url: "https://cdn/x.mp4" });
  const b = videoFileName({ localTaskId: "t2", providerTaskId: "999", url: "https://cdn/x.mp4" });
  const c = videoFileName({ localTaskId: "t1", providerTaskId: "1000", url: "https://cdn/x.mp4" });
  const d = videoFileName({ localTaskId: "t1", providerTaskId: "999", url: "https://cdn/y.mp4" });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
  assert.notEqual(a1, d);
  assert.match(a1, /^minimax-[0-9a-f]{32}-[0-9a-f]{24}\.mp4$/);
  assert.ok(!a1.includes("/") && !a1.includes("\\"));
  assert.equal(taskHash({ localTaskId: "t1", providerTaskId: "999" }).length, 32);
});

test("mime: known extensions map through, jpg/jpeg share a type", () => {
  assert.equal(mimeForPath("a.PNG"), "image/png");
  assert.equal(mimeForPath("a.jpg"), "image/jpeg");
  assert.equal(mimeForPath("a.jpeg"), "image/jpeg");
  assert.equal(mimeForPath("a.mov"), "video/quicktime");
  assert.equal(mimeForPath("a.mp3"), "audio/mpeg");
});

/* 9. extractBytes -------------------------------------------------- */

test("extractBytes: tolerates every shape the host may return", () => {
  const expected = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual(extractBytes(Buffer.from([1, 2, 3, 4])), expected);
  assert.deepEqual(extractBytes(new Uint8Array([1, 2, 3, 4])), expected);
  assert.deepEqual(extractBytes({ $bytes: Buffer.from([1, 2, 3, 4]) }), expected);
  assert.deepEqual(extractBytes({ $bytes: Buffer.from([1, 2, 3, 4]).toString("base64") }), expected);
  assert.deepEqual(extractBytes({ type: "Buffer", data: [1, 2, 3, 4] }), expected);
  assert.deepEqual(extractBytes({ content: Buffer.from([1, 2, 3, 4]) }), expected);
  assert.deepEqual(extractBytes(Buffer.from([1, 2, 3, 4]).toString("base64")), expected);
  assert.deepEqual(extractBytes(Buffer.from("abcd", "utf8")), Buffer.from("abcd", "utf8"));
});

test("extractBytes: a useless shape reports the top-level keys", () => {
  assert.throws(() => extractBytes({ nope: 1, other: 2 }), /nope, other/);
});

/* 10. capability snapshot ------------------------------------------ */

test("capability snapshot: two models, five modes, protocolId matches the adapter", () => {
  const snapshot = buildCapabilitySnapshot();
  assert.equal(snapshot.providerId, "minimax-video");
  const video = snapshot.media.videoGeneration;
  assert.equal(video.defaultModelId, "MiniMax-H3");
  assert.equal(video.models.length, 2);
  for (const model of video.models) {
    assert.equal(model.protocolId, "minimax-video-videos");
    assert.equal(model.modes.length, 5);
    assert.deepEqual(model.outputs, ["video"]);
  }
  const h3 = video.models.find((m) => m.id === "MiniMax-H3");
  const h3max = video.models.find((m) => m.id === "MiniMax-H3-Max");
  assert.deepEqual(h3.resolutions, ["768P", "2K"]);
  assert.deepEqual(h3max.resolutions, ["480P", "768P"]);
  assert.deepEqual(h3.duration, { min: 4, max: 15 });
  assert.deepEqual(h3max.duration, { min: 5, max: 15 });
});
