import test from "node:test";
import assert from "node:assert/strict";

import {
  uploadFile,
  retrieveFile,
  retrieveContent,
  FILE_UPLOAD_PATH,
  FILE_RETRIEVE_PATH,
  FILE_RETRIEVE_CONTENT_PATH,
  FILE_PURPOSES,
  MAX_HOST_TIMEOUT_MS,
} from "../lib/files-client.mjs";
import { buildMultipartFormData as fromMultipart } from "../lib/multipart.mjs";
import { buildMultipartFormData as fromSpeech } from "../lib/speech-client.mjs";

/* ---------------------------------------------------------------- *
 * 响应替身
 * ---------------------------------------------------------------- */

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
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

function binaryResponse(bytes, { ok = true, status = 200 } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  return {
    ok,
    status,
    async text() {
      return Buffer.from(u8).toString("utf-8");
    },
    async arrayBuffer() {
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

const OK_UPLOAD = {
  file: {
    file_id: "file-abc-123",
    bytes: 11,
    filename: "clip.mp4",
    purpose: "video_generation_input",
  },
  base_resp: { status_code: 0, status_msg: "success" },
};

/* ---------------------------------------------------------------- *
 * fetch 注入纪律
 * ---------------------------------------------------------------- */

test("uploadFile: 缺少注入 fetch 即抛错，不回退 globalThis.fetch", async () => {
  await assert.rejects(() => uploadFile({ purpose: "video_generation_input", bytes: Buffer.from("x") }), /fetch/);
  await assert.rejects(() => uploadFile({ fetch: null, purpose: "video_generation_input", bytes: Buffer.from("x") }), /fetch/);
  await assert.rejects(() => uploadFile({ fetch: 123, purpose: "video_generation_input", bytes: Buffer.from("x") }), /fetch/);
  // 宿主环境确有 globalThis.fetch，也必须拒绝静默启用。
  assert.equal(typeof globalThis.fetch, "function");
});

test("retrieveFile / retrieveContent: 缺少注入 fetch 即抛错", async () => {
  await assert.rejects(() => retrieveFile({ fileId: "f1" }), /fetch/);
  await assert.rejects(() => retrieveContent({ fileId: "f1" }), /fetch/);
});

/* ---------------------------------------------------------------- *
 * purpose 校验：上传前拒绝
 * ---------------------------------------------------------------- */

test("uploadFile: 未知 purpose 在上传前被拒绝，fetch 从未被调用", async () => {
  let called = false;
  const mockFetch = async () => {
    called = true;
    return jsonResponse(OK_UPLOAD);
  };
  await assert.rejects(
    () => uploadFile({ fetch: mockFetch, purpose: "not_a_purpose", bytes: Buffer.from("x") }),
    /purpose/,
  );
  assert.equal(called, false, "非法 purpose 必须在任何网络调用之前抛错");
  assert.deepEqual(FILE_PURPOSES, [
    "video_generation_input",
    "voice_clone",
    "prompt_audio",
    "t2a_async_input",
  ]);
});

/* ---------------------------------------------------------------- *
 * 上传成功：multipart 形状
 * ---------------------------------------------------------------- */

test("uploadFile: 成功上传，multipart 形状正确并返回 fileId", async () => {
  let capturedUrl = "";
  let capturedInit = null;
  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedInit = options;
    return jsonResponse(OK_UPLOAD);
  };

  const payload = Buffer.from("hello world");
  const result = await uploadFile({
    fetch: mockFetch,
    auth: { apiKey: "test-token" },
    purpose: "video_generation_input",
    bytes: payload,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
  });

  assert.equal(capturedUrl, `https://api.minimax.cn${FILE_UPLOAD_PATH}`);
  assert.equal(capturedInit.method, "POST");
  assert.match(capturedInit.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  assert.equal(capturedInit.headers["Authorization"], "Bearer test-token");

  const body = Buffer.isBuffer(capturedInit.body) ? capturedInit.body.toString("utf-8") : String(capturedInit.body);
  assert.match(body, /name="purpose"\r\n\r\nvideo_generation_input/);
  assert.match(body, /name="file"; filename="clip\.mp4"/);
  assert.match(body, /Content-Type: video\/mp4/);
  assert.ok(body.includes("hello world"));
  assert.match(body, /--\r\n$/);

  assert.equal(result.fileId, "file-abc-123");
  assert.equal(result.filename, "clip.mp4");
  assert.equal(result.purpose, "video_generation_input");
  assert.equal(typeof result.bytes, "number");
});

/* ---------------------------------------------------------------- *
 * 错误信封 / 非 2xx / 缺 file_id / 网络错误
 * ---------------------------------------------------------------- */

test("uploadFile: 错误信封（base_resp.status_code≠0）报错且脱敏", async () => {
  const mockFetch = async () =>
    jsonResponse({
      base_resp: { status_code: 1004, status_msg: "invalid key Bearer sk-abcdef1234567890" },
    });

  await assert.rejects(
    () => uploadFile({ fetch: mockFetch, auth: { apiKey: "k" }, purpose: "voice_clone", bytes: Buffer.from("x") }),
    (err) => {
      assert.match(err.message, /1004/);
      assert.match(err.message, /Bearer \[redacted\]/);
      assert.doesNotMatch(err.message, /sk-abcdef1234567890/);
      return true;
    },
  );
});

test("uploadFile: 非 2xx 报错并带状态码", async () => {
  const mockFetch = async () => jsonResponse({ message: "boom" }, { ok: false, status: 502 });
  await assert.rejects(
    () => uploadFile({ fetch: mockFetch, purpose: "prompt_audio", bytes: Buffer.from("x") }),
    (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /502/);
      return true;
    },
  );
});

test("uploadFile: HTTP 2xx 但缺少 file.file_id 即报错", async () => {
  const mockFetch = async () => jsonResponse({ file: { bytes: 3 }, base_resp: { status_code: 0 } });
  await assert.rejects(
    () => uploadFile({ fetch: mockFetch, purpose: "t2a_async_input", bytes: Buffer.from("x") }),
    /file_id/,
  );
});

test("uploadFile: 网络错误向上抛出", async () => {
  const mockFetch = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(
    () => uploadFile({ fetch: mockFetch, purpose: "voice_clone", bytes: Buffer.from("x") }),
    /ECONNRESET/,
  );
});

/* ---------------------------------------------------------------- *
 * 检索
 * ---------------------------------------------------------------- */

test("retrieveFile: 成功解析 download_url / bytes / filename / purpose", async () => {
  let capturedUrl = "";
  const mockFetch = async (url) => {
    capturedUrl = url;
    return jsonResponse({
      file: {
        download_url: "https://cdn.example.com/f/file-1",
        bytes: 4096,
        filename: "input.mp4",
        purpose: "video_generation_input",
      },
      base_resp: { status_code: 0, status_msg: "success" },
    });
  };

  const result = await retrieveFile({ fetch: mockFetch, auth: { apiKey: "t" }, fileId: "file-1" });
  assert.equal(capturedUrl, `https://api.minimax.cn${FILE_RETRIEVE_PATH}?file_id=file-1`);
  assert.equal(result.downloadUrl, "https://cdn.example.com/f/file-1");
  assert.equal(result.bytes, 4096);
  assert.equal(result.filename, "input.mp4");
  assert.equal(result.purpose, "video_generation_input");
});

test("retrieveFile: 错误信封报错", async () => {
  const mockFetch = async () =>
    jsonResponse({ base_resp: { status_code: 1002, status_msg: "rate limited" } });
  await assert.rejects(
    () => retrieveFile({ fetch: mockFetch, fileId: "f1" }),
    /1002/,
  );
});

/* ---------------------------------------------------------------- *
 * 取内容
 * ---------------------------------------------------------------- */

test("retrieveContent: 成功返回二进制 Buffer", async () => {
  let capturedUrl = "";
  const mockFetch = async (url) => {
    capturedUrl = url;
    return binaryResponse(new Uint8Array([1, 2, 3, 4, 5]));
  };
  const buf = await retrieveContent({ fetch: mockFetch, auth: { apiKey: "t" }, fileId: "file-9" });
  assert.equal(capturedUrl, `https://api.minimax.cn${FILE_RETRIEVE_CONTENT_PATH}?file_id=file-9`);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf], [1, 2, 3, 4, 5]);
});

test("retrieveContent: 非 2xx 报错", async () => {
  const mockFetch = async () => jsonResponse({ message: "nope" }, { ok: false, status: 404 });
  await assert.rejects(() => retrieveContent({ fetch: mockFetch, fileId: "f1" }), /404/);
});

test("retrieveContent: HTTP 200 但返回 JSON 错误信封时报错，不当成音频", async () => {
  const mockFetch = async () =>
    binaryResponse(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "not ready" } }));
  await assert.rejects(() => retrieveContent({ fetch: mockFetch, fileId: "f1" }), /1008/);
});

/* ---------------------------------------------------------------- *
 * 出站预算：显式 timeoutMs(≤30000) 与正整数 maxResponseBytes
 * ---------------------------------------------------------------- */

test("所有出站调用显式声明 timeoutMs(≤30000) 与正整数 maxResponseBytes，且超时被夹紧", async () => {
  const seen = [];
  const mockFetch = async (url, options) => {
    seen.push({ url, options });
    if (url.includes(FILE_UPLOAD_PATH)) return jsonResponse(OK_UPLOAD);
    if (url.includes(FILE_RETRIEVE_CONTENT_PATH)) return binaryResponse(new Uint8Array([1]));
    return jsonResponse({ file: { file_id: "f", bytes: 1 }, base_resp: { status_code: 0 } });
  };

  // 缺省超时
  await uploadFile({ fetch: mockFetch, purpose: "voice_clone", bytes: Buffer.from("x") });
  // 超限超时必须被夹到 ≤30000
  await retrieveFile({ fetch: mockFetch, fileId: "f", timeoutMs: 999999 });
  await retrieveContent({ fetch: mockFetch, fileId: "f" });

  assert.equal(seen.length, 3);
  for (const { options } of seen) {
    assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0);
    assert.ok(options.timeoutMs <= MAX_HOST_TIMEOUT_MS, `timeoutMs ${options.timeoutMs} 超过宿主上限`);
    assert.ok(Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0);
  }
  assert.equal(seen[0].options.timeoutMs, MAX_HOST_TIMEOUT_MS);
  assert.equal(MAX_HOST_TIMEOUT_MS, 30000);
});

/* ---------------------------------------------------------------- *
 * 共享 multipart：同一函数引用
 * ---------------------------------------------------------------- */

test("buildMultipartFormData 在 multipart 与 speech-client 是同一函数引用", () => {
  assert.equal(typeof fromMultipart, "function");
  assert.equal(fromSpeech, fromMultipart);
});

test("files-client 的 multipart 与共享构建器逐字节一致（同边界归一化）", async () => {
  let captured = null;
  const mockFetch = async (url, options) => {
    captured = options;
    return jsonResponse(OK_UPLOAD);
  };

  const bytes = Buffer.from("PAYLOAD-BYTES");
  await uploadFile({
    fetch: mockFetch,
    purpose: "video_generation_input",
    bytes,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
  });

  const shared = fromMultipart({
    fields: { purpose: "video_generation_input" },
    files: [{ name: "file", filename: "clip.mp4", mimeType: "video/mp4", buffer: bytes }],
  });

  const normalize = (buf) =>
    buf.toString("utf-8").replace(/----MinimaxBoundary[0-9a-f]{16}/g, "<BOUNDARY>");

  assert.equal(normalize(captured.body), normalize(shared.bodyBuffer));
});
