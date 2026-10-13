#!/usr/bin/env node
/**
 * scripts/smoke.mjs — standalone end-to-end smoke test for the MiniMax video provider.
 *
 * Reads the key from `MINIMAX_API_KEY` only: never from a file, never echoed,
 * never written anywhere. Missing key → usage + exit 1.
 *
 *   PowerShell:  $env:MINIMAX_API_KEY="<你的key>"; node scripts/smoke.mjs
 *   bash:        MINIMAX_API_KEY=<你的key> node scripts/smoke.mjs
 *
 * Flow: create task → poll → download the finished mp4 next to this script.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  API_BASE_URL,
  CREATE_PATH,
  QUERY_PATH_PREFIX,
  MODEL_SPECS,
  buildCreateRequestBody,
} from "../lib/minimax-api.mjs";
import { scrub } from "../lib/http-util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const JSON_MAX_BYTES = 8 * 1024 * 1024;

const PROMPT = "一只小猫在阳光下打盹，毛发清晰，镜头缓慢推进";
const MODEL_ID = "MiniMax-H3";

const USAGE = [
  "MiniMax 视频生成 — 冒烟脚本",
  "",
  "用法：",
  '  PowerShell:  $env:MINIMAX_API_KEY="<你的key>"; node scripts/smoke.mjs',
  "  bash:        MINIMAX_API_KEY=<你的key> node scripts/smoke.mjs",
  "",
  "Key 只从环境变量读取，不落盘、不回显。",
].join("\n");

function log(message) {
  process.stdout.write(`${scrub(message)}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`${scrub(message)}\n`);
  process.exit(code);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiMessage(status, text) {
  const json = parseJson(text);
  const detail =
    json?.error?.message || json?.message || json?.base_resp?.status_msg || text.trim().slice(0, 400);
  return `HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

async function main() {
  const apiKey = String(process.env.MINIMAX_API_KEY ?? "").trim();
  if (!apiKey) {
    die(`缺少 MINIMAX_API_KEY 环境变量。\n\n${USAGE}`);
  }

  log(`MiniMax 冒烟开始（model=${MODEL_ID}, base=${API_BASE_URL}）`);
  log(`key: 已从环境变量读取（长度 ${apiKey.length}），不回显`);

  const body = await buildCreateRequestBody({
    params: {
      prompt: PROMPT,
      modelId: MODEL_ID,
      duration: 4,
      ratio: "16:9",
      video_resolution: "768P",
    },
    modelSpec: MODEL_SPECS[MODEL_ID],
    readReference: async () => {
      throw new Error("冒烟脚本不读取参考素材（文生视频）");
    },
  });

  const createResponse = await fetch(`${API_BASE_URL}${CREATE_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const createText = await createResponse.text();
  if (!createResponse.ok) {
    die(`创建任务失败：${apiMessage(createResponse.status, createText)}`);
  }
  const created = parseJson(createText) || {};
  const taskId = created.task_id ? String(created.task_id) : "";
  if (!taskId) die(`创建任务未返回 task_id：${createText.slice(0, 400)}`);
  log(`task_id: ${taskId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let videoUrl = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const queryResponse = await fetch(
      `${API_BASE_URL}${QUERY_PATH_PREFIX}${encodeURIComponent(taskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const queryText = await queryResponse.text();
    if (!queryResponse.ok) {
      die(`查询任务失败：${apiMessage(queryResponse.status, queryText)}`);
    }
    const task = (parseJson(queryText) || {}).task || {};
    const status = String(task.status ?? "");
    log(`  status: ${status}`);
    if (status === "succeeded" || status === "success" || status === "completed") {
      videoUrl = String(task?.content?.url ?? "");
      if (!videoUrl) die("任务成功但未返回视频地址");
      break;
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      die(`任务失败：${task?.error?.message || status}`);
    }
  }
  if (!videoUrl) die("轮询超时（10 分钟）仍未完成");

  const target = path.join(HERE, `minimax-smoke-${Date.now()}.mp4`);
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    die(`下载视频失败：HTTP ${videoResponse.status}`);
  }
  const buffer = Buffer.from(await videoResponse.arrayBuffer());
  fs.writeFileSync(target, buffer);

  log(`完成：${target}`);
  log(`大小：${buffer.length} 字节`);
}

main().catch((error) => {
  die(`冒烟失败：${error?.message || error}`);
});
