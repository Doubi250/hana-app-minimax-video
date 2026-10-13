/**
 * lib/minimax-adapter.mjs
 *
 * Assembles the media adapter the host routes `minimax-video-videos` to:
 * `checkAuth` / `submit` / `query`, plus the background download state machine
 * that turns a finished remote task into a file under `ctx.generatedDir`.
 *
 * The adapter closes over `config` / `logger` / `resources` / `network` /
 * `dataDir` captured in `apply(ctx)`: only serialisable fields survive into the
 * `submit` / `query` callbacks across the process boundary.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ERROR_CODES,
  PROVIDER_ID,
  PROTOCOL_ID,
  RATIOS_FULL,
  buildCreateRequestBody,
  downloadStateKey,
  partFileName,
  resolveMode,
  resolveModelSpec,
  taskHash,
  videoFileName,
} from "./minimax-api.mjs";
import { createCredentialResolver, NOT_CONFIGURED_MESSAGE } from "./auth.mjs";
import { createMinimaxClient, downloadToFile, MAX_VIDEO_BYTES } from "./minimax-client.mjs";
import { uploadFile } from "./files-client.mjs";
import { scrub } from "./http-util.mjs";

const MAX_DOWNLOAD_ATTEMPTS = 3;

/** Static adapter capabilities (declared for display / host validation). */
export const ADAPTER_CAPABILITIES = {
  ratios: [...RATIOS_FULL],
  resolutions: ["480P", "768P", "2K"],
  duration: { min: 4, max: 15 },
  referenceImages: { min: 0, max: 9 },
  referenceVideos: { min: 0, max: 3 },
  referenceAudios: { min: 0, max: 3 },
};

function errorMessage(error) {
  return scrub(error?.message || String(error));
}

/**
 * Download-state retention. Settled entries (a finished download, or a failed
 * attempt) stay in the map for a short window so back-to-back host polls get
 * the cached answer — a repeat query for a `done` task republishes the file
 * without re-downloading, and a retry of a `failed` one keeps its attempt
 * count. After the window they are reclaimed; a hard cap additionally bounds
 * the map when many tasks settle within the window, evicting the oldest
 * settled entries first. Active entries (`settledAt === 0`) are never evicted:
 * their background job still owns them.
 */
export const TERMINAL_TTL_MS = 5 * 60 * 1000;
export const MAX_TRACKED_DOWNLOADS = 256;

/**
 * Reclaim settled download states that outlived `ttlMs`, then evict the oldest
 * settled entries while the map exceeds `maxTracked`.
 *
 * @param {Map<string, { settledAt?: number }>} downloads
 * @returns {number} how many entries were removed
 */
export function pruneDownloadStates(downloads, {
  now = Date.now(),
  ttlMs = TERMINAL_TTL_MS,
  maxTracked = MAX_TRACKED_DOWNLOADS,
} = {}) {
  let removed = 0;
  for (const [key, state] of downloads) {
    if (state?.settledAt > 0 && now - state.settledAt >= ttlMs) {
      downloads.delete(key);
      removed += 1;
    }
  }
  if (downloads.size > maxTracked) {
    const settledOldestFirst = [...downloads.entries()]
      .filter(([, state]) => state?.settledAt > 0)
      .sort((a, b) => a[1].settledAt - b[1].settledAt);
    for (const [key] of settledOldestFirst) {
      if (downloads.size <= maxTracked) break;
      downloads.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function createMinimaxVideoAdapter({
  logger,
  resources,
  network,
  dataDir,
  bus,
  downloadStore,
  downloadTtlMs = TERMINAL_TTL_MS,
  maxTrackedDownloads = MAX_TRACKED_DOWNLOADS,
} = {}) {
  const client = createMinimaxClient({ fetch: (url, init) => network.fetch(url, init) });
  /**
   * taskKey → { phase, attempts, file, error, settledAt }
   * `settledAt > 0` marks a settled entry (done, or a failed attempt) retained
   * for the anti-replay / retry window (see TERMINAL_TTL_MS); active entries
   * keep it at 0 and are never evicted.
   */
  const downloads = downloadStore instanceof Map ? downloadStore : new Map();

  /**
   * Credential resolution is shared with the `minimax_context_ir` tool through
   * `createCredentialResolver` (lib/auth.mjs): both paths borrow the same
   * MiniMax Token Plan lane, so "which credential does this call use" has one
   * answer in this app. Nothing logs, echoes or persists a key.
   */
  const { resolveAuth, requireAuth } = createCredentialResolver({
    bus,
    selfProviderId: PROVIDER_ID,
  });

  function generatedDirFor(ctx) {
    const fromCtx = typeof ctx?.generatedDir === "string" ? ctx.generatedDir.trim() : "";
    if (fromCtx) return fromCtx;
    return path.join(String(dataDir || "."), "generated");
  }

  function localTaskIdFor(ctx) {
    const value = ctx?.task?.taskId;
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function readReference(filePath) {
    if (typeof resources?.read !== "function") {
      throw new Error("参考文件读取通道不可用（缺少 app/resources.read 授权）");
    }
    return resources.read({ kind: "local-file", path: filePath });
  }

  function statReference(filePath) {
    if (typeof resources?.stat !== "function") return null;
    return resources.stat({ kind: "local-file", path: filePath });
  }

  /**
   * The reference-material upload dependency handed to request-body assembly.
   *
   * Reference bytes go out through the SAME injected `network.fetch` the rest of
   * the adapter uses, with the credential lane already resolved for this submit;
   * a purpose of `video_generation_input` matches the video materials. Any
   * failure throws and the builder falls back to inline base64 — the adapter
   * stays transparent to the host either way.
   */
  function makeUploadDependency(auth) {
    return ({ purpose, bytes, fileName, mimeType }) =>
      uploadFile({
        fetch: (url, init) => network.fetch(url, init),
        auth,
        purpose,
        bytes,
        fileName,
        mimeType,
      });
  }

  function startBackgroundDownload({ state, url, generatedDir, fileName, digest }) {
    state.attempts += 1;
    const partPath = path.join(generatedDir, partFileName(digest));
    const finalPath = path.join(generatedDir, fileName);
    void (async () => {
      try {
        await fs.promises.mkdir(generatedDir, { recursive: true });
        await downloadToFile({
          fetch: (target, init) => network.fetch(target, init),
          url,
          partPath,
        });
        const size = fs.statSync(partPath).size;
        if (size > MAX_VIDEO_BYTES) throw new Error("视频超过 1GB 上限，已中止下载");
        fs.renameSync(partPath, finalPath);
        state.phase = "done";
        state.file = fileName;
        state.error = null;
        state.settledAt = Date.now();
        await logger?.info?.(`minimax-video 下载完成：${fileName}（${size} 字节）`);
      } catch (error) {
        state.phase = "failed";
        state.error = `视频下载失败：${errorMessage(error)}；可稍后重试`;
        // A failed entry is reclaimable too: within the window the host's next
        // poll retries with the attempt count preserved; after it — or on
        // eviction — the entry is simply gone, so an abandoned task cannot
        // pin memory forever.
        state.settledAt = Date.now();
        await logger?.warn?.(`minimax-video 下载失败：${errorMessage(error)}`);
      }
    })();
  }

  const adapter = {
    id: PROTOCOL_ID,
    protocolId: PROTOCOL_ID,
    name: "Minimax",
    types: ["video"],
    capabilities: ADAPTER_CAPABILITIES,

    async checkAuth() {
      const auth = await resolveAuth();
      if (!auth) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
      return { ok: true };
    },

    async submit(params = {}, ctx = {}) {
      const auth = await requireAuth(params, ctx);
      const modelSpec = resolveModelSpec(params);
      const mode = resolveMode(params, modelSpec);
      const body = await buildCreateRequestBody({
        params,
        modelSpec,
        readReference,
        statReference,
        upload: makeUploadDependency(auth),
        logger,
      });
      // 2K regeneration is submitted through its own endpoint; the response
      // parsing is identical to a normal create.
      const { taskId } =
        mode === "regeneration"
          ? await client.createRegenerationTask({ auth, body })
          : await client.createTask({ auth, body });
      await logger?.info?.(`minimax-video 提交任务：${taskId}（模型 ${modelSpec.id}）`);
      return { taskId };
    },

    async query(providerTaskId, ctx = {}) {
      const auth = await requireAuth(ctx, ctx);
      const remoteTaskId = String(providerTaskId ?? "").trim();
      if (!remoteTaskId) throw new Error("MiniMax 任务 ID 为空");

      const localTaskId = localTaskIdFor(ctx);
      const key = downloadStateKey({ localTaskId, providerTaskId: remoteTaskId });
      const reclaimed = pruneDownloadStates(downloads, {
        ttlMs: downloadTtlMs,
        maxTracked: maxTrackedDownloads,
      });
      if (reclaimed > 0) {
        await logger?.info?.(`minimax-video 下载状态回收：${reclaimed} 条（终态超时或超上限）`);
      }
      const remote = await client.queryTask({ auth, taskId: remoteTaskId });

      if (remote.mapped === "pending") return { status: "pending" };
      if (remote.mapped === "failed") {
        return {
          status: "failed",
          failReason: remote.failReason || "MiniMax 生成失败",
          error: { code: "MINIMAX_FAILED", message: remote.failReason || "MiniMax 生成失败" },
        };
      }
      if (!remote.url) {
        const message = "MiniMax 任务已成功但未返回视频地址";
        return {
          status: "failed",
          failReason: message,
          error: { code: "MINIMAX_NO_URL", message },
        };
      }

      const generatedDir = generatedDirFor(ctx);
      const fileName = videoFileName({
        localTaskId,
        providerTaskId: remoteTaskId,
        url: remote.url,
      });
      const finalPath = path.join(generatedDir, fileName);
      const digest = taskHash({ localTaskId, providerTaskId: remoteTaskId });

      let state = downloads.get(key);
      if (!state) {
        // A finished file may already be on disk while this process has no
        // record of it (restart, eviction, reclaim): republish it instead of
        // re-downloading what we already have.
        if (fs.existsSync(finalPath)) {
          state = { phase: "done", attempts: 0, file: fileName, error: null, settledAt: Date.now() };
          downloads.set(key, state);
          return { status: "success", files: [state.file] };
        }
        state = { phase: "downloading", attempts: 0, file: null, error: null, settledAt: 0 };
        downloads.set(key, state);
        startBackgroundDownload({
          state,
          url: remote.url,
          generatedDir,
          fileName,
          digest,
        });
        return { status: "pending" };
      }
      if (state.phase === "downloading") return { status: "pending" };
      if (state.phase === "done") return { status: "success", files: [state.file] };
      if (state.attempts < MAX_DOWNLOAD_ATTEMPTS) {
        state.phase = "downloading";
        state.error = null;
        state.settledAt = 0;
        startBackgroundDownload({
          state,
          url: remote.url,
          generatedDir,
          fileName,
          digest,
        });
        return { status: "pending" };
      }
      const message = state.error || "视频下载失败";
      return {
        status: "failed",
        failReason: message,
        error: { code: "MINIMAX_DOWNLOAD_FAILED", message },
      };
    },
  };

  return adapter;
}

export { ERROR_CODES, PROVIDER_ID };
