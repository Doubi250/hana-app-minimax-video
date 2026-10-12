#!/usr/bin/env node
/**
 * scripts/ext-async-tts.mjs — 长篇异步 TTS 的 CLI 出口（隐藏扩展，非模型工具）。
 *
 * 文本来源：一个文本文件路径，或 `--text "…"`。key **只**从 `MINIMAX_API_KEY` 环境变量读取，
 * 不落盘、不回显。
 *
 *   PowerShell:  $env:MINIMAX_API_KEY="<key>"; node scripts/ext-async-tts.mjs book.txt --subtitle
 *   bash:        MINIMAX_API_KEY=<key> node scripts/ext-async-tts.mjs book.txt --subtitle
 *
 * 机器契约：stdout **末行**严格为单行 JSON。
 *   成功 `{"ok":true,"tasks":[...],"files":[...]}`
 *   失败 `{"ok":false,"error":{"code","message"}}`
 * 退出码：成功 0，失败 1。其余输出为人类可读进度行。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createAsyncTtsExtension,
  ASYNC_TTS_DIRECT_TEXT_MAX_CHARS,
  ASYNC_TTS_SEGMENT_CHARS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
} from "../lib/extensions/async-tts.mjs";
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_FORMAT } from "../lib/speech-api.mjs";

const USAGE = [
  "MiniMax 长篇异步 TTS — CLI",
  "",
  "用法：",
  '  node scripts/ext-async-tts.mjs <文本文件> [选项]',
  '  node scripts/ext-async-tts.mjs --text "要朗读的文本" [选项]',
  "",
  "选项：",
  "  --text <str>            直接给文本（与文本文件二选一）",
  "  --voice-id <id>         音色 id（缺省 male-qn-qingse）",
  "  --model <id>            模型（缺省 speech-2.8-hd）",
  "  --format <fmt>          输出格式 mp3/wav/flac/pcm（缺省 mp3）",
  "  --out-dir <dir>         成品落盘目录（缺省脚本旁 ./minimax-tts-out）",
  "  --subtitle              同时取回 SRT 字幕",
  "  --poll-interval <ms>    轮询间隔（缺省 3000，下界 1000）",
  "  --timeout <ms>          单片轮询总超时（缺省 600000）",
  "  --max-chars <n>         切片字符上限（缺省 20000）",
  "",
  "Key 只从 MINIMAX_API_KEY 环境变量读取，不落盘、不回显。",
].join("\n");

function scrub(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=_-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9]{6,}/g, "[redacted]");
}

/** 解析命令行参数。 */
export function parseArgs(argv = []) {
  const opts = {
    textFile: undefined,
    text: undefined,
    voiceId: undefined,
    model: undefined,
    format: undefined,
    outDir: undefined,
    subtitle: false,
    pollIntervalMs: undefined,
    timeoutMs: undefined,
    maxChars: undefined,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--text":
        opts.text = argv[++i];
        break;
      case "--voice-id":
        opts.voiceId = argv[++i];
        break;
      case "--model":
        opts.model = argv[++i];
        break;
      case "--format":
        opts.format = argv[++i];
        break;
      case "--out-dir":
        opts.outDir = argv[++i];
        break;
      case "--subtitle":
        opts.subtitle = true;
        break;
      case "--poll-interval":
        opts.pollIntervalMs = Number(argv[++i]);
        break;
      case "--timeout":
        opts.timeoutMs = Number(argv[++i]);
        break;
      case "--max-chars":
        opts.maxChars = Number(argv[++i]);
        break;
      default:
        rest.push(arg);
    }
  }
  if (!opts.text && rest.length > 0) opts.textFile = rest[0];
  return opts;
}

function emitJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 可注入的入口（测试用）：返回退出码。
 *
 * @param {object} [deps]
 * @param {string[]} [deps.argv]
 * @param {object}   [deps.env]
 * @param {{write:Function}} [deps.stdout]
 * @param {{write:Function}} [deps.stderr]
 * @param {Function} [deps.fetch]
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const opts = parseArgs(argv);
  const log = (message) => stdout.write(`${scrub(message)}\n`);

  const apiKey = String(env?.MINIMAX_API_KEY ?? "").trim();
  if (!apiKey) {
    stderr.write(`${scrub(`缺少 MINIMAX_API_KEY 环境变量。\n\n${USAGE}`)}\n`);
    emitJson(stdout, { ok: false, error: { code: "MISSING_API_KEY", message: "缺少 MINIMAX_API_KEY 环境变量" } });
    return 1;
  }

  let text = opts.text;
  if (!text && opts.textFile) {
    try {
      text = fs.readFileSync(opts.textFile, "utf-8");
    } catch (error) {
      const message = scrub(`无法读取文本文件 ${opts.textFile}：${error?.message || error}`);
      stderr.write(`${message}\n`);
      emitJson(stdout, { ok: false, error: { code: "TEXT_FILE_UNREADABLE", message } });
      return 1;
    }
  }
  if (typeof text !== "string" || !text.trim()) {
    stderr.write(`${scrub(`未提供文本（文本文件或 --text）。\n\n${USAGE}`)}\n`);
    emitJson(stdout, { ok: false, error: { code: "NO_TEXT", message: "未提供文本（文本文件或 --text）" } });
    return 1;
  }

  const outDir = opts.outDir || path.join(process.cwd(), "minimax-tts-out");

  try {
    const extension = createAsyncTtsExtension({ fetch: fetchImpl, auth: { apiKey } });
    const result = await extension.runJob({
      text,
      model: opts.model || DEFAULT_TTS_MODEL,
      voiceId: opts.voiceId,
      format: opts.format || DEFAULT_TTS_FORMAT,
      subtitleEnable: opts.subtitle === true,
      maxChars: Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : ASYNC_TTS_SEGMENT_CHARS,
      directTextMaxChars: ASYNC_TTS_DIRECT_TEXT_MAX_CHARS,
      pollIntervalMs: Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_POLL_TIMEOUT_MS,
      outDir,
      logger: log,
    });

    if (result.ok) {
      emitJson(stdout, { ok: true, tasks: result.tasks, files: result.files });
      return 0;
    }
    emitJson(stdout, {
      ok: false,
      error: {
        code: String(result.error?.code ?? "JOB_FAILED"),
        message: scrub(result.error?.message ?? "异步 TTS 作业失败"),
      },
      tasks: result.tasks,
      files: result.files,
    });
    return 1;
  } catch (error) {
    emitJson(stdout, {
      ok: false,
      error: {
        code: String(error?.code ?? "UNEXPECTED_ERROR"),
        message: scrub(error?.message || String(error)),
      },
    });
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${scrub(`异步 TTS CLI 崩溃：${error?.message || error}`)}\n`);
      process.exitCode = 1;
    });
}
