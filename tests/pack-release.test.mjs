/**
 * tests/pack-release.test.mjs — `node --test tests/pack-release.test.mjs`
 *
 * Unit coverage for `scripts/pack-release.mjs`, the release-pipeline CLI that
 * turns the hand-run recipe (clean `git archive` copy → validate → pack → scan →
 * smoke → bundle) into one command. The real pipeline needs the host toolchain
 * (tar, validate-app.mjs, extension-pack.mjs) and a clean checkout, so the
 * end-to-end run is not exercised here; the pure seams are:
 *
 *   - parseArgs        — argv → options
 *   - resolveToolsRoot — --tools-root > HANA_APP_TOOLS_ROOT > discovery
 *   - scanText / scanZipEntries — leak rules mirrored from scripts/check-clean.mjs
 *   - run              — ordered steps, fail-fast, `check-clean:allow` honoured
 *
 * The value of a test here is the same as everywhere else: it pins behaviour a
 * refactor must not change. The scan rules in particular are a copy of
 * check-clean.mjs's detector, so these assertions are the record of that parity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(appRoot, "scripts", "pack-release.mjs");

const mod = await import(pathToFileURL(scriptPath).href);
const { parseArgs, resolveToolsRoot, resolveNodeRuntime, scanText, scanZipEntries, run, buildSummary } = mod;

/* ------------------------------------------------------------------ *
 * parseArgs
 * ------------------------------------------------------------------ */

test("parseArgs: 无参数时全部回落默认值", () => {
  const opts = parseArgs([]);
  assert.equal(opts.ref, "HEAD");
  assert.equal(opts.out, "release");
  assert.equal(opts.toolsRoot, undefined);
  assert.equal(opts.bundle, false);
  assert.equal(opts.bundleBase, "0696115");
  assert.equal(opts.skipTests, false);
});

test("parseArgs: 逐个开关解析", () => {
  const opts = parseArgs([
    "--ref", "abc123",
    "--out", "dist-out",
    "--tools-root", "C:\\tools",
    "--bundle",
    "--bundle-base", "deadbeef",
    "--skip-tests",
  ]);
  assert.equal(opts.ref, "abc123");
  assert.equal(opts.out, "dist-out");
  assert.equal(opts.toolsRoot, "C:\\tools");
  assert.equal(opts.bundle, true);
  assert.equal(opts.bundleBase, "deadbeef");
  assert.equal(opts.skipTests, true);
});

test("parseArgs: 未知参数报错", () => {
  assert.throws(() => parseArgs(["--nope"]), /未知参数|unknown/i);
});

/* ------------------------------------------------------------------ *
 * resolveToolsRoot — 优先级与目录发现
 * ------------------------------------------------------------------ */

/** 造一个假的工具根目录树：{root}/scripts/{validate-app.mjs,extension-pack.mjs}。 */
function fakeFs(files) {
  return {
    existsSync: (p) => files.has(path.normalize(p)),
    readdirSync: (p) => {
      const prefix = path.normalize(p);
      const out = new Set();
      for (const f of files) {
        if (f.startsWith(prefix) && f !== prefix) {
          const rest = f.slice(prefix.length).replace(/^[\\/]+/, "");
          out.add(rest.split(/[\\/]/)[0]);
        }
      }
      return [...out];
    },
  };
}

function toolsFiles(root) {
  return new Set([
    path.normalize(path.join(root, "scripts", "validate-app.mjs")),
    path.normalize(path.join(root, "scripts", "extension-pack.mjs")),
  ]);
}

test("resolveToolsRoot: 显式参数优先于 env", () => {
  const param = "C:\\param-root";
  const envRoot = "C:\\env-root";
  const files = new Set([...toolsFiles(param), ...toolsFiles(envRoot)]);
  const got = resolveToolsRoot({ toolsRoot: param, env: { HANA_APP_TOOLS_ROOT: envRoot }, fs: fakeFs(files) });
  assert.equal(got, param);
});

test("resolveToolsRoot: 无参数时用 env HANA_APP_TOOLS_ROOT", () => {
  const envRoot = "C:\\env-root";
  const got = resolveToolsRoot({ env: { HANA_APP_TOOLS_ROOT: envRoot }, fs: fakeFs(toolsFiles(envRoot)) });
  assert.equal(got, envRoot);
});

test("resolveToolsRoot: 参数与 env 均缺时在 {HANA_HOME}/artifacts/server 下发现最新版本目录", () => {
  const home = "C:\\hana-home";
  const oldRoot = path.join(home, "artifacts", "server", "1.0.16-beta-win32-x64-aaa");
  const newRoot = path.join(home, "artifacts", "server", "1.1.0-beta-win32-x64-bbb");
  const files = new Set([...toolsFiles(oldRoot), ...toolsFiles(newRoot)]);
  const got = resolveToolsRoot({ env: { HANA_HOME: home }, fs: fakeFs(files) });
  assert.equal(got, newRoot, "应选版本号最高的目录");
});

test("resolveToolsRoot: 发现时跳过不含工具脚本的候选目录", () => {
  const home = "C:\\hana-home";
  const badRoot = path.join(home, "artifacts", "server", "2.0.0-beta-win32-x64-ccc"); // 无 scripts
  const goodRoot = path.join(home, "artifacts", "server", "1.1.0-beta-win32-x64-bbb");
  const files = new Set([...toolsFiles(goodRoot)]);
  const got = resolveToolsRoot({ env: { HANA_HOME: home }, fs: fakeFs(files) });
  assert.equal(got, goodRoot);
});

test("resolveToolsRoot: 无任何匹配时报错并列出已试路径", () => {
  const home = "C:\\hana-home";
  try {
    resolveToolsRoot({ env: { HANA_HOME: home }, fs: fakeFs(new Set()) });
    assert.fail("应抛错");
  } catch (error) {
    const message = String(error?.message || error);
    assert.match(message, /已试路径|tried/i);
    assert.ok(message.includes(path.join(home, "artifacts", "server")) || message.includes("artifacts"), "应列出扫描过的位置");
  }
});

test("resolveToolsRoot: 显式参数指向缺脚本的目录也报错", () => {
  assert.throws(
    () => resolveToolsRoot({ toolsRoot: "C:\\empty", env: {}, fs: fakeFs(new Set()) }),
    /已试路径|tried|工具根/i,
  );
});

/* ------------------------------------------------------------------ *
 * resolveNodeRuntime — 冒烟运行时（HANA_NODE_RUNTIME > 平台缓存）
 * ------------------------------------------------------------------ */

test("resolveNodeRuntime: env HANA_NODE_RUNTIME 优先", () => {
  const got = resolveNodeRuntime({ env: { HANA_NODE_RUNTIME: "C:\\rt\\node.exe" }, fs: fakeFs(new Set()) });
  assert.equal(got, "C:\\rt\\node.exe");
});

test("resolveNodeRuntime: 缺 env 时在 {HANA_HOME}/.cache/node-runtime 下发现 node 可执行文件", () => {
  const home = "C:\\hana-home";
  const runtimeDir = path.join(home, ".cache", "node-runtime", "node-v26.8.1-win-x64");
  const exe = process.platform === "win32" ? path.join(runtimeDir, "node.exe") : path.join(runtimeDir, "bin", "node");
  const got = resolveNodeRuntime({ env: { HANA_HOME: home }, fs: fakeFs(new Set([path.normalize(exe)])) });
  assert.equal(got, exe);
});

test("resolveNodeRuntime: 无缓存运行时时返回 undefined（交由宿主报错）", () => {
  const got = resolveNodeRuntime({ env: { HANA_HOME: "C:\\hana-home" }, fs: fakeFs(new Set()) });
  assert.equal(got, undefined);
});

/* ------------------------------------------------------------------ *
 * scanText / scanZipEntries — 规则与 check-clean.mjs 对齐
 * ------------------------------------------------------------------ */

test("scanText: 命中各凭据与路径规则", () => {
  const cases = [
    ["Bearer " + "a".repeat(40), "bearer-token"],
    ["sk-" + "A".repeat(24), "api-key"],
    ["ghp_" + "B".repeat(24), "github-token"],
    ["github_pat_" + "C".repeat(24), "github-token"],
    ["eyJ" + "D".repeat(24), "jwt"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key-header"], // check-clean:allow — 扫描器夹具字符串
    ["C:\\Users\\someone\\file", "windows-user-path"], // check-clean:allow — 扫描器夹具字符串
    ["D:/Openhanako/thing", "openhanako-checkout"], // check-clean:allow — 扫描器夹具字符串
    ["C:\\Users\\me\\AppData\\Roaming", "appdata-path"], // check-clean:allow — 扫描器夹具字符串
  ];
  for (const [line, id] of cases) {
    const ids = scanText(line).map((h) => h.id);
    assert.ok(ids.includes(id), `${JSON.stringify(line)} 应命中 ${id}，实际 ${ids.join(",")}`);
  }
});

test("scanText: 干净行不命中", () => {
  assert.deepEqual(scanText("const x = 1; // nothing sensitive here"), []);
});

test("scanText: 裸产品名 OpenHanako 不命中，须带盘符前缀才命中", () => {
  // openhanako-checkout 规则要求绝对路径前缀；正文里的产品名不是泄漏。
  assert.deepEqual(scanText("Credentials come from the OpenHanako provider side."), []);
  const hit = scanText("C:/Openhanako/HanaCode_workspace/x").map((h) => h.id); // check-clean:allow — 扫描器夹具字符串
  assert.ok(hit.includes("openhanako-checkout"));
});

test("scanText: .hanako 字面量不命中（与发布扫描口径一致）", () => {
  // check-clean 的 hanako-home-path 规则在发布扫描中刻意剔除：宿主主目录约定不是泄漏。
  assert.deepEqual(scanText("const p = path.join(home, '.hanako', 'app-data');"), []);
});

test("scanText: check-clean:allow 豁免本行及上一行", () => {
  const secret = "sk-" + "Z".repeat(24);
  const sameLine = scanText(`${secret} // check-clean:allow — 测试夹具`);
  assert.deepEqual(sameLine, [], "同行标记应豁免");
  const prevLine = scanText(`// check-clean:allow — 说明\n${secret}`);
  assert.ok(prevLine.length === 0, "上一行标记应豁免");
});

test("scanZipEntries: 汇总命中的 文件:行 —— id", () => {
  const entries = [
    { name: "lib/ok.mjs", content: "export const a = 1;\n" },
    { name: "docs/leak.md", content: "line one\nBearer " + "q".repeat(40) + "\n" },
  ];
  const findings = scanZipEntries(entries);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "docs/leak.md");
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].id, "bearer-token");
});

test("scanZipEntries: .git / .sdk 条目命中", () => {
  const entries = [
    { name: ".git/config", content: "[core]\n" },
    { name: "sub/.git/HEAD", content: "ref: refs/heads/x\n" },
    { name: "node_modules/.sdk/index.js", content: "x\n" },
  ];
  const ids = scanZipEntries(entries).map((f) => f.id).sort();
  assert.deepEqual(ids, ["git-entry", "git-entry", "sdk-entry"]);
});

test("scanZipEntries: 干净条目集返回空", () => {
  const entries = [
    { name: "manifest.json", content: JSON.stringify({ id: "minimax-video", version: "0.3.2" }) },
    { name: "index.mjs", content: "export default {};\n" },
  ];
  assert.deepEqual(scanZipEntries(entries), []);
});

test("scanZipEntries: 二进制条目跳过（与 check-clean 一致）", () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]);
  const entries = [{ name: "assets/icon.bin", content: binary }];
  assert.deepEqual(scanZipEntries(entries), []);
});

/* ------------------------------------------------------------------ *
 * run — 步骤顺序、失败即停、跳过开关
 * ------------------------------------------------------------------ */

/** 造一组可观测的 mock 步骤；返回 steps 与调用顺序数组。 */
function mockSteps(order, { failAt } = {}) {
  const names = ["preflight", "archive", "test", "validate", "pack", "scan", "smoke", "bundle"];
  const steps = {};
  for (const name of names) {
    steps[name] = async () => {
      order.push(name);
      if (name === failAt) throw Object.assign(new Error(`${name} 失败`), { code: "BOOM" });
      switch (name) {
        case "preflight":
          return { ref: "HEAD", id: "minimax-video", version: "0.3.2" };
        case "archive":
          return { cleanCopy: "C:\\tmp\\minimax-video" };
        case "tests":
          return {};
        case "validate":
          return { errors: 0 };
        case "pack":
          return { zip: "release/app-minimax-video-0.3.2.zip", entryJson: "release/app-minimax-video-0.3.2.entry.json" };
        case "scan":
          return { scan: "clean" };
        case "smoke":
          return { ok: true };
        case "bundle":
          return { bundle: "release/x.bundle", bundleSha256: "abc", commits: 3 };
        default:
          return {};
      }
    };
  }
  return steps;
}

test("run: 成功时按序跑完全部步骤并返回汇总", async () => {
  const order = [];
  const out = await run({ argv: ["--bundle"], env: {}, steps: mockSteps(order) });
  assert.equal(out.ok, true);
  assert.deepEqual(order, ["preflight", "archive", "test", "validate", "pack", "scan", "smoke", "bundle"]);
  assert.equal(out.zip, "release/app-minimax-video-0.3.2.zip");
  assert.equal(out.scan, "clean");
});

test("run: 某步抛错即停，后续步骤不再执行，失败步被记录", async () => {
  const order = [];
  const out = await run({ argv: [], env: {}, steps: mockSteps(order, { failAt: "scan" }) });
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, "scan");
  assert.match(String(out.error?.message || out.error), /scan 失败/);
  assert.equal(order.includes("smoke"), false, "scan 之后不得再跑");
  assert.equal(order.includes("pack"), true);
});

test("run: --skip-tests 跳过 test 步骤", async () => {
  const order = [];
  const out = await run({ argv: ["--skip-tests"], env: {}, steps: mockSteps(order) });
  assert.equal(out.ok, true);
  assert.equal(order.includes("test"), false);
  assert.equal(order.includes("validate"), true);
});

test("run: 不给 --bundle 时跳过 bundle 步骤", async () => {
  const order = [];
  const out = await run({ argv: [], env: {}, steps: mockSteps(order) });
  assert.equal(out.ok, true);
  assert.equal(order.includes("bundle"), false);
});

test("buildSummary: 成功契约含全部字段", () => {
  const payload = buildSummary({
    ok: true,
    zip: "release/app-minimax-video-0.3.2.zip",
    bytes: 123,
    sha256: "dead",
    entries: 59,
    entryJson: "release/app-minimax-video-0.3.2.entry.json",
    bundle: "release/minimax-video-0.3.2.bundle",
    bundleSha256: "beef",
    commits: 29,
  });
  assert.deepEqual(Object.keys(payload), [
    "ok", "zip", "bytes", "sha256", "entries", "entryJson", "scan", "bundle", "bundleSha256", "commits",
  ]);
  assert.equal(payload.ok, true);
  assert.equal(payload.scan, "clean");
});
