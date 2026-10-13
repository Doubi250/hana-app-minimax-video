/**
 * tests/http-util.test.mjs — `node --test tests/http-util.test.mjs`
 *
 * 共享 HTTP 工具（scrub 错误脱敏与 withAuth 请求头装配）单测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scrub, withAuth, assertBaseRespOk } from "../lib/http-util.mjs";

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
