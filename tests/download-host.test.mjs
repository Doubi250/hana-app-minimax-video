/**
 * tests/download-host.test.mjs — `node --test tests/download-host.test.mjs`
 *
 * T6：下载 URL 的 host 纵深校验。
 *
 * 校验的面在生产代码里就两个：`assertDownloadHost(url, suffixes)`（抛错的入口）
 * 与 `isDownloadHostAllowed(host, suffixes)`（纯判定），以及 `downloadToFile` 在
 * 发起任何请求**之前**调用前者。全部离线——没有网络，fetch 是注入的探针。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DOWNLOAD_HOST_SUFFIXES,
  assertDownloadHost,
  isDownloadHostAllowed,
} from "../lib/download-host.mjs";
import { downloadToFile } from "../lib/minimax-client.mjs";

/* 1. 唯一可扩常量 ----------------------------------------------------- */

test("DOWNLOAD_HOST_SUFFIXES: 是唯一可扩白名单，默认只放行 MiniMax CDN", () => {
  assert.deepEqual(DOWNLOAD_HOST_SUFFIXES, ["*.aliyuncs.com"]);
});

/* 2. 合法域通过 ------------------------------------------------------- */

test("assertDownloadHost: 合法 CDN 域（子域 / 裸域 / 深层子域）通过并原样返回", () => {
  const ok = [
    "https://v.aliyuncs.com/videos/out.mp4",
    "https://aliyuncs.com/file.mp4",
    "https://a.b.aliyuncs.com/deep/path/file.mp4?sign=x",
    "http://aliyuncs.com/file.mp4",
  ];
  for (const url of ok) {
    assert.equal(assertDownloadHost(url), url, `${url} 应通过`);
    assert.equal(isDownloadHostAllowed(new URL(url).hostname), true);
  }
});

test("assertDownloadHost: 前后空白被 trim 后仍判定通过", () => {
  assert.equal(
    assertDownloadHost("  https://v.aliyuncs.com/a.mp4  "),
    "https://v.aliyuncs.com/a.mp4",
  );
});

/* 3. 伪后缀拒绝（不用天真 endsWith） ---------------------------------- */

test("assertDownloadHost: 伪后缀与同后缀的伪装域一律拒绝", () => {
  const bad = [
    "https://evil-aliyuncs.com/v.mp4", // 前缀拼接
    "https://notaliyuncs.com/v.mp4", // 无点边界
    "https://aliyuncs.com.evil.com/v.mp4", // 域在后缀位置
    "https://evil.com/v.mp4", // 毫不相干
    "https://sub.evil-aliyuncs.com/v.mp4", // 伪装域的子域
  ];
  for (const url of bad) {
    assert.throws(() => assertDownloadHost(url), /DOWNLOAD_HOST_SUFFIXES/, `${url} 应被拒`);
    assert.equal(isDownloadHostAllowed(new URL(url).hostname), false);
  }
});

test("isDownloadHostAllowed: 匹配是「相等」或「.域 结尾」，不是裸 endsWith", () => {
  assert.equal(isDownloadHostAllowed("aliyuncs.com", ["*.aliyuncs.com"]), true);
  assert.equal(isDownloadHostAllowed("a.aliyuncs.com", ["*.aliyuncs.com"]), true);
  assert.equal(isDownloadHostAllowed("a.b.aliyuncs.com", ["*.aliyuncs.com"]), true);
  assert.equal(isDownloadHostAllowed("evil-aliyuncs.com", ["*.aliyuncs.com"]), false);
  assert.equal(isDownloadHostAllowed("xaliyuncs.com", ["*.aliyuncs.com"]), false);
});

/* 4. 大小写与端口容错 ------------------------------------------------ */

test("assertDownloadHost: 主机名大小写与端口被归一（HOST:443 通过）", () => {
  assert.equal(
    assertDownloadHost("HTTPS://CDN.ALIYUNCS.COM:443/v.mp4"),
    "HTTPS://CDN.ALIYUNCS.COM:443/v.mp4",
  );
  assert.equal(isDownloadHostAllowed("CDN.ALIYUNCS.COM"), true);
  // 非默认端口的伪造主机仍被拒（端口不参与白名单）。
  assert.throws(() => assertDownloadHost("https://evil-aliyuncs.com:443/v.mp4"), /DOWNLOAD_HOST_SUFFIXES/);
});

test("assertDownloadHost: 尾点（FQDN 全限定写法）不导致误拒", () => {
  assert.equal(assertDownloadHost("https://v.aliyuncs.com./v.mp4"), "https://v.aliyuncs.com./v.mp4");
});

/* 5. 错误信息指向唯一修改点，且不回带完整 URL ------------------------- */

test("assertDownloadHost: 拒绝文案回带 host 且指向 DOWNLOAD_HOST_SUFFIXES", () => {
  let err;
  try {
    assertDownloadHost("https://evil-aliyuncs.com/secret.mp4?sig=leaked");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "必须抛错");
  assert.match(err.message, /evil-aliyuncs\.com/);
  assert.match(err.message, /DOWNLOAD_HOST_SUFFIXES/);
  assert.doesNotMatch(err.message, /sig=leaked/, "不得回带查询串里的签名");
});

/* 6. 形状不合法的输入 ------------------------------------------------ */

test("assertDownloadHost: 非 http(s) 协议与非法 URL 明确报错", () => {
  assert.throws(() => assertDownloadHost("ftp://v.aliyuncs.com/v.mp4"), /协议/);
  assert.throws(() => assertDownloadHost("ws://v.aliyuncs.com/v.mp4"), /协议/);
  assert.throws(() => assertDownloadHost("data:text/plain,hi"), /协议/);
  assert.throws(() => assertDownloadHost("not a url"), /URL 无效/);
  assert.throws(() => assertDownloadHost(""), /URL 无效/);
});

/* 7. 可扩：显式传入 suffixes 覆盖默认白名单 --------------------------- */

test("assertDownloadHost: 显式 suffixes 决定判定，默认常量不被修改", () => {
  assert.equal(assertDownloadHost("https://cdn.example.com/a.mp4", ["*.example.com"]), "https://cdn.example.com/a.mp4");
  assert.throws(() => assertDownloadHost("https://v.aliyuncs.com/a.mp4", ["*.example.com"]), /DOWNLOAD_HOST_SUFFIXES/);
  // 前缀 `*.` 可省略，两种写法等价。
  assert.equal(isDownloadHostAllowed("cdn.example.com", ["example.com"]), true);
  assert.deepEqual(DOWNLOAD_HOST_SUFFIXES, ["*.aliyuncs.com"], "默认常量未被改写");
});

/* 8. 接线：downloadToFile 在发请求之前校验 ---------------------------- */

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-download-host-"));
  return { dir, file: path.join(dir, name) };
}

test("downloadToFile: 白名单外的 host 在发出任何请求前即被拒绝", async () => {
  const { dir, file } = tempFile("out.mp4");
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  await assert.rejects(
    () => downloadToFile({ fetch: fetchStub, url: "https://evil-aliyuncs.com/v.mp4", partPath: file }),
    /DOWNLOAD_HOST_SUFFIXES/,
  );
  assert.equal(calls, 0, "被拒的 host 不得产生任何出站请求");
  assert.equal(fs.existsSync(file), false, "被拒时不落盘");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("downloadToFile: 白名单内的 CDN host 正常走完下载", async () => {
  const { dir, file } = tempFile("out.mp4");
  const bytes = Buffer.from("minimax-video-bytes");
  const fetchStub = async () => ({
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const written = await downloadToFile({
    fetch: fetchStub,
    url: "https://v.aliyuncs.com/v.mp4",
    partPath: file,
  });
  assert.equal(written, bytes.length);
  assert.equal(fs.readFileSync(file, "utf8"), "minimax-video-bytes");
  fs.rmSync(dir, { recursive: true, force: true });
});
