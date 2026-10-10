/**
 * tests/regeneration-submit.test.mjs — `node --test tests/regeneration-submit.test.mjs`
 *
 * The 2K regeneration submit path: a regeneration body must reach
 * `POST /v2/video_regeneration` through both the client and the adapter, while
 * ordinary generation keeps using `POST /v2/video_generation`. Everything is
 * offline: `fetch` is a mock, no key and no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMinimaxClient } from "../lib/minimax-client.mjs";
import { createMinimaxVideoAdapter } from "../lib/minimax-adapter.mjs";

const REGENERATION_URL = "https://api.minimax.cn/v2/video_regeneration";
const GENERATION_URL = "https://api.minimax.cn/v2/video_generation";

/** Records every call and answers `{ task_id }` like the API create endpoints. */
function mockFetch() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: "t-42" }) };
    },
  };
}

const REGEN_PARAMS = { source_task_id: "src-1", credentials: { apiKey: "k" } };

test("client: createRegenerationTask POSTs the body to /v2/video_regeneration and parses task_id", async () => {
  const { calls, fetch } = mockFetch();
  const client = createMinimaxClient({ fetch });
  const body = { model: "MiniMax-H3", source_task_id: "src-1", resolution: "2K" };
  const { taskId } = await client.createRegenerationTask({ auth: { apiKey: "k" }, body });
  assert.equal(taskId, "t-42");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REGENERATION_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test("adapter: a regeneration submit posts to /v2/video_regeneration", async () => {
  const { calls, fetch } = mockFetch();
  const adapter = createMinimaxVideoAdapter({ network: { fetch } });
  const result = await adapter.submit(REGEN_PARAMS, {});
  assert.equal(result.taskId, "t-42");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REGENERATION_URL);
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { model: "MiniMax-H3", source_task_id: "src-1", resolution: "2K" });
});

test("adapter: ordinary generation still posts to /v2/video_generation", async () => {
  const { calls, fetch } = mockFetch();
  const adapter = createMinimaxVideoAdapter({ network: { fetch } });
  await adapter.submit({ prompt: "一只猫", credentials: { apiKey: "k" } }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GENERATION_URL);
  assert.equal(calls[0].init.method, "POST");
});

test("adapter: H3-Max regeneration is rejected offline (model does not support the mode)", async () => {
  const { calls, fetch } = mockFetch();
  const adapter = createMinimaxVideoAdapter({ network: { fetch } });
  await assert.rejects(
    () =>
      adapter.submit(
        { source_task_id: "src-1", modelId: "MiniMax-H3-Max", credentials: { apiKey: "k" } },
        {},
      ),
    /不支持模式/,
  );
  assert.equal(calls.length, 0, "rejected before any network call");
});
