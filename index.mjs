/**
 * MiniMax 视频生成 — Hana v2 App (media provider + context-ir tool).
 *
 * Registers one runtime capability source and one media adapter with the host's
 * media runtime, so `media_describe-options` / `media_generate-video` can list
 * and drive MiniMax H3, plus the `minimax_context_ir` model tool that enhances
 * prompts and delivers them back through the host task system. No UI, no
 * cards, no settings page.
 *
 * Plain ESM on purpose: the isolated app process has no host `node_modules`,
 * so `@hana/app-sdk` is never imported — everything comes from the `ctx` handed
 * to `apply`.
 */
import { FALLBACK_PROVIDER_ID, PROVIDER_ID } from "./lib/minimax/constants.mjs";
import {
  TOKEN_PLAN_HINT,
  buildCapabilitySnapshot,
  throwLaneUnavailable,
} from "./lib/snapshot.mjs";
import { createMinimaxVideoAdapter } from "./lib/minimax-adapter.mjs";
import { createMinimaxSpeechAdapter } from "./lib/speech-adapter.mjs";
import { createMinimaxContextIrTool } from "./lib/context-ir-tool.mjs";
import { createTtsTool } from "./lib/tts-tool.mjs";
import { createAsrTool } from "./lib/asr-tool.mjs";

const MEDIA_REGISTER_HINT = "缺少 app/media.provide 授权或媒体运行时不可用";
const TOOL_REGISTER_HINT =
  "缺少 app/tools.expose-to-model 授权或工具注册表不可用";

async function logError(logger, label, error, hint = MEDIA_REGISTER_HINT) {
  try {
    await logger?.error?.(`minimax-video ${label} 注册失败（${hint}）：${error?.message || error}`);
  } catch {
    // Logging must never break app loading.
  }
}

/**
 * Ask the host once whether the MiniMax Token Plan provider yields a credential.
 *
 * This app keeps no credential of its own — every call borrows the Token Plan
 * provider's, so "can I get one right now?" is the provider's real state. The
 * three outcomes are kept apart on purpose:
 *   - "denied"  → the capability grant is missing; that is a permissions
 *                 problem, not a configuration one, so it must not be reported
 *                 as an unavailable provider.
 *   - "absent"  → the bus has no such door on this host; same conclusion.
 *   - "missing" → the provider is configured but has no usable credential, or
 *                 is not configured at all → the caller must surface this.
 */
async function probeCredentialLane(bus, logger) {
  if (typeof bus?.request !== "function") return { outcome: "absent" };
  try {
    const result = await bus.request("provider:credentials", { providerId: FALLBACK_PROVIDER_ID });
    if (result && typeof result === "object" && typeof result.error === "string") {
      return { outcome: "missing", reason: result.error };
    }
    const hasKey = typeof result?.apiKey === "string" && result.apiKey.trim().length > 0;
    const headers = result?.headers && typeof result.headers === "object" ? result.headers : null;
    const hasHeaders = !!headers && Object.values(headers).some((v) => v !== undefined && v !== null && v !== "");
    return hasKey || hasHeaders ? { outcome: "present" } : { outcome: "missing", reason: "empty" };
  } catch (error) {
    const message = String(error?.message || error || "");
    // A missing grant is a permissions state, not a provider state — keep the
    // panel green and let generation surface it in its own error message.
    if (/provider\.credentials\.read|not authorized|grant/i.test(message)) {
      return { outcome: "denied" };
    }
    await logger?.warn?.(`minimax-video 凭证 lane 探测失败：${message}`);
    return { outcome: "absent" };
  }
}

export async function apply(ctx) {
  const logger = ctx?.logger;

  try {
    const probe = await probeCredentialLane(ctx.bus, logger);
    const ready = probe.outcome !== "missing";
    const snapshot = buildCapabilitySnapshot();

    await ctx.media.registerCapabilitySource(PROVIDER_ID, {
      // The model table is static; the only live fact is the credential lane.
      // Every host read re-runs `refresh`, and it re-probes on each call so the
      // panel flips as soon as the provider is configured (no cache to invalidate).
      //
      // A missing lane credential THROWS: the host stores only `media`,
      // `version` and `fingerprint` from a successful refresh and hard-codes
      // `status: "ready"` — extra fields on the return value are dropped, so
      // the only way to reach the panel's `unavailableReason`/`unavailableMessage`
      // is the non-ready branch, and the only way to get there is to throw.
      // The host then reports hasCredentials:false with our code + message.
      refresh: async () => {
        const current = await probeCredentialLane(ctx.bus, logger);
        if (current.outcome === "missing") {
          throwLaneUnavailable({ reason: "no_credentials", message: TOKEN_PLAN_HINT });
        }
        return snapshot;
      },
    });
    if (!ready) {
      await logger?.warn?.(`minimax-video 凭证 lane 未就绪：${TOKEN_PLAN_HINT}`);
    }
  } catch (error) {
    await logError(logger, "能力源", error);
  }

  try {
    const adapter = createMinimaxVideoAdapter({
      logger: ctx.logger,
      resources: ctx.resources,
      network: ctx.network,
      dataDir: ctx.dataDir,
      bus: ctx.bus,
    });
    await ctx.media.registerAdapter(adapter);
  } catch (error) {
    await logError(logger, "适配器", error);
  }

  try {
    // 宿主全局发音入口 `media_generate-speech` 按 `types:["speech"]` 选适配器：
    // 注册后 MiniMax 音色即出现在宿主目录里。产物写生成目录（与媒体管线同一落点），
    // 复用既有 speech-client 的合成实现。注册失败只记日志，绝不阻断 App 加载。
    const speechAdapter = createMinimaxSpeechAdapter({
      logger: ctx.logger,
      network: ctx.network,
      bus: ctx.bus,
      dataDir: ctx.dataDir,
      generatedDir: ctx.generatedDir,
    });
    await ctx.media.registerAdapter(speechAdapter);
  } catch (error) {
    await logError(logger, "语音适配器", error);
  }

  try {
    // The context-ir tool ships the enhanced prompt back into the conversation
    // through the host task system (delivery next-step), so it needs the tool
    // registry plus tasks. `ctx.tools.register` returns its disposer
    // synchronously (per the app SDK — unlike the media registrations above,
    // which are promises), so there is nothing to await here.
    ctx.tools.register(
      createMinimaxContextIrTool({
        logger: ctx.logger,
        network: ctx.network,
        bus: ctx.bus,
        tasks: ctx.tasks,
        resources: ctx.resources,
      }),
    );
  } catch (error) {
    await logError(logger, "工具", error, TOOL_REGISTER_HINT);
  }

  try {
    // 语音合成工具：产物写入生成目录（与媒体管线同一落点），返回的本地路径
    // 可被后续工具当作参考音频引用。注册失败只记日志，绝不阻断 App 加载。
    ctx.tools.register(
      createTtsTool({
        logger: ctx.logger,
        network: ctx.network,
        bus: ctx.bus,
        generatedDir: ctx.generatedDir,
        dataDir: ctx.dataDir,
      }),
    );
  } catch (error) {
    await logError(logger, "TTS 工具", error, TOOL_REGISTER_HINT);
  }

  try {
    // 语音识别工具：本地文件经宿主资源通道读取（受传输预算约束），
    // 也接受网络音频 URL。同样只记日志、不阻断加载。
    ctx.tools.register(
      createAsrTool({
        logger: ctx.logger,
        network: ctx.network,
        bus: ctx.bus,
        resources: ctx.resources,
      }),
    );
  } catch (error) {
    await logError(logger, "ASR 工具", error, TOOL_REGISTER_HINT);
  }

  await ctx.logger?.info?.("minimax-video loaded");
}

export default { apply };
