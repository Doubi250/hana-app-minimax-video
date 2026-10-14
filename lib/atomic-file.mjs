/**
 * lib/atomic-file.mjs
 *
 * `dataDir` 持久化的两个共用原语：原子写与损坏备份。
 *
 * 为什么单源：音色表（`voice-registry.mjs`）与 context-ir 在途任务簿
 * （`context-ir-pending.mjs`）都写 `{dataDir}`——「临时文件 + rename」与「损坏先备份、
 * 再重建」必须是同一份实现。两处各存一份时，一次修好的半截文件问题会在另一处复活
 * （本仓库 T2 的同款教训：语义靠注释对齐必然再次分叉，靠构造对齐才不会）。
 *
 * 落点纪律：只认调用方给的**绝对目标路径**；本模块不推断任何目录，绝不写安装目录。
 * 纯 Node，无宿主 API，无网络：可用 `node --test` 离线验证。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 读文本；文件不存在（ENOENT）或父路径不是目录（ENOTDIR）→ `null`，其余错误照抛。
 *
 * ENOTDIR 一并吞掉是有意的：`dataDir` 本身被一个文件占住时，读取应当退化为「没有
 * 这本簿」，而不是把 App 装载掀翻。
 */
export async function readFileTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * 原子写：同目录临时文件 → rename 覆盖。
 *
 * 临时文件与目标同目录，`rename` 才是同一文件系统内的原子替换；跨目录（如 tmp 分区）
 * 会退化为「复制 + 删除」，中途断电仍可能留下半截目标。
 *
 * Windows 上的重试是有意为之：目标文件正被另一个句柄读着时，`rename` 以 `EPERM` /
 * `EACCES` / `EBUSY` 失败（同进程的异步读也算）——宿主是 Windows 时，「装载读簿」与
 * 「轮询结算写簿」天然并发，不是异常。短暂自旋后重试即可穿过这扇窗口；真写不进去时
 * 仍按原样抛出，由调用方决定是否降级（本仓库一律降为日志，不阻断主流程）。
 */
export async function writeFileAtomic(targetPath, text, { retries = 5, retryDelayMs = 15 } = {}) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await fs.writeFile(tmpPath, text, "utf8");
  const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (error) {
      if (attempt < retries && transient.has(error?.code)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      // 最终失败时清理临时文件，避免把垃圾留在用户的 dataDir 里。
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** 把损坏文件原样备份为 `<target>.corrupt-<ts>`；备份失败不阻断重建。 */
export async function backupCorruptFile(targetPath, raw) {
  const backupPath = `${targetPath}.corrupt-${Date.now()}`;
  try {
    await fs.writeFile(backupPath, raw, "utf8");
  } catch {
    // 备份是尽力而为：写不出备份时仍要能把文件重建为可用状态。
  }
  return backupPath;
}
