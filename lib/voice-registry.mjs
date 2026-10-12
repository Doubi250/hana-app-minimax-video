/**
 * lib/voice-registry.mjs
 *
 * 本 App 的音色持久化表：读写 `{dataDir}/voices.json`。
 *
 * 三条硬约束（票据 03）：
 *   - **只写 dataDir**。安装目录 `{HANA_HOME}/apps/minimax-video` 对 App 子进程只读
 *     （Node Permission Model），任何写安装目录的实现都是 blocker。本模块只认调用方
 *     给的 `dataDir`，绝不自行推断安装目录。
 *   - **原子写**：先写同目录临时文件，再 `rename` 覆盖，避免半截文件。
 *   - **损坏恢复**：无法解析 / 形状非法的文件先原样备份为
 *     `voices.json.corrupt-<ts>`，再重建为空表——绝不静默丢数据。
 *
 * 纯 Node，无宿主 API，无网络：整个模块可用 `node --test` 离线验证。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const VOICES_FILE_NAME = "voices.json";
export const VOICES_VERSION = 1;

/** 音色表在 `dataDir` 下的绝对路径——唯一落点。 */
export function voicesFilePath(dataDir) {
  return path.join(String(dataDir), VOICES_FILE_NAME);
}

function emptyRegistry() {
  return { version: VOICES_VERSION, voices: [] };
}

/** 把任意形状归一化为「合法表 or null」；null 即视为损坏。 */
function normaliseRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== VOICES_VERSION) return null;
  if (!Array.isArray(value.voices)) return null;
  return { version: VOICES_VERSION, voices: value.voices };
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 原子写：同目录临时文件 → rename 覆盖。
 *
 * 临时文件与目标同目录，`rename` 才是同一文件系统内的原子替换；跨目录（如 tmp 分区）
 * 会退化为「复制 + 删除」，中途断电仍可能留下半截目标。
 */
async function writeAtomic(targetPath, text) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${VOICES_FILE_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await fs.writeFile(tmpPath, text, "utf8");
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    // rename 失败时清理临时文件，避免把垃圾留在用户的 dataDir 里。
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** 把损坏文件原样备份为 `voices.json.corrupt-<ts>`；备份失败不阻断重建。 */
async function backupCorrupt(targetPath, raw) {
  const backupPath = `${targetPath}.corrupt-${Date.now()}`;
  try {
    await fs.writeFile(backupPath, raw, "utf8");
  } catch {
    // 备份是尽力而为：写不出备份时仍要能把表重建为可用状态。
  }
  return backupPath;
}

/**
 * 读取音色表。文件缺失 → 空表；损坏 → 备份后重建空表（并把空表落盘）。
 *
 * @returns {Promise<{version: number, voices: Array<object>}>}
 */
export async function loadVoices(dataDir) {
  const target = voicesFilePath(dataDir);
  const raw = await readText(target);
  if (raw === null) return emptyRegistry();

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const registry = normaliseRegistry(parsed);
  if (registry) return registry;

  // 损坏：先备份原始字节，再重建为空表并落盘。
  await backupCorrupt(target, raw);
  const rebuilt = emptyRegistry();
  await writeAtomic(target, `${JSON.stringify(rebuilt, null, 2)}\n`);
  return rebuilt;
}

/** 登记 / 覆盖一个音色。重复 `voiceId` 覆盖内容但**保留原 createdAt**。 */
export async function registerVoice(dataDir, entry = {}) {
  const voiceId = typeof entry?.voiceId === "string" ? entry.voiceId.trim() : "";
  if (!voiceId) {
    throw new Error("登记音色失败：必须提供非空的 voiceId");
  }

  const registry = await loadVoices(dataDir);
  const existing = registry.voices.find((v) => v?.voiceId === voiceId) || null;

  const createdAt =
    (typeof existing?.createdAt === "string" && existing.createdAt.trim()
      ? existing.createdAt
      : null) ||
    (typeof entry.createdAt === "string" && entry.createdAt.trim() ? entry.createdAt : null) ||
    new Date().toISOString();

  const stored = {
    voiceId,
    label: typeof entry.label === "string" && entry.label.trim() ? entry.label : voiceId,
    createdAt,
    sample: entry.sample && typeof entry.sample === "object" ? entry.sample : {},
  };

  const next = registry.voices.filter((v) => v?.voiceId !== voiceId);
  next.push(stored);
  const out = { version: VOICES_VERSION, voices: next };

  await writeAtomic(voicesFilePath(dataDir), `${JSON.stringify(out, null, 2)}\n`);
  return stored;
}

/** 按 voiceId 查一条；未命中返回 null。 */
export async function findVoice(dataDir, voiceId) {
  const registry = await loadVoices(dataDir);
  return registry.voices.find((v) => v?.voiceId === voiceId) || null;
}
