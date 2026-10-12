/**
 * lib/speech-api.mjs
 *
 * MiniMax 语音输入/输出（TTS & ASR）纯逻辑与接口协议帮助函数。
 *
 * 不依赖任何平台宿主 API（ctx.*），不直接做网络 I/O，支持离线单元测试。
 * 凭证解析与字节提取由视频侧的统一实现负责，本模块不重复它们。
 */

export const API_BASE_URL = "https://api.minimax.cn";
export const TTS_PATH = "/v1/t2a_v2";
export const ASR_PATH = "/v1/speech_to_text";

/* ------------------------------------------------------------------ *
 * 模型 / 音色 / 格式常量
 * ------------------------------------------------------------------ */

export const DEFAULT_TTS_MODEL = "speech-2.8-hd";
export const SUPPORTED_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
];

export const DEFAULT_ASR_MODEL = "asr-1.0";
export const SUPPORTED_ASR_MODELS = ["asr-1.0"];

export const DEFAULT_VOICE_ID = "male-qn-qingse";

export const POPULAR_VOICE_PRESETS = [
  { id: "male-qn-qingse", name: "青涩青年", description: "年轻男声，自然生动" },
  { id: "female-yujie", name: "御姐音色", description: "成熟女声，知性优雅" },
  { id: "female-tianmei", name: "甜美女声", description: "清脆甜美，活泼亲和" },
  { id: "presenter_male", name: "专业男播", description: "专业男主播，端庄厚重" },
  { id: "presenter_female", name: "专业女播", description: "专业女主播，清晰流畅" },
  { id: "audiobook_male_1", name: "评书男声", description: "说书说故事，节奏鲜明" },
  { id: "audiobook_female_1", name: "故事女声", description: "娓娓道来，适合有声书" },
  { id: "English_expressive_narrator", name: "英文生动解说", description: "地道美音，富有表现力" },
];

/**
 * T2A 请求体 `audio_setting.format` 接受的**输出**格式——也是落盘扩展名的唯一来源。
 *
 * 与 `SUPPORTED_AUDIO_FORMATS` 不是同一个集合：前者是 API 的出参能力（决定容器与
 * 扩展名），后者是 ASR 可接受的**输入**文件格式描述。二者此前被混用为同一份列表，
 * 导致 schema 枚举、请求体归一化与落盘扩展名各自漂移。
 */
export const TTS_OUTPUT_FORMATS = ["mp3", "wav", "flac", "pcm"];
export const DEFAULT_TTS_FORMAT = "mp3";

/** ASR 可接受的输入音频文件格式（仅用于描述与文档，不做请求体校验）。 */
export const SUPPORTED_AUDIO_FORMATS = ["mp3", "wav", "flac", "pcm", "aac", "m4a", "opus"];

/** ASR 支持的输出格式；顺序即 schema enum 顺序。 */
export const ASR_RESPONSE_FORMATS = ["json", "verbose_json", "srt", "vtt"];
export const DEFAULT_ASR_RESPONSE_FORMAT = "json";

export const MAX_TTS_TEXT_CHARS = 10000;

/* ------------------------------------------------------------------ *
 * 传输预算
 * ------------------------------------------------------------------ */

/**
 * 宿主单次 `network.fetch` RPC 的硬上限是 30s（不是可调优参数），
 * 所有出站请求都必须显式声明并落在此上限内。
 */
export const REQUEST_TIMEOUT_MS = 30000;
/** 音频 URL 下载留出余量，仍低于 30s 硬上限。 */
export const AUDIO_DOWNLOAD_TIMEOUT_MS = 28000;

/** JSON 信封响应上限（8 MiB）。 */
export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
/** TTS 响应内联 hex 音频，上限放宽，但仍为 RPC 信封（base64 ≈1.33x）留出余量。 */
export const MAX_TTS_RESPONSE_BYTES = 24 * 1024 * 1024;
/**
 * ASR 本地 / 远端音频的传输上限，与视频参考素材同口径。
 *
 * 此前该常量定义后从未被引用（死代码），本地文件路径因此无界进内存并内联进
 * multipart。工具层（见 02 票）必须以它为硬约束：先 stat、读后复校、计入预算。
 */
export const MAX_ASR_FILE_BYTES = 12 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * TTS 请求体与落盘格式
 * ------------------------------------------------------------------ */

/** 把任意输入归一化到 API 接受的 TTS 输出格式；非法 / 缺失值回落到 mp3。 */
export function normaliseTtsFormat(format) {
  const lower = typeof format === "string" ? format.trim().toLowerCase() : "";
  return TTS_OUTPUT_FORMATS.includes(lower) ? lower : DEFAULT_TTS_FORMAT;
}

/**
 * TTS 落盘文件扩展名——必须由**归一化后**的格式派生，而不是原始入参。
 *
 * 请求体 `audio_setting.format` 回显的正是同一个归一化值，因此二者永远一致：
 * 若拿原始 `args.format` 拼扩展名，一个 API 不接受的入参（如 "aac"）会产出
 * 「容器是 mp3、扩展名是 .aac」的不一致产物，下游播放器按错误容器解析。
 */
export function ttsFileExtension(format) {
  return `.${normaliseTtsFormat(format)}`;
}

/**
 * 组装并校验 TTS 请求体
 */
export function buildTtsRequestBody({
  text,
  model = DEFAULT_TTS_MODEL,
  voiceId = DEFAULT_VOICE_ID,
  speed = 1.0,
  vol = 1.0,
  pitch = 0,
  format = DEFAULT_TTS_FORMAT,
  sampleRate = 32000,
  bitrate = 128000,
  outputFormat = "hex",
  subtitleEnable = false,
  subtitleType = "sentence",
  soundEffects = undefined,
} = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("TTS 合成文本 (text) 不能为空");
  }
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new Error(`TTS 合成文本长度超过限制（${text.length} > ${MAX_TTS_TEXT_CHARS} 字符）`);
  }

  const resolvedModel = SUPPORTED_TTS_MODELS.includes(model) ? model : DEFAULT_TTS_MODEL;
  const resolvedFormat = normaliseTtsFormat(format);

  const body = {
    model: resolvedModel,
    text: text.trim(),
    stream: false,
    language_boost: "auto",
    output_format: outputFormat === "url" ? "url" : "hex",
    voice_setting: {
      voice_id: voiceId || DEFAULT_VOICE_ID,
      speed: Math.max(0.5, Math.min(2.0, Number(speed) || 1.0)),
      vol: Math.max(0.1, Math.min(10.0, Number(vol) || 1.0)),
      pitch: Math.max(-12, Math.min(12, Number(pitch) || 0)),
    },
    audio_setting: {
      sample_rate: Number(sampleRate) || 32000,
      bitrate: Number(bitrate) || 128000,
      format: resolvedFormat,
      channel: 1,
    },
  };

  if (subtitleEnable) {
    body.subtitle_enable = true;
    body.subtitle_type = subtitleType === "word" ? "word" : "sentence";
  }

  if (soundEffects) {
    body.voice_modify = {
      pitch: 0,
      intensity: 0,
      timbre: 0,
      sound_effects: String(soundEffects),
    };
  }

  return body;
}

/**
 * 将 MiniMax 返回的 hex 编码音频解码为 Buffer
 *
 * 对奇数长度与非十六进制字符显式报错：`Buffer.from(x, "hex")` 会静默截断
 * （"abc" → 1 字节）或产出空 buffer（"zz" → 0 字节），把上游的坏数据伪装成
 * 一段「成功但空」的音频。
 */
export function decodeHexAudio(hexStr) {
  if (typeof hexStr !== "string" || !hexStr.trim()) {
    throw new Error("音频 hex 数据为空");
  }
  const clean = hexStr.trim();
  if (clean.length % 2 !== 0) {
    throw new Error(`音频 hex 数据长度非法：${clean.length} 个字符（应为偶数）`);
  }
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("音频 hex 数据包含非十六进制字符");
  }
  return Buffer.from(clean, "hex");
}

/**
 * 校验 ASR 参数并返回标准化配置
 */
export function validateAsrParams({
  model = DEFAULT_ASR_MODEL,
  responseFormat = DEFAULT_ASR_RESPONSE_FORMAT,
  timestampLevel = "word",
} = {}) {
  const resolvedModel = SUPPORTED_ASR_MODELS.includes(model) ? model : DEFAULT_ASR_MODEL;
  const resolvedFormat = ASR_RESPONSE_FORMATS.includes(responseFormat)
    ? responseFormat
    : DEFAULT_ASR_RESPONSE_FORMAT;

  return {
    model: resolvedModel,
    response_format: resolvedFormat,
    timestamp_level: timestampLevel === "segment" ? "segment" : "word",
    stream: "false",
  };
}
