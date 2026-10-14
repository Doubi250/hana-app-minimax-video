/**
 * lib/speech/catalog.mjs
 *
 * 宿主语音通道（speech channel）发布的 MiniMax TTS 模型目录：音频格式白名单、
 * 语速边界、参数标签、模型条目构建。
 *
 * 纯函数与静态常量：不触宿主 API（`ctx.*`）、不做网络 I/O，可离线单测。
 */
import { SPEECH_PROTOCOL_ID } from "../minimax/constants.mjs";
import {
  DEFAULT_VOICE_ID,
  POPULAR_VOICE_PRESETS,
} from "../speech-api.mjs";

/**
 * The audio formats the HOST's speech channel knows — and therefore the only
 * ones this app may publish or accept through it.
 *
 * The host constant is `["mp3","wav","pcm","ogg_opus"]` and does NOT include
 * `flac`: a `flac` value would be rejected by the host at call time
 * (`speech format "flac" is not a known audio format`). `flac` therefore stays
 * on the model-tool (`minimax_text_to_speech`) direct path only, and the
 * adapter REJECTS it outright rather than silently downgrading to mp3.
 */
export const SPEECH_FORMATS = ["mp3", "wav", "pcm"];
export const SPEECH_SPEED_MIN = 0.5;
export const SPEECH_SPEED_MAX = 2;

/** Human-facing labels for the speech model's mode parameters. */
export const SPEECH_PARAM_LABELS = {
  voice: "音色",
  speed: "语速",
  format: "音频格式",
};

/** The speech models published through the runtime capability source. */
export const SPEECH_MODEL_IDS = ["speech-2.8-hd", "speech-2.8-turbo"];

const SPEECH_MODEL_DISPLAY_NAMES = {
  "speech-2.8-hd": "Speech 2.8 HD",
  "speech-2.8-turbo": "Speech 2.8 Turbo",
};

/** The preset voices published for one speech model (id + label, host shape). */
function buildSpeechVoices() {
  return POPULAR_VOICE_PRESETS.map((preset) => ({
    id: preset.id,
    displayName: preset.name,
    description: preset.description,
  }));
}

/** The single `text2speech` mode shared by every speech model. */
function buildSpeechMode() {
  return {
    id: "text2speech",
    label: "文字转语音",
    parameterSchema: {
      type: "object",
      properties: {
        voice: {
          type: "string",
          title: SPEECH_PARAM_LABELS.voice,
          default: DEFAULT_VOICE_ID,
        },
        speed: {
          type: "number",
          title: SPEECH_PARAM_LABELS.speed,
          minimum: SPEECH_SPEED_MIN,
          maximum: SPEECH_SPEED_MAX,
          default: 1,
        },
        format: {
          type: "string",
          title: SPEECH_PARAM_LABELS.format,
          enum: [...SPEECH_FORMATS],
          default: "mp3",
        },
      },
    },
    defaults: {
      voice: DEFAULT_VOICE_ID,
      speed: 1,
      format: "mp3",
    },
  };
}

/** One speech model entry published in `media.speechGeneration.models`. */
export function buildSpeechModelEntry(modelId) {
  return {
    id: modelId,
    displayName: SPEECH_MODEL_DISPLAY_NAMES[modelId] || modelId,
    protocolId: SPEECH_PROTOCOL_ID,
    inputs: ["text"],
    outputs: ["audio"],
    defaultVoiceId: DEFAULT_VOICE_ID,
    voices: buildSpeechVoices(),
    modes: [buildSpeechMode()],
  };
}
