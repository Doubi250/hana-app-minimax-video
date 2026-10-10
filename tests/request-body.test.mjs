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
  MAX_REFERENCE_FILE_BYTES,
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

/* 6b. regeneration (2K, source_task_id path) ----------------------- */

test("regeneration: a bare source_task_id drives the dedicated 2K body", async () => {
  // No `mode`, no `prompt`: the source_task_id itself identifies the request.
  const body = await build({
    source_task_id: "mm-768p-task-1",
    duration: 6,
    ratio: "adaptive",
  });
  assert.deepEqual(body, {
    model: "MiniMax-H3",
    source_task_id: "mm-768p-task-1",
    resolution: "2K",
  });
  // The source task fixes content, duration and ratio — none of them ride along.
  assert.equal("content" in body, false);
  assert.equal("duration" in body, false);
  assert.equal("ratio" in body, false);
  assert.equal("aigc_watermark" in body, false, "not set → not carried");
});

test("regeneration: a non-empty source_task_id routes there even without the mode", async () => {
  // Either signal identifies the request; a stray mode must not misroute it.
  const body = await build({ mode: "text2video", source_task_id: "t-2", prompt: "ignored" });
  assert.equal(body.source_task_id, "t-2");
  assert.equal(body.content, undefined);
});

test("regeneration: explicit mode + watermark opt-in", async () => {
  const body = await build({
    prompt: "x",
    mode: "regeneration",
    source_task_id: "t-1",
    video_resolution: "2K",
    aigc_watermark: true,
  });
  assert.deepEqual(body, {
    model: "MiniMax-H3",
    source_task_id: "t-1",
    resolution: "2K",
    aigc_watermark: true,
  });
  const optedOut = await build({ source_task_id: "t-1", aigc_watermark: false });
  assert.equal(optedOut.aigc_watermark, false, "explicitly given → carried even when false");
});

test("regeneration: mode=regeneration without a source_task_id is rejected", async () => {
  await assert.rejects(
    () => build({ prompt: "x", mode: "regeneration" }),
    /source_task_id/,
  );
});

test("regeneration: only 2K passes the resolution gate", async () => {
  await assert.rejects(
    () => build({ source_task_id: "t-1", video_resolution: "768P" }),
    /只支持分辨率/,
  );
});

test("regeneration: H3-Max does not carry the mode — explicit or via source_task_id", async () => {
  await assert.rejects(
    () => build({ prompt: "x", mode: "regeneration", source_task_id: "t-1", modelId: "MiniMax-H3-Max" }, H3_MAX),
    (error) => /MiniMax-H3-Max/.test(error.message) && /regeneration/.test(error.message),
  );
  await assert.rejects(
    () => build({ prompt: "x", source_task_id: "t-1", modelId: "MiniMax-H3-Max" }, H3_MAX),
    /不支持模式/,
  );
});

/* 6c. regeneration (2K, base_video path) --------------------------- */

test("regeneration base_video: prompt + source video build a text+base_video body", async () => {
  const body = await build({
    mode: "regeneration",
    prompt: "重现原提示词",
    video: "C:/tmp/source.mp4",
    duration: 6,
    ratio: "adaptive",
  });
  assert.equal(body.model, "MiniMax-H3");
  assert.equal(body.resolution, "2K");
  assert.equal(body.source_task_id, undefined);
  assert.equal(body.duration, undefined);
  assert.equal(body.ratio, undefined);
  assert.equal("aigc_watermark" in body, false, "not set → not carried");
  assert.equal(body.content.length, 2);
  assert.deepEqual(body.content[0], { type: "text", text: "重现原提示词" });
  assert.equal(body.content[1].type, "video_url");
  assert.equal(body.content[1].role, "base_video");
  assert.ok(body.content[1].video_url.url.startsWith("data:video/mp4;base64,"));
});

test("regeneration base_video: the prompt is required — the original text must be reproduced", async () => {
  await assert.rejects(
    () => build({ mode: "regeneration", video: "C:/tmp/source.mp4" }),
    /prompt/,
  );
});

test("regeneration base_video: a non-2K resolution is rejected like the source path", async () => {
  await assert.rejects(
    () =>
      build({
        mode: "regeneration",
        prompt: "x",
        video: "C:/tmp/source.mp4",
        video_resolution: "768P",
      }),
    /只支持分辨率/,
  );
});

test("regeneration base_video: materials keep their original roles, base video goes last", async () => {
  const body = await build({
    mode: "regeneration",
    prompt: "重现原提示词",
    // `image` / `audio` repeat the reference lists here on purpose: the host
    // mirrors a non-empty referenceVideos / referenceImages / referenceAudios
    // array onto the singular keys, and that mirrored copy must not turn into
    // a first frame, a duplicate, or a base video.
    image: ["C:/tmp/ref1.png", "C:/tmp/ref2.png"],
    referenceImages: ["C:/tmp/ref1.png", "C:/tmp/ref2.png"],
    referenceVideos: ["C:/tmp/ref.mp4"],
    referenceAudios: ["C:/tmp/ref.wav"],
    audio: ["C:/tmp/ref.wav"],
    video: "C:/tmp/source.mp4",
    aigc_watermark: true,
  });
  assert.equal(body.source_task_id, undefined);
  assert.equal(body.aigc_watermark, true, "the watermark opt-in rides along on this path too");
  const items = body.content.slice(1);
  assert.deepEqual(
    items.map((item) => item.role),
    ["reference_image", "reference_image", "reference_video", "reference_audio", "base_video"],
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["image_url", "image_url", "video_url", "audio_url", "video_url"],
  );
  assert.ok(items[0].image_url.url.startsWith("data:image/png;base64,"));
  assert.ok(items[3].audio_url.url.startsWith("data:audio/wav;base64,"));
  assert.ok(items[4].video_url.url.startsWith("data:video/mp4;base64,"));
});

test("regeneration base_video: a lone image reproduces the original first frame", async () => {
  const body = await build({
    mode: "regeneration",
    prompt: "重现原提示词",
    image: "C:/tmp/first.png",
    video: "C:/tmp/source.mp4",
  });
  const items = body.content.slice(1);
  assert.deepEqual(items.map((item) => item.role), ["first_frame", "base_video"]);
  assert.ok(items[0].image_url.url.startsWith("data:image/png;base64,"));
});

test("regeneration: source_task_id and video together are rejected (二选一)", async () => {
  await assert.rejects(
    () =>
      build({
        mode: "regeneration",
        prompt: "x",
        source_task_id: "t-1",
        video: "C:/tmp/source.mp4",
      }),
    /二选一/,
  );
});

test("regeneration: neither source_task_id nor video is rejected, listing both ways", async () => {
  await assert.rejects(
    () => build({ mode: "regeneration", prompt: "x" }),
    (error) => /source_task_id/.test(error.message) && /video/.test(error.message),
  );
});

test("regeneration base_video: two video items are rejected — exactly one base video", async () => {
  await assert.rejects(
    () =>
      build({
        mode: "regeneration",
        prompt: "x",
        video: ["C:/tmp/a.mp4", "C:/tmp/b.mp4"],
      }),
    /恰好 1 个/,
  );
});

test("regeneration base_video: a host-mirrored referenceVideos array is not a base video", async () => {
  // The host mirrors a non-empty `referenceVideos` onto `video` when `video`
  // was not supplied; the same list arrives under both keys and must still
  // read as reference-only, not as a base video.
  await assert.rejects(
    () =>
      build({
        mode: "regeneration",
        prompt: "x",
        video: ["C:/tmp/ref.mp4"],
        referenceVideos: ["C:/tmp/ref.mp4"],
      }),
    /二选一/,
  );
});

test("regeneration base_video: a bare video param without the mode stays multimodal", async () => {
  const body = await build({ prompt: "x", video: "C:/tmp/clip.mp4" });
  assert.equal(body.content[1].role, "reference_video");
  assert.equal(body.source_task_id, undefined);
});

test("regeneration base_video: an over-budget source video points at source_task_id", async () => {
  const bigVideo = Buffer.alloc(MAX_REFERENCE_FILE_BYTES + 1);
  await assert.rejects(
    () =>
      build(
        { mode: "regeneration", prompt: "x", video: "C:/tmp/big.mp4" },
        H3,
        async () => bigVideo,
      ),
    (error) => /12MB/.test(error.message) && /source_task_id/.test(error.message) && /压缩/.test(error.message),
  );
});

test("regeneration base_video: a total-budget overflow keeps the standard message, not the source_task_id hint", async () => {
  // The source video itself fits (7MB ≤ 12MB), but reading it pushes the
  // shared total past 16MB (10MB material + 7MB source). That is a TOTAL
  // overflow: the dedicated source_task_id hint is scoped to the single-file
  // case, so this must surface the standard budget message instead.
  const tenMb = Buffer.alloc(10 * 1024 * 1024);
  const sevenMb = Buffer.alloc(7 * 1024 * 1024);
  await assert.rejects(
    () =>
      build(
        {
          mode: "regeneration",
          prompt: "x",
          video: "C:/tmp/source.mp4",
          referenceVideos: ["C:/tmp/ref.mp4"],
        },
        H3,
        async (filePath) => (filePath.endsWith("source.mp4") ? sevenMb : tenMb),
      ),
    (error) =>
      /参考素材超出传输限制/.test(error.message) &&
      /总量 ≤16MB/.test(error.message) &&
      !/source_task_id/.test(error.message),
  );
});

test("regeneration base_video: other materials keep the existing budget message", async () => {
  const bigImage = Buffer.alloc(MAX_REFERENCE_FILE_BYTES + 1);
  await assert.rejects(
    () =>
      build(
        {
          mode: "regeneration",
          prompt: "x",
          video: "C:/tmp/source.mp4",
          referenceImages: ["C:/tmp/big.png"],
        },
        H3,
        async () => bigImage,
      ),
    /参考素材超出传输限制/,
  );
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

test("capability snapshot: two models with per-model modes, protocolId matches the adapter", () => {
  const snapshot = buildCapabilitySnapshot();
  assert.equal(snapshot.providerId, "minimax-video");
  const video = snapshot.media.videoGeneration;
  assert.equal(video.defaultModelId, "MiniMax-H3");
  assert.equal(video.models.length, 2);
  for (const model of video.models) {
    assert.equal(model.protocolId, "minimax-video-videos");
    assert.deepEqual(model.outputs, ["video"]);
  }
  const h3 = video.models.find((m) => m.id === "MiniMax-H3");
  const h3max = video.models.find((m) => m.id === "MiniMax-H3-Max");
  // The five generation modes are shared; regeneration is H3-only.
  assert.equal(h3.modes.length, 6);
  assert.equal(h3max.modes.length, 5);
  assert.ok(h3.modes.some((m) => m.id === "regeneration" && m.label === "2K 再生成"));
  assert.ok(!h3max.modes.some((m) => m.id === "regeneration"));
  assert.deepEqual(h3.resolutions, ["768P", "2K"]);
  assert.deepEqual(h3max.resolutions, ["480P", "768P"]);
  assert.deepEqual(h3.duration, { min: 4, max: 15 });
  assert.deepEqual(h3max.duration, { min: 5, max: 15 });
});

test("regeneration mode schema: source_task_id + 2K resolution + opt-in watermark, multimodal limits", () => {
  const snapshot = buildCapabilitySnapshot();
  const h3 = snapshot.media.videoGeneration.models.find((m) => m.id === "MiniMax-H3");
  const regen = h3.modes.find((m) => m.id === "regeneration");
  const props = regen.parameterSchema.properties;
  // The source task fixes duration and ratio — they are not parameters here.
  assert.equal("duration" in props, false);
  assert.equal("ratio" in props, false);
  assert.equal(props.source_task_id.type, "string");
  assert.deepEqual(props.video_resolution.enum, ["2K"]);
  assert.equal(props.video_resolution.default, "2K");
  assert.equal(props.aigc_watermark.type, "boolean");
  assert.equal(props.aigc_watermark.default, false);
  assert.deepEqual(regen.defaults, { video_resolution: "2K", aigc_watermark: false });
  assert.deepEqual(regen.inputLimits, {
    referenceImages: { min: 0, max: 9 },
    referenceVideos: { min: 0, max: 3 },
    referenceAudios: { min: 0, max: 3 },
  });
});

test("parameterSchema: each mode labels its parameters in Chinese (regeneration has its own set)", () => {
  const snapshot = buildCapabilitySnapshot();
  for (const model of snapshot.media.videoGeneration.models) {
    for (const mode of model.modes) {
      const props = mode.parameterSchema.properties;
      if (mode.id === "regeneration") {
        // No duration/ratio here: the source task determines both.
        assert.equal(props.source_task_id.title, "源任务 ID");
        assert.equal(props.video_resolution.title, "分辨率");
        assert.equal(props.aigc_watermark.title, "AIGC 水印");
        continue;
      }
      assert.equal(props.duration.title, "生成视频时长（秒）");
      assert.equal(props.ratio.title, "宽高比");
      assert.equal(props.video_resolution.title, "分辨率");
      // The enum option values stay literal — only the field label is Chinese.
      assert.ok(props.video_resolution.enum.includes("768P"));
    }
  }
});
