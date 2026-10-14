/**
 * lib/minimax/reference-pipeline.mjs
 *
 * MiniMax H3 参考素材字节管线：把本地 / 资源引用读成 data URL 或上传成 `mm_file://`
 * 引用，并统一执行 ≤12MB/≤16MB 内联传输预算与 ≤20MB 上传上限。
 *
 * 全部读取都经过注入的 `readReference` / `statReference` / `upload` 回调——本模块
 * 不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import {
  ERROR_CODES,
  MAX_REFERENCE_FILE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
  MAX_UPLOAD_FILE_BYTES,
} from "./constants.mjs";

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/** Tolerant byte extraction across every shape a `resources.read` reply may take. */
export function extractBytes(value) {
  if (value === undefined || value === null) {
    throw fail("参考文件读取结果为空（null/undefined）", ERROR_CODES.unknownShape);
  }
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return decodeStringBytes(value);
  }
  if (typeof value === "object") {
    if (value.$bytes !== undefined && value.$bytes !== null) {
      const inner = value.$bytes;
      if (typeof inner === "string") return decodeStringBytes(inner);
      return extractBytes(inner);
    }
    if (value.type === "Buffer" && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    if (Array.isArray(value.data)) return Buffer.from(value.data);
    if (value.bytes !== undefined) return extractBytes(value.bytes);
    if (value.buffer !== undefined) return extractBytes(value.buffer);
    if (value.content !== undefined) return extractBytes(value.content);
  }
  const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 12) : [];
  throw fail(
    `无法从参考文件读取结果中提取字节（顶层键：${keys.length ? keys.join(", ") : "无"}）`,
    ERROR_CODES.unknownShape,
  );
}

function decodeStringBytes(text) {
  const trimmed = text.trim();
  if (trimmed.length > 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length % 4 === 0) {
    return Buffer.from(trimmed, "base64");
  }
  return Buffer.from(text, "utf8");
}

export function mimeForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  const mime = MIME_BY_EXTENSION[ext];
  if (!mime) {
    throw fail(
      `不支持的参考文件类型 "${ext || "(无扩展名)"}"；支持：${Object.keys(MIME_BY_EXTENSION).join(", ")}`,
      ERROR_CODES.unknownMime,
    );
  }
  return mime;
}

function statSize(stat) {
  if (stat === undefined || stat === null) return null;
  // `version.size` is where the host's ResourceIO stat puts the byte count;
  // the top-level candidates cover older / simpler shapes. Null-ish values
  // mean "unknown" and must not be read as 0 (Number(null) === 0).
  const candidates = [stat.size, stat.bytes, stat.byteLength, stat.version?.size];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function referenceTooLarge() {
  return fail(
    `参考素材超出传输限制（单文件 ≤${Math.floor(MAX_REFERENCE_FILE_BYTES / (1024 * 1024))}MB、总量 ≤${Math.floor(MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024))}MB），请压缩后再试`,
    ERROR_CODES.referenceTooLarge,
  );
}

function referenceTotalTooLarge() {
  return fail(
    `参考素材超出传输限制（单文件 ≤${Math.floor(MAX_REFERENCE_FILE_BYTES / (1024 * 1024))}MB、总量 ≤${Math.floor(MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024))}MB），请压缩后再试`,
    ERROR_CODES.referenceTotalTooLarge,
  );
}

/** The bare file name of a local reference path (handles both `/` and `\`). */
function baseName(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * The existing inline path: one local reference → a `data:` URL, charged to the
 * shared ≤12MB/≤16MB transport budget. This is the fallback whenever upload is
 * unavailable or refused.
 */
async function toBase64DataUrl(localPath, label, deps) {
  const { readReference, statReference, budget } = deps;
  if (typeof localPath !== "string" || !localPath.trim()) {
    throw fail(`参考${label}路径无效`);
  }
  const filePath = localPath.trim();
  const { bytes } = await readBytesWithinBudget({
    ref: filePath,
    label,
    position: `：${filePath}`,
    readReference,
    statReference,
    budget,
  });
  return `data:${mimeForPath(filePath)};base64,${bytes.toString("base64")}`;
}

/** Read one reference's bytes for upload — no inline budget charge (see below). */
async function readBytesForUpload(filePath, label, { readReference }) {
  if (typeof readReference !== "function") {
    throw fail("参考文件读取通道不可用（缺少 app/resources.read 授权）");
  }
  const payload = await readReference(filePath);
  const bytes = extractBytes(payload);
  if (bytes.length === 0) throw fail(`参考${label}内容为空：${filePath}`);
  if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
    throw fail(
      `参考${label}上传超出单文件上限（${bytes.length} > ${MAX_UPLOAD_FILE_BYTES} 字节，20MB）：${filePath}`,
    );
  }
  return bytes;
}

/** One `logger.warn` on an upload fallback; logging never fails the request. */
async function warnUploadFallback(logger, label, error) {
  const reason = error?.message || String(error);
  try {
    await logger?.warn?.(`minimax-video 参考${label}上传失败，回落 base64 内联：${reason}`);
  } catch {
    // A broken logger must not turn a recoverable upload miss into a hard error.
  }
}

/**
 * Resolve one local reference into the URL that rides in content[].
 *
 * Upload-first: when an `upload` dependency is injected and it yields a
 * `fileId`, the material is referenced by `mm_file://{fileId}` and its bytes
 * never enter the request body — so they do NOT count against the ≤12MB/≤16MB
 * inline transport budget. Any failure (upload missing, throwing, or returning
 * no `fileId`) falls back to the existing base64 data URL path (still
 * budget-checked) and records exactly one `logger.warn`; it never fails the
 * request. With no `upload` injected, behaviour is byte-for-byte the 0.3.0
 * inline path.
 */
export async function toDataUrl(localPath, label, deps) {
  if (typeof localPath !== "string" || !localPath.trim()) {
    throw fail(`参考${label}路径无效`);
  }
  const filePath = localPath.trim();

  if (typeof deps.upload === "function") {
    // A read failure or an unknown extension is a hard error, not an upload
    // miss: surface it before the try so it never masquerades as a fallback.
    const bytes = await readBytesForUpload(filePath, label, deps);
    const mimeType = mimeForPath(filePath);
    try {
      const result = await deps.upload({
        purpose: "video_generation_input",
        bytes,
        fileName: baseName(filePath),
        mimeType,
      });
      const fileId =
        result && result.fileId !== undefined && result.fileId !== null
          ? String(result.fileId).trim()
          : "";
      if (!fileId) throw new Error("上传响应缺少 fileId");
      return `mm_file://${fileId}`;
    } catch (error) {
      await warnUploadFallback(deps.logger, label, error);
    }
  }

  return toBase64DataUrl(filePath, label, deps);
}

/**
 * Read one reference's bytes and charge them to the shared transport budget.
 *
 * Both reference paths go through here — the generation modes' local paths
 * (a string `ref`) and the Context-IR refs (an open ResourceRef object) — so
 * the ≤12MB/≤16MB rules and their messages live in exactly one place. `ref`
 * is handed to the injected readers untouched.
 */
export async function readBytesWithinBudget({
  ref,
  label,
  position = "",
  readReference,
  statReference,
  budget,
}) {
  if (typeof statReference === "function") {
    try {
      const stat = await statReference(ref);
      const size = statSize(stat);
      if (size !== null && size > MAX_REFERENCE_FILE_BYTES) throw referenceTooLarge();
    } catch (error) {
      if (error?.code === ERROR_CODES.referenceTooLarge) throw error;
      // stat unavailable or unrecognised shape: fall through and check after read.
    }
  }
  if (typeof readReference !== "function") {
    throw fail("参考文件读取通道不可用（缺少 app/resources.read 授权）");
  }
  const payload = await readReference(ref);
  const bytes = extractBytes(payload);
  if (bytes.length === 0) throw fail(`参考${label}内容为空${position}`);
  if (bytes.length > MAX_REFERENCE_FILE_BYTES) throw referenceTooLarge();
  budget.total += bytes.length;
  if (budget.total > MAX_REFERENCE_TOTAL_BYTES) throw referenceTotalTooLarge();
  return { bytes, payload };
}
