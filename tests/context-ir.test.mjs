/**
 * tests/context-ir.test.mjs — `node --test tests/context-ir.test.mjs`
 *
 * Offline coverage for the H3-Context-IR seams this ticket adds:
 *   1. `buildContextIrRequestBody` — the pure `POST /v2/h3_context_ir` body
 *      (model, text content, duration/ratio rules of a text scenario);
 *   2. `createMinimaxClient().createContextIrTask` / `queryContextIrTask` — the
 *      submit POST and the shared query endpoint, whose result is read from
 *      `task.content.prompt` (NOT the video-style `content.url`).
 *
 * No key and no network: `fetch` is an injected stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildContextIrRequestBody, RATIOS_NO_ADAPTIVE } from "../lib/minimax-api.mjs";
import { createMinimaxClient } from "../lib/minimax-client.mjs";

/* 1. request body -------------------------------------------------- */

test("context-ir body: defaults — MiniMax-H3, single text item, duration 5, ratio 16:9", () => {
  const body = buildContextIrRequestBody({ prompt: "一只猫在窗台上打盹" });
  assert.deepEqual(body, {
    model: "MiniMax-H3",
    content: [{ type: "text", text: "一只猫在窗台上打盹" }],
    duration: 5,
    ratio: "16:9",
  });
  assert.equal(body.prompt, undefined, "prompt rides inside content[], not at top level");
});

test("context-ir body: explicit duration/ratio pass through, prompt is trimmed", () => {
  const body = buildContextIrRequestBody({ prompt: "  日落时分  ", duration: 15, ratio: "9:16" });
  assert.equal(body.content[0].text, "日落时分");
  assert.equal(body.duration, 15);
  assert.equal(body.ratio, "9:16");
});

test("context-ir body: ratio must be one of the six literal options", () => {
  assert.deepEqual(RATIOS_NO_ADAPTIVE, ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  for (const ratio of RATIOS_NO_ADAPTIVE) {
    assert.equal(buildContextIrRequestBody({ prompt: "x", ratio }).ratio, ratio);
  }
});

test("context-ir body: adaptive is rejected (a text scenario has no source frame)", () => {
  assert.throws(() => buildContextIrRequestBody({ prompt: "x", ratio: "adaptive" }), /adaptive/);
});

test("context-ir body: an unknown ratio is rejected with the supported list", () => {
  assert.throws(() => buildContextIrRequestBody({ prompt: "x", ratio: "3:2" }), /3:2/);
});

test("context-ir body: empty prompt is rejected", () => {
  assert.throws(() => buildContextIrRequestBody({ prompt: "   " }), /prompt/);
  assert.throws(() => buildContextIrRequestBody({}), /prompt/);
});

test("context-ir body: duration must be an integer within 4-15", () => {
  assert.throws(() => buildContextIrRequestBody({ prompt: "x", duration: 16 }), /4-15/);
  assert.throws(() => buildContextIrRequestBody({ prompt: "x", duration: 3 }), /4-15/);
  assert.throws(() => buildContextIrRequestBody({ prompt: "x", duration: 4.5 }), /整数/);
});

test("manifest: the three new capabilities are declared and the version is untouched", () => {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const capability of ["app/tools.expose-to-model", "app/tasks.manage", "app/session.start-turn"]) {
    assert.ok(manifest.capabilities.includes(capability), `missing capability: ${capability}`);
  }
  assert.equal(manifest.version, "0.1.7", "this ticket must not bump the version");
});

/* 2. client: submit + query ---------------------------------------- */

function mockFetch(responder) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    },
  };
}

test("client: createContextIrTask POSTs to /v2/h3_context_ir and returns the task id", async () => {
  const { calls, fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task_id: "ci-1" }),
  }));
  const client = createMinimaxClient({ fetch });
  const { taskId } = await client.createContextIrTask({ auth: { apiKey: "k" }, body: { model: "MiniMax-H3" } });
  assert.equal(taskId, "ci-1");
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].url.endsWith("/v2/h3_context_ir"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "MiniMax-H3" });
});

test("client: queryContextIrTask hits the shared query endpoint and reads task.content.prompt", async () => {
  const { calls, fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "success", content: { prompt: "增强后的提示词" } } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci 1" });
  assert.ok(calls[0].url.endsWith("/v2/query/video_generation/ci%201"));
  assert.equal(remote.mapped, "success");
  assert.equal(remote.prompt, "增强后的提示词");
  assert.equal(remote.status, "success");
});

test("client: queryContextIrTask maps a running task to pending, no prompt yet", async () => {
  const { fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "running" } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci-2" });
  assert.equal(remote.mapped, "pending");
  assert.equal(remote.prompt, null);
});

test("client: queryContextIrTask surfaces a failed task's reason", async () => {
  const { fetch } = mockFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task: { status: "failed", error: { message: "内容审核未通过" } } }),
  }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryContextIrTask({ auth: { apiKey: "k" }, taskId: "ci-3" });
  assert.equal(remote.mapped, "failed");
  assert.match(remote.failReason, /内容审核未通过/);
});
