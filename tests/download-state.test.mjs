/**
 * tests/download-state.test.mjs — `node --test tests/download-state.test.mjs`
 *
 * Download-state lifecycle for the media adapter: the `downloads` map must not
 * grow without bound in a long-running host process. Pinned here:
 *   - a finished download is served from the map (or from disk) without ever
 *     re-downloading, and is reclaimed after the terminal TTL;
 *   - a failed download retries up to MAX_DOWNLOAD_ATTEMPTS, keeps its failed
 *     answer briefly, and is reclaimed like any settled entry;
 *   - concurrent polls during one download never start a second one;
 *   - the hard cap evicts the oldest settled entries first and never touches
 *     active ones.
 *
 * Everything is offline: `fetch` and `fs` targets are a mock and a temp dir.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMinimaxVideoAdapter, pruneDownloadStates } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax-adapter.mjs"))
);
const { downloadStateKey, videoFileName } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax", "naming.mjs"))
);

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-download-state-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return;
    await sleep(interval);
  }
  throw new Error("waitFor: condition never became true");
}

const successTask = (url) => () => ({ task: { status: "success", content: { url } } });
const pendingTask = () => ({ task: { status: "running" } });

/**
 * A `fetch` that answers MiniMax query URLs from `tasks` (id → payload
 * factory) and routes everything else through `onDownload` (default: a tiny
 * 200 response). Records every call for assertions.
 */
function routingFetch({ tasks = {}, onDownload } = {}) {
  const calls = { query: [], download: [] };
  const fetch = async (url) => {
    const target = String(url);
    if (target.includes("/v2/query/video_generation/")) {
      calls.query.push(target);
      const id = decodeURIComponent(target.slice(target.lastIndexOf("/") + 1));
      const payload = tasks[id];
      if (!payload) throw new Error(`unexpected query for task ${id}`);
      const value = typeof payload === "function" ? payload() : payload;
      return { ok: true, text: async () => JSON.stringify(value) };
    }
    calls.download.push(target);
    if (typeof onDownload === "function") return onDownload(target);
    const data = new TextEncoder().encode("minimax-video-bytes");
    return { status: 200, headers: { get: () => null }, arrayBuffer: async () => data.buffer };
  };
  return { fetch, calls };
}

const ctxFor = (localTaskId, generatedDir) => ({
  credentials: { apiKey: "test-key" },
  task: { taskId: localTaskId },
  generatedDir,
});

function makeAdapter({ fetch, downloadStore, downloadTtlMs, maxTrackedDownloads, dataDir }) {
  return createMinimaxVideoAdapter({
    network: { fetch },
    downloadStore,
    ...(downloadTtlMs !== undefined ? { downloadTtlMs } : {}),
    ...(maxTrackedDownloads !== undefined ? { maxTrackedDownloads } : {}),
    dataDir,
  });
}

test("done lifecycle: one download, then cached successes, no re-download", async () => {
  const dir = tempDir();
  const store = new Map();
  const { fetch, calls } = routingFetch({
    tasks: { "remote-1": successTask("https://cdn.example/v.mp4") },
  });
  const adapter = makeAdapter({ fetch, downloadStore: store, dataDir: dir });
  const ctx = ctxFor("local-1", dir);
  const key = downloadStateKey({ localTaskId: "local-1", providerTaskId: "remote-1" });

  const first = await adapter.query("remote-1", ctx);
  assert.equal(first.status, "pending", "the download runs in the background");
  await waitFor(() => store.get(key)?.phase === "done");

  const second = await adapter.query("remote-1", ctx);
  assert.equal(second.status, "success");
  assert.match(second.files[0], /^minimax-[0-9a-f]{32}-[0-9a-f]{24}\.mp4$/);
  const third = await adapter.query("remote-1", ctx);
  assert.equal(third.status, "success");
  assert.equal(calls.download.length, 1, "repeat polls never re-download");
  assert.ok(store.get(key).settledAt > 0, "a done entry is marked settled");
});

test("settled entries are reclaimed after the TTL (the leak fix)", async () => {
  const dir = tempDir();
  const store = new Map();
  const { fetch } = routingFetch({
    tasks: {
      "remote-1": successTask("https://cdn.example/v.mp4"),
      "remote-2": pendingTask,
    },
  });
  const adapter = makeAdapter({ fetch, downloadStore: store, downloadTtlMs: 30, dataDir: dir });
  const key = downloadStateKey({ localTaskId: "local-1", providerTaskId: "remote-1" });

  await adapter.query("remote-1", ctxFor("local-1", dir));
  await waitFor(() => store.get(key)?.phase === "done");
  assert.equal(store.has(key), true);

  await sleep(120);
  // Any query sweeps the map — query an unrelated pending task so no new
  // entry is created and the reclaim is unambiguous.
  const other = await adapter.query("remote-2", ctxFor("local-2", dir));
  assert.equal(other.status, "pending");
  assert.equal(store.has(key), false, "the done entry was reclaimed after the TTL");
  assert.equal(store.size, 0);
});

test("failed downloads exhaust their attempts and keep the failed answer within the TTL", async () => {
  const dir = tempDir();
  const store = new Map();
  const { fetch, calls } = routingFetch({
    tasks: { "remote-1": successTask("https://cdn.example/v.mp4") },
    onDownload: () => {
      throw new Error("cdn down");
    },
  });
  const adapter = makeAdapter({ fetch, downloadStore: store, downloadTtlMs: 60_000, dataDir: dir });
  const ctx = ctxFor("local-1", dir);
  const key = downloadStateKey({ localTaskId: "local-1", providerTaskId: "remote-1" });

  await adapter.query("remote-1", ctx);
  await waitFor(() => store.get(key)?.attempts === 1 && store.get(key)?.phase === "failed");

  const second = await adapter.query("remote-1", ctx); // retry #2
  assert.equal(second.status, "pending");
  await waitFor(() => store.get(key)?.attempts === 2 && store.get(key)?.phase === "failed");

  const third = await adapter.query("remote-1", ctx); // retry #3
  assert.equal(third.status, "pending");
  await waitFor(() => store.get(key)?.attempts === 3 && store.get(key)?.phase === "failed");

  const fourth = await adapter.query("remote-1", ctx); // exhausted → failed answer
  assert.equal(fourth.status, "failed");
  assert.equal(fourth.error.code, "MINIMAX_DOWNLOAD_FAILED");
  assert.equal(calls.download.length, 3, "exactly MAX_DOWNLOAD_ATTEMPTS attempts");
  // Still inside the TTL window: the entry stays so the host's final polls get
  // the same answer instead of a fresh download cycle.
  assert.equal(store.has(key), true);
  assert.ok(store.get(key).settledAt > 0);
});

test("a failed entry is reclaimed after the TTL like any settled one", async () => {
  const dir = tempDir();
  const store = new Map();
  const { fetch } = routingFetch({
    tasks: {
      "remote-1": successTask("https://cdn.example/v.mp4"),
      "remote-2": pendingTask,
    },
    onDownload: () => {
      throw new Error("cdn down");
    },
  });
  const adapter = makeAdapter({ fetch, downloadStore: store, downloadTtlMs: 30, dataDir: dir });
  const key = downloadStateKey({ localTaskId: "local-1", providerTaskId: "remote-1" });

  await adapter.query("remote-1", ctxFor("local-1", dir));
  await waitFor(() => store.get(key)?.phase === "failed");
  assert.equal(store.has(key), true);

  await sleep(120);
  await adapter.query("remote-2", ctxFor("local-2", dir));
  assert.equal(store.has(key), false, "abandoned failed entries cannot pin memory forever");
});

test("concurrent polls during one download never start a second one", async () => {
  const dir = tempDir();
  const store = new Map();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { fetch, calls } = routingFetch({
    tasks: { "remote-1": successTask("https://cdn.example/v.mp4") },
    onDownload: async () => {
      await gate;
      const data = new TextEncoder().encode("minimax-video-bytes");
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => data.buffer };
    },
  });
  const adapter = makeAdapter({ fetch, downloadStore: store, dataDir: dir });
  const ctx = ctxFor("local-1", dir);
  const key = downloadStateKey({ localTaskId: "local-1", providerTaskId: "remote-1" });

  const first = await adapter.query("remote-1", ctx);
  assert.equal(first.status, "pending");
  await waitFor(() => calls.download.length === 1, { timeout: 2000 });
  const second = await adapter.query("remote-1", ctx);
  assert.equal(second.status, "pending", "an in-flight download is not restarted");
  assert.equal(calls.download.length, 1);

  release();
  await waitFor(() => store.get(key)?.phase === "done");
  const third = await adapter.query("remote-1", ctx);
  assert.equal(third.status, "success");
  assert.equal(calls.download.length, 1);
});

test("a file already on disk is republished without downloading", async () => {
  const dir = tempDir();
  const store = new Map();
  const url = "https://cdn.example/v.mp4";
  const fileName = videoFileName({ localTaskId: "local-1", providerTaskId: "remote-1", url });
  fs.writeFileSync(path.join(dir, fileName), "already-here");

  const { fetch, calls } = routingFetch({ tasks: { "remote-1": successTask(url) } });
  const adapter = makeAdapter({ fetch, downloadStore: store, dataDir: dir });

  const result = await adapter.query("remote-1", ctxFor("local-1", dir));
  assert.equal(result.status, "success");
  assert.deepEqual(result.files, [fileName]);
  assert.equal(calls.download.length, 0, "nothing to fetch — the file is right there");
});

test("the hard cap evicts oldest settled entries first and never active ones", async () => {
  const dir = tempDir();
  const now = Date.now();
  const store = new Map([
    ["seed-1::r", { phase: "failed", attempts: 3, settledAt: now - 5000 }],
    ["seed-2::r", { phase: "failed", attempts: 3, settledAt: now - 4000 }],
    ["seed-3::r", { phase: "done", settledAt: now - 3000 }],
    ["seed-4::r", { phase: "done", settledAt: now - 2000 }],
    ["seed-active::r", { phase: "downloading", attempts: 0, settledAt: 0 }],
  ]);
  const { fetch } = routingFetch({ tasks: { "remote-x": pendingTask } });
  const adapter = makeAdapter({
    fetch,
    downloadStore: store,
    maxTrackedDownloads: 3,
    dataDir: dir,
  });

  await adapter.query("remote-x", ctxFor("local-x", dir));

  assert.deepEqual(
    [...store.keys()].sort(),
    ["seed-3::r", "seed-4::r", "seed-active::r"],
    "oldest settled entries evicted down to the cap; the active entry survives",
  );
});

test("pruneDownloadStates: TTL reclaims only settled entries older than ttlMs", () => {
  const map = new Map([
    ["exactly-at-ttl", { settledAt: 900 }],
    ["stale", { settledAt: 850 }],
    ["just-settled", { settledAt: 950 }],
    ["active", { settledAt: 0 }],
  ]);
  const removed = pruneDownloadStates(map, { now: 1000, ttlMs: 100 });
  assert.equal(removed, 2);
  assert.deepEqual(
    [...map.keys()].sort(),
    ["active", "just-settled"],
    "age >= ttl is reclaimed; active entries (settledAt 0) never are",
  );
});

test("pruneDownloadStates: the cap trims oldest-first and stops at maxTracked", () => {
  const map = new Map();
  for (let i = 1; i <= 10; i += 1) {
    map.set(`settled-${i}`, { settledAt: i });
  }
  map.set("active", { settledAt: 0 });
  // ttlMs large enough that nothing is TTL-reclaimed: this case isolates the cap.
  const removed = pruneDownloadStates(map, { now: 1_000_000, ttlMs: 2_000_000, maxTracked: 3 });
  assert.equal(removed, 8, "11 entries trimmed to the cap of 3");
  assert.deepEqual(
    [...map.keys()].sort(),
    ["active", "settled-10", "settled-9"],
    "newest settled entries survive; active is untouchable",
  );
});
