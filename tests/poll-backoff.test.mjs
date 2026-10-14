/**
 * tests/poll-backoff.test.mjs — `node --test tests/poll-backoff.test.mjs`
 *
 * T7: transient-failure backoff for the two pollers, plus the shared error-code
 * registry.
 *
 * Pinned here, through the public seams only:
 *   - `contextIrPollDelayMs` — `min(base × 2^n, cap)` ±20% jitter, and its
 *     reset when a real answer arrives;
 *   - the context-ir poll loop, driven by an injected `sleep` and `random` so
 *     the exact delay sequence is observable offline (fail → back off → a real
 *     answer resets → fail again → succeed);
 *   - `asyncTtsPollDelayMs` — same jitter shape, but the 1000 ms rate-limit
 *     floor is a hard clamp (the red line);
 *   - `ERROR_CODES` — the three adapter codes are registered and their literal
 *     values are unchanged (external callers branch on them).
 *
 * Everything is offline and deterministic: no real timers, files or network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  CONTEXT_IR_POLL_INTERVAL_MS,
  CONTEXT_IR_POLL_BACKOFF_MAX_MS,
  contextIrPollDelayMs,
  createMinimaxContextIrTool,
} = await import(pathToFileURL(path.join(appRoot, "lib", "context-ir-tool.mjs")));

const { asyncTtsPollDelayMs, QUERY_MIN_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS } = await import(
  pathToFileURL(path.join(appRoot, "lib", "extensions", "async-tts.mjs"))
);

const { ERROR_CODES } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax", "constants.mjs"))
);

/* ------------------------------------------------------------------ *
 * ERROR_CODES — the adapter's task-level codes join the registry
 * ------------------------------------------------------------------ */

test("ERROR_CODES: 适配器三码并入注册表，字符串值逐字不变", () => {
  // The literal values are an external contract: a caller may branch on them.
  assert.equal(ERROR_CODES.taskFailed, "MINIMAX_FAILED");
  assert.equal(ERROR_CODES.noUrl, "MINIMAX_NO_URL");
  assert.equal(ERROR_CODES.downloadFailed, "MINIMAX_DOWNLOAD_FAILED");
  // The pre-existing codes stay put.
  assert.equal(ERROR_CODES.referenceTooLarge, "MINIMAX_REFERENCE_TOO_LARGE");
  assert.equal(ERROR_CODES.referenceTotalTooLarge, "MINIMAX_REFERENCE_TOTAL_TOO_LARGE");
  assert.equal(ERROR_CODES.bodyTooLarge, "MINIMAX_REQUEST_BODY_TOO_LARGE");
  assert.equal(ERROR_CODES.unknownMime, "MINIMAX_UNKNOWN_MIME");
  assert.equal(ERROR_CODES.unknownShape, "MINIMAX_UNKNOWN_RESOURCE_SHAPE");
});

/* ------------------------------------------------------------------ *
 * contextIrPollDelayMs — the pure backoff formula
 * ------------------------------------------------------------------ */

test("contextIrPollDelayMs: 无失败即基准间隔，每次连续失败翻倍，封顶 60s", () => {
  // random = 0.5 → jitter factor exactly 1, so the bare formula is visible.
  const noJitter = () => 0.5;
  const base = { baseMs: CONTEXT_IR_POLL_INTERVAL_MS, random: noJitter };

  assert.equal(contextIrPollDelayMs({ ...base, consecutiveFailures: 0 }), 10_000);
  assert.equal(contextIrPollDelayMs({ ...base, consecutiveFailures: 1 }), 20_000);
  assert.equal(contextIrPollDelayMs({ ...base, consecutiveFailures: 2 }), 40_000);
  assert.equal(contextIrPollDelayMs({ ...base, consecutiveFailures: 3 }), 60_000, "封顶 60s");
  assert.equal(contextIrPollDelayMs({ ...base, consecutiveFailures: 9 }), 60_000, "封顶后不再增长");
  assert.equal(CONTEXT_IR_POLL_BACKOFF_MAX_MS, 60_000);
});

test("contextIrPollDelayMs: 抖动为 ±20%（注入 random 的两端）", () => {
  const low = contextIrPollDelayMs({ baseMs: 10_000, consecutiveFailures: 1, random: () => 0 });
  const high = contextIrPollDelayMs({ baseMs: 10_000, consecutiveFailures: 1, random: () => 1 });
  assert.equal(low, 16_000, "20s × 0.8");
  assert.equal(high, 24_000, "20s × 1.2");
});

test("contextIrPollDelayMs: 非法/负数失败计数按 0 处理，结果非负", () => {
  const d = contextIrPollDelayMs({ baseMs: 10_000, consecutiveFailures: -3, random: () => 0.5 });
  assert.equal(d, 10_000);
  assert.ok(contextIrPollDelayMs({ baseMs: 0, random: () => 0 }) >= 0);
});

/* ------------------------------------------------------------------ *
 * the poll loop — fail → back off → a real answer resets → succeed
 * ------------------------------------------------------------------ */

function fakeTasks() {
  return {
    created: [],
    completed: [],
    failed: [],
    async create(input) {
      this.created.push(input);
      return { taskId: "host-task-1", scope: "session", delivery: input.delivery };
    },
    async complete(taskId, result) {
      this.completed.push({ taskId, result });
    },
    async fail(taskId, error) {
      this.failed.push({ taskId, error });
    },
  };
}

function fakeBus() {
  return {
    async request(verb) {
      if (verb === "provider:credentials") return { apiKey: "k".repeat(10) };
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
}

/**
 * A `fetch` answering the context-ir submit and the shared query URL. `queries`
 * entries may be payloads or Errors (a query then throws); the last repeats.
 */
function pollingFetch({ queries = [] } = {}) {
  let queryIndex = 0;
  const fetch = async (url) => {
    const target = String(url);
    if (target.includes("/v2/h3_context_ir")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: "remote-1" }) };
    }
    if (target.includes("/v2/query/video_generation/")) {
      const index = Math.min(queryIndex, queries.length - 1);
      queryIndex += 1;
      const payload = queries[index];
      const value = typeof payload === "function" ? payload() : payload;
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { fetch, queriesSeen: () => queryIndex };
}

test("context-ir 退避三态：连续瞬态失败翻倍退避，任一真实应答即重置，成功退出", async () => {
  const { fetch } = pollingFetch({
    queries: [
      new Error("network hiccup"),
      new Error("network hiccup"),
      { task: { status: "running" } }, // a real answer (still pending) → reset
      new Error("network hiccup"),
      { task: { status: "success", content: { prompt: "增强后的提示词" } } },
    ],
  });
  const tasks = fakeTasks();
  const delays = [];
  const tool = createMinimaxContextIrTool({
    network: { fetch },
    bus: fakeBus(),
    tasks,
    logger: { info() {}, warn() {}, error() {} },
    pollIntervalMs: 1000,
    pollTimeoutMs: 60000,
    // Injected timers: no real waiting, exact delay sequence, no jitter.
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
  });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  // Let the fire-and-forget poll job finish (all sleeps resolve immediately).
  for (let i = 0; i < 50 && tasks.completed.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(tasks.completed.length, 1, "the job settled successfully");
  assert.equal(tasks.failed.length, 0);
  // fail(×2) → 1000×2, 1000×4; running resets → 1000×1; fail again → 1000×2.
  assert.deepEqual(delays, [2000, 4000, 1000, 2000]);
});

/* ------------------------------------------------------------------ *
 * asyncTtsPollDelayMs — jitter with the rate-limit floor as a hard clamp
 * ------------------------------------------------------------------ */

test("asyncTtsPollDelayMs: 同款 ±20% 抖动", () => {
  const low = asyncTtsPollDelayMs({ intervalMs: DEFAULT_POLL_INTERVAL_MS, random: () => 0 });
  const high = asyncTtsPollDelayMs({ intervalMs: DEFAULT_POLL_INTERVAL_MS, random: () => 1 });
  const mid = asyncTtsPollDelayMs({ intervalMs: DEFAULT_POLL_INTERVAL_MS, random: () => 0.5 });
  assert.equal(mid, 3000);
  assert.equal(low, 2400, "3000 × 0.8");
  assert.equal(high, 3600, "3000 × 1.2");
});

test("asyncTtsPollDelayMs: 抖动压不破 1000ms 限流下界（红线）", () => {
  // A tiny interval and the lowest jitter would fall under the floor; it must clamp.
  const d = asyncTtsPollDelayMs({ intervalMs: 5, random: () => 0 });
  assert.equal(d, QUERY_MIN_INTERVAL_MS, "抖动后仍不得低于 1000ms");
  assert.equal(QUERY_MIN_INTERVAL_MS, 1000);
  // Even a base already below the floor is lifted to it.
  assert.ok(asyncTtsPollDelayMs({ intervalMs: 0, random: () => 0.5 }) >= QUERY_MIN_INTERVAL_MS);
});
