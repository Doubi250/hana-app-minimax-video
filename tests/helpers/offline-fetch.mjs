/**
 * tests/helpers/offline-fetch.mjs — a fake `globalThis.fetch` for CLI contract tests.
 *
 * Loaded through `node --import <this file> scripts/ext-voice-clone.mjs`, so it is
 * evaluated *before* the CLI entry module and can stand in for the network. The
 * CLI is a standalone script (not host-mediated), so it legitimately reaches for
 * `globalThis.fetch`; swapping it here keeps the contract test fully offline.
 *
 * Behaviour is chosen by `MMS_FAKE_MODE`:
 *   - "ok"          upload + voice_clone both succeed (default)
 *   - "upload_fail" upload returns a non-zero base_resp envelope
 *   - "clone_fail"  voice_clone returns a non-zero base_resp envelope
 *
 * Every request is appended as one JSON line to `MMS_FAKE_LOG` (when set), so a
 * test can assert what the CLI actually sent.
 */
import fs from "node:fs";

const mode = String(process.env.MMS_FAKE_MODE || "ok").trim();
const logPath = String(process.env.MMS_FAKE_LOG || "").trim();

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(payload);
  return {
    ok,
    status,
    async text() {
      return text;
    },
    async arrayBuffer() {
      const u8 = new TextEncoder().encode(text);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

function record(url, init) {
  if (!logPath) return;
  try {
    const body = Buffer.isBuffer(init?.body)
      ? init.body.toString("utf-8").slice(0, 200)
      : typeof init?.body === "string"
        ? init.body.slice(0, 200)
        : null;
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ url: String(url), method: init?.method, timeoutMs: init?.timeoutMs, body })}\n`,
    );
  } catch {
    // Logging is best-effort; the contract under test is the CLI's stdout.
  }
}

globalThis.fetch = async (url, init = {}) => {
  record(url, init);
  const target = String(url);

  if (target.includes("/v1/files/upload")) {
    if (mode === "upload_fail") {
      return jsonResponse({ base_resp: { status_code: 1004, status_msg: "fake upload failure" } });
    }
    return jsonResponse({
      file: { file_id: "file-fake-1", bytes: 44, filename: "sample.wav", purpose: "voice_clone" },
      base_resp: { status_code: 0, status_msg: "success" },
    });
  }

  if (target.includes("/v1/voice_clone")) {
    if (mode === "clone_fail") {
      return jsonResponse({ base_resp: { status_code: 1002, status_msg: "fake clone failure" } });
    }
    const sent = (() => {
      try {
        return JSON.parse(String(init.body));
      } catch {
        return {};
      }
    })();
    return jsonResponse({
      voice_id: sent.voice_id || "file-fake-1",
      base_resp: { status_code: 0, status_msg: "success" },
    });
  }

  return jsonResponse({ message: "unexpected URL" }, { ok: false, status: 404 });
};
