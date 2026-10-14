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
 * 原子写与损坏备份两个原语住在 `lib/atomic-file.mjs`，与 context-ir 在途任务簿
 * （`lib/context-ir-pending.mjs`）**共用同一份实现**——同一落点纪律的两处不能各存一份。
 *
 * 纯 Node，无宿主 API，无网络：整个模块可用 `node --test` 离线验证。
 *
 * 读取侧：`loadVoices` / `findVoice` 是持久化入口，`resolveVoiceInput` / `listVoiceLabels`
 * 是运行时消费方——把调用方给的 `voiceId` 或 `label` 解析回表内的 `voiceId`，让克隆出的
 * 音色除手工抄 `voiceId` 外还能按 `label` 复用。
 */
import path from "node:path";
import {
  backupCorruptFile,
  readFileTextOrNull,
  writeFileAtomic,
} from "./atomic-file.mjs";

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

/**
 * 读取音色表。文件缺失 → 空表；损坏 → 备份后重建空表（并把空表落盘）。
 *
 * @returns {Promise<{version: number, voices: Array<object>}>}
 */
export async function loadVoices(dataDir) {
  const target = voicesFilePath(dataDir);
  const raw = await readFileTextOrNull(target);
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
  await backupCorruptFile(target, raw);
  const rebuilt = emptyRegistry();
  await writeFileAtomic(target, `${JSON.stringify(rebuilt, null, 2)}\n`);
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

  await writeFileAtomic(voicesFilePath(dataDir), `${JSON.stringify(out, null, 2)}\n`);
  return stored;
}

/** 按 voiceId 查一条；未命中返回 null。 */
export async function findVoice(dataDir, voiceId) {
  const registry = await loadVoices(dataDir);
  return registry.voices.find((v) => v?.voiceId === voiceId) || null;
}

/**
 * 把一个调用方给的音色引用解析为表内的 `voiceId`。
 *
 * 这是音色表的**运行时读取方**：克隆出的音色除了记住 `voiceId` 外，还能按 `label`
 * （人读的名字）被复用，否则模型只能手工抄 `voiceId`。匹配规则：
 *   - 输入先 `trim`，与表内 `voiceId` **或** `label` 做**大小写敏感**的精确相等；
 *   - 命中返回该项的 `voiceId`；
 *   - 表为空 / 形状非法 / 无命中 → 返回 `null`（调用方决定如何处置，本函数不抛错）。
 *
 * 纯函数：不触碰磁盘、不做网络，可离线单测。
 *
 * @param {object} table  `loadVoices` 返回的表（`{version, voices}`）；非法即视为空表
 * @param {string} input  待解析的引用（voiceId 或 label）
 * @returns {string|null}
 */
export function resolveVoiceInput(table, input) {
  const wanted = typeof input === "string" ? input.trim() : "";
  if (!wanted) return null;
  const voices = Array.isArray(table?.voices) ? table.voices : [];
  for (const entry of voices) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.voiceId === wanted || entry.label === wanted) {
      return typeof entry.voiceId === "string" ? entry.voiceId : null;
    }
  }
  return null;
}

/** 表内全部可用 label（去空），供报错时提示可选值。 */
export function listVoiceLabels(table) {
  const voices = Array.isArray(table?.voices) ? table.voices : [];
  return voices
    .map((entry) => (entry && typeof entry.label === "string" ? entry.label.trim() : ""))
    .filter(Boolean);
}
