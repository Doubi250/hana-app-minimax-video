/**
 * tests/upload-limits.test.mjs — `node --test tests/upload-limits.test.mjs`
 *
 * 上传路径专属单文件上限（MAX_UPLOAD_FILE_BYTES = 20MB）断言。
 *
 * 覆盖：
 *   - 超过 MAX_UPLOAD_FILE_BYTES 的素材在读取后被拒，且未发出任何上传请求；
 *   - 恰好等于上限的素材通过并成功调用 upload；
 *   - 12–20MB 区间的素材能走上传（证明未退回 12MB 内联口径）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateRequestBody, MODEL_SPECS, MAX_UPLOAD_FILE_BYTES } from "../lib/minimax-api.mjs";

const H3 = MODEL_SPECS["MiniMax-H3"];

test("上传路径上限: 超过 MAX_UPLOAD_FILE_BYTES 的素材在读取后被拒，且未发出任何上传请求", async () => {
  let uploadCalled = false;
  const oversized = Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1);

  await assert.rejects(
    () =>
      buildCreateRequestBody({
        params: { prompt: "超限素材测试", mode: "image2video", image: "C:/tmp/oversized.png" },
        modelSpec: H3,
        readReference: async () => oversized,
        upload: async () => {
          uploadCalled = true;
          return { fileId: "never-called" };
        },
      }),
    (err) => {
      assert.equal(uploadCalled, false, "超限素材绝不得发出任何上传请求");
      assert.match(err.message, /上传/);
      assert.match(err.message, /单文件上限/);
      assert.match(err.message, /20MB/);
      assert.match(err.message, new RegExp(String(MAX_UPLOAD_FILE_BYTES)));
      return true;
    },
  );
});

test("上传路径上限: 恰好等于上限的素材通过并完成上传", async () => {
  let uploadedBytes = 0;
  const exact = Buffer.alloc(MAX_UPLOAD_FILE_BYTES);

  const body = await buildCreateRequestBody({
    params: { prompt: "恰好上限素材", mode: "image2video", image: "C:/tmp/exact.png" },
    modelSpec: H3,
    readReference: async () => exact,
    upload: async ({ bytes }) => {
      uploadedBytes = bytes.length;
      return { fileId: "file-exact-20mb" };
    },
  });

  assert.equal(uploadedBytes, MAX_UPLOAD_FILE_BYTES);
  assert.equal(body.content[1].image_url.url, "mm_file://file-exact-20mb");
});

test("上传路径上限: 12–20MB 区间的素材能走上传（证明未退回 12MB 内联口径）", async () => {
  let uploadCalled = false;
  const fifteenMb = Buffer.alloc(15 * 1024 * 1024);

  const body = await buildCreateRequestBody({
    params: { prompt: "15MB素材", mode: "image2video", image: "C:/tmp/fifteen.png" },
    modelSpec: H3,
    readReference: async () => fifteenMb,
    upload: async () => {
      uploadCalled = true;
      return { fileId: "file-15mb" };
    },
  });

  assert.equal(uploadCalled, true, "12–20MB 区间必须成功调用上传");
  assert.equal(body.content[1].image_url.url, "mm_file://file-15mb");
});
