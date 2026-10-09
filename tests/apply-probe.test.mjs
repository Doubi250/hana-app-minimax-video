/**
 * tests/apply-probe.test.mjs — `node --test tests/apply-probe.test.mjs`
 *
 * The runtime capability source is the one piece of `apply(ctx)` that reaches
 * the media panel, so its contract is pinned here: when the borrowed provider
 * has no usable credential, `refresh()` THROWS — that is the only transport for
 * `unavailableReason`/`unavailableMessage`, because the host stores just
 * `media`/`version`/`fingerprint` from a successful refresh and hard-codes
 * `status: "ready"` (bundle: `_refreshRuntimeMediaCapability`). A denied grant
 * or a missing bus door must NOT throw (permissions/environment ≠ provider
 * state) — the panel stays green and generation carries the explanation.
 *
 * Everything is offline: the host is a stub object, no key, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = (await import(pathToFileURL(path.join(appRoot, "index.mjs")))).apply;
const { buildCapabilitySnapshot, throwLaneUnavailable } = await import(
  pathToFileURL(path.join(appRoot, "lib", "minimax-api.mjs"))
);

function hostStub({ credentialsResult }) {
  const calls = { credentials: [], registered: null, adapter: null };
  const bus = {
    async request(verb, payload) {
      if (verb === "provider:credentials") {
        calls.credentials.push(payload);
        return typeof credentialsResult === "function" ? credentialsResult(payload) : credentialsResult;
      }
      throw new Error(`unexpected bus verb: ${verb}`);
    },
  };
  const ctx = {
    bus,
    logger: { infos: [], warns: [], errors: [], async info(m) { this.infos.push(m); }, async warn(m) { this.warns.push(m); }, async error(m) { this.errors.push(m); } },
    media: {
      async registerCapabilitySource(providerId, source) { calls.registered = { providerId, source }; },
      async registerAdapter(adapter) { calls.adapter = adapter; },
    },
  };
  return { ctx, calls };
}

test("token plan usable → plain snapshot", async () => {
  const { ctx, calls } = hostStub({ credentialsResult: { apiKey: "k".repeat(10) } });
  await apply(ctx);
  assert.ok(calls.registered, "capability source registered");
  const snap = await calls.registered.source.refresh();
  assert.equal(snap.media.videoGeneration.models.length, 2);
  assert.equal(calls.credentials.length, 2, "one probe at apply + one per refresh (no caching by design)");
  assert.ok(calls.credentials.every((c) => c.providerId === "minimax-token-plan"));
});

test("token plan not configured → refresh() THROWS with the host-facing code and message", async () => {
  const { ctx, calls } = hostStub({ credentialsResult: { error: "no_credentials" } });
  await apply(ctx);
  await assert.rejects(
    calls.registered.source.refresh(),
    (error) => error.code === "no_credentials" && /MiniMax Token Plan/.test(error.message),
    "throwing is the only way to reach the panel's unavailableReason/unavailableMessage",
  );
});

test("empty credential object counts as missing, not present", async () => {
  const { ctx, calls } = hostStub({ credentialsResult: { apiKey: "   " } });
  await apply(ctx);
  await assert.rejects(
    calls.registered.source.refresh(),
    (error) => error.code === "no_credentials",
  );
});

test("headers-only credential counts as present", async () => {
  const { ctx, calls } = hostStub({ credentialsResult: { headers: { Authorization: "X y" } } });
  await apply(ctx);
  const snap = await calls.registered.source.refresh();
  assert.ok(snap.media.videoGeneration.models.length > 0, "headers are a usable credential");
});

test("a denied grant keeps the panel green (permissions ≠ provider state)", async () => {
  const { ctx, calls } = hostStub({
    credentialsResult: async () => {
      throw new Error('v2 app "minimax-video" is not authorized to call provider:credentials — the user has not granted "app/provider.credentials.read"');
    },
  });
  await apply(ctx);
  const snap = await calls.registered.source.refresh();
  assert.ok(snap.media.videoGeneration.models.length > 0, "denied grant must not darken the panel");
  assert.equal(ctx.logger.warns.length, 0, "a denied grant is not the provider's fault — stay quiet");
});

test("an unexpected probe error degrades to the plain snapshot", async () => {
  const { ctx, calls } = hostStub({
    credentialsResult: async () => {
      throw new Error("bus exploded");
    },
  });
  await apply(ctx);
  const snap = await calls.registered.source.refresh();
  assert.equal(snap.media.videoGeneration.models.length, 2);
});

test("no bus at all → plain snapshot (absent door, not a provider problem)", async () => {
  const { ctx, calls } = hostStub({ credentialsResult: null });
  ctx.bus = undefined;
  await apply(ctx);
  const snap = await calls.registered.source.refresh();
  assert.equal(snap.media.videoGeneration.models.length, 2);
});

test("throwLaneUnavailable produces the code+message pair the host projects", () => {
  assert.throws(
    () => throwLaneUnavailable({ reason: "no_credentials", message: "x" }),
    (error) => error.code === "no_credentials" && error.message === "x",
  );
  try {
    throwLaneUnavailable();
    assert.fail("must throw");
  } catch (error) {
    assert.equal(error.code, "no_credentials");
    assert.match(error.message, /MiniMax Token Plan/);
  }
});

test("throwLaneUnavailable keeps the snapshot builder itself clean", () => {
  const snap = buildCapabilitySnapshot();
  assert.equal(snap.status, undefined);
  assert.equal(snap.error, undefined);
  assert.equal(snap.media.videoGeneration.models.length, 2);
  assert.equal(snap.media.videoGeneration.credentialLanes.length, 1);
});
