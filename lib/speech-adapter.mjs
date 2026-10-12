/**
 * lib/speech-adapter.mjs
 *
 * The host's global speech channel adapter for MiniMax TTS.
 *
 * The host routes `media_generate-speech` to a `types:["speech"]` adapter: it
 * reads the adapter's descriptor (formats / speed bounds), resolves a voice and
 * format against it, then calls `submit(params, ctx)`. This module is that
 * adapter — it does NOT re-implement synthesis: it borrows the credential lane
 * through the shared resolver (lib/auth.mjs) and the actual T2A call through
 * the existing client (lib/speech-client.mjs), then writes the returned audio
 * into the generation directory and hands back `{ taskId, files:[fileName] }`.
 *
 * Two hard facts from the SPEC §0:
 *   - the host's known audio formats are `["mp3","wav","pcm","ogg_opus"]` and
 *     do NOT include `flac` — so this adapter accepts only `mp3/wav/pcm` and
 *     REJECTS `flac` outright, never silently downgrading it;
 *   - `ctx.generatedDir` is the landing directory, falling back to
 *     `{dataDir}/generated` (the same place the media pipeline writes).
 *
 * Everything here is offline-testable: `fetch` and the bus are injected.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  DEFAULT_TTS_FORMAT,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_ID,
  normaliseTtsFormat,
  ttsFileExtension,
} from "./speech-api.mjs";
import {
  PROVIDER_ID,
  SPEECH_FORMATS,
  SPEECH_PROTOCOL_ID,
  SPEECH_SPEED_MAX,
  SPEECH_SPEED_MIN,
} from "./minimax-api.mjs";
import { createCredentialResolver, NOT_CONFIGURED_MESSAGE } from "./auth.mjs";
import { createMinimaxSpeechClient } from "./speech-client.mjs";

/** The descriptor's static capability block, kept as one exported fact. */
export const SPEECH_ADAPTER_CAPABILITIES = {
  formats: [...SPEECH_FORMATS],
  speedMin: SPEECH_SPEED_MIN,
  speedMax: SPEECH_SPEED_MAX,
};

/** A non-empty trimmed string, or "" — the only value shape these params take. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Clamp the speed into the adapter's declared window (host already validated). */
function clampSpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(SPEECH_SPEED_MIN, Math.min(SPEECH_SPEED_MAX, numeric));
}

export function createMinimaxSpeechAdapter({
  logger,
  network,
  bus,
  dataDir,
  generatedDir,
} = {}) {
  const client = createMinimaxSpeechClient({ fetch: (url, init) => network.fetch(url, init) });
  const { resolveAuth } = createCredentialResolver({ bus, selfProviderId: PROVIDER_ID });

  /** Synthesis landing directory: call-time ctx → apply-time → `{dataDir}/generated`. */
  function resolveOutputDir(ctx) {
    const fromCall = text(ctx?.generatedDir);
    if (fromCall) return fromCall;
    const fromApply = text(generatedDir);
    if (fromApply) return fromApply;
    return path.join(String(dataDir || "."), "generated");
  }

  return {
    id: SPEECH_PROTOCOL_ID,
    protocolId: SPEECH_PROTOCOL_ID,
    name: "MiniMax 语音合成",
    types: ["speech"],
    capabilities: { ...SPEECH_ADAPTER_CAPABILITIES },

    async checkAuth() {
      const auth = await resolveAuth();
      if (!auth) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
      return { ok: true };
    },

    async submit(params = {}, ctx = {}) {
      const auth = await resolveAuth(params, ctx);
      if (!auth) throw new Error(NOT_CONFIGURED_MESSAGE);

      const source = text(params.text) || text(params.prompt);
      if (!source) throw new Error("语音合成需要非空文本 (text)");

      // The host only knows mp3/wav/pcm; `flac` must be refused, not downgraded.
      const requestedFormat = text(params.format).toLowerCase() || DEFAULT_TTS_FORMAT;
      if (!SPEECH_FORMATS.includes(requestedFormat)) {
        throw new Error(
          `MiniMax 语音合成不支持格式 "${requestedFormat}"；宿主通道仅支持：${SPEECH_FORMATS.join(", ")}`,
        );
      }
      const format = normaliseTtsFormat(requestedFormat);

      const signal = ctx?.attempt?.signal;
      if (signal?.aborted) {
        throw new Error("MiniMax 语音合成在开始前已被取消");
      }

      const result = await client.synthesizeSpeech({
        auth,
        text: source,
        model: text(params.modelId) || text(params.model) || DEFAULT_TTS_MODEL,
        voiceId: text(params.voice) || text(params.voiceId) || DEFAULT_VOICE_ID,
        speed: clampSpeed(params.speed),
        format,
        outputFormat: "hex",
      });

      const outputDir = resolveOutputDir(ctx);
      await fs.mkdir(outputDir, { recursive: true });
      const digest = crypto.randomBytes(6).toString("hex");
      const fileName = `minimax-speech-${Date.now()}-${digest}${ttsFileExtension(format)}`;
      await fs.writeFile(path.join(outputDir, fileName), result.audioBuffer);
      await logger?.info?.(
        `minimax-video 语音合成已保存至：${path.join(outputDir, fileName)}`,
      );

      const taskId = text(ctx?.attempt?.taskId) || text(params.taskId) || crypto.randomUUID();
      return { taskId, files: [fileName] };
    },
  };
}
