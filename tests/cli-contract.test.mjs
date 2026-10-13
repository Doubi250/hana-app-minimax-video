/**
 * tests/cli-contract.test.mjs — `node --test tests/cli-contract.test.mjs`
 *
 * The machine contract of `scripts/ext-voice-clone.mjs`: whatever else it prints,
 * the LAST line of stdout is a single-line JSON object that `JSON.parse` accepts,
 * on both the success and the failure path. That is what an agent reads; progress
 * lines above it are for humans.
 *
 * The CLI is a standalone script (not host-mediated), so it reads the key from
 * `MINIMAX_API_KEY` and reaches for `globalThis.fetch`. The test keeps the network
 * offline by preloading `tests/helpers/offline-fetch.mjs` with `--import`, and
 * always runs with a temp `--data-dir` so nothing escapes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(appRoot, "scripts", "ext-voice-clone.mjs");
const loaderPath = path.join(appRoot, "tests", "helpers", "offline-fetch.mjs");

const { resolveDataDir } = await import(pathToFileURL(scriptPath).href);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mms-cli-"));
}

/** 44 字节 PCM WAV 头 + 目标时长静音数据。 */
function wavBytes(seconds, { sampleRate = 8000 } = {}) {
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/**
 * Run the CLI as a child process, offline. Returns { code, stdout, stderr, lines, last }.
 * `lines` drops trailing blank lines; `last` is the final stdout line.
 */
function runCli(args, { env = {}, cwd = appRoot } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", pathToFileURL(loaderPath).href, scriptPath, ...args],
      { cwd, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const lines = String(stdout).split(/\r?\n/).filter((l) => l.trim() !== "");
        resolve({
          code: error?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
          lines,
          last: lines.length ? lines[lines.length - 1] : "",
        });
      },
    );
  });
}

/** Parse the CLI's last stdout line, asserting it is exactly one line of JSON. */
function parseLast(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  assert.ok(last, "stdout 末行不得为空");
  assert.doesNotMatch(last, /\n/, "末行必须是单行");
  return JSON.parse(last); // 不抛即证明可 JSON.parse
}

test("cli: 成功路径——末行是单行 JSON 且可 JSON.parse", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));
  const dataDir = path.join(dir, "data");

  const result = await runCli(
    [samplePath, "--voice-id", "cli-voice-1", "--label", "CLI 音色", "--data-dir", dataDir],
    { env: { MINIMAX_API_KEY: "test-key", MMS_FAKE_MODE: "ok" } },
  );

  assert.equal(result.code, 0, `期望退出码 0，stderr=${result.stderr}`);
  const parsed = parseLast(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.voice.voiceId, "cli-voice-1");
  assert.equal(parsed.voice.label, "CLI 音色");
  assert.equal(typeof parsed.voice.voiceId, "string");

  // 契约之外的可观察副作用：音色表确实落在 --data-dir 下。
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, "voices.json"), "utf8"));
  assert.equal(stored.voices[0].voiceId, "cli-voice-1");
});

test("cli: 末行严格单行 JSON——不夹带进度文本，也不多行", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));

  const result = await runCli(
    [samplePath, "--voice-id", "v-single", "--data-dir", path.join(dir, "data")],
    { env: { MINIMAX_API_KEY: "test-key", MMS_FAKE_MODE: "ok" } },
  );

  assert.ok(result.lines.length >= 1);
  // 末行独立解析，且不含换行 / 前后无杂质。
  const last = result.lines[result.lines.length - 1];
  assert.equal(last, last.trim());
  assert.doesNotThrow(() => JSON.parse(last));
  // 人类进度行可以存在，但绝不能与 JSON 挤在同一行。
  for (const line of result.lines.slice(0, -1)) {
    assert.throws(() => JSON.parse(line), `进度行不应是 JSON：${line}`);
  }
});

test("cli: 失败路径（缺少 MINIMAX_API_KEY）——末行仍是单行 JSON，退出码 1", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));

  const result = await runCli(
    [samplePath, "--voice-id", "v", "--data-dir", path.join(dir, "data")],
    { env: { MINIMAX_API_KEY: "", MMS_FAKE_MODE: "ok" } },
  );

  assert.equal(result.code, 1);
  const parsed = parseLast(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error.code, "string");
  assert.equal(typeof parsed.error.message, "string");
  assert.match(parsed.error.code, /api_key|key/i);
});

test("cli: 失败路径（样本格式非法）——末行单行 JSON，退出码 1", async () => {
  const dir = await tempDir();
  const badPath = path.join(dir, "bad.txt");
  await fs.writeFile(badPath, "not audio");

  const result = await runCli(
    [badPath, "--voice-id", "v", "--data-dir", path.join(dir, "data")],
    { env: { MINIMAX_API_KEY: "test-key", MMS_FAKE_MODE: "ok" } },
  );

  assert.equal(result.code, 1);
  const parsed = parseLast(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error.code, /sample|format|invalid/i);
});

test("cli: 失败路径（上游克隆错误）——末行单行 JSON，退出码 1", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));

  const result = await runCli(
    [samplePath, "--voice-id", "v", "--data-dir", path.join(dir, "data")],
    { env: { MINIMAX_API_KEY: "test-key", MMS_FAKE_MODE: "clone_fail" } },
  );

  assert.equal(result.code, 1);
  const parsed = parseLast(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error.message, /1002/);
});

test("cli: key 不回显——stdout/stderr 不出现密钥明文", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));
  const secret = "zzq-cli-secret-9f3a2b1c4d5e";

  const result = await runCli(
    [samplePath, "--voice-id", "v", "--data-dir", path.join(dir, "data")],
    { env: { MINIMAX_API_KEY: secret, MMS_FAKE_MODE: "ok" } },
  );

  assert.equal(result.stdout.includes(secret), false, "stdout 不得回显 key");
  assert.equal(result.stderr.includes(secret), false, "stderr 不得回显 key");
});

/* ---------------------------------------------------------------- *
 * A（ticket 10）：缺省音色表落点必须在安装目录之外，且与 App 运行时同一张表
 * ---------------------------------------------------------------- */

test("resolveDataDir: HANA_HOME 优先，落在 {HANA_HOME}/app-data/minimax-video", () => {
  const dir = resolveDataDir({ env: { HANA_HOME: "C:\\fake-hana-home" }, homedir: () => "C:\\fake-user" });
  assert.equal(dir, path.join("C:\\fake-hana-home", "app-data", "minimax-video"));
});

// check-clean:allow — 该字符串是产品约定的 HANA_HOME 缺省路径名（宿主文档口径），不是本机路径。
test("resolveDataDir: HANA_HOME 缺失时回落 ~/.hanako/app-data/minimax-video", () => {
  const dir = resolveDataDir({ env: {}, homedir: () => "C:\\fake-user" });
  assert.equal(dir, path.join("C:\\fake-user", ".hanako", "app-data", "minimax-video"));
  // 空串 / 全空白同样视为缺失。
  assert.equal(
    resolveDataDir({ env: { HANA_HOME: "   " }, homedir: () => "C:\\fake-user" }),
    path.join("C:\\fake-user", ".hanako", "app-data", "minimax-video"),
  );
});

test("resolveDataDir: 缺省落点绝不落在脚本所在的安装目录之下", async () => {
  // 脚本位于 {HANA_HOME}/apps/minimax-video/scripts/；缺省 dataDir 不得在其之下。
  const scriptsDir = path.dirname(scriptPath);
  const defaultDir = resolveDataDir({ env: {}, homedir: () => "C:\\fake-user" });
  const rel = path.relative(scriptsDir, defaultDir);
  assert.ok(
    rel.startsWith("..") || path.isAbsolute(rel),
    `缺省落点 ${defaultDir} 不得位于安装目录 ${scriptsDir} 之下`,
  );
  // 源码中也不应再残留旧的 HERE/.minimax-data 缺省。
  const source = await fs.readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /path\.join\(HERE,\s*"\.minimax-data"\)/);
});

test("cli: 不给 --data-dir 时音色表落在 HANA_HOME 下的 app-data，不落安装目录", async () => {
  const dir = await tempDir();
  const samplePath = path.join(dir, "sample.wav");
  await fs.writeFile(samplePath, wavBytes(30));
  const hanaHome = path.join(dir, "hana-home");

  const result = await runCli([samplePath, "--voice-id", "cli-default-voice"], {
    env: { MINIMAX_API_KEY: "test-key", MMS_FAKE_MODE: "ok", HANA_HOME: hanaHome },
  });

  assert.equal(result.code, 0, `期望退出码 0，stderr=${result.stderr}`);
  const parsed = parseLast(result.stdout);
  assert.equal(parsed.ok, true);

  const expected = path.join(hanaHome, "app-data", "minimax-video", "voices.json");
  const stored = JSON.parse(await fs.readFile(expected, "utf8"));
  assert.equal(stored.voices[0].voiceId, "cli-default-voice");

  // 安装目录（脚本旁）绝不出现 voices.json / .minimax-data。
  const installDirEntries = await fs.readdir(path.dirname(scriptPath));
  assert.equal(installDirEntries.includes("voices.json"), false, "安装目录不得出现 voices.json");
  assert.equal(installDirEntries.includes(".minimax-data"), false, "安装目录不得出现 .minimax-data");
});
