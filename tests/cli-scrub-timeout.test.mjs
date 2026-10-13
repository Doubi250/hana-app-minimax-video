/**
 * tests/cli-scrub-timeout.test.mjs — `node --test tests/cli-scrub-timeout.test.mjs`
 *
 * 两个 CLI 出口（`scripts/ext-voice-clone.mjs` / `scripts/ext-async-tts.mjs`）与两个
 * 批处理脚本（`scripts/fetch-task.mjs` / `scripts/smoke.mjs`）的两条收口断言：
 *
 *   A. 脱敏只有一个真源——四个脚本导入的 `scrub` 必须是 `lib/http-util.mjs` 的**同一个
 *      函数引用**，且旧的本地实现确实已删除。本地副本曾各自用不同正则，其中一个
 *      （`\bsk-[A-Za-z0-9]{6,}`）漏掉 `-` 与 `_`，是真实的密钥泄漏口。
 *   B. 原生 `fetch` 不识别宿主私有的 `timeoutMs`：CLI 必须用 `AbortSignal` 兑现真实
 *      超时，否则网络假死即永久阻塞。
 *
 * 全部离线：不触碰网络，`globalThis.fetch` 不被调用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scrub } from "../lib/http-util.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(appRoot, "scripts");

/** 四个曾各带本地 scrub 的脚本。 */
const SCRUB_SCRIPTS = ["ext-voice-clone.mjs", "ext-async-tts.mjs", "fetch-task.mjs", "smoke.mjs"];

async function readScript(name) {
  return fs.readFile(path.join(scriptsDir, name), "utf8");
}

/* ---------------------------------------------------------------- *
 * A. 脱敏单源化
 * ---------------------------------------------------------------- */

test("A1: 四个脚本都从 lib/http-util.mjs 导入 scrub，且不再自带本地实现", async () => {
  for (const name of SCRUB_SCRIPTS) {
    const source = await readScript(name);
    assert.match(
      source,
      /import\s*\{\s*scrub\s*\}\s*from\s*"\.\.\/lib\/http-util\.mjs"/,
      `${name} 必须从 ../lib/http-util.mjs 导入 scrub`,
    );
    assert.doesNotMatch(
      source,
      /function\s+scrub\s*\(/,
      `${name} 不得再定义本地 scrub（唯一真源在 lib/http-util.mjs）`,
    );
    assert.doesNotMatch(source, /sk-\[redacted\]/, `${name} 不得保留旧的替换串`);
  }
});

test("A2: 四个脚本用到的 scrub 与 lib/http-util.mjs 是同一个函数引用", async () => {
  // 两个 CLI 都是可导入模块；它们各自导出的 `scrub` 若能取到，必须 === 共享实现。
  const { scrub: fromVoiceClone } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );
  const { scrub: fromAsyncTts } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-async-tts.mjs")).href
  );
  assert.equal(typeof fromVoiceClone, "function");
  assert.equal(typeof fromAsyncTts, "function");
  assert.equal(fromVoiceClone, scrub, "ext-voice-clone 的 scrub 必须就是共享实现的同一引用");
  assert.equal(fromAsyncTts, scrub, "ext-async-tts 的 scrub 必须就是共享实现的同一引用");

  // fetch-task / smoke 顶层即跑网络流程，不能 import；静态确认其导入源是共享模块，
  // 且模块内不再有本地定义（A1 已断言）。
  for (const name of ["fetch-task.mjs", "smoke.mjs"]) {
    const source = await readScript(name);
    assert.match(source, /import\s*\{\s*scrub\s*\}\s*from\s*"\.\.\/lib\/http-util\.mjs"/);
  }
});

test("A3: 含 - 与 _ 的 sk- 形态文本被完全屏蔽（旧正则的漏洞）", () => {
  const secret = "sk-ab-cd_ef-123456";
  const redacted = scrub(`请求失败：key=${secret} 已拒绝`);

  assert.equal(redacted.includes(secret), false, "含 -/_ 的 key 不得原样出现在输出里");
  assert.match(redacted, /\[redacted\]/);
  assert.equal(redacted, "请求失败：key=[redacted] 已拒绝");

  // 旧的漏洞正则会漏掉这一段——固化断言，防止回退。
  const leakyPattern = /\bsk-[A-Za-z0-9]{6,}/;
  assert.equal(leakyPattern.test(secret), false, "旧正则确实漏掉 - / _，故单源化是必要的");
});

test("A4: 四个脚本对外可见的脱敏行为一致（同一引用即同一结果）", async () => {
  const { scrub: fromVoiceClone } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );
  const { scrub: fromAsyncTts } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-async-tts.mjs")).href
  );
  const samples = [
    "key=sk-ab-cd_ef-123456",
    // check-clean:allow —— 合成的假 Bearer 样本，用来断言脱敏结果，不是真凭据。
    "Authorization: Bearer eyJhbGciOi.payload_part.sig-here",
    "普通错误信息",
    "key=sk-短",
  ];
  for (const sample of samples) {
    assert.equal(fromVoiceClone(sample), scrub(sample), `样本输出不一致：${sample}`);
    assert.equal(fromAsyncTts(sample), scrub(sample), `样本输出不一致：${sample}`);
  }
});

/* ---------------------------------------------------------------- *
 * B. 真实超时（AbortSignal）
 * ---------------------------------------------------------------- */

test("B1: withTimeout 包装后发出的 init.signal 是 AbortSignal", async () => {
  const { withTimeout } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200 };
  };
  const wrapped = withTimeout(fakeFetch, 30000);

  await wrapped("https://api.example.com/x", { method: "GET", timeoutMs: 1234 });

  assert.equal(seen.length, 1);
  assert.ok(seen[0].init.signal instanceof AbortSignal, "必须注入 AbortSignal");
  assert.equal(seen[0].init.timeoutMs, 1234, "timeoutMs 仍透传给宿主实现");
});

test("B2: timeoutMs = 1234 时信号在约 1.2 秒内中止", async () => {
  const { withTimeout } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );

  let captured;
  const neverResolves = (url, init) => {
    captured = init;
    return new Promise(() => {}); // 模拟假死
  };
  const wrapped = withTimeout(neverResolves, 30000);

  const started = Date.now();
  const pending = wrapped("https://api.example.com/slow", { timeoutMs: 1200 });
  pending.catch(() => {}); // 只关心信号的 abort 事件

  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.signal.aborted, false);

  await new Promise((resolve) => {
    captured.signal.addEventListener("abort", resolve, { once: true });
  });

  const elapsed = Date.now() - started;
  assert.equal(captured.signal.aborted, true);
  assert.ok(elapsed >= 900 && elapsed < 5000, `应在 ~1.2s 处中止，实测 ${elapsed}ms`);
});

test("B3: 已提供的外部 signal 优先，不被覆盖", async () => {
  const { withTimeout } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );
  const external = new AbortController();
  let captured;
  const fakeFetch = async (url, init) => {
    captured = init;
    return { ok: true, status: 200 };
  };
  const wrapped = withTimeout(fakeFetch, 30000);

  await wrapped("https://api.example.com/x", { signal: external.signal });
  assert.equal(captured.signal, external.signal, "外部 signal 必须优先");
});

test("B4: 缺省与非法 timeoutMs 回落 30000", async () => {
  const { withTimeout } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-voice-clone.mjs")).href
  );
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(init);
    return { ok: true, status: 200 };
  };
  const wrapped = withTimeout(fakeFetch, 30000);

  await wrapped("https://api.example.com/a", {});
  await wrapped("https://api.example.com/b", { timeoutMs: -1 });
  await wrapped("https://api.example.com/c", { timeoutMs: "nope" });

  for (const init of seen) {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false, "缺省 30s 不应立即中止");
  }
});

test("B5: ext-async-tts 的 withTimeout 与 ext-voice-clone 行为一致", async () => {
  const { withTimeout } = await import(
    pathToFileURL(path.join(scriptsDir, "ext-async-tts.mjs")).href
  );
  let captured;
  const fakeFetch = async (url, init) => {
    captured = init;
    return { ok: true, status: 200 };
  };
  await withTimeout(fakeFetch, 30000)("https://api.example.com/x", { method: "POST", timeoutMs: 2222 });
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.method, "POST");
  assert.equal(captured.timeoutMs, 2222);
});

test("B6: CLI 组装扩展时把 withTimeout 接到 fetch 注入点", async () => {
  const voiceClone = await readScript("ext-voice-clone.mjs");
  const asyncTts = await readScript("ext-async-tts.mjs");
  assert.match(voiceClone, /fetch:\s*withTimeout\(globalThis\.fetch\)/, "ext-voice-clone 必须包装 fetch");
  assert.match(asyncTts, /fetch:\s*withTimeout\(fetchImpl\)/, "ext-async-tts 必须包装 fetch");
});
