/**
 * lib/auth.mjs
 *
 * Credential selection for the MiniMax video adapter.
 *
 * Credentials come from the OpenHanako provider side (the MiniMax Token Plan
 * provider), not from an app-local setting: this app has no settings page.
 *
 * Pure and host-free on purpose: no `ctx.*`, no filesystem, no network. The
 * caller injects the provider lookup (a host-bus round trip), so the whole
 * decision is unit-testable with `node --test` and no key.
 *
 * Priority, highest first:
 *   1. credentials handed straight to `submit` / `query` (host context)
 *   2. the first provider in `providerCandidates` that yields a credential
 *      (defaults to MiniMax Token Plan)
 *
 * Nothing here logs, echoes or persists a key.
 */

/** The provider whose credentials are used when the call carries no explicit lane. */
export const FALLBACK_PROVIDER_ID = "minimax-token-plan";

/** Drop empty / non-string header values; keep the rest as strings. */
export function normaliseHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (raw === undefined || raw === null || raw === "") continue;
    out[key] = String(raw);
  }
  return out;
}

/**
 * A credential is usable when it carries a non-empty apiKey or at least one
 * non-empty header. Everything else (null, `{ error }`, `{}`) is "no credential".
 *
 * @returns {{ apiKey?: string, headers?: Record<string, string> } | null}
 */
export function usableAuth(value) {
  if (!value || typeof value !== "object") return null;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  const headers = normaliseHeaders(value.headers);
  const headerCount = Object.keys(headers).length;
  if (!apiKey && headerCount === 0) return null;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(headerCount ? { headers } : {}),
  };
}

/**
 * Decide which credentials the adapter should use.
 *
 * @param {object} input
 * @param {unknown} input.hostAuth               credentials already present on the submit/query call
 * @param {readonly string[]} [input.providerCandidates]  provider ids to try, in order
 * @param {(providerId: string) => Promise<unknown>} [input.requestHostCredentials]
 * @returns {Promise<{ source: string, apiKey?: string, headers?: Record<string, string> } | null>}
 */
export async function resolveCredentialAuth({
  hostAuth,
  providerCandidates = [FALLBACK_PROVIDER_ID],
  requestHostCredentials,
} = {}) {
  const explicit = usableAuth(hostAuth);
  if (explicit) return { source: "host-context", ...explicit };

  if (typeof requestHostCredentials !== "function") return null;

  const seen = new Set();
  for (const candidate of providerCandidates || []) {
    const providerId = typeof candidate === "string" ? candidate.trim() : "";
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    let result = null;
    try {
      result = await requestHostCredentials(providerId);
    } catch {
      // A denied grant or an unconfigured provider just means "try the next one".
      result = null;
    }
    const auth = usableAuth(result);
    if (auth) return { source: `provider:${providerId}`, ...auth };
  }

  return null;
}

/** The hint shown when no usable credential can be resolved for an outbound call. */
export const NOT_CONFIGURED_MESSAGE =
  "未取得 MiniMax 凭证：请确认已在 设置 → 供应商 中配置可用的 MiniMax Token Plan，并已授予本应用 app/provider.credentials.read 权限。";

/**
 * Build the credential resolver every outbound call path shares.
 *
 * The media adapter and the `minimax_context_ir` tool borrow the same provider
 * lane, so "which credential does this call use" must have exactly one answer
 * in this app — this factory is that single place. The same three rules as the
 * adapter always had:
 *   1. credentials handed straight to the call win (host context);
 *   2. provider hints are tried in order, then the MiniMax Token Plan lane;
 *   3. a hint naming this app itself is skipped — it has no self-hosted
 *      credential (no settings page, no app-local key).
 *
 * `bus` is injected and nothing here logs, echoes or persists a key.
 *
 * @param {object} input
 * @param {{ request?: Function }} [input.bus]  host bus (the `provider:credentials` door)
 * @param {string} [input.selfProviderId]       this app's own provider id
 */
export function createCredentialResolver({ bus, selfProviderId = "" } = {}) {
  /** Read a provider's credentials through the host bus; never logs or persists them. */
  async function requestHostCredentials(providerId) {
    if (!providerId || typeof bus?.request !== "function") return null;
    try {
      const result = await bus.request("provider:credentials", { providerId });
      if (!result || typeof result !== "object" || typeof result.error === "string") return null;
      return { apiKey: result.apiKey, headers: result.headers };
    } catch {
      return null;
    }
  }

  /** Pick the credential to use: an explicit one, else the first provider lane that resolves. */
  async function resolveAuth(params = {}, ctx = {}) {
    const hostAuth = params?.credentials ?? params?.credential ?? ctx?.credentials ?? null;
    const candidates = [];
    for (const hinted of [params?.credentialProviderId, ctx?.credentialProviderId]) {
      // Skip a hint that names this app itself (see the factory doc above).
      if (typeof hinted === "string" && hinted.trim() && hinted.trim() !== selfProviderId) {
        candidates.push(hinted.trim());
      }
    }
    candidates.push(FALLBACK_PROVIDER_ID);
    return resolveCredentialAuth({ hostAuth, providerCandidates: candidates, requestHostCredentials });
  }

  /** Resolve or throw the app-standard "not configured" error. */
  async function requireAuth(params = {}, ctx = {}) {
    const auth = await resolveAuth(params, ctx);
    if (!auth) throw new Error(NOT_CONFIGURED_MESSAGE);
    return auth;
  }

  return { resolveAuth, requireAuth };
}
