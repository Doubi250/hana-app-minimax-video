/**
 * lib/context-ir-pending.mjs
 *
 * context-ir 的**在途任务簿**：读写 `{dataDir}/context-ir-pending.json`。
 *
 * 为什么需要：一个 context-ir 任务在 MiniMax 侧要跑几分钟，工具把宿主任务
 * （delivery `next-step`）挂在那儿等后台轮询结算。此前轮询状态纯内存——App 重载即丢，
 * 宿主任务永久悬挂、增强提示词永不送达。本簿把「谁在等」落到 `dataDir`，重载后即可恢复。
 *
 * 结构（version 1）：
 *
 *     { "version": 1,
 *       "tasks": [ { "hostTaskId", "remoteTaskId", "createdAt", "deadlineAt" } ] }
 *
 * `createdAt` / `deadlineAt` 是 epoch 毫秒数（数字）。`deadlineAt` 是轮询放弃的时刻；
 * 装载侧据此判断「还剩多久」与「是否早已过期」。
 *
 * 三条硬约束（与 `voice-registry.mjs` 同源，共用 `atomic-file.mjs` 的两个原语）：
 *   - **只写 `dataDir`**：本模块只认调用方给的目录，绝不推断安装目录。
 *   - **原子写**：临时文件 + `rename`，不留半截文件。
 *   - **损坏恢复**：无法解析 / 形状非法的文件先原样备份为
 *     `context-ir-pending.json.corrupt-<ts>`，再重建为空簿——绝不静默丢数据。
 *
 * **凭证纪律**：本簿只存宿主/远端任务 ID 与时间戳，**绝不写任何凭证**。重载后凭证由
 * 轮询侧每轮重新解析（见 `context-ir-tool.mjs`），不落盘、不继承。
 *
 * 纯 Node，无宿主 API，无网络：可用 `node --test` 离线验证。
 */
import path from "node:path";
import {
  backupCorruptFile,
  readFileTextOrNull,
  writeFileAtomic,
} from "./atomic-file.mjs";

export const CONTEXT_IR_PENDING_FILE_NAME = "context-ir-pending.json";
export const CONTEXT_IR_PENDING_VERSION = 1;

/** 在途任务簿在 `dataDir` 下的绝对路径——唯一落点。 */
export function contextIrPendingFilePath(dataDir) {
  return path.join(String(dataDir), CONTEXT_IR_PENDING_FILE_NAME);
}

function emptyBook() {
  return { version: CONTEXT_IR_PENDING_VERSION, tasks: [] };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** 单条在途记录的形状校验；形状非法即不可恢复，按损坏处理。 */
function normaliseTask(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isNonEmptyString(value.hostTaskId) || !isNonEmptyString(value.remoteTaskId)) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.deadlineAt)) return null;
  return {
    hostTaskId: value.hostTaskId.trim(),
    remoteTaskId: value.remoteTaskId.trim(),
    createdAt: value.createdAt,
    deadlineAt: value.deadlineAt,
  };
}

/**
 * 把任意形状归一化为「合法簿 or null」；null 即视为损坏。
 *
 * 条目的形状**从严**：本文件只由本模块原子写产出，单写者；出现一条形状不合的条目意味着
 * 外部改写或磁盘问题，此时原样备份、重建空簿，胜过留一条永远轮询不动的记录去拖住宿主任务。
 */
function normaliseBook(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== CONTEXT_IR_PENDING_VERSION) return null;
  if (!Array.isArray(value.tasks)) return null;
  const tasks = [];
  for (const raw of value.tasks) {
    const task = normaliseTask(raw);
    if (!task) return null;
    tasks.push(task);
  }
  return { version: CONTEXT_IR_PENDING_VERSION, tasks };
}

/* ---------------------------------------------------------------- *
 * 串行化：本簿的每次改动都是「读 → 改 → 原子写」，并发调用（同一进程内多个
 * 轮询任务同时在途）不串行就会互相覆盖。按 `dataDir` 串成一条链，代价可忽略。
 * ---------------------------------------------------------------- */

const writeChains = new Map();

function withBookLock(dataDir, work) {
  const key = String(dataDir);
  const previous = writeChains.get(key) || Promise.resolve();
  const result = previous.then(work, work);
  // 链上只保留「已结算」的占位：前一步成功或失败都不影响下一步执行。
  writeChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function persist(dataDir, book) {
  await writeFileAtomic(
    contextIrPendingFilePath(dataDir),
    `${JSON.stringify(book, null, 2)}\n`,
  );
}

/**
 * 读取在途任务簿。文件缺失 → 空簿；损坏 → 备份后重建空簿（并把空簿落盘）。
 *
 * @returns {Promise<{version: number, tasks: Array<{hostTaskId: string, remoteTaskId: string, createdAt: number, deadlineAt: number}>}>}
 */
export async function loadPendingTasks(dataDir) {
  const target = contextIrPendingFilePath(dataDir);
  const raw = await readFileTextOrNull(target);
  if (raw === null) return emptyBook();

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const book = normaliseBook(parsed);
  if (book) return book;

  // 损坏：先备份原始字节，再重建为空簿并落盘。
  await backupCorruptFile(target, raw);
  const rebuilt = emptyBook();
  await persist(dataDir, rebuilt);
  return rebuilt;
}

/**
 * 登记一条在途任务（同 hostTaskId 覆盖，幂等）。返回落盘的那一条。
 *
 * 写点：宿主任务创建且远端提交成功之后——那一刻起才「有人需要被恢复」。
 */
export async function addPendingTask(dataDir, entry = {}) {
  const task = normaliseTask(entry);
  if (!task) {
    throw new Error(
      "登记在途 context-ir 任务失败：需要非空 hostTaskId / remoteTaskId 与数字 createdAt / deadlineAt",
    );
  }
  return withBookLock(dataDir, async () => {
    const book = await loadPendingTasks(dataDir);
    const next = book.tasks.filter((item) => item.hostTaskId !== task.hostTaskId);
    next.push(task);
    await persist(dataDir, { version: CONTEXT_IR_PENDING_VERSION, tasks: next });
    return task;
  });
}

/**
 * 按 hostTaskId 注销一条在途任务（幂等）。
 *
 * 删点：`settleComplete` / `settleFail` 的**成功路径**——宿主任务已结算，无人再等。
 *
 * @returns {Promise<boolean>} 是否确实删掉了一条
 */
export async function removePendingTask(dataDir, hostTaskId) {
  const wanted = isNonEmptyString(hostTaskId) ? hostTaskId.trim() : "";
  if (!wanted) return false;
  return withBookLock(dataDir, async () => {
    const book = await loadPendingTasks(dataDir);
    const next = book.tasks.filter((item) => item.hostTaskId !== wanted);
    if (next.length === book.tasks.length) return false;
    await persist(dataDir, { version: CONTEXT_IR_PENDING_VERSION, tasks: next });
    return true;
  });
}
