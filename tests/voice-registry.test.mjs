/**
 * tests/voice-registry.test.mjs — `node --test tests/voice-registry.test.mjs`
 *
 * The dataDir-backed voice registry, through the seam the ticket pre-agreed:
 * `loadVoices` / `registerVoice` / `findVoice` over `{dataDir}/voices.json`.
 *
 * What is pinned here:
 *   - the registry lands at exactly `{dataDir}/voices.json` — never anywhere else
 *   - the write is atomic: a temp file is renamed into place, no `*.tmp-*` survives
 *   - a corrupt file is backed up to `voices.json.corrupt-<ts>` and rebuilt,
 *     never silently dropped
 *   - re-registering a voiceId overwrites it but keeps the original `createdAt`
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
const { VOICES_FILE_NAME, voicesFilePath, loadVoices, registerVoice, findVoice } = await import(
  pathToFileURL(path.join(appRoot, "lib", "voice-registry.mjs"))
);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mms-voices-"));
}

function sample(overrides = {}) {
  return {
    voiceId: "clone-001",
    label: "测试音色",
    createdAt: "2020-01-01T00:00:00.000Z",
    sample: { fileName: "a.wav", bytes: 123, fileId: "file-1" },
    ...overrides,
  };
}

test("voicesFilePath: 只落在 dataDir 之下", () => {
  assert.equal(VOICES_FILE_NAME, "voices.json");
  assert.equal(voicesFilePath("/tmp/x"), path.join("/tmp/x", "voices.json"));
});

test("loadVoices: 文件缺失时返回空表（version 1）", async () => {
  const dir = await tempDir();
  const registry = await loadVoices(dir);
  assert.deepEqual(registry, { version: 1, voices: [] });
});

test("registerVoice: 原子写——落到 {dataDir}/voices.json，不留临时文件", async () => {
  const dir = await tempDir();
  await registerVoice(dir, sample());

  const entries = (await fs.readdir(dir)).sort();
  assert.deepEqual(entries, ["voices.json"], "只应有 voices.json，不留 *.tmp-*");

  const onDisk = JSON.parse(await fs.readFile(voicesFilePath(dir), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.voices.length, 1);
  assert.equal(onDisk.voices[0].voiceId, "clone-001");
  assert.deepEqual(onDisk.voices[0].sample, { fileName: "a.wav", bytes: 123, fileId: "file-1" });
});

test("registerVoice: dataDir 落点——不向别处写", async () => {
  const dir = await tempDir();
  const elsewhere = await tempDir();
  await registerVoice(dir, sample());

  assert.equal((await fs.readdir(elsewhere)).length, 0, "无关目录不应出现任何文件");
  assert.equal(await exists(path.join(dir, VOICES_FILE_NAME)), true);
});

test("registerVoice: 重复 voiceId 覆盖但保留原 createdAt（幂等）", async () => {
  const dir = await tempDir();
  await registerVoice(dir, sample({ createdAt: "2020-01-01T00:00:00.000Z", label: "旧名" }));
  const second = await registerVoice(
    dir,
    sample({ createdAt: "2030-12-31T00:00:00.000Z", label: "新名", sample: { fileName: "b.wav", bytes: 9, fileId: "file-2" } }),
  );

  assert.equal(second.createdAt, "2020-01-01T00:00:00.000Z", "createdAt 必须保留第一次的值");
  const registry = await loadVoices(dir);
  assert.equal(registry.voices.length, 1, "同一 voiceId 不得产生第二行");
  assert.equal(registry.voices[0].label, "新名");
  assert.equal(registry.voices[0].sample.fileId, "file-2");
  assert.equal(registry.voices[0].createdAt, "2020-01-01T00:00:00.000Z");
});

test("registerVoice: 不同 voiceId 追加，createdAt 缺省补当前时间", async () => {
  const dir = await tempDir();
  await registerVoice(dir, sample({ voiceId: "v1", createdAt: undefined }));
  const stored = await findVoice(dir, "v1");
  assert.ok(stored);
  assert.equal(typeof stored.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(stored.createdAt)), "缺省 createdAt 必须是可解析的时间");

  await registerVoice(dir, sample({ voiceId: "v2" }));
  const registry = await loadVoices(dir);
  assert.deepEqual(
    registry.voices.map((v) => v.voiceId).sort(),
    ["v1", "v2"],
  );
});

test("loadVoices: 损坏 JSON 先备份为 voices.json.corrupt-<ts> 再重建", async () => {
  const dir = await tempDir();
  const garbage = "{ this is not json";
  await fs.writeFile(voicesFilePath(dir), garbage, "utf8");

  const registry = await loadVoices(dir);
  assert.deepEqual(registry, { version: 1, voices: [] }, "损坏文件应重建为空表");

  const entries = await fs.readdir(dir);
  const backups = entries.filter((name) => /^voices\.json\.corrupt-\d+$/.test(name));
  assert.equal(backups.length, 1, `应恰好有一个 .corrupt-<ts> 备份，实际：${entries.join(", ")}`);
  assert.equal(await fs.readFile(path.join(dir, backups[0]), "utf8"), garbage, "备份须保留原始字节");

  // 重建后的表是可用的：登记一条再读回。
  await registerVoice(dir, sample());
  assert.equal((await loadVoices(dir)).voices.length, 1);
});

test("loadVoices: 形状非法（voices 非数组）同样备份重建", async () => {
  const dir = await tempDir();
  await fs.writeFile(voicesFilePath(dir), JSON.stringify({ version: 1, voices: {} }), "utf8");

  const registry = await loadVoices(dir);
  assert.deepEqual(registry, { version: 1, voices: [] });
  const backups = (await fs.readdir(dir)).filter((n) => /^voices\.json\.corrupt-\d+$/.test(n));
  assert.equal(backups.length, 1);
});

test("loadVoices: version 非 1 视为损坏", async () => {
  const dir = await tempDir();
  await fs.writeFile(
    voicesFilePath(dir),
    JSON.stringify({ version: 2, voices: [{ voiceId: "v" }] }),
    "utf8",
  );
  const registry = await loadVoices(dir);
  assert.deepEqual(registry, { version: 1, voices: [] });
  assert.equal(
    (await fs.readdir(dir)).filter((n) => /^voices\.json\.corrupt-\d+$/.test(n)).length,
    1,
  );
});

test("findVoice: 命中返回条目，未命中返回 null", async () => {
  const dir = await tempDir();
  await registerVoice(dir, sample());
  const hit = await findVoice(dir, "clone-001");
  assert.equal(hit.voiceId, "clone-001");
  assert.equal(await findVoice(dir, "nope"), null);
});

test("registerVoice: 缺少 voiceId 即报错，且不创建文件", async () => {
  const dir = await tempDir();
  await assert.rejects(() => registerVoice(dir, { label: "无名" }), /voiceId/);
  assert.equal((await fs.readdir(dir)).length, 0);
});

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
