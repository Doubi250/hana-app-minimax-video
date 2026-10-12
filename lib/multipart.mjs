/**
 * lib/multipart.mjs
 *
 * 单一 multipart/form-data 组装实现，供语音（ASR）与 Files 上传两处共用。
 *
 * 采用原生 Buffer 手动组装 RFC 7578 标准 multipart/form-data，
 * 彻底避免跨进程 JSON-RPC 沙箱将 FormData 序列化为空对象的问题。
 * boundary 形如 `----MinimaxBoundary<8 字节 hex>`，file 段带 `filename`
 * 与 `Content-Type`，结尾为 `--<boundary>--\r\n`。
 */

import crypto from "node:crypto";

/**
 * 手动装配符合 RFC 7578 的 multipart/form-data 缓冲区
 */
export function buildMultipartFormData({ fields = {}, files = [] } = {}) {
  const boundary = `----MinimaxBoundary${crypto.randomBytes(8).toString("hex")}`;
  const chunks = [];

  for (const [name, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`;
    chunks.push(Buffer.from(header, "utf-8"));
  }

  for (const file of files) {
    const { name, filename, mimeType = "application/octet-stream", buffer } = file;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    chunks.push(Buffer.from(header, "utf-8"));
    chunks.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    chunks.push(Buffer.from("\r\n", "utf-8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));

  return {
    bodyBuffer: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
