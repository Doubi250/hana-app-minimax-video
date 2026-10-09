#!/usr/bin/env node
/**
 * scripts/fetch-task.mjs — fetch one existing MiniMax video task and land its mp4.
 *
 * Use case: recover the artefact of a task that already finished remotely but
 * whose bytes never made it to disk (e.g. a known `task_id`).
 *
 * Reads the key from `MINIMAX_API_KEY` only: never from a file, never echoed,
 * never written anywhere. Missing key or argument → usage + exit 1.
 *
 *   PowerShell:  $env:MINIMAX_API_KEY="<你的key>"; node scripts/fetch-task.mjs <taskId> [outPath]
 *   bash:        MINIMAX_API_KEY=<你的key> node scripts/fetch-task.mjs <taskId> [outPath]
 *
 * Exit codes: 0 succeeded & downloaded, 1 usage / query error, 2 not ready or failed.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { API_BASE_URL, QUERY_PATH_PREFIX } from "../lib/minimax-api.mjs";
import { createMinimaxClient, downloadToFile } from "../lib/minimax-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "MiniMax 视频生成 — 找回已有任务",
  "",
  "用法：",
  "  node scripts/fetch-task.mjs <taskId> [outPath]",
  "",
  "  PowerShell:  $env:MINIMAX_API_KEY=\"<你的key>\"; node scripts/fetch-task.mjs <taskId> [outPath]",
  "  bash:        MINIMAX_API_KEY=<你的key> node scripts/fetch-task.mjs <taskId> [outPath]",
  "",
  "  taskId   远端任务 id（必填）",
  "  outPath  输出路径（可选，默认 scripts/minimax-task-<taskId>.mp4）",
  "",
  "Key 只从环境变量读取，不落盘、不回显。",
  "",
  "退出码：0 已下载；1 用法/查询错误；2 未完成或已失败。",
].join("\n");

function scrub(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=_-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}

function log(message) {
  process.stdout.write(`${scrub(message)}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`${scrub(message)}\n`);
  process.exit(code);
}

async function main() {
  const taskId = String(process.argv[2] ?? "").trim();
  if (!taskId) {
    die(USAGE);
  }

  const apiKey = String(process.env.MINIMAX_API_KEY ?? "").trim();
  if (!apiKey) {
    die(`缺少 MINIMAX_API_KEY 环境变量。\n\n${USAGE}`);
  }

  const outArg = String(process.argv[3] ?? "").trim();
  const outPath = outArg
    ? path.resolve(outArg)
    : path.join(HERE, `minimax-task-${taskId}.mp4`);

  log(`查询任务 ${taskId}（base=${API_BASE_URL}${QUERY_PATH_PREFIX}）`);
  log(`key: 已从环境变量读取（长度 ${apiKey.length}），不回显`);

  // Standalone process: the global fetch is unrestricted here, so inject it.
  const client = createMinimaxClient({ fetch: globalThis.fetch });

  let task;
  try {
    task = await client.queryTask({ apiKey, taskId });
  } catch (error) {
    die(`查询任务失败：${error?.message || error}`);
  }

  if (task.mapped === "success") {
    if (!task.url) {
      die(`任务已完成但未返回视频地址（status=${task.status}）`);
    }
    const partPath = `${outPath}.part`;
    let bytes;
    try {
      bytes = await downloadToFile({ fetch: globalThis.fetch, url: task.url, partPath });
      await fs.promises.rename(partPath, outPath);
    } catch (error) {
      die(`下载视频失败：${error?.message || error}`);
    }
    if (!fs.existsSync(outPath)) {
      die(`下载结束但文件不存在：${outPath}`);
    }
    log(`完成：${outPath}`);
    log(`大小：${bytes} 字节`);
    return;
  }

  if (task.mapped === "failed") {
    die(`任务失败：${task.failReason || task.status}`, 2);
  }

  // mapped === "pending" (queued / running / created / unknown)
  die(`任务尚未完成（status=${task.status || "unknown"}），请稍后重试。`, 2);
}

main().catch((error) => {
  die(`执行失败：${error?.message || error}`);
});
