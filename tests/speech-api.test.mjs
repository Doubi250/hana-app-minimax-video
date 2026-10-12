import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTtsRequestBody,
  decodeHexAudio,
  validateAsrParams,
  normaliseTtsFormat,
  ttsFileExtension,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_ID,
  DEFAULT_ASR_MODEL,
  DEFAULT_TTS_FORMAT,
  TTS_OUTPUT_FORMATS,
  REQUEST_TIMEOUT_MS,
  MAX_ASR_FILE_BYTES,
} from "../lib/speech-api.mjs";

test("buildTtsRequestBody: 组装标准参数", () => {
  const body = buildTtsRequestBody({
    text: "你好，这是一段测试文本",
    voiceId: "female-yujie",
    speed: 1.2,
    pitch: 2,
    vol: 1.5,
    subtitleEnable: true,
  });

  assert.equal(body.text, "你好，这是一段测试文本");
  assert.equal(body.model, DEFAULT_TTS_MODEL);
  assert.equal(body.voice_setting.voice_id, "female-yujie");
  assert.equal(body.voice_setting.speed, 1.2);
  assert.equal(body.voice_setting.pitch, 2);
  assert.equal(body.voice_setting.vol, 1.5);
  assert.equal(body.subtitle_enable, true);
  assert.equal(body.subtitle_type, "sentence");
  assert.equal(body.output_format, "hex");
});

test("buildTtsRequestBody: 边界保护与非法输入阻断", () => {
  assert.throws(() => buildTtsRequestBody({ text: "" }), /文本.*不能为空/);
  assert.throws(() => buildTtsRequestBody({ text: "   " }), /文本.*不能为空/);

  // 速度越界保护
  const bodyFast = buildTtsRequestBody({ text: "test", speed: 5.0 });
  assert.equal(bodyFast.voice_setting.speed, 2.0);

  const bodySlow = buildTtsRequestBody({ text: "test", speed: 0.1 });
  assert.equal(bodySlow.voice_setting.speed, 0.5);
});

test("buildTtsRequestBody: 非法 format 归一化为 mp3 并回显在请求体", () => {
  const body = buildTtsRequestBody({ text: "test", format: "aac" });
  assert.equal(body.audio_setting.format, "mp3");
  assert.ok(TTS_OUTPUT_FORMATS.includes(body.audio_setting.format));
});

test("ttsFileExtension: 扩展名由归一化格式派生，与请求体回显一致", () => {
  // 原始入参是 API 不接受的 "aac"：请求体回落 mp3，扩展名也必须回落 .mp3，
  // 而不是跟着原始入参产出容器/扩展名不一致的 .aac 文件。
  const body = buildTtsRequestBody({ text: "test", format: "aac" });
  assert.equal(body.audio_setting.format, "mp3");
  assert.equal(ttsFileExtension("aac"), `.${body.audio_setting.format}`);
  assert.equal(ttsFileExtension("aac"), ".mp3");

  // 大小写与空白同样归一化
  assert.equal(ttsFileExtension("  WAV "), ".wav");
  assert.equal(ttsFileExtension(undefined), `.${DEFAULT_TTS_FORMAT}`);
  assert.equal(normaliseTtsFormat("flac"), "flac");
});

test("decodeHexAudio: 正常解码十六进制音频流", () => {
  const hex = "48656c6c6f20417564696f"; // "Hello Audio" 的 hex
  const buffer = decodeHexAudio(hex);
  assert.equal(buffer.toString("utf-8"), "Hello Audio");
});

test("decodeHexAudio: 空输入抛错", () => {
  assert.throws(() => decodeHexAudio(""), /为空/);
});

test("decodeHexAudio: 奇数长度输入报错而非静默截断", () => {
  // Buffer.from("abc", "hex") 会静默截断为 1 字节；这里必须显式报错。
  assert.throws(() => decodeHexAudio("abc"), /长度非法/);
  assert.throws(() => decodeHexAudio("48656c6c6f2"), /长度非法/);
});

test("decodeHexAudio: 非十六进制字符报错而非静默产出空 buffer", () => {
  assert.throws(() => decodeHexAudio("zzzz"), /非十六进制/);
  assert.throws(() => decodeHexAudio("48656c6c6f2041zz"), /非十六进制/);
});

test("validateAsrParams: 组装与兜底", () => {
  const standard = validateAsrParams({
    responseFormat: "verbose_json",
    timestampLevel: "segment",
  });
  assert.equal(standard.model, DEFAULT_ASR_MODEL);
  assert.equal(standard.response_format, "verbose_json");
  assert.equal(standard.timestamp_level, "segment");

  const fallback = validateAsrParams({
    responseFormat: "invalid_format",
  });
  assert.equal(fallback.response_format, "json");
});

test("传输预算常量: 超时 ≤ 30000 且 ASR 单文件上限已就位", () => {
  assert.ok(REQUEST_TIMEOUT_MS <= 30000);
  assert.ok(MAX_ASR_FILE_BYTES > 0 && MAX_ASR_FILE_BYTES <= 12 * 1024 * 1024);
});
