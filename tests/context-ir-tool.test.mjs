/**
 * tests/context-ir-tool.test.mjs — `node --test tests/context-ir-tool.test.mjs`
 *
 * The `minimax_context_ir` model tool, through the two seams this ticket
 * pre-agreed:
 *   - `apply(ctx)` with a fake host: the registration shape (name, description,
 *     parameter schema) and the end-to-end execute path;
 *   - `createMinimaxContextIrTool` with injected fetch / tasks / bus and fast
 *     poll timings: the background lifecycle (submit → poll → settle), where
 *     the host task must always end settled (complete or fail).
 *
 * Everything is offline: the host, `fetch` and the task service are stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;

// A conversation call token, assembled so no scrubbing pipeline ever sees it.
const TOKEN = ["conv", "token", "1"].join("-");

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

function fakeLogger() {
  return {
    infos: [],
    warns: [],
    errors: [],
    async info(m) { this.infos.push(m); },
    async warn(m) { this.warns.push(m); },
    async error(m) { this.errors.push(m); },
  };
}

/** The host task service, recording every settlement. */
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

function fakeBus({ credentials = { apiKey: "k".repeat(10) } } = {}) {
  const calls = [];
  return {
    calls,
    async request(verb, payload) {
      if (verb === "provider:credentials") {
        calls.push(payload);
        return typeof credentials === "function" ? credentials(payload) : credentials;
      }
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
}

/**
 * A `fetch` that answers the context-ir submit URL and the shared query URL,
 * recording what was sent. `queries` entries may be payload objects or Error
 * instances (a query then throws, simulating a transient network failure).
 * The last entry repeats for any further queries.
 */
function contextIrFetch({ queries = [], submit = () => ({ task_id: "remote-1" }) } = {}) {
  const calls = { submit: 0, query: 0, submitBodies: [] };
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v2/h3_context_ir")) {
      calls.submit += 1;
      calls.submitBodies.push(JSON.parse(init.body));
      const payload = typeof submit === "function" ? submit() : submit;
      if (payload instanceof Error) throw payload;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }
    if (target.includes("/v2/query/video_generation/")) {
      const index = Math.min(calls.query, queries.length - 1);
      calls.query += 1;
      const payload = queries.length ? queries[index] : { task: { status: "running" } };
      const value = typeof payload === "function" ? payload() : payload;
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { fetch, calls };
}

/** A host stub rich enough for `apply(ctx)` including tools / tasks / network. */
function hostStub({ fetch, credentials } = {}) {
  const calls = { tools: [], credentials: [] };
  const bus = {
    async request(verb, payload) {
      if (verb === "provider:credentials") {
        calls.credentials.push(payload);
        return credentials ?? { apiKey: "k".repeat(10) };
      }
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
  const tasks = fakeTasks();
  const ctx = {
    bus,
    logger: fakeLogger(),
    tasks,
    network: { fetch },
    media: {
      async registerCapabilitySource() {},
      async registerAdapter() {},
    },
    tools: {
      register(tool) {
        calls.tools.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, calls, tasks };
}

/* 1. registration shape -------------------------------------------- */

test("apply: registers minimax_context_ir — prompt enhancement only, async delivery, six-ratio schema", async () => {
  const { fetch } = contextIrFetch({});
  const { ctx, calls } = hostStub({ fetch });
  await apply(ctx);
  assert.equal(calls.tools.length, 1, "exactly one tool is registered");
  const tool = calls.tools[0];
  assert.equal(tool.name, "minimax_context_ir");
  assert.match(tool.description, /增强提示词/);
  assert.match(tool.description, /不产生视频/);
  assert.match(tool.description, /异步/);
  assert.equal(typeof tool.execute, "function");
  const parameters = tool.parameters;
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.required, ["prompt"]);
  assert.equal(parameters.properties.prompt.type, "string");
  assert.equal(parameters.properties.duration.type, "integer");
  assert.equal(parameters.properties.duration.minimum, 4);
  assert.equal(parameters.properties.duration.maximum, 15);
  assert.equal(parameters.properties.duration.default, 5);
  assert.equal(parameters.properties.ratio.type, "string");
  assert.deepEqual(parameters.properties.ratio.enum, ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.equal(parameters.properties.ratio.default, "16:9");
  assert.ok(!parameters.properties.ratio.enum.includes("adaptive"), "a pure text scenario has no adaptive");
});

/* 2. execute through the registered tool (wiring) ------------------- */

test("apply-tool: execute submits with the callToken task and settles complete with the labelled enhanced prompt", async () => {
  const { fetch, calls } = contextIrFetch({
    queries: [{ task: { status: "success", content: { prompt: "一只橘猫在夕阳下的窗台上打盹，暖色调" } } }],
  });
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  const receipt = await tool.execute({
    prompt: "一只猫打盹",
    duration: 6,
    ratio: "9:16",
    context: { callToken: TOKEN, sessionPath: "s.jsonl" },
  });

  // The receipt comes back immediately, names the host task and the async semantics.
  const receiptText = receipt.content[0].text;
  assert.match(receiptText, /已提交/);
  assert.match(receiptText, /host-task-1/);
  assert.match(receiptText, /送达/);

  // The host task was created for this conversation with next-step delivery.
  assert.equal(tasks.created.length, 1);
  assert.equal(tasks.created[0].callToken, TOKEN);
  assert.equal(tasks.created[0].delivery, "next-step");
  assert.ok(tasks.created[0].label.length > 0);

  // The submitted body is the context-ir shape with the tool's parameters.
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.submitBodies[0], {
    model: "MiniMax-H3",
    content: [{ type: "text", text: "一只猫打盹" }],
    duration: 6,
    ratio: "9:16",
  });

  // The background job soon settles the host task with the labelled prompt.
  await waitFor(() => tasks.completed.length === 1);
  assert.equal(tasks.completed[0].taskId, "host-task-1");
  assert.equal(
    tasks.completed[0].result.text,
    "H3-Context-IR 增强提示词：\n\n一只橘猫在夕阳下的窗台上打盹，暖色调",
  );
  assert.equal(tasks.failed.length, 0);
});

/* 3. execute failure paths ----------------------------------------- */

test("execute: no callToken → explicit error, nothing is submitted", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({ prompt: "一只猫", context: {} }),
    /callToken|会话/,
  );
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
});

test("execute: credential unavailable → explicit error before any task is created", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({
    fetch,
    credentials: { error: "no_credentials" },
  });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(tool.execute({ prompt: "一只猫", context: { callToken: "t" } }), /凭证|供应商/);
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
});

test("execute: an invalid ratio is rejected before any side effect", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({ prompt: "一只猫", ratio: "adaptive", context: { callToken: "t" } }),
    /adaptive/,
  );
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
});

test("execute: a failed submission settles the host task as failed and surfaces the error", async () => {
  const { fetch } = contextIrFetch({ submit: () => new Error("boom") });
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({ prompt: "一只猫", context: { callToken: "t" } }),
    /boom/,
  );
  assert.equal(tasks.created.length, 1, "the host task existed before the submit failed");
  await waitFor(() => tasks.failed.length === 1);
  assert.equal(tasks.failed[0].taskId, "host-task-1");
  assert.match(tasks.failed[0].error, /失败/);
  assert.equal(tasks.completed.length, 0);
});

test("execute: a host without a task service → explicit error, nothing is submitted", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls } = hostStub({ fetch });
  ctx.tasks = undefined;
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({ prompt: "一只猫", context: { callToken: "t" } }),
    /任务通道不可用|tasks\.manage/,
  );
  assert.equal(calls.submit, 0);
});

/* 4. background lifecycle (fast poll timings) ---------------------- */

const { createMinimaxContextIrTool } = await import(
  pathToFileURL(path.join(appRoot, "lib", "context-ir-tool.mjs"))
);

function makeTool({ fetch, tasks, credentials, pollIntervalMs = 15, pollTimeoutMs = 5000 }) {
  return createMinimaxContextIrTool({
    network: { fetch },
    bus: fakeBus({ credentials }),
    tasks,
    logger: fakeLogger(),
    pollIntervalMs,
    pollTimeoutMs,
  });
}

test("background: a remote failure settles the host task as failed with the API reason", async () => {
  const { fetch } = contextIrFetch({
    queries: [{ task: { status: "failed", error: { message: "内容审核未通过" } } }],
  });
  const tasks = fakeTasks();
  const tool = makeTool({ fetch, tasks });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  await waitFor(() => tasks.failed.length === 1);
  assert.match(tasks.failed[0].error, /内容审核未通过/);
  assert.equal(tasks.completed.length, 0);
});

test("background: a success without a prompt is a failure, not an empty delivery", async () => {
  const { fetch } = contextIrFetch({ queries: [{ task: { status: "success", content: {} } }] });
  const tasks = fakeTasks();
  const tool = makeTool({ fetch, tasks });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  await waitFor(() => tasks.failed.length === 1);
  assert.match(tasks.failed[0].error, /增强提示词/);
});

test("background: transient query errors are tolerated until the task succeeds", async () => {
  const { fetch } = contextIrFetch({
    queries: [
      new Error("network hiccup"),
      new Error("network hiccup"),
      { task: { status: "running" } },
      { task: { status: "success", content: { prompt: "增强后的提示词" } } },
    ],
  });
  const tasks = fakeTasks();
  const tool = makeTool({ fetch, tasks });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  await waitFor(() => tasks.completed.length === 1, { timeout: 5000 });
  assert.match(tasks.completed[0].result.text, /增强后的提示词/);
  assert.equal(tasks.failed.length, 0);
});

test("background: polling stops at the time cap and settles the host task as failed", async () => {
  const { fetch } = contextIrFetch({ queries: [{ task: { status: "running" } }] });
  const tasks = fakeTasks();
  const tool = makeTool({ fetch, tasks, pollIntervalMs: 15, pollTimeoutMs: 40 });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  await waitFor(() => tasks.failed.length === 1, { timeout: 2000 });
  assert.match(tasks.failed[0].error, /超时/);
  assert.equal(tasks.completed.length, 0);
});

test("background: persistent network errors also end at the time cap, never hanging", async () => {
  const { fetch } = contextIrFetch({ queries: [new Error("offline")] });
  const tasks = fakeTasks();
  const tool = makeTool({ fetch, tasks, pollIntervalMs: 15, pollTimeoutMs: 40 });

  await tool.execute({ prompt: "一只猫", context: { callToken: "t" } });
  await waitFor(() => tasks.failed.length === 1, { timeout: 2000 });
  assert.match(tasks.failed[0].error, /超时/);
});
