/**
 * tests/http-util.test.mjs — `node --test tests/http-util.test.mjs`
 *
 * 共享 HTTP 工具（scrub 错误脱敏与 withAuth 请求头装配）单测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBaseRespOk,
  clampHostTimeout,
  envelopeStatusMessage,
  hasBaseResp,
  httpError,
  isBaseRespError,
  parseJsonSafe,
  readResponseText,
  scrub,
  withAuth,
} from "../lib/http-util.mjs";

test("http-util: scrub 脱敏 Bearer 凭据", () => {
  assert.equal(scrub("Bearer eyJhbGciOi..."), "Bearer [redacted]");
  assert.equal(scrub("Error with Bearer sk-1234567890 occurred"), "Error with Bearer [redacted] occurred");
});

test("http-util: scrub 脱敏裸 sk- 凭据", () => {
  assert.equal(scrub("Invalid sk-abcdef1234567890 key"), "Invalid [redacted] key");
  assert.equal(scrub("Key sk-ant-api03-abcdef123 rejected"), "Key [redacted] rejected");
});

test("http-util: scrub 处理边界值（null / undefined / 空）", () => {
  assert.equal(scrub(null), "");
  assert.equal(scrub(undefined), "");
  assert.equal(scrub("Normal error message"), "Normal error message");
});

test("http-util: withAuth 装配 apiKey 为 Bearer 头", () => {
  const headers = withAuth({ "Content-Type": "application/json" }, { apiKey: "my-key" });
  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer my-key",
  });
});

test("http-util: withAuth 合并 auth.headers 且过滤空值", () => {
  const headers = withAuth(
    { Accept: "*/*" },
    { headers: { "X-Custom": "val", "X-Empty": "", "X-Null": null, "X-Undef": undefined } },
  );
  assert.deepEqual(headers, {
    Accept: "*/*",
    "X-Custom": "val",
  });
});

test("http-util: withAuth 缺省参数或空 auth 安全返回", () => {
  assert.deepEqual(withAuth(), {});
  assert.deepEqual(withAuth({ "User-Agent": "agent" }), { "User-Agent": "agent" });
  assert.deepEqual(withAuth({ "User-Agent": "agent" }, null), { "User-Agent": "agent" });
});

/* assertBaseRespOk：信封语义的单一来源（ticket 10 / D） --------------- */

test("assertBaseRespOk: status_code === 0 通过并原样返回 json", () => {
  const json = { base_resp: { status_code: 0, status_msg: "success" }, task_id: "t" };
  assert.equal(assertBaseRespOk(json), json);
  assert.equal(assertBaseRespOk(json, { label: "某操作失败" }), json);
});

test("assertBaseRespOk: status_code 缺失（undefined）视为失败", () => {
  assert.throws(() => assertBaseRespOk({}, { label: "声音克隆失败" }), /声音克隆失败/);
  assert.throws(
    () => assertBaseRespOk({ base_resp: {} }, { label: "异步 TTS 创建失败" }),
    /异步 TTS 创建失败/,
  );
  // 显式 null 同样视为失败（不是「跳过校验」）。
  assert.throws(
    () => assertBaseRespOk({ base_resp: { status_code: null } }, { label: "X" }),
    /X/,
  );
});

test("assertBaseRespOk: 非 0 状态码失败，并回带 code 与 status", () => {
  let err;
  try {
    assertBaseRespOk(
      { base_resp: { status_code: 1004, status_msg: "bad key" } },
      { label: "声音克隆失败", status: 200 },
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, "非 0 必须抛错");
  assert.equal(err.code, 1004);
  assert.equal(err.status, 200);
  assert.match(err.message, /1004/);
  assert.match(err.message, /bad key/);
});

test("assertBaseRespOk: 非对象（未解析出 JSON）失败", () => {
  assert.throws(() => assertBaseRespOk(null, { label: "X" }), /无效的 JSON/);
  assert.throws(() => assertBaseRespOk(undefined, { label: "X" }), /无效的 JSON/);
  assert.throws(() => assertBaseRespOk("nope", { label: "X" }), /无效的 JSON/);
  assert.throws(() => assertBaseRespOk([], { label: "X" }), /无效的 JSON/);
});

test("assertBaseRespOk: 错误信息经 scrub 脱敏", () => {
  assert.throws(
    () =>
      assertBaseRespOk(
        { base_resp: { status_code: 1004, status_msg: "invalid key Bearer sk-abcdef1234567890" } },
        { label: "声音克隆失败" },
      ),
    (err) => !/sk-abcdef1234567890/.test(err.message) && /\[redacted\]/.test(err.message),
  );
});

/* readResponseText：三处本地副本的统一版 ------------------------------- */

function textResponse(text) {
  return { async text() { return text; } };
}

function throwingResponse() {
  return { async text() { throw new Error("socket hang up"); } };
}

test("readResponseText: 正常读取文本体", async () => {
  assert.equal(await readResponseText(textResponse("{\"a\":1}")), '{"a":1}');
  assert.equal(await readResponseText(textResponse("")), "");
});

test("readResponseText: 读失败（连接中断）返回空串，不抛出", async () => {
  assert.equal(await readResponseText(throwingResponse()), "");
});

test("readResponseText: 非字符串体被 String() 归一", async () => {
  assert.equal(await readResponseText({ async text() { return 42; } }), "42");
});

/* parseJsonSafe：空 / 坏 JSON / 合法体 --------------------------------- */

test("parseJsonSafe: 合法 JSON 解析为对象/数组", () => {
  assert.deepEqual(parseJsonSafe('{"task_id":"t"}'), { task_id: "t" });
  assert.deepEqual(parseJsonSafe("[1,2]"), [1, 2]);
});

test("parseJsonSafe: 空文本与坏 JSON 返回 null", () => {
  assert.equal(parseJsonSafe(""), null);
  assert.equal(parseJsonSafe(undefined), null);
  assert.equal(parseJsonSafe(null), null);
  assert.equal(parseJsonSafe("<html>502</html>"), null);
  assert.equal(parseJsonSafe("{not json"), null);
});

/* httpError：错误拼装 + 脱敏 + .status ------------------------------- */

test("httpError: 非 2xx 拼装 label/status 并挂 .status", () => {
  const err = httpError({ label: "Files 上传失败", status: 502, text: JSON.stringify({ message: "boom" }) });
  assert.equal(err.status, 502);
  assert.match(err.message, /Files 上传失败 \(502\): boom/);
});

test("httpError: 文案优先级——信封 status_msg > error.message > message > 原始文本", () => {
  const envelope = httpError({
    label: "X",
    status: 200,
    text: JSON.stringify({ base_resp: { status_msg: "信封文案" }, error: { message: "e" }, message: "m" }),
  });
  assert.match(envelope.message, /信封文案/);

  const errMsg = httpError({ label: "X", status: 200, text: JSON.stringify({ error: { message: "e" }, message: "m" }) });
  assert.match(errMsg.message, /: e/);

  const msg = httpError({ label: "X", status: 200, text: JSON.stringify({ message: "m" }) });
  assert.match(msg.message, /: m/);

  const raw = httpError({ label: "X", status: 200, text: "  plain failure  " });
  assert.match(raw.message, /: plain failure/);
});

test("httpError: 空体回落到 defaultLabel，再回落「未知错误」", () => {
  assert.match(httpError({ defaultLabel: "语音合成失败", status: 500, text: "" }).message, /语音合成失败 \(500\): 语音合成失败/);
  assert.match(httpError({ status: 500, text: "" }).message, /未知错误/);
});

test("httpError: 错误文本经 scrub 脱敏", () => {
  const err = httpError({ defaultLabel: "X", status: 401, text: "denied Bearer sk-abcdef1234567890" });
  assert.doesNotMatch(err.message, /sk-abcdef1234567890/);
  assert.match(err.message, /\[redacted\]/);
});

/* clampHostTimeout：超时钳制的唯一实现 -------------------------------- */

test("clampHostTimeout: 缺省/非法回落到上限", () => {
  assert.equal(clampHostTimeout(undefined), 30000);
  assert.equal(clampHostTimeout(null), 30000);
  assert.equal(clampHostTimeout("nope"), 30000);
  assert.equal(clampHostTimeout(-1), 30000);
  assert.equal(clampHostTimeout(0), 30000);
});

test("clampHostTimeout: 超过上限被夹到 cap，正整数向下取整", () => {
  assert.equal(clampHostTimeout(999999), 30000);
  assert.equal(clampHostTimeout(1234.9), 1234);
  assert.equal(clampHostTimeout(1000, 500), 500);
  assert.equal(clampHostTimeout(200, 500), 200);
});

/* 信封判定的辅助读取：base_resp 字段名的收敛面 --------------------------- */

test("hasBaseResp: 仅对象且携带 base_resp 为真", () => {
  assert.equal(hasBaseResp({ base_resp: { status_code: 0 } }), true);
  assert.equal(hasBaseResp({}), false);
  assert.equal(hasBaseResp(null), false);
  assert.equal(hasBaseResp([]), false);
  assert.equal(hasBaseResp("x"), false);
});

test("envelopeStatusMessage: 回带非空 status_msg，否则空串", () => {
  assert.equal(envelopeStatusMessage({ base_resp: { status_msg: "boom" } }), "boom");
  assert.equal(envelopeStatusMessage({ base_resp: {} }), "");
  assert.equal(envelopeStatusMessage({}), "");
});

test("isBaseRespError: 显式非 0 状态码才为真（缺 status_code 不算报错）", () => {
  assert.equal(isBaseRespError({ base_resp: { status_code: 1004 } }), true);
  assert.equal(isBaseRespError({ base_resp: { status_code: 0 } }), false);
  assert.equal(isBaseRespError({ base_resp: {} }), false);
  assert.equal(isBaseRespError({}), false);
});

/* 空文本 / 缺 base_resp 的组合快照 ------------------------------------- */

test("组合快照：空文本 → parseJsonSafe null → assertBaseRespOk 报无效 JSON", () => {
  const json = parseJsonSafe("");
  assert.equal(json, null);
  assert.throws(() => assertBaseRespOk(json, { label: "X" }), /无效的 JSON/);
});

test("组合快照：缺 base_resp 的 JSON 体 → assertBaseRespOk 视为失败", () => {
  const json = parseJsonSafe('{"task_id":"t"}');
  assert.equal(hasBaseResp(json), false);
  assert.throws(() => assertBaseRespOk(json, { label: "X" }), /X/);
});
