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

/** A fake ResourceIO: records every ref it is asked to read, answers bytes. */
function fakeResources() {
  return {
    reads: [],
    async read(ref) {
      this.reads.push(ref);
      if (ref.kind === "session-file") {
        // The host read reply carries the resolved file path (MIME source).
        return { filePath: "C:/cache/f-9.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) };
      }
      return { content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
    },
    async stat() {
      return null;
    },
  };
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
  const resources = fakeResources();
  const ctx = {
    bus,
    logger: fakeLogger(),
    tasks,
    resources,
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
  return { ctx, calls, tasks, resources };
}

/* 1. registration shape -------------------------------------------- */

test("apply: registers minimax_context_ir — prompt enhancement only, async delivery, scenario-ratio schema", async () => {
  const { fetch } = contextIrFetch({});
  const { ctx, calls } = hostStub({ fetch });
  await apply(ctx);
  // `apply` now registers the media capability source, the adapter and three
  // model tools (context-ir, TTS, ASR); this suite owns the context-ir one.
  const tool = calls.tools.find((t) => t.name === "minimax_context_ir");
  assert.ok(tool, "the minimax_context_ir tool is registered");
  assert.equal(calls.tools.length, 3, "context-ir, TTS and ASR are all registered");
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
  // Frames and reference scenarios may need adaptive, so the enum is the full
  // seven; the text-only rejection lives in the body builder, not the schema.
  assert.deepEqual(parameters.properties.ratio.enum, ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.match(parameters.properties.ratio.description, /纯文本/);
});

const { CONTEXT_IR_REF_LIMITS } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax", "context-ir-body.mjs"))
);

test("apply: multimodal parameters — single frame refs, capped lists, and the exclusion rule in the description", async () => {
  const { fetch } = contextIrFetch({});
  const { ctx, calls } = hostStub({ fetch });
  await apply(ctx);
  const tool = calls.tools[0];
  const properties = tool.parameters.properties;

  for (const key of ["firstFrame", "lastFrame"]) {
    const variants = properties[key].anyOf;
    assert.ok(Array.isArray(variants), `${key} accepts multiple shapes`);
    assert.ok(variants.some((v) => v.type === "string"), `${key} accepts a URL string`);
    assert.ok(variants.some((v) => v.type === "object"), `${key} accepts a ref object`);
  }
  // The schema maxItems come from the single limits constant — a cap change
  // must not be able to leave a stale number in the advertised schema.
  for (const [key, max] of [
    ["referenceImages", CONTEXT_IR_REF_LIMITS.images],
    ["referenceVideos", CONTEXT_IR_REF_LIMITS.videos],
    ["referenceAudios", CONTEXT_IR_REF_LIMITS.audios],
  ]) {
    assert.equal(properties[key].type, "array", key);
    assert.equal(properties[key].maxItems, max, key);
    assert.ok(Array.isArray(properties[key].items.anyOf), `${key} items accept multiple shapes`);
  }
  assert.deepEqual(tool.parameters.required, ["prompt"]);
  assert.match(tool.description, /互斥/);
  assert.match(tool.description, /session-file/);
  assert.match(tool.description, /URL/);
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

test("execute: local and session frame refs are read through the injected resources and submitted as first/last frame data URLs", async () => {
  const { fetch, calls } = contextIrFetch({
    queries: [{ task: { status: "success", content: { prompt: "增强提示词" } } }],
  });
  const { ctx, calls: hostCalls, tasks, resources } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await tool.execute({
    prompt: "从清晨到黄昏",
    firstFrame: { kind: "local-file", path: "C:/tmp/a.png" },
    lastFrame: { kind: "session-file", fileId: "f-9" },
    context: { callToken: TOKEN },
  });

  assert.deepEqual(resources.reads, [
    { kind: "local-file", path: "C:/tmp/a.png" },
    { kind: "session-file", fileId: "f-9" },
  ]);
  assert.equal(calls.submit, 1);
  const sent = calls.submitBodies[0];
  assert.equal(sent.content.length, 3);
  assert.equal(sent.content[1].role, "first_frame");
  assert.ok(sent.content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(sent.content[2].role, "last_frame");
  assert.ok(sent.content[2].image_url.url.startsWith("data:image/jpeg;base64,"));
  assert.equal(sent.ratio, "adaptive", "a frame scenario pins adaptive");
  assert.equal(tasks.created.length, 1);
});

test("execute: reference materials map to reference_* roles; URLs pass through and are never read", async () => {
  const { fetch, calls } = contextIrFetch({
    queries: [{ task: { status: "success", content: { prompt: "增强提示词" } } }],
  });
  const { ctx, calls: hostCalls, resources } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await tool.execute({
    prompt: "参考素材合成",
    referenceImages: ["https://cdn.example.com/a.png"],
    referenceVideos: [{ kind: "local-file", path: "C:/tmp/clip.mp4" }],
    referenceAudios: ["https://cdn.example.com/voice.wav"],
    context: { callToken: TOKEN },
  });

  assert.deepEqual(resources.reads, [{ kind: "local-file", path: "C:/tmp/clip.mp4" }], "only the local ref is read");
  const sent = calls.submitBodies[0];
  assert.deepEqual(sent.content.slice(1).map((item) => item.role), [
    "reference_image",
    "reference_video",
    "reference_audio",
  ]);
  assert.equal(sent.content[1].image_url.url, "https://cdn.example.com/a.png");
  assert.ok(sent.content[2].video_url.url.startsWith("data:video/mp4;base64,"));
  assert.equal(sent.ratio, "adaptive", "a reference scenario defaults to adaptive");
});

test("execute: mixing frames with reference materials is rejected before any side effect", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({
      prompt: "一只猫",
      firstFrame: "https://cdn.example.com/a.png",
      referenceImages: ["https://cdn.example.com/b.png"],
      context: { callToken: TOKEN },
    }),
    /互斥/,
  );
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
});

test("execute: a bare local path string is rejected with the accepted shapes", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({ prompt: "一只猫", firstFrame: "C:/tmp/a.png", context: { callToken: TOKEN } }),
    /http\(s\)/,
  );
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
});

test("execute: a host without the resources channel rejects a local reference before any task", async () => {
  const { fetch, calls } = contextIrFetch({});
  const { ctx, calls: hostCalls, tasks } = hostStub({ fetch });
  ctx.resources = undefined;
  await apply(ctx);
  const tool = hostCalls.tools[0];

  await assert.rejects(
    tool.execute({
      prompt: "一只猫",
      firstFrame: { kind: "local-file", path: "C:/tmp/a.png" },
      context: { callToken: TOKEN },
    }),
    /读取通道不可用|resources\.read/,
  );
  assert.equal(tasks.created.length, 0);
  assert.equal(calls.submit, 0);
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
