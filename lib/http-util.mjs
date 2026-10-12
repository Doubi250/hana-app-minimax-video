/**
 * lib/http-util.mjs
 *
 * 共享 HTTP 工具：请求头装配与错误脱敏。
 *
 * 安全相关：scrub 作为全工程防密钥泄漏的唯一定义，统一处理 Bearer 与 sk- 凭据；
 * withAuth 统一合并 auth.headers 与 auth.apiKey。
 */

/**
 * 把 `Bearer …` 与 `sk-…` 之类的凭据从错误文本里脱敏（防泄漏护栏）。
 *
 * 匹配：
 *   - `Bearer <token>`
 *   - `sk-<key>`（长度 ≥ 6 的字母数字及 `_`/`-`）
 */
export function scrub(message) {
  return String(message ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=_-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]");
}

/**
 * 将显式凭据合并到请求头。
 *
 *   - auth.headers 逐项复制（过滤 undefined/null/""）
 *   - auth.apiKey 装配为 Authorization: Bearer <apiKey>
 *   - 兼容缺省入参与非对象 auth 传参
 */
export function withAuth(baseHeaders = {}, auth = {}) {
  const headers = { ...baseHeaders };
  if (auth?.headers && typeof auth.headers === "object") {
    for (const [key, val] of Object.entries(auth.headers)) {
      if (val !== undefined && val !== null && val !== "") {
        headers[key] = String(val);
      }
    }
  }
  if (auth?.apiKey) {
    headers.Authorization = `Bearer ${String(auth.apiKey)}`;
  }
  return headers;
}
