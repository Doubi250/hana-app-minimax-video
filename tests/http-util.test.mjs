/**
 * tests/http-util.test.mjs — `node --test tests/http-util.test.mjs`
 *
 * 共享 HTTP 工具（scrub 错误脱敏与 withAuth 请求头装配）单测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scrub, withAuth } from "../lib/http-util.mjs";

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
