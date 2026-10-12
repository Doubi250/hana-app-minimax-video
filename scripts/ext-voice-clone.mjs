#!/usr/bin/env node
/**
 * scripts/ext-voice-clone.mjs — 声音克隆的 CLI 出口。
 *
 * 隐藏能力（不注册为模型工具）只经此脚本暴露：读一段样本音，克隆成可复用音色，
 * 并登记进本 App 的音色表。
 *
 * 机器契约（Agent 依赖它）：**stdout 末行严格为单行 JSON**——
 *   成功：{"ok":true,"voice":{"voiceId":"...","label":"..."}}
 *   失败：{"ok":false,"error":{"code":"...","message":"..."}}
 * 其余行是人类可读进度。退出码：成功 0，失败 1。
 *
 * Key 只从 `MINIMAX_API_KEY` 环境变量读取，不落盘、不回显。
 *
 *   PowerShell:  $env:MINIMAX_API_KEY="<你的key>"; node scripts/ext-voice-clone.mjs <sample> --voice-id <id> [--label <名>] [--data-dir <目录>]
 *   bash:        MINIMAX_API_KEY=<你的key> node scripts/ext-voice-clone.mjs <sample> --voice-id <id> [--label <名>] [--data-dir <目录>]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createVoiceCloneExtension, validateSample } from "../lib/extensions/voice-clone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(HERE, ".minimax-data");

const USAGE = [
  "MiniMax 声音克隆 — 把样本音克隆为可复用音色并登记音色表",
  "",
  "用法：",
  "  node scripts/ext-voice-clone.mjs <sample> [--voice-id <id>] [--label <名>] [--data-dir <目录>]",
  "",
  "  PowerShell:  $env:MINIMAX_API_KEY=\"<你的key>\"; node scripts/ext-voice-clone.mjs <sample> --voice-id my-voice",
  "  bash:        MINIMAX_API_KEY=<你的key> node scripts/ext-voice-clone.mjs <sample> --voice-id my-voice",
  "",
  "  sample       样本音频路径（mp3 / m4a / wav，10 秒–5 分钟，≤20MB）",
  "  --voice-id   自定义音色 id（缺省由上传的 file_id 派生）",
  "  --label      音色显示名（缺省等于 voiceId）",
  "  --data-dir   音色表落点（缺省 " + DEFAULT_DATA_DIR + "）",
  "",
  "Key 只从环境变量读取，不落盘、不回显。",
  "stdout 末行为单行 JSON。退出码：0 成功，1 失败。",
].join("\n");

/** 把凭据从任何文本里脱敏——进度行与错误消息都不回显 key。 */
function scrub(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=_-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]");
}

/** 人类进度行：一律走 stdout，末行由 emitResult 单独写 JSON。 */
function log(message) {
  process.stdout.write(`${scrub(message)}\n`);
}

/** 末行契约：单行 JSON，然后设定退出码。 */
function emitResult(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
}

function fail(code, message) {
  emitResult({ ok: false, error: { code, message: scrub(message) } }, 1);
}

/** 解析 `--flag value` 形式的参数；缺值即报 usage。 */
function parseArgs(argv) {
  const opts = { sample: "", voiceId: "", label: "", dataDir: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--voice-id") {
      opts.voiceId = String(argv[++i] ?? "");
    } else if (arg === "--label") {
      opts.label = String(argv[++i] ?? "");
    } else if (arg === "--data-dir") {
      opts.dataDir = String(argv[++i] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数：${arg}`);
    } else {
      rest.push(arg);
    }
  }
  opts.sample = rest[0] ?? "";
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail("usage", `${error?.message || error}\n\n${USAGE}`);
    return;
  }

  if (opts.help || !opts.sample) {
    fail("usage", USAGE);
    return;
  }

  const apiKey = String(process.env.MINIMAX_API_KEY ?? "").trim();
  if (!apiKey) {
    fail("missing_api_key", `缺少 MINIMAX_API_KEY 环境变量。\n\n${USAGE}`);
    return;
  }

  const samplePath = path.resolve(opts.sample);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;

  let bytes;
  try {
    bytes = await fs.promises.readFile(samplePath);
  } catch (error) {
    fail("sample_unreadable", `无法读取样本文件：${samplePath}（${error?.code || error?.message}）`);
    return;
  }

  log(`MiniMax 声音克隆开始`);
  log(`样本：${samplePath}（${bytes.length} 字节）`);
  log(`音色表落点：${dataDir}`);
  log(`key：已从环境变量读取（长度 ${apiKey.length}），不回显`);

  // 本地校验先于任何网络调用：格式 / 时长 / 体积不合法时立刻失败，不碰网络。
  try {
    const validated = validateSample({ fileName: path.basename(samplePath), bytes });
    log(`样本校验通过：${validated.format}，约 ${(validated.durationMs / 1000).toFixed(1)} 秒`);
  } catch (error) {
    fail("invalid_sample", error?.message || String(error));
    return;
  }

  const extension = createVoiceCloneExtension({
    fetch: globalThis.fetch,
    dataDir,
  });

  try {
    const result = await extension.cloneVoice({
      auth: { apiKey },
      bytes,
      fileName: path.basename(samplePath),
      voiceId: opts.voiceId || undefined,
      label: opts.label || undefined,
    });
    log(`克隆完成：${result.voice.voiceId}`);
    emitResult({ ok: true, voice: { voiceId: result.voice.voiceId, label: result.voice.label } }, 0);
  } catch (error) {
    fail("clone_failed", error?.message || String(error));
  }
}

main().catch((error) => {
  fail("unexpected", error?.message || String(error));
});
