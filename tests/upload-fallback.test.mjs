/**
 * tests/upload-fallback.test.mjs — `node --test tests/upload-fallback.test.mjs`
 *
 * 参考素材「先上传取 file_id、以云端引用提交」优先路径与 base64 回落路径。
 *
 * 覆盖：
 *   - 上传成功 → content 写 `mm_file://{fileId}`，字节不计入 16MB 内联预算；
 *   - 上传抛错 / 返回无 fileId → 回落 base64，请求体仍合法，并记一条 warn；
 *   - 回落路径仍受既有预算（单文件 ≤12MB、总量 ≤16MB）；
 *   - 未注入 upload 时与 0.3.0 完全一致；
 *   - 适配器 submit 注入上传依赖：上传成功走云端引用，上传失败静默回落且仍提交成功。
 *
 * 全部离线：readReference / upload / fetch 均为替身，无 key、无网络。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_SPECS } from "../lib/minimax/model-catalog.mjs";
import { buildCreateRequestBody } from "../lib/minimax/request-body.mjs";
import { createMinimaxVideoAdapter } from "../lib/minimax-adapter.mjs";

const H3 = MODEL_SPECS["MiniMax-H3"];
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function fakeLogger() {
  return {
    warns: [],
    infos: [],
    async warn(message) {
      this.warns.push(String(message));
    },
    async info(message) {
      this.infos.push(String(message));
    },
  };
}

function build(params, { readReference = async () => PNG_BYTES, upload, logger } = {}) {
  return buildCreateRequestBody({
    params,
    modelSpec: H3,
    readReference,
    ...(upload ? { upload } : {}),
    ...(logger ? { logger } : {}),
  });
}

/* ---------------------------------------------------------------- *
 * 上传成功：云端引用，字节不计预算
 * ---------------------------------------------------------------- */

test("上传成功：content 写 mm_file://{fileId}，且不内联字节、不计入 16MB 预算", async () => {
  const logger = fakeLogger();
  // 单文件 20MB：既超单文件 12MB、也超总量 16MB —— 上传成功路径必须完全豁免内联预算。
  const huge = Buffer.alloc(20 * 1024 * 1024);
  const body = await build(
    { prompt: "参考素材合成", mode: "image2video", image: "C:/tmp/big.png" },
    { readReference: async () => huge, upload: async () => ({ fileId: "file-cloud-1" }), logger },
  );

  assert.equal(body.content[1].type, "image_url");
  assert.equal(body.content[1].role, "first_frame");
  assert.equal(body.content[1].image_url.url, "mm_file://file-cloud-1");
  assert.ok(!JSON.stringify(body).includes("base64"), "上传成功不得内联字节");
  assert.equal(logger.warns.length, 0, "成功路径不产生 warn");
});

test("上传成功：多素材各自取到 fileId，按 role 分别写云端引用", async () => {
  const logger = fakeLogger();
  const seen = [];
  const body = await build(
    {
      prompt: "多模态参考",
      mode: "multimodal2video",
      referenceImages: ["C:/tmp/a.png", "C:/tmp/b.png"],
      referenceVideos: ["C:/tmp/clip.mp4"],
      referenceAudios: ["C:/tmp/voice.wav"],
    },
    {
      upload: async ({ purpose, fileName, mimeType }) => {
        seen.push({ purpose, fileName, mimeType });
        return { fileId: `fid-${seen.length}` };
      },
      logger,
    },
  );

  const items = body.content.slice(1);
  assert.deepEqual(
    items.map((i) => i.image_url?.url ?? i.video_url?.url ?? i.audio_url?.url),
    ["mm_file://fid-1", "mm_file://fid-2", "mm_file://fid-3", "mm_file://fid-4"],
  );
  assert.deepEqual(seen.map((s) => s.purpose), Array(4).fill("video_generation_input"));
  assert.deepEqual(seen.map((s) => s.fileName), ["a.png", "b.png", "clip.mp4", "voice.wav"]);
  assert.equal(seen[0].mimeType, "image/png");
  assert.equal(seen[2].mimeType, "video/mp4");
  assert.equal(seen[3].mimeType, "audio/wav");
  assert.equal(logger.warns.length, 0);
});

/* ---------------------------------------------------------------- *
 * 上传失败：回落 base64 + 一条 warn，请求体仍合法
 * ---------------------------------------------------------------- */

test("上传失败（抛错）：回落 base64，请求体仍合法，并记一条含「上传失败」的 warn", async () => {
  const logger = fakeLogger();
  const body = await build(
    {
      prompt: "镜头缓慢推进",
      modelId: "MiniMax-H3",
      mode: "image2video",
      image: "C:/tmp/first.png",
      duration: 6,
      video_resolution: "2K",
    },
    {
      upload: async () => {
        throw new Error("Files 上传失败 (502): upstream boom");
      },
      logger,
    },
  );

  // 请求体完整性：模型 / 文本 / 参考项 / 参数齐全。
  assert.equal(body.model, "MiniMax-H3");
  assert.equal(body.content[0].type, "text");
  assert.equal(body.content[0].text, "镜头缓慢推进");
  assert.equal(body.content[1].type, "image_url");
  assert.equal(body.content[1].role, "first_frame");
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(body.duration, 6);
  assert.equal(body.resolution, "2K");
  assert.equal(body.ratio, "adaptive");

  assert.equal(logger.warns.length, 1, "回落恰好记一条 warn");
  assert.match(logger.warns[0], /上传失败/);
});

test("上传返回无 fileId：同样回落 base64 并记一条 warn", async () => {
  const logger = fakeLogger();
  const body = await build(
    { prompt: "x", mode: "image2video", image: "C:/tmp/first.png" },
    { upload: async () => ({ bytes: 12 }), logger },
  );
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0], /上传失败/);
});

test("部分素材上传失败：成功者走云端引用、失败者回落 base64，互不影响", async () => {
  const logger = fakeLogger();
  let call = 0;
  const body = await build(
    {
      prompt: "x",
      mode: "multimodal2video",
      referenceImages: ["C:/tmp/a.png", "C:/tmp/b.png"],
    },
    {
      upload: async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
        return { fileId: "fid-2" };
      },
      logger,
    },
  );
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(body.content[2].image_url.url, "mm_file://fid-2");
  assert.equal(logger.warns.length, 1);
});

/* ---------------------------------------------------------------- *
 * 回落路径仍受既有预算约束
 * ---------------------------------------------------------------- */

test("回落仍受总量预算约束：两份素材合计 >16MB 报错（消息含「总量 ≤16MB」）", async () => {
  const tenMb = Buffer.alloc(10 * 1024 * 1024);
  await assert.rejects(
    () =>
      build(
        {
          prompt: "x",
          mode: "multimodal2video",
          referenceImages: ["C:/tmp/a.png", "C:/tmp/b.png"],
        },
        {
          readReference: async () => tenMb,
          upload: async () => {
            throw new Error("boom");
          },
          logger: fakeLogger(),
        },
      ),
    (error) =>
      /参考素材超出传输限制/.test(error.message) && /总量 ≤16MB/.test(error.message),
  );
});

test("回落仍受单文件预算约束：单份素材 >12MB 报错（消息含「单文件 ≤12MB」）", async () => {
  const big = Buffer.alloc(13 * 1024 * 1024);
  await assert.rejects(
    () =>
      build(
        { prompt: "x", mode: "image2video", image: "C:/tmp/big.png" },
        {
          readReference: async () => big,
          upload: async () => {
            throw new Error("boom");
          },
          logger: fakeLogger(),
        },
      ),
    /单文件 ≤12MB/,
  );
});

/* ---------------------------------------------------------------- *
 * 未注入 upload：与 0.3.0 完全一致
 * ---------------------------------------------------------------- */

test("未注入 upload：走既有 base64 路径，且不产生 warn", async () => {
  const logger = fakeLogger();
  const body = await buildCreateRequestBody({
    params: { prompt: "x", mode: "image2video", image: "C:/tmp/first.png" },
    modelSpec: H3,
    readReference: async () => PNG_BYTES,
    logger,
  });
  assert.ok(body.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(logger.warns.length, 0);
});

/* ---------------------------------------------------------------- *
 * 2K 再生成装配同样支持 upload
 * ---------------------------------------------------------------- */

test("2K 再生成 base_video：上传成功写 mm_file://，源片不再内联", async () => {
  const logger = fakeLogger();
  const body = await build(
    { mode: "regeneration", prompt: "重现原提示词", video: "C:/tmp/source.mp4" },
    { upload: async () => ({ fileId: "src-cloud" }), logger },
  );
  assert.equal(body.resolution, "2K");
  assert.equal(body.content[1].role, "base_video");
  assert.equal(body.content[1].video_url.url, "mm_file://src-cloud");
  assert.equal(logger.warns.length, 0);
});

/* ---------------------------------------------------------------- *
 * 适配器：submit 注入上传依赖
 * ---------------------------------------------------------------- */

/** MiniMax 出站替身：Files 上传与 create 两个端点分开应答，记录每次调用。 */
function adapterFetch({ uploadOk = true } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.includes("/v1/files/upload")) {
      if (!uploadOk) {
        return {
          ok: false,
          status: 502,
          text: async () => JSON.stringify({ message: "boom" }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            file: { file_id: "up-1", bytes: PNG_BYTES.length, filename: "a.png" },
            base_resp: { status_code: 0, status_msg: "success" },
          }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: "t-9" }) };
  };
  return { fetch, calls };
}

const submitParams = (extra = {}) => ({
  prompt: "x",
  mode: "image2video",
  image: "C:/tmp/a.png",
  credentials: { apiKey: "test-key" },
  ...extra,
});

test("适配器 submit：上传成功 → 提交体写 mm_file://，出站 timeoutMs ≤ 30000", async () => {
  const logger = fakeLogger();
  const { fetch, calls } = adapterFetch({ uploadOk: true });
  const adapter = createMinimaxVideoAdapter({
    network: { fetch },
    logger,
    resources: { read: async () => PNG_BYTES },
  });

  const result = await adapter.submit(submitParams(), {});
  assert.equal(result.taskId, "t-9");

  const uploadCalls = calls.filter((c) => c.url.includes("/v1/files/upload"));
  assert.equal(uploadCalls.length, 1, "恰好一次 Files 上传");
  assert.ok(
    Number.isInteger(uploadCalls[0].init.timeoutMs) && uploadCalls[0].init.timeoutMs <= 30000,
    "上传出站 timeoutMs ≤ 30000",
  );

  const createCall = calls.find((c) => c.url.includes("/v2/video_generation"));
  const sent = JSON.parse(createCall.init.body);
  assert.equal(sent.content[1].image_url.url, "mm_file://up-1");
  assert.equal(logger.warns.length, 0);
});

test("适配器 submit：上传失败 → 静默回落 base64，仍提交成功", async () => {
  const logger = fakeLogger();
  const { fetch, calls } = adapterFetch({ uploadOk: false });
  const adapter = createMinimaxVideoAdapter({
    network: { fetch },
    logger,
    resources: { read: async () => PNG_BYTES },
  });

  const result = await adapter.submit(submitParams(), {});
  assert.equal(result.taskId, "t-9", "上传失败不使整单失败");

  const createCall = calls.find((c) => c.url.includes("/v2/video_generation"));
  const sent = JSON.parse(createCall.init.body);
  assert.ok(sent.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.ok(logger.warns.some((line) => /上传失败/.test(line)), "回落记一条 warn");
});
