/**
 * tests/context-ir-tool.test.mjs — `node --test tests/context-ir-tool.test.mjs`
 *
 * The `minimax_context_ir` model tool, through the two seams this ticket
 * pre-agreed:
 *   - `apply(ctx)` with a fake host: the registration shape (name, description,
 *     parameter schema) and the end-to-end execute path;
 *   - `createMinimaxContextIrTool` with injected fetch / tasks / bus and fast
 *     poll timings: the background lifecycle (submit → poll → settle), where
 *     the host task must always end settled (complete or fail);
 *   - a real temp `dataDir`: the in-flight book round trip (create → fake reload
 *     via a second tool instance → resume → settle).
 *
 * Everything is offline: the host, `fetch` and the task service are stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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

function makeTool({ fetch, tasks, credentials, pollIntervalMs = 15, pollTimeoutMs = 5000, dataDir }) {
  return createMinimaxContextIrTool({
    network: { fetch },
    bus: fakeBus({ credentials }),
    tasks,
    logger: fakeLogger(),
    pollIntervalMs,
    pollTimeoutMs,
    dataDir,
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

/* 5. in-flight book: create → fake reload → resume → settle ------------- */

const {
  CONTEXT_IR_PENDING_FILE_NAME,
  contextIrPendingFilePath,
  loadPendingTasks,
} = await import(pathToFileURL(path.join(appRoot, "lib", "context-ir-pending.mjs")));

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mms-ci-pending-"));
}

/** Settlement drops the book entry *after* the host task settles — wait for both. */
async function waitForEmptyBook(dir) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if ((await loadPendingTasks(dir)).tasks.length === 0) return;
    await sleep(10);
  }
  throw new Error("waitForEmptyBook: the book never emptied");
}

/**
 * A `fetch` where the submit succeeds and the query NEVER settles.
 *
 * This is what an App reload looks like from the outside: the old poller is
 * parked mid-round and will never touch the host task again, while the book on
 * disk still names it. Parking on a bare never-resolving promise (no timer)
 * keeps the test process able to exit.
 */
function submittingFetch({ submit = () => ({ task_id: "remote-1" }) } = {}) {
  const calls = { submit: 0, query: 0 };
  const fetch = async (url) => {
    const target = String(url);
    if (target.includes("/v2/h3_context_ir")) {
      calls.submit += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(submit()) };
    }
    if (target.includes("/v2/query/video_generation/")) {
      calls.query += 1;
      return new Promise(() => {});
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { fetch, calls };
}

/** A `fetch` that answers the query, recording the Authorization header it saw. */
function recoveringFetch({ queries = [] } = {}) {
  const calls = { query: 0, auth: [] };
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v2/query/video_generation/")) {
      const index = Math.min(calls.query, queries.length - 1);
      calls.query += 1;
      calls.auth.push(init.headers?.Authorization ?? null);
      const payload = typeof queries[index] === "function" ? queries[index]() : queries[index];
      if (payload instanceof Error) throw payload;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { fetch, calls };
}

/** Run one submit against a hanging poller, leaving an entry in the book. */
async function createInFlightTask(dataDir, { hostTaskId = "host-task-1", pollTimeoutMs } = {}) {
  const tasks = fakeTasks();
  tasks.create = async (input) => {
    tasks.created.push(input);
    return { taskId: hostTaskId, scope: "session", delivery: input.delivery };
  };
  const { fetch } = submittingFetch();
  const tool = makeTool({ fetch, tasks, dataDir, pollTimeoutMs });
  await tool.execute({ prompt: "一只猫", context: { callToken: TOKEN } });
  return { tasks, tool };
}

test("persistence: 创建任务后落到 {dataDir}/context-ir-pending.json（原子写，且只在 dataDir）", async () => {
  const dir = await tempDataDir();
  const elsewhere = await tempDataDir();
  await createInFlightTask(dir);

  const book = await loadPendingTasks(dir);
  assert.equal(book.version, 1);
  assert.equal(book.tasks.length, 1, "远端接受后即登记在途任务");
  const entry = book.tasks[0];
  assert.equal(entry.hostTaskId, "host-task-1");
  assert.equal(entry.remoteTaskId, "remote-1");
  assert.equal(typeof entry.createdAt, "number");
  assert.ok(entry.deadlineAt > entry.createdAt, "deadlineAt 是 createdAt 之后的绝对时刻");

  assert.deepEqual(
    (await fs.readdir(dir)).sort(),
    [CONTEXT_IR_PENDING_FILE_NAME],
    "不留 *.tmp-* 临时文件",
  );
  assert.equal((await fs.readdir(elsewhere)).length, 0, "不向 dataDir 之外写");
});

test("persistence: 伪造重载后新实例接着轮询并完成结算（恢复成功）", async () => {
  const dir = await tempDataDir();
  const { tasks: oldTasks } = await createInFlightTask(dir);
  assert.equal(oldTasks.completed.length, 0, "重载前旧实例还没结算");

  // “重载”：新 tool 实例、同 dataDir、全新的凭证。
  const tasks = fakeTasks();
  const { fetch, calls } = recoveringFetch({
    queries: [{ task: { status: "success", content: { prompt: "重载后拿到的增强提示词" } } }],
  });
  makeTool({ fetch, tasks, dataDir: dir, credentials: { apiKey: "k-after-reload" } });

  await waitFor(() => tasks.completed.length === 1, { timeout: 3000 });
  assert.equal(tasks.completed[0].taskId, "host-task-1");
  assert.equal(
    tasks.completed[0].result.text,
    "H3-Context-IR 增强提示词：\n\n重载后拿到的增强提示词",
  );
  assert.equal(tasks.failed.length, 0);

  // 凭证是每轮重新解析的：恢复轮的 Authorization 用的是新凭证。
  assert.equal(calls.auth[0], "Bearer k-after-reload");

  // 结算成功即从簿中删除。
  await waitForEmptyBook(dir);
});

test("persistence: 重载后远端已失败 → 宿主任务判失败并从簿中删除", async () => {
  const dir = await tempDataDir();
  await createInFlightTask(dir);

  const tasks = fakeTasks();
  const { fetch } = recoveringFetch({
    queries: [{ task: { status: "failed", error: { message: "内容审核未通过（重载后才发现）" } } }],
  });
  makeTool({ fetch, tasks, dataDir: dir });

  await waitFor(() => tasks.failed.length === 1, { timeout: 3000 });
  assert.match(tasks.failed[0].error, /内容审核未通过/);
  assert.equal(tasks.completed.length, 0);
  await waitForEmptyBook(dir);
});

test("persistence: 超时清理——deadlineAt 已过超 24h 的条目直接判失败、不入轮询、不碰网络", async () => {
  const dir = await tempDataDir();
  const stale = {
    hostTaskId: "host-task-1",
    remoteTaskId: "remote-1",
    createdAt: Date.now() - 30 * 3600 * 1000,
    deadlineAt: Date.now() - 25 * 3600 * 1000,
  };
  await fs.writeFile(
    contextIrPendingFilePath(dir),
    `${JSON.stringify({ version: 1, tasks: [stale] }, null, 2)}\n`,
    "utf8",
  );

  const tasks = fakeTasks();
  const { fetch, calls } = recoveringFetch({ queries: [{ task: { status: "success", content: { prompt: "不该被取" } } }] });
  makeTool({ fetch, tasks, dataDir: dir });

  await waitFor(() => tasks.failed.length === 1, { timeout: 3000 });
  assert.match(tasks.failed[0].error, /过期|24/);
  assert.equal(tasks.completed.length, 0);
  assert.equal(calls.query, 0, "过期条目不得再打网络");
  await waitForEmptyBook(dir);
});

test("persistence: 过期条目判失败若结算本身失败，条目保留（下次重载重试，不静默丢弃）", async () => {
  const dir = await tempDataDir();
  const stale = {
    hostTaskId: "host-task-1",
    remoteTaskId: "remote-1",
    createdAt: Date.now() - 30 * 3600 * 1000,
    deadlineAt: Date.now() - 25 * 3600 * 1000,
  };
  await fs.writeFile(
    contextIrPendingFilePath(dir),
    `${JSON.stringify({ version: 1, tasks: [stale] }, null, 2)}\n`,
    "utf8",
  );

  const tasks = fakeTasks();
  tasks.fail = async () => {
    throw new Error("宿主不认识这个任务");
  };
  const { fetch, calls } = recoveringFetch({ queries: [] });
  makeTool({ fetch, tasks, dataDir: dir });

  await sleep(80);
  assert.equal(calls.query, 0, "过期条目从不入轮询");
  assert.equal((await loadPendingTasks(dir)).tasks.length, 1, "未结算成功的条目不得从簿中消失");
});

test("persistence: deadlineAt 已过但在 24h 内 → 仍然恢复（不是清理）", async () => {
  const dir = await tempDataDir();
  const recentlyExpired = {
    hostTaskId: "host-task-1",
    remoteTaskId: "remote-1",
    createdAt: Date.now() - 2 * 3600 * 1000,
    deadlineAt: Date.now() - 3600 * 1000, // 1 小时前过期，仍在 24h 窗口内
  };
  await fs.writeFile(
    contextIrPendingFilePath(dir),
    `${JSON.stringify({ version: 1, tasks: [recentlyExpired] }, null, 2)}\n`,
    "utf8",
  );

  const tasks = fakeTasks();
  const { fetch, calls } = recoveringFetch({
    queries: [{ task: { status: "success", content: { prompt: "迟到的增强提示词" } } }],
  });
  makeTool({ fetch, tasks, dataDir: dir });

  await waitFor(() => tasks.completed.length === 1, { timeout: 3000 });
  assert.equal(calls.query, 1, "窗口内仍要问一次远端");
  assert.match(tasks.completed[0].result.text, /迟到的增强提示词/);
});

test("persistence: 重载恢复时凭证解析失败按瞬态处理，继续轮询到 deadline 才判失败", async () => {
  const dir = await tempDataDir();
  await createInFlightTask(dir, { pollTimeoutMs: 60 });

  const tasks = fakeTasks();
  const { fetch, calls } = recoveringFetch({ queries: [{ task: { status: "success", content: { prompt: "x" } } }] });
  // 凭证不可用（例如用户正在改配置）：不得炸掉，也不能结算。
  makeTool({ fetch, tasks, dataDir: dir, credentials: { error: "no_credentials" }, pollIntervalMs: 15, pollTimeoutMs: 60 });

  await waitFor(() => tasks.failed.length === 1, { timeout: 3000 });
  assert.match(tasks.failed[0].error, /超时/);
  assert.equal(calls.query, 0, "无凭证时不出站");
  await waitForEmptyBook(dir);
});

test("persistence: 没有 dataDir 时完全不落盘、也不因簿而入轮询", async () => {
  const tasks = fakeTasks();
  const { fetch, calls } = recoveringFetch({ queries: [{ task: { status: "success" } }] });
  makeTool({ fetch, tasks }); // 无 dataDir
  await sleep(50);
  assert.equal(calls.query, 0);
  assert.equal(tasks.failed.length, 0);
  assert.equal(tasks.completed.length, 0);
});

test("persistence: 簿落点不可写（dataDir 指向一个文件）只记日志，不阻断工具创建", async () => {
  const dir = await tempDataDir();
  const blocked = path.join(dir, "not-a-dir");
  await fs.writeFile(blocked, "occupied", "utf8");

  const { fetch } = submittingFetch();
  const tasks = fakeTasks();
  let tool;
  assert.doesNotThrow(() => {
    tool = makeTool({ fetch, tasks, dataDir: blocked });
  });
  // 落盘失败不阻断提交：宿主任务照常创建与结算。
  await tool.execute({ prompt: "一只猫", context: { callToken: TOKEN } });
  assert.equal(tasks.created.length, 1);
  assert.equal(await fs.readFile(blocked, "utf8"), "occupied", "既不是目录就不该被改成目录");
});

test("apply: 装载时把 dataDir 交给 context-ir 工具（损坏簿不阻断 apply）", async () => {
  const dir = await tempDataDir();
  await fs.writeFile(contextIrPendingFilePath(dir), "{ broken", "utf8");

  const { fetch } = contextIrFetch({});
  const { ctx, calls } = hostStub({ fetch });
  ctx.dataDir = dir;
  await apply(ctx);
  assert.equal(calls.tools.length, 3, "簿损坏不影响工具注册");
});
