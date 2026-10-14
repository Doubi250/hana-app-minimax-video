/**
 * tests/credentials.test.mjs — `node --test tests/credentials.test.mjs`
 *
 * Offline coverage for credential selection (lib/auth.mjs), the request-header
 * merge (lib/minimax-client.mjs) and the published credential lane. No key and
 * no network are involved: the provider lookup and `fetch` are injected stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FALLBACK_PROVIDER_ID,
  normaliseHeaders,
  resolveCredentialAuth,
  usableAuth,
} from "../lib/auth.mjs";
import { buildCapabilitySnapshot } from "../lib/snapshot.mjs";
import { createMinimaxClient } from "../lib/minimax-client.mjs";

/* 1. usableAuth ----------------------------------------------------- */

test("usableAuth: rejects empties, accepts a key or non-empty headers", () => {
  assert.equal(usableAuth(null), null);
  assert.equal(usableAuth(undefined), null);
  assert.equal(usableAuth({}), null);
  assert.equal(usableAuth({ apiKey: "   " }), null);
  assert.equal(usableAuth({ apiKey: "" }), null);
  assert.equal(usableAuth({ error: "no_credentials" }), null);
  assert.equal(usableAuth({ headers: {} }), null);
  assert.equal(usableAuth({ headers: { "X-A": "" } }), null);
  assert.deepEqual(usableAuth({ apiKey: " k " }), { apiKey: "k" });
  assert.deepEqual(usableAuth({ headers: { "X-A": "1" } }), { headers: { "X-A": "1" } });
  assert.deepEqual(usableAuth({ apiKey: "k", headers: { "X-A": "1", "X-B": "" } }), {
    apiKey: "k",
    headers: { "X-A": "1" },
  });
});

test("normaliseHeaders: drops non-strings-able junk, coerces the rest", () => {
  assert.deepEqual(normaliseHeaders(undefined), {});
  assert.deepEqual(normaliseHeaders(["nope"]), {});
  assert.deepEqual(normaliseHeaders({ a: 1, b: null, c: "x", "": "skip" }), { a: "1", c: "x" });
});

/* 2. resolveCredentialAuth ----------------------------------------- */

test("host context wins and the provider side is never consulted", async () => {
  let calls = 0;
  const auth = await resolveCredentialAuth({
    hostAuth: { apiKey: "host" },
    requestHostCredentials: async () => {
      calls += 1;
      return { apiKey: "provider" };
    },
  });
  assert.deepEqual(auth, { source: "host-context", apiKey: "host" });
  assert.equal(calls, 0);
});

test("default candidate is the MiniMax Token Plan provider", async () => {
  const seen = [];
  const auth = await resolveCredentialAuth({
    requestHostCredentials: async (providerId) => {
      seen.push(providerId);
      return { apiKey: "tp-key", headers: { "X-Extra": "1" } };
    },
  });
  assert.deepEqual(seen, [FALLBACK_PROVIDER_ID]);
  assert.deepEqual(auth, {
    source: `provider:${FALLBACK_PROVIDER_ID}`,
    apiKey: "tp-key",
    headers: { "X-Extra": "1" },
  });
});

test("candidates are walked in order until one resolves", async () => {
  const seen = [];
  const auth = await resolveCredentialAuth({
    providerCandidates: ["first-lane", "second-lane"],
    requestHostCredentials: async (providerId) => {
      seen.push(providerId);
      return providerId === "second-lane" ? { apiKey: "second" } : null;
    },
  });
  assert.deepEqual(seen, ["first-lane", "second-lane"]);
  assert.deepEqual(auth, { source: "provider:second-lane", apiKey: "second" });
});

test("a thrown lookup falls through to the next candidate", async () => {
  const auth = await resolveCredentialAuth({
    providerCandidates: ["denied", FALLBACK_PROVIDER_ID],
    requestHostCredentials: async (providerId) => {
      if (providerId === "denied") throw new Error("grant denied");
      return { apiKey: "tp" };
    },
  });
  assert.deepEqual(auth, { source: `provider:${FALLBACK_PROVIDER_ID}`, apiKey: "tp" });
});

test("headers alone are enough", async () => {
  const auth = await resolveCredentialAuth({
    requestHostCredentials: async () => ({ headers: { Authorization: "SomeOther xyz" } }),
  });
  assert.deepEqual(auth, {
    source: `provider:${FALLBACK_PROVIDER_ID}`,
    headers: { Authorization: "SomeOther xyz" },
  });
});

test("blank, duplicate and non-string candidates are skipped", async () => {
  const seen = [];
  const auth = await resolveCredentialAuth({
    providerCandidates: ["", "  ", null, FALLBACK_PROVIDER_ID, FALLBACK_PROVIDER_ID, 42],
    requestHostCredentials: async (providerId) => {
      seen.push(providerId);
      return { apiKey: "k" };
    },
  });
  assert.deepEqual(seen, [FALLBACK_PROVIDER_ID]);
  assert.equal(auth.apiKey, "k");
});

test("nothing configured (or no lookup at all): null", async () => {
  assert.equal(await resolveCredentialAuth({ requestHostCredentials: async () => null }), null);
  assert.equal(await resolveCredentialAuth({ requestHostCredentials: async () => ({ error: "no_credentials" }) }), null);
  assert.equal(await resolveCredentialAuth({}), null);
});

/* 3. request headers ----------------------------------------------- */

function mockFetch(responder) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  };
}

const OK_JSON = { ok: true, status: 200, text: async () => JSON.stringify({ task_id: "t1" }) };

test("client: apiKey becomes a Bearer Authorization header", async () => {
  const { calls, fetch } = mockFetch(() => OK_JSON);
  const client = createMinimaxClient({ fetch });
  await client.createTask({ auth: { apiKey: "k" }, body: { model: "MiniMax-H3" } });
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("client: provider headers are copied verbatim, no Bearer added", async () => {
  const { calls, fetch } = mockFetch(() => OK_JSON);
  const client = createMinimaxClient({ fetch });
  await client.createTask({ auth: { headers: { "X-Token": "abc" } }, body: {} });
  assert.equal(calls[0].init.headers["X-Token"], "abc");
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("client: queryTask carries the credential and hits the query path", async () => {
  const { calls, fetch } = mockFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ task: { status: "running" } }) }));
  const client = createMinimaxClient({ fetch });
  const remote = await client.queryTask({ auth: { apiKey: "k" }, taskId: "abc 1" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.ok(calls[0].url.endsWith("/v2/query/video_generation/abc%201"));
  assert.equal(remote.mapped, "pending");
});

test("client: a legacy bare apiKey still works", async () => {
  const { calls, fetch } = mockFetch(() => OK_JSON);
  const client = createMinimaxClient({ fetch });
  await client.createTask({ apiKey: "legacy", body: {} });
  assert.equal(calls[0].init.headers.Authorization, "Bearer legacy");
});

/* 4. published credential lane ------------------------------------- */

test("snapshot: the only credential lane is the MiniMax Token Plan provider", () => {
  const video = buildCapabilitySnapshot().media.videoGeneration;
  assert.deepEqual(video.credentialLanes.map((lane) => lane.id), [FALLBACK_PROVIDER_ID]);
  assert.deepEqual(video.credentialLanes.map((lane) => lane.providerId), [FALLBACK_PROVIDER_ID]);
  for (const lane of video.credentialLanes) {
    assert.equal(typeof lane.label, "string");
    assert.ok(lane.label.length > 0);
  }
});

/* 5. manifest guards ----------------------------------------------- */

test("manifest: provider is authType none and there is no settings page", () => {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const provider = (manifest.contributes?.providers || []).find((p) => p.id === manifest.id);
  // authType "none" is what makes the media panel report credentials as available.
  // With "api-key" the host looks up its own credential store and reports
  // no_credentials for this provider (see README §3 / §9).
  assert.equal(provider?.authType, "none");
  assert.equal(manifest.contributes?.settings, undefined, "this app keeps no settings page");
  assert.ok(manifest.capabilities.includes("app/provider.credentials.read"));
});

test("manifest: 能力源快照 version 与 manifest.json version 保持一致", () => {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const snapshot = buildCapabilitySnapshot();
  assert.equal(snapshot.version, manifest.version);
});

