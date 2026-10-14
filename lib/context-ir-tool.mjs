/**
 * lib/context-ir-tool.mjs
 *
 * The `minimax_context_ir` model tool: submit a H3-Context-IR prompt-enhancement
 * task, hand the model an immediate "submitted" receipt, and deliver the
 * enhanced prompt back into the conversation when the background task settles.
 *
 * Why the split: a context-ir task takes minutes on MiniMax's side, far longer
 * than a tool call can block. The tool therefore creates a host task (delivery
 * `next-step`), returns at once, and a background poller settles that host task
 * when the remote one finishes — the host task is never left hanging.
 *
 * Transport details: the submit goes to `POST /v2/h3_context_ir`; polling
 * reuses the shared `/v2/query/video_generation/{id}` endpoint, but the result
 * rides in `task.content.prompt` — an enhancement result, never the video-style
 * `content.url`. Read it through `queryContextIrTask`, not `queryTask`.
 *
 * Multimodal references ride through the host ResourceIO (`ctx.resources`):
 * a session-file / local-file ref is read as bytes and becomes a data URL
 * under the shared transport budget, while a public http(s) URL passes
 * through untouched. The ref shapes and budget rules themselves live in the
 * body builder (`lib/minimax/context-ir-body.mjs`); this module only injects the readers.
 *
 * Everything is injected (`fetch`, `bus`, `tasks`, `resources`, `logger`, `dataDir`) so
 * the whole lifecycle is unit-testable offline with fake objects.
 *
 * In-flight tasks are **persisted** to `{dataDir}/context-ir-pending.json` (see
 * `lib/context-ir-pending.mjs`): the moment a host task exists and the remote
 * submission succeeded, the pair is written down, and the entry is dropped only
 * on a **successful** settlement. Creating the tool re-reads that book and resumes
 * polling, so an App reload no longer strands a host task. Two consequences:
 *   - `runPollJob` re-resolves the credential **every round** (the credential may
 *     change across a reload); a resolution failure is treated as transient and
 *     polling continues to the deadline.
 *   - The book holds task ids and timestamps only — never a credential (see
 *     `docs/known-limitations.md`).
 */
import { PROVIDER_ID, RATIOS_FULL, T2V_DEFAULT_RATIO } from "./minimax/constants.mjs";
import {
  CONTEXT_IR_REF_LIMITS,
  buildContextIrRequestBody,
} from "./minimax/context-ir-body.mjs";
import { createCredentialResolver } from "./auth.mjs";
import { createMinimaxClient } from "./minimax-client.mjs";
import {
  addPendingTask,
  loadPendingTasks,
  removePendingTask,
} from "./context-ir-pending.mjs";

/** Background poll cadence: fast enough to feel live, gentle on the API. */
export const CONTEXT_IR_POLL_INTERVAL_MS = 10_000;
/** Hard cap on the whole background wait (~20 minutes). */
export const CONTEXT_IR_POLL_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * A recovered entry whose deadline passed more than this long ago is abandoned
 * outright: the remote task is hopeless and the host task must not stay pending
 * forever. Anything inside this window is resumed and still gets its chance.
 */
export const CONTEXT_IR_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** The delivered text is labelled so the model can quote it directly. */
export const CONTEXT_IR_DELIVERY_PREFIX = "H3-Context-IR 增强提示词：\n\n";

/**
 * The parameter schema for one reference: a bare http(s) URL string, or an
 * open ResourceRef the host ResourceIO can read. Mirrors the media pipeline's
 * ref shapes so the model passes the same thing everywhere in this app.
 */
const CONTEXT_IR_REF_SCHEMA = {
  anyOf: [
    {
      type: "string",
      description: "公网 http(s) URL（直通，不读字节、不占传输预算）",
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["session-file", "local-file"] },
        fileId: { type: "string", description: "kind=session-file 时必填：会话文件 ID" },
        path: { type: "string", description: "kind=local-file 时必填：本地文件绝对路径" },
      },
      required: ["kind"],
    },
  ],
};

function messageOf(error) {
  return String(error?.message || error || "未知错误");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the tool registration and its execute handler.
 *
 * @param {object} deps
 * @param {{ fetch: Function }} deps.network  host network bridge (`ctx.network`)
 * @param {object} [deps.bus]                 host bus (`ctx.bus`) for `provider:credentials`
 * @param {object} deps.tasks                 host task service (`ctx.tasks`)
 * @param {object} [deps.resources]           host ResourceIO (`ctx.resources`) for reference bytes
 * @param {object} [deps.logger]
 * @param {string} [deps.dataDir]             `ctx.dataDir` — the only place the in-flight book is written
 * @param {number} [deps.pollIntervalMs]      overridable for tests
 * @param {number} [deps.pollTimeoutMs]       overridable for tests
 */
export function createMinimaxContextIrTool({
  network,
  bus,
  tasks,
  resources,
  logger,
  dataDir,
  pollIntervalMs = CONTEXT_IR_POLL_INTERVAL_MS,
  pollTimeoutMs = CONTEXT_IR_POLL_TIMEOUT_MS,
} = {}) {
  const client = createMinimaxClient({ fetch: (url, init) => network.fetch(url, init) });
  const { requireAuth } = createCredentialResolver({ bus, selfProviderId: PROVIDER_ID });
  /** The book's landing directory; absent when the host hands us no `dataDir`. */
  const pendingDir = typeof dataDir === "string" && dataDir.trim() ? dataDir : null;

  /**
   * Write one in-flight entry. A book write is best-effort: it must never break
   * the submission (same principle as "a failed registration never blocks load").
   */
  async function rememberPending(record) {
    if (!pendingDir) return;
    try {
      await addPendingTask(pendingDir, record);
    } catch (error) {
      await logger?.warn?.(
        `minimax-video context-ir 登记在途簿失败（${record.hostTaskId}）：${messageOf(error)}`,
      );
    }
  }

  /** Drop one in-flight entry once its host task is settled. Best-effort. */
  async function forgetPending(hostTaskId) {
    if (!pendingDir) return;
    try {
      await removePendingTask(pendingDir, hostTaskId);
    } catch (error) {
      await logger?.warn?.(
        `minimax-video context-ir 清理在途簿失败（${hostTaskId}）：${messageOf(error)}`,
      );
    }
  }

  // Reference bytes ride the host ResourceIO; when the channel is missing the
  // body builder raises its own explicit error (only local refs need it —
  // public URLs pass through and never read).
  const readReference =
    typeof resources?.read === "function" ? (ref) => resources.read(ref) : undefined;
  const statReference =
    typeof resources?.stat === "function" ? (ref) => resources.stat(ref) : undefined;

  /** Settle the host task successfully; never let a settlement error kill the job. */
  async function settleComplete(hostTaskId, enhancedPrompt) {
    try {
      await tasks.complete(hostTaskId, { text: `${CONTEXT_IR_DELIVERY_PREFIX}${enhancedPrompt}` });
      // Deletion point: the host task is settled for real, so nobody is waiting
      // on this entry any more (a settlement that threw keeps it — see below).
      await forgetPending(hostTaskId);
      await logger?.info?.(`minimax-video context-ir 完成：${hostTaskId}`);
    } catch (error) {
      await logger?.error?.(`minimax-video context-ir 结算失败（${hostTaskId}）：${messageOf(error)}`);
    }
  }

  /** Settle the host task as failed; the reason must survive even if recording it fails. */
  async function settleFail(hostTaskId, reason) {
    try {
      await tasks.fail(hostTaskId, reason);
      // Deletion point, same rule as `settleComplete`.
      await forgetPending(hostTaskId);
      await logger?.warn?.(`minimax-video context-ir 失败：${hostTaskId}：${reason}`);
    } catch (error) {
      await logger?.error?.(`minimax-video context-ir 结算失败（${hostTaskId}）：${messageOf(error)}`);
    }
  }

  /**
   * Background job: poll the remote task until it settles (or the deadline is
   * hit), then settle the host task. Transient failures are tolerated — the only
   * exit doors are complete and fail.
   *
   * The credential is **re-resolved every round**: after an App reload the key may
   * have been replaced, added or removed, and a job resumed from the book must
   * still be able to settle. A resolution failure is transient (the user may be
   * mid-reconfiguration), so it is treated like a network hiccup: keep polling
   * until the deadline.
   *
   * `deadlineAt` is an absolute epoch-ms instant so a resumed job inherits the
   * ORIGINAL budget instead of restarting it on every reload.
   */
  async function runPollJob({ hostTaskId, remoteTaskId, deadlineAt }) {
    const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + pollTimeoutMs;
    while (true) {
      let remote = null;
      let auth = null;
      try {
        auth = await requireAuth({});
      } catch {
        auth = null;
      }
      if (auth) {
        try {
          remote = await client.queryContextIrTask({ auth, taskId: remoteTaskId });
        } catch {
          // Transient network trouble (or a slow host): keep polling; the
          // deadline below is what bounds a persistent outage.
          remote = null;
        }
      }
      if (remote) {
        if (remote.mapped === "failed") {
          await settleFail(hostTaskId, remote.failReason || "H3-Context-IR 任务失败");
          return;
        }
        if (remote.mapped === "success") {
          if (remote.prompt) {
            await settleComplete(hostTaskId, remote.prompt);
          } else {
            await settleFail(hostTaskId, "H3-Context-IR 任务已成功但未返回增强提示词");
          }
          return;
        }
      }
      if (Date.now() >= deadline) {
        const minutes = Math.max(1, Math.round(pollTimeoutMs / 60000));
        await settleFail(
          hostTaskId,
          `H3-Context-IR 任务超时（约 ${minutes} 分钟仍未完成），可稍后重试`,
        );
        return;
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Reload recovery: re-read the in-flight book and put every entry back to work.
   *
   * An entry whose deadline passed more than `CONTEXT_IR_STALE_AFTER_MS` ago is
   * hopeless — settle the host task as failed (which also drops it from the book)
   * rather than leave it pending forever. Everything else resumes with its
   * remaining budget.
   */
  async function restorePending() {
    if (!pendingDir) return;
    let book;
    try {
      book = await loadPendingTasks(pendingDir);
    } catch (error) {
      await logger?.warn?.(`minimax-video context-ir 读取在途簿失败：${messageOf(error)}`);
      return;
    }
    if (!book.tasks.length) return;
    const now = Date.now();
    for (const task of book.tasks) {
      if (now - task.deadlineAt > CONTEXT_IR_STALE_AFTER_MS) {
        // Settling is also what drops the entry (the deletion point of the book);
        // if settling itself throws, the entry stays and the NEXT reload retries
        // it — cheaper than silently abandoning a host task the host still knows.
        await settleFail(
          task.hostTaskId,
          "H3-Context-IR 任务已过期（超过 24 小时未完成），重载后不再恢复，可重新提交",
        );
        continue;
      }
      await logger?.info?.(
        `minimax-video context-ir 恢复在途任务：${task.remoteTaskId}（宿主任务 ${task.hostTaskId}）`,
      );
      void runPollJob({
        hostTaskId: task.hostTaskId,
        remoteTaskId: task.remoteTaskId,
        deadlineAt: task.deadlineAt,
      }).catch(async (error) => {
        await settleFail(task.hostTaskId, `H3-Context-IR 任务异常：${messageOf(error)}`);
      });
    }
  }

  // Reload recovery starts here: the tool is created during `apply()`, so a fresh
  // instance with the same `dataDir` picks up whatever was in flight. Fire and
  // forget on purpose — a book read must never block App loading (a failed read
  // only logs), and `ctx.tools.register` is synchronous.
  void restorePending();

  return {
    name: "minimax_context_ir",
    description:
      `提交 H3-Context-IR 提示词增强任务（异步）。立即返回「已提交」回执；增强后的提示词会在后台完成时自动送达本会话，请等待送达后再引用，不要用相同提示词重复调用。注意：本工具只产出增强提示词，不产生视频；要生成视频请改用媒体生成工具，并使用送达的增强提示词。参数：prompt 为待增强的提示词；duration 为规划的视频时长（4-15 秒，默认 5）；ratio 为规划的视频宽高比（默认 16:9，纯文本场景不支持 adaptive，带首/尾帧时固定 adaptive，参考场景可传具体比例或 adaptive）。素材输入二选一且互斥：首/尾帧（firstFrame / lastFrame，单图）或参考素材（referenceImages ≤${CONTEXT_IR_REF_LIMITS.images} 张、referenceVideos ≤${CONTEXT_IR_REF_LIMITS.videos} 个、referenceAudios ≤${CONTEXT_IR_REF_LIMITS.audios} 段）。每个素材引用支持 { kind: "session-file", fileId }、{ kind: "local-file", path } 或公网 http(s) URL 字符串；本地引用按单文件 ≤12MB、总量 ≤16MB 的传输预算读取，URL 直通不读字节。`,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "待增强的提示词（必填）",
        },
        duration: {
          type: "integer",
          minimum: 4,
          maximum: 15,
          default: 5,
          description: "规划的视频时长（秒），4-15，默认 5",
        },
        ratio: {
          type: "string",
          enum: [...RATIOS_FULL],
          default: T2V_DEFAULT_RATIO,
          description:
            "规划的视频宽高比，默认 16:9；纯文本场景不支持 adaptive；带首/尾帧时固定为 adaptive；参考场景默认 adaptive",
        },
        firstFrame: {
          ...CONTEXT_IR_REF_SCHEMA,
          description: "首帧图片（单图引用；与参考素材互斥，不能混用）",
        },
        lastFrame: {
          ...CONTEXT_IR_REF_SCHEMA,
          description: "尾帧图片（单图引用；与参考素材互斥，不能混用）",
        },
        referenceImages: {
          type: "array",
          items: CONTEXT_IR_REF_SCHEMA,
          maxItems: CONTEXT_IR_REF_LIMITS.images,
          description: `参考图片（≤${CONTEXT_IR_REF_LIMITS.images} 张；与首/尾帧互斥）`,
        },
        referenceVideos: {
          type: "array",
          items: CONTEXT_IR_REF_SCHEMA,
          maxItems: CONTEXT_IR_REF_LIMITS.videos,
          description: `参考视频（≤${CONTEXT_IR_REF_LIMITS.videos} 个；与首/尾帧互斥）`,
        },
        referenceAudios: {
          type: "array",
          items: CONTEXT_IR_REF_SCHEMA,
          maxItems: CONTEXT_IR_REF_LIMITS.audios,
          description: `参考音频（≤${CONTEXT_IR_REF_LIMITS.audios} 段；与首/尾帧互斥）`,
        },
      },
      required: ["prompt"],
    },

    async execute({
      prompt,
      duration,
      ratio,
      firstFrame,
      lastFrame,
      referenceImages,
      referenceVideos,
      referenceAudios,
      context,
    } = {}) {
      const callToken = context?.callToken;
      if (!callToken) {
        // Without a call token the result could never reach a conversation —
        // refuse loudly instead of submitting a task nobody can receive.
        throw new Error(
          "minimax_context_ir 仅支持在会话中调用：缺少调用令牌（callToken），非会话通道不支持本工具",
        );
      }
      if (typeof tasks?.create !== "function") {
        throw new Error(
          "minimax_context_ir 无法提交：宿主任务通道不可用（缺少 app/tasks.manage 授权）",
        );
      }
      // Validate the input before any side effect: a bad prompt or a bad
      // reference must not create a host task and must not cost an API call.
      // Reference bytes are read here too — under the shared budget.
      const body = await buildContextIrRequestBody({
        prompt,
        duration,
        ratio,
        firstFrame,
        lastFrame,
        referenceImages,
        referenceVideos,
        referenceAudios,
        readReference,
        statReference,
      });
      const auth = await requireAuth({});

      const hostTask = await tasks.create({
        callToken,
        label: `H3-Context-IR：${body.content[0].text.slice(0, 80)}`,
        delivery: "next-step",
      });

      let remoteTaskId;
      try {
        ({ taskId: remoteTaskId } = await client.createContextIrTask({ auth, body }));
      } catch (error) {
        // The host task was created: settle it before surfacing the failure,
        // so a failed submission can never leave a hanging task behind.
        await settleFail(hostTask.taskId, `提交 H3-Context-IR 任务失败：${messageOf(error)}`);
        throw error;
      }

      await logger?.info?.(
        `minimax-video context-ir 提交任务：${remoteTaskId}（宿主任务 ${hostTask.taskId}）`,
      );
      // 写点：宿主任务已创建、远端已接受 —— 从这一刻起「有人需要被恢复」。
      const createdAt = Date.now();
      const deadlineAt = createdAt + pollTimeoutMs;
      await rememberPending({
        hostTaskId: hostTask.taskId,
        remoteTaskId,
        createdAt,
        deadlineAt,
      });
      void runPollJob({ hostTaskId: hostTask.taskId, remoteTaskId, deadlineAt }).catch(
        async (error) => {
          // Belt and braces: runPollJob settles its own paths; if something
          // unforeseen escapes, the host task still must not hang.
          await settleFail(hostTask.taskId, `H3-Context-IR 任务异常：${messageOf(error)}`);
        },
      );

      return {
        content: [
          {
            type: "text",
            text: `已提交 H3-Context-IR 任务（任务 ID：${hostTask.taskId}），增强提示词生成后会自动送达本会话。`,
          },
        ],
      };
    },
  };
}
