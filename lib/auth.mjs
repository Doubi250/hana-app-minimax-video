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
