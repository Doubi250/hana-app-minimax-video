/**
 * tests/context-ir-pending.test.mjs — `node --test tests/context-ir-pending.test.mjs`
 *
 * The context-ir in-flight task book, through the seam the ticket pre-agreed:
 * `loadPendingTasks` / `addPendingTask` / `removePendingTask` over
 * `{dataDir}/context-ir-pending.json`.
 *
 * What is pinned here:
 *   - the book lands at exactly `{dataDir}/context-ir-pending.json` — nowhere else
 *   - the write is atomic: no `*.tmp-*` survives a write
 *   - a corrupt file is backed up to `context-ir-pending.json.corrupt-<ts>` and
 *     rebuilt, never silently dropped
 *   - add is idempotent per hostTaskId; remove is idempotent and reports whether
 *     it actually dropped a row
 *   - the book carries task ids and timestamps only — never a credential
 *
 * Everything is offline: real temp directories, no network, no key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  CONTEXT_IR_PENDING_FILE_NAME,
  contextIrPendingFilePath,
  loadPendingTasks,
  addPendingTask,
  removePendingTask,
} = await import(pathToFileURL(path.join(appRoot, "lib", "context-ir-pending.mjs")));

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mms-pending-"));
}

function entry(overrides = {}) {
  return {
    hostTaskId: "host-1",
    remoteTaskId: "remote-1",
    createdAt: 1_700_000_000_000,
    deadlineAt: 1_700_001_200_000,
    ...overrides,
  };
}

test("contextIrPendingFilePath: 只落在 dataDir 之下", () => {
  assert.equal(CONTEXT_IR_PENDING_FILE_NAME, "context-ir-pending.json");
  assert.equal(
    contextIrPendingFilePath("/tmp/x"),
    path.join("/tmp/x", "context-ir-pending.json"),
  );
});

test("loadPendingTasks: 文件缺失时返回空簿（version 1）", async () => {
  const dir = await tempDir();
  assert.deepEqual(await loadPendingTasks(dir), { version: 1, tasks: [] });
});

test("addPendingTask: 原子写——落到 {dataDir}，不留临时文件，且落点只在 dataDir", async () => {
  const dir = await tempDir();
  const elsewhere = await tempDir();
  const stored = await addPendingTask(dir, entry());

  assert.deepEqual(stored, entry());
  assert.deepEqual((await fs.readdir(dir)).sort(), ["context-ir-pending.json"]);
  assert.equal((await fs.readdir(elsewhere)).length, 0, "无关目录不应出现任何文件");

  const onDisk = JSON.parse(await fs.readFile(contextIrPendingFilePath(dir), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.tasks, [entry()]);
});

test("addPendingTask: 同一 hostTaskId 覆盖而不追加（幂等）", async () => {
  const dir = await tempDir();
  await addPendingTask(dir, entry());
  await addPendingTask(dir, entry({ remoteTaskId: "remote-2", deadlineAt: 42 }));

  const book = await loadPendingTasks(dir);
  assert.equal(book.tasks.length, 1, "同一宿主任务不得出现两行");
  assert.equal(book.tasks[0].remoteTaskId, "remote-2");
  assert.equal(book.tasks[0].deadlineAt, 42);
});

test("addPendingTask: 多个宿主任务各占一行", async () => {
  const dir = await tempDir();
  await addPendingTask(dir, entry({ hostTaskId: "h1", remoteTaskId: "r1" }));
  await addPendingTask(dir, entry({ hostTaskId: "h2", remoteTaskId: "r2" }));
  const book = await loadPendingTasks(dir);
  assert.deepEqual(
    book.tasks.map((t) => t.hostTaskId).sort(),
    ["h1", "h2"],
  );
});

test("addPendingTask: 形状非法即报错，且不创建文件", async () => {
  const dir = await tempDir();
  for (const bad of [
    {},
    { hostTaskId: "h", remoteTaskId: "r" },
    { hostTaskId: "", remoteTaskId: "r", createdAt: 1, deadlineAt: 2 },
    { hostTaskId: "h", remoteTaskId: "", createdAt: 1, deadlineAt: 2 },
    { hostTaskId: "h", remoteTaskId: "r", createdAt: "now", deadlineAt: 2 },
  ]) {
    await assert.rejects(() => addPendingTask(dir, bad), /hostTaskId|createdAt/);
  }
  assert.equal((await fs.readdir(dir)).length, 0);
});

test("removePendingTask: 命中即删并回 true；未命中和空 id 回 false", async () => {
  const dir = await tempDir();
  await addPendingTask(dir, entry({ hostTaskId: "h1" }));
  await addPendingTask(dir, entry({ hostTaskId: "h2" }));

  assert.equal(await removePendingTask(dir, "h1"), true);
  assert.deepEqual(
    (await loadPendingTasks(dir)).tasks.map((t) => t.hostTaskId),
    ["h2"],
  );
  assert.equal(await removePendingTask(dir, "h1"), false, "重复删同一条是幂等的");
  assert.equal(await removePendingTask(dir, "  "), false);
  assert.equal(await removePendingTask(dir, undefined), false);
});

test("removePendingTask: 删掉最后一条后簿为空，文件仍在（不是被删）", async () => {
  const dir = await tempDir();
  await addPendingTask(dir, entry());
  await removePendingTask(dir, "host-1");
  assert.deepEqual(await loadPendingTasks(dir), { version: 1, tasks: [] });
  assert.deepEqual((await fs.readdir(dir)).sort(), ["context-ir-pending.json"]);
});

test("loadPendingTasks: 损坏 JSON 先备份为 .corrupt-<ts> 再重建空簿", async () => {
  const dir = await tempDir();
  const garbage = "{ not json at all";
  await fs.writeFile(contextIrPendingFilePath(dir), garbage, "utf8");

  assert.deepEqual(await loadPendingTasks(dir), { version: 1, tasks: [] });

  const entries = await fs.readdir(dir);
  const backups = entries.filter((name) => /^context-ir-pending\.json\.corrupt-\d+$/.test(name));
  assert.equal(backups.length, 1, `应恰好有一个 .corrupt-<ts> 备份，实际：${entries.join(", ")}`);
  assert.equal(await fs.readFile(path.join(dir, backups[0]), "utf8"), garbage, "备份须保留原始字节");

  // 重建后的簿是可用的：登记一条再读回。
  await addPendingTask(dir, entry());
  assert.equal((await loadPendingTasks(dir)).tasks.length, 1);
});

test("loadPendingTasks: 形状非法（tasks 非数组 / version 非 1 / 条目缺字段）均备份重建", async () => {
  const cases = [
    { version: 1, tasks: {} },
    { version: 2, tasks: [{ hostTaskId: "h", remoteTaskId: "r", createdAt: 1, deadlineAt: 2 }] },
    { version: 1, tasks: [{ hostTaskId: "h" }] },
    { version: 1, tasks: [{ hostTaskId: "h", remoteTaskId: "r", createdAt: 1, deadlineAt: "later" }] },
    [1, 2, 3],
  ];
  for (const value of cases) {
    const dir = await tempDir();
    await fs.writeFile(contextIrPendingFilePath(dir), JSON.stringify(value), "utf8");
    assert.deepEqual(await loadPendingTasks(dir), { version: 1, tasks: [] });
    const backups = (await fs.readdir(dir)).filter((n) =>
      /^context-ir-pending\.json\.corrupt-\d+$/.test(n),
    );
    assert.equal(backups.length, 1, `形状非法应备份重建：${JSON.stringify(value)}`);
  }
});

test("簿只存任务 ID 与时间戳——绝不落任何凭证", async () => {
  const dir = await tempDir();
  await addPendingTask(dir, entry());
  const raw = await fs.readFile(contextIrPendingFilePath(dir), "utf8");
  const task = JSON.parse(raw).tasks[0];
  assert.deepEqual(Object.keys(task).sort(), [
    "createdAt",
    "deadlineAt",
    "hostTaskId",
    "remoteTaskId",
  ]);
  assert.doesNotMatch(raw, /apiKey|Authorization|Bearer|sk-/i);
});

test("并发 add 不互相覆盖（同 dataDir 串行化）", async () => {
  const dir = await tempDir();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      addPendingTask(dir, entry({ hostTaskId: `h${i}`, remoteTaskId: `r${i}` })),
    ),
  );
  const book = await loadPendingTasks(dir);
  assert.equal(book.tasks.length, 8, "并发的登记一条都不能丢");
  assert.deepEqual(
    book.tasks.map((t) => t.hostTaskId).sort(),
    ["h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7"],
  );
});

test("并发读 + 写不炸：读簿与结算写簿同时发生时不抛错（Windows rename 窗口）", async () => {
  // 现实形态：装载时读簿，与某条任务的结算写簿同时发生。在 Windows 上目标文件正被
  // 读句柄占着时 `rename` 会 EPERM——原子写必须自旋穿过这扇窗口，而不是把错误抛给
  // 调用方（调用方只会降为一条日志，结果就是宿主任务永久悬挂）。
  const dir = await tempDir();
  await addPendingTask(dir, entry({ hostTaskId: "h" }));

  const readers = Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 50; i += 1) await loadPendingTasks(dir);
  });
  const writers = Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 25; i += 1) {
      await addPendingTask(dir, entry({ hostTaskId: "h", remoteTaskId: `r${i}` }));
    }
  });

  await Promise.all([...readers, ...writers]);
  assert.equal(await removePendingTask(dir, "h"), true);
  assert.deepEqual(await loadPendingTasks(dir), { version: 1, tasks: [] });
  assert.deepEqual((await fs.readdir(dir)).sort(), ["context-ir-pending.json"], "不留临时文件");
});

test("atomic-file: writeFileAtomic 覆盖既有内容且不留临时文件", async () => {
  const { writeFileAtomic, readTextOrNull } = await import(
    pathToFileURL(path.join(appRoot, "lib", "atomic-file.mjs"))
  );
  const dir = await tempDir();
  const target = path.join(dir, "x.json");
  await writeFileAtomic(target, "first");
  await writeFileAtomic(target, "second");
  assert.equal(await readTextOrNull(target), "second");
  assert.deepEqual((await fs.readdir(dir)).sort(), ["x.json"]);

  assert.equal(await readTextOrNull(path.join(dir, "missing.json")), null, "缺失 → null");
});
