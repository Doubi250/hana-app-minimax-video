#!/usr/bin/env node
/**
 * scripts/pack-release.mjs — 把发版流程固化成一条命令。
 *
 * WHY THIS EXISTS
 *   发版流程过去手动重复了 5 次，每一步都有踩过的坑：
 *     1. **绝不从 worktree / 克隆目录直接打包**——worktree 的 `.git` 是携带本机绝对路径
 *        的指针文件，`git ls-files` 不收录、`check-clean`（tracked-only）漏过、packer 却
 *        会把它打进包。唯一正确做法是 `git archive` 导出仅 tracked 文件再展开打包。
 *     2. PowerShell 下 `git archive | tar -x` 的管道会破坏二进制流——必须先 `-o` 落文件
 *        再 `tar -xf`。
 *   本脚本把整条配方固化成一条命令，让这些陷阱从「文档警告」变成「结构上不可能」。
 *
 * PIPELINE（每步失败即退出非零，并打印失败步）
 *   preflight → archive → test → validate → pack → scan → smoke → bundle
 *
 * 用法：
 *   node scripts/pack-release.mjs [--ref <ref>] [--out <dir>] [--tools-root <dir>]
 *                                 [--bundle] [--bundle-base <ref>] [--skip-tests]
 *
 *   --ref        要发布的 ref（缺省 HEAD）
 *   --out        产物落点（缺省 ./release）
 *   --tools-root 宿主工具根（缺省 env HANA_APP_TOOLS_ROOT，否则 {HANA_HOME}/artifacts/server
 *                下最新版本目录；须含 scripts/validate-app.mjs 与 scripts/extension-pack.mjs）
 *   --bundle     同时导出 git bundle（base = --bundle-base，缺省 0696115）
 *   --skip-tests 跳过干净副本上的 node --test
 *
 * 机器契约（与其它 CLI 一致）：stdout **末行**严格为单行 JSON。
 *   成功：{"ok":true,"zip":…,"bytes":…,"sha256":…,"entries":…,"entryJson":…,"scan":"clean",
 *          "bundle":…,"bundleSha256":…,"commits":N}
 *   失败：{"ok":false,"failedStep":"…","error":{"code":"…","message":"…"}}
 * 退出码：成功 0，失败 1。其余输出为人类可读进度行，全程经 scrub 脱敏。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scrub } from "../lib/http-util.mjs";

export { scrub };

const ALLOW_MARKER = "check-clean:allow";
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 泄漏规则——与 `scripts/check-clean.mjs` 的探测器同源，但**刻意剔除** `.hanako/` // check-clean:allow — 说明被剔除的规则本身，非本机路径。
 * 目录规则（`hanako-home-path`）：宿主主目录约定（`~/.hanako`、`{HANA_HOME}`）是合法
 * 代码/文档对约定的引用，不是本机绝对路径泄漏；发布扫描对它零命中即可，若照搬会误伤
 * 8 处合法字面量。其余规则逐条对齐；宿主主目录约定不是泄漏。
 */
const PATTERNS = [
  { id: "windows-user-path", re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/i },
  { id: "openhanako-checkout", re: /[A-Za-z]:[\\/]{1,2}Openhanako\b/i },
  { id: "appdata-path", re: /AppData[\\/]/i },
  { id: "api-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { id: "github-token", re: /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "jwt", re: /eyJ[A-Za-z0-9_-]{20,}/ },
  { id: "private-key-header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "bearer-token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{30,}/ },
];

/** 工具根必须同时存在的脚本（校验器兼容连字符/下划线两种宿主命名）。 */
const TOOL_VALIDATE_NAMES = ["validate-app.mjs", "validate_app.mjs"];
const TOOL_PACK_NAME = "extension-pack.mjs";

const DEFAULT_BUNDLE_BASE = "0696115";

/* ------------------------------------------------------------------ *
 * CLI 参数
 * ------------------------------------------------------------------ */

export function parseArgs(argv = []) {
  const opts = {
    ref: "HEAD",
    out: "release",
    toolsRoot: undefined,
    bundle: false,
    bundleBase: DEFAULT_BUNDLE_BASE,
    skipTests: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--ref":
        opts.ref = String(argv[++i] ?? "");
        break;
      case "--out":
        opts.out = String(argv[++i] ?? "");
        break;
      case "--tools-root":
        opts.toolsRoot = String(argv[++i] ?? "");
        break;
      case "--bundle":
        opts.bundle = true;
        break;
      case "--bundle-base":
        opts.bundleBase = String(argv[++i] ?? "");
        break;
      case "--skip-tests":
        opts.skipTests = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * 工具根解析：--tools-root > env HANA_APP_TOOLS_ROOT > 目录发现
 * ------------------------------------------------------------------ */

/** 提取 `1.2.3` 形态的版本键，用于候选目录降序。 */
function versionKey(name) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(name));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compareVersionDesc(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return String(b).localeCompare(String(a));
}

function hasTools(root, io) {
  const scriptsDir = path.join(root, "scripts");
  const hasValidate = TOOL_VALIDATE_NAMES.some((n) => io.existsSync(path.join(scriptsDir, n)));
  const hasPack = io.existsSync(path.join(scriptsDir, TOOL_PACK_NAME));
  return hasValidate && hasPack;
}

/**
 * 解析工具根。
 *
 * 优先级：显式参数 > env.HANA_APP_TOOLS_ROOT > `{HANA_HOME}/artifacts/server/*` 最新版本
 * 目录。被选中的目录必须含校验器与打包器脚本，否则继续（发现模式下）或报错（显式给定）。
 * 找不到时抛错并列出**已试路径**。
 */
export function resolveToolsRoot({ toolsRoot, env = process.env, fs: io = fs } = {}) {
  const tried = [];
  const explicit = String(toolsRoot ?? "").trim();
  if (explicit) {
    tried.push(explicit);
    if (hasTools(explicit, io)) return explicit;
    throw new Error(
      `指定的 --tools-root 不含所需脚本（${TOOL_VALIDATE_NAMES[0]} 与 ${TOOL_PACK_NAME}）。\n已试路径：\n${tried.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const envRoot = String(env?.HANA_APP_TOOLS_ROOT ?? "").trim();
  if (envRoot) {
    tried.push(envRoot);
    if (hasTools(envRoot, io)) return envRoot;
  }

  const home = String(env?.HANA_HOME ?? "").trim() || path.join(String(os.homedir()), ".hanako");
  const serverDir = path.join(home, "artifacts", "server");
  tried.push(serverDir);
  let candidates = [];
  try {
    candidates = io.readdirSync(serverDir);
  } catch {
    candidates = [];
  }
  candidates.sort(compareVersionDesc);
  for (const name of candidates) {
    const root = path.join(serverDir, name);
    tried.push(root);
    if (hasTools(root, io)) return root;
  }

  throw new Error(
    `未找到工具根（须含 scripts/${TOOL_VALIDATE_NAMES[0]} 与 scripts/${TOOL_PACK_NAME}）。\n` +
      `已试路径：\n${tried.map((p) => `  - ${p}`).join("\n")}`,
  );
}

/* ------------------------------------------------------------------ *
 * 泄漏扫描：文本行 + zip 条目
 * ------------------------------------------------------------------ */

/** 扫描一行文本；命中 `check-clean:allow`（本行或上一行）即整行豁免。返回 [{id}]。 */
export function scanText(line, prevLine = "") {
  const text = String(line ?? "");
  if (text.includes(ALLOW_MARKER) || String(prevLine ?? "").includes(ALLOW_MARKER)) return [];
  const hits = [];
  for (const { id, re } of PATTERNS) {
    if (re.test(text)) hits.push({ id });
  }
  return hits;
}

/** 把条目内容统一成 Buffer。 */
function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(String(content ?? ""), "utf8");
}

/**
 * 严格扫描一组 zip 条目（`[{name, content}]`）。规则：
 *   文本规则同 scanText；`.git` / `.sdk` 路径段直接判负；二进制内容跳过（与 check-clean 一致）。
 * 返回 [{file, line, id}]（条目级命中 line 为 0）。
 */
export function scanZipEntries(entries = []) {
  const findings = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? "");
    const segments = name.split(/[\\/]/);
    if (segments.includes(".git")) findings.push({ file: name, line: 0, id: "git-entry" });
    if (segments.includes(".sdk")) findings.push({ file: name, line: 0, id: "sdk-entry" });

    const buf = toBuffer(entry?.content);
    if (buf.length > MAX_SCAN_FILE_BYTES) continue;
    if (buf.subarray(0, 8000).includes(0)) continue; // 二进制
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const hit of scanText(lines[i], i > 0 ? lines[i - 1] : "")) {
        findings.push({ file: name, line: i + 1, id: hit.id });
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * 最小 ZIP 读取（中央目录 + 本地头 + inflateRaw），供 scan 步骤用
 * ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 从 buffer 读出中央目录条目并解压为 [{name, content(Buffer)}]。 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip：未找到中央目录结束记录");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const content = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    entries.push({ name, content });

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * 结果汇总与末行契约
 * ------------------------------------------------------------------ */

/** 构造成功汇总，键序固定。 */
export function buildSummary({
  ok = true,
  zip = null,
  bytes = null,
  sha256 = null,
  entries = null,
  entryJson = null,
  scan = "clean",
  bundle = null,
  bundleSha256 = null,
  commits = null,
} = {}) {
  return { ok, zip, bytes, sha256, entries, entryJson, scan, bundle, bundleSha256, commits };
}

/** 单行 JSON 出栈：serialize → scrub。 */
function emit(stream, payload) {
  stream.write(`${scrub(JSON.stringify(payload))}\n`);
}

/* ------------------------------------------------------------------ *
 * 真实步骤实现
 * ------------------------------------------------------------------ */

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw Object.assign(new Error(`git ${args[0]} 失败（退出码 ${res.status}）：${(res.stderr || res.stdout || "").trim()}`), {
      code: "GIT_FAILED",
      stderr: res.stderr,
      stdout: res.stdout,
    });
  }
  return res.stdout;
}

/**
 * 跑一个 Node 子进程（校验器 / 打包器 / 测试）。用 spawnSync 而非 execFileSync：
 * 非零退出时 execFileSync 会抱走 stdout，而失败原因（尤其校验器的末行 JSON）就在那里。
 * 这里把已捕获的 stdout/stderr 挂在 error 上，交给上层失败报告打印。
 * 返回 {status, stdout, stderr}；调用方决定非零是否致命。
 */
function runNode(scriptPath, args, { cwd, env }) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 从捕获输出里取末行 JSON（校验器契约）；取不到返回 null。 */
function lastJson(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 解析冒烟用的 Node 运行时：env.HANA_NODE_RUNTIME > `{HANA_HOME}/.cache/node-runtime/*`
 * 下任一 node 可执行文件（宿主工具会自己找精确版本，透明即可）。找不到返回 undefined，
 * 交由宿主自己报 SMOKE_NODE_RUNTIME_UNAVAILABLE。
 */
export function resolveNodeRuntime({ env = process.env, fs: io = fs, homedir = os.homedir } = {}) {
  const explicit = String(env?.HANA_NODE_RUNTIME ?? "").trim();
  if (explicit) return explicit;
  const home = String(env?.HANA_HOME ?? "").trim() || path.join(String(homedir()), ".hanako");
  const root = path.join(home, ".cache", "node-runtime");
  let dirs = [];
  try {
    dirs = io.readdirSync(root).sort(compareVersionDesc);
  } catch {
    return undefined;
  }
  for (const name of dirs) {
    const exe = process.platform === "win32"
      ? path.join(root, name, "node.exe")
      : path.join(root, name, "bin", "node");
    if (io.existsSync(exe)) return exe;
  }
  return undefined;
}

/** 递归判断目录下是否含名为 `.git` 的条目。 */
function containsGitEntry(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (item.name === ".git") return true;
      if (item.isDirectory()) stack.push(path.join(current, item.name));
    }
  }
  return false;
}

/** 真实步骤集合。每个步骤拿到共享 ctx，返回合并进 ctx 的局部结果。 */
function realSteps({ cwd, stdout }) {
  const log = (message) => stdout.write(`${scrub(message)}\n`);

  return {
    async preflight(ctx) {
      const { opts } = ctx;
      // ref 存在性
      const sha = git(["rev-parse", "--verify", `${opts.ref}^{commit}`], cwd).trim();
      // 工作树干净：不得有已跟踪/已暂存改动（未跟踪 ?? 允许，产物目录被 gitignore）。
      const porcelain = git(["status", "--porcelain", "--untracked-files=no"], cwd);
      const dirty = porcelain.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (dirty.length) {
        throw Object.assign(new Error(`工作树不干净，先提交或 stash：\n${dirty.join("\n")}`), {
          code: "DIRTY_WORKTREE",
        });
      }
      const manifest = JSON.parse(git(["show", `${opts.ref}:manifest.json`], cwd));
      log(`preflight：${opts.ref} = ${sha.slice(0, 12)}，id=${manifest.id} version=${manifest.version}`);
      return { ref: opts.ref, sha, id: manifest.id, version: manifest.version };
    },

    async archive(ctx) {
      const { opts, id } = ctx;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mms-pack-"));
      const tarPath = path.join(tmpDir, "archive.tar");
      // 先落文件再解压——禁止管道（PowerShell 管道会破坏二进制流）。
      git(["archive", "--format=tar", "-o", tarPath, opts.ref], cwd);
      const cleanCopy = path.join(tmpDir, id);
      fs.mkdirSync(cleanCopy, { recursive: true });
      const tarRes = spawnSync("tar", ["-xf", tarPath, "-C", cleanCopy], { encoding: "utf8" });
      if (tarRes.status !== 0) {
        throw Object.assign(new Error(`tar 解档失败（退出码 ${tarRes.status}）：${(tarRes.stderr || "").trim()}`), {
          code: "TAR_FAILED",
        });
      }
      if (containsGitEntry(cleanCopy)) {
        throw Object.assign(new Error(`干净副本内出现 .git（archive 泄漏）：${cleanCopy}`), {
          code: "CLEAN_COPY_HAS_GIT",
        });
      }
      log(`archive：干净副本 ${cleanCopy}（无 .git）`);
      return { tmpDir, cleanCopy };
    },

    async test(ctx) {
      const { cleanCopy } = ctx;
      const res = spawnSync(process.execPath, ["--test"], {
        cwd: cleanCopy,
        env: { ...process.env },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (res.status !== 0) {
        const tail = String(res.stdout ?? "")
          .split(/\r?\n/)
          .filter((l) => /tests |pass |fail /.test(l));
        throw Object.assign(new Error(`干净副本 node --test 未全绿：${tail.join(" ")}`), {
          code: "TESTS_FAILED",
          stdout: res.stdout,
        });
      }
      log(`test：干净副本 node --test 全绿`);
      return {};
    },

    async validate(ctx) {
      const { opts, env, cleanCopy } = ctx;
      const toolsRoot = resolveToolsRoot({ toolsRoot: opts.toolsRoot, env });
      const validateScript = TOOL_VALIDATE_NAMES.map((n) => path.join(toolsRoot, "scripts", n)).find((p) =>
        fs.existsSync(p),
      );
      const res = runNode(validateScript, ["--dir", cleanCopy, "--json"], { cwd, env });
      const report = lastJson(res.stdout);
      const errors = report?.summary?.errors ?? (report?.ok === true ? 0 : 1);
      if (res.status !== 0 || errors > 0) {
        throw Object.assign(
          new Error(
            `validate 未通过（退出码 ${res.status}，${errors} error）：${JSON.stringify(report?.issues ?? res.stderr)}`,
          ),
          { code: "VALIDATE_FAILED", report },
        );
      }
      log(`validate：--dir 校验 0 error`);
      return { toolsRoot, validateScript };
    },

    async pack(ctx) {
      const { opts, env, toolsRoot, cleanCopy, id, version } = ctx;
      const outDir = path.resolve(cwd, opts.out);
      fs.mkdirSync(outDir, { recursive: true });
      const packScript = path.join(toolsRoot, "scripts", TOOL_PACK_NAME);
      const res = runNode(
        packScript,
        ["--kind", "app", "--dir", cleanCopy, "--publisher", "Doubi250", "--out", outDir],
        { cwd, env },
      );
      if (res.status !== 0) {
        throw Object.assign(
          new Error(`打包器失败（退出码 ${res.status}）：${(res.stderr || res.stdout || "").trim()}`),
          { code: "PACK_FAILED" },
        );
      }
      const zip = path.join(outDir, `app-${id}-${version}.zip`);
      const entryJson = path.join(outDir, `app-${id}-${version}.entry.json`);
      if (!fs.existsSync(zip)) throw Object.assign(new Error(`打包器未产出预期 zip：${zip}`), { code: "PACK_MISSING_ZIP" });
      const zipBytes = fs.readFileSync(zip);
      const sha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
      log(`pack：${zip}（${zipBytes.length} B，sha256 ${sha256.slice(0, 12)}…）`);
      return { zip, entryJson, bytes: zipBytes.length, sha256 };
    },

    async scan(ctx) {
      const { zip } = ctx;
      const entries = readZipEntries(fs.readFileSync(zip));
      const findings = scanZipEntries(entries);
      if (findings.length) {
        const rendered = findings.map((f) => `${f.file}:${f.line}  [${f.id}]`).join("\n");
        throw Object.assign(new Error(`严格扫描命中 ${findings.length} 处：\n${rendered}`), { code: "SCAN_HIT" });
      }
      log(`scan：${entries.length} 条目，clean`);
      return { scan: "clean", entries: entries.length };
    },

    async smoke(ctx) {
      const { env, validateScript, zip } = ctx;
      // 冒烟需要宿主运行时（Node ≥26）；env.HANA_NODE_RUNTIME 优先，否则找平台缓存运行时。
      const nodeRuntime = resolveNodeRuntime({ env });
      const smokeEnv = nodeRuntime ? { ...env, HANA_NODE_RUNTIME: nodeRuntime } : { ...env };
      const res = runNode(validateScript, ["--archive", zip, "--smoke", "--json"], { cwd, env: smokeEnv });
      const report = lastJson(res.stdout);
      if (res.status !== 0 || report?.ok !== true) {
        const detail = report?.issues ? JSON.stringify(report.issues) : (res.stderr || res.stdout || "").trim();
        throw Object.assign(new Error(`smoke 未通过（退出码 ${res.status}）：${detail}`), {
          code: "SMOKE_FAILED",
          report,
        });
      }
      log(`smoke：ok`);
      return {};
    },

    async bundle(ctx) {
      const { opts, id, version } = ctx;
      const outDir = path.resolve(cwd, opts.out);
      const range = `${opts.bundleBase}..${opts.ref}`;
      const commits = Number(git(["rev-list", "--count", range], cwd).trim());
      const bundlePath = path.join(outDir, `${id}-${version}.bundle`);
      git(["bundle", "create", bundlePath, range], cwd);
      git(["bundle", "verify", bundlePath], cwd);
      const bundleSha256 = crypto.createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
      log(`bundle：${bundlePath}（${commits} 提交）`);
      return { bundle: bundlePath, bundleSha256, commits };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 按序执行步骤。`steps` 可注入（测试用）；缺省走真实实现。
 * 某步抛错即停，返回 {ok:false, failedStep, error}。
 */
export async function run({ argv = [], env = process.env, steps, cwd = process.cwd(), stdout = process.stdout } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) return { ok: false, failedStep: "usage", error: { code: "USAGE", message: usage() } };

  const order = [
    "preflight",
    "archive",
    ...(opts.skipTests ? [] : ["test"]),
    "validate",
    "pack",
    "scan",
    "smoke",
    ...(opts.bundle ? ["bundle"] : []),
  ];
  const impl = steps ?? realSteps({ cwd, stdout });
  const ctx = { opts, env };

  for (const name of order) {
    const step = impl[name];
    if (typeof step !== "function") {
      return { ok: false, failedStep: name, error: { code: "NO_STEP", message: `缺少步骤实现：${name}` } };
    }
    try {
      const partial = await step(ctx, { log: (m) => stdout.write(`${scrub(m)}\n`) });
      if (partial && typeof partial === "object") Object.assign(ctx, partial);
    } catch (error) {
      return {
        ok: false,
        failedStep: name,
        error: {
          code: String(error?.code ?? "STEP_FAILED"),
          message: scrub(error?.message || String(error)),
        },
      };
    }
  }
  ctx.ok = true;
  return ctx;
}

function usage() {
  return [
    "node scripts/pack-release.mjs [--ref <ref>] [--out <dir>] [--tools-root <dir>] [--bundle] [--bundle-base <ref>] [--skip-tests]",
    "  --ref         要发布的 ref（缺省 HEAD）",
    "  --out         产物落点（缺省 ./release）",
    "  --tools-root  宿主工具根（缺省 env HANA_APP_TOOLS_ROOT，否则 HANA_HOME/artifacts/server 下最新版本目录）",
    "  --bundle      同时导出 git bundle（base = --bundle-base，缺省 0696115）",
    "  --skip-tests  跳过干净副本上的 node --test",
  ].join("\n");
}

/** 可注入的入口（测试/复用）：返回退出码。 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  steps,
} = {}) {
  const result = await run({ argv, env, steps, stdout });
  if (result.ok) {
    emit(stdout, buildSummary(result));
    return 0;
  }
  if (result.failedStep === "usage") {
    stderr.write(`${scrub(result.error.message)}\n`);
  }
  emit(stdout, { ok: false, failedStep: result.failedStep, error: result.error });
  return 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${scrub(`pack-release 崩溃：${error?.message || error}`)}\n`);
      process.exitCode = 1;
    });
}
