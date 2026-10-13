/**
 * lib/http-util.mjs
 *
 * 共享 HTTP 工具：请求头装配、错误脱敏与响应信封校验。
 *
 * 安全相关：scrub 作为全工程防密钥泄漏的唯一定义，统一处理 Bearer 与 sk- 凭据；
 * withAuth 统一合并 auth.headers 与 auth.apiKey。
 *
 * 信封语义：assertBaseRespOk 是 `base_resp.status_code` 判定语义的唯一来源——
 * 与 `lib/files-client.mjs` 的 `unwrapEnvelope` 对齐：**HTTP 2xx 且 `status_code === 0`
 * 才算成功，`status_code` 缺失视为失败**。
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

/**
 * 校验 MiniMax 响应信封：**HTTP 2xx 且 `base_resp.status_code === 0`** 才算成功。
 *
 * 语义的**单一来源**，与 `lib/files-client.mjs` 的 `unwrapEnvelope` 对齐：
 *   - `status_code` 缺失（`undefined` / `null`）**视为失败**——MiniMax 的成功响应总带
 *     `base_resp`，缺失即异常（网关通告、被中间层改写的体、非预期载荷）；
 *   - 非 0（含字符串、负数）一律失败，错误信息回显 code 与 `status_msg`；
 *   - 传入非对象（未解析出 JSON）同样失败。
 *
 * 此前两处 CLI 实现语义相反：`lib/extensions/voice-clone.mjs` 把 `undefined` 当失败
 * （`!== 0`），而 `lib/extensions/async-tts.mjs` 把 `undefined` 当成功
 * （`code !== undefined && code !== null && code !== 0`）。本函数钉死为「缺失即失败」。
 *
 * HTTP 状态由调用方先行判定（`response.ok`）；本函数只管**已解析的 JSON 体**，
 * 因此可离线单测。
 *
 * @param {unknown} json          已解析的响应体
 * @param {object}  [opts]
 * @param {string}  [opts.label]  错误前缀（如「声音克隆失败」）
 * @param {number}  [opts.status] HTTP 状态（仅在错误信息里回显）
 * @returns {object} 同一个 json（成功时）
 */
export function assertBaseRespOk(json, { label = "MiniMax API 错误", status } = {}) {
  const prefix = `${label}${status ? ` (${status})` : ""}`;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(scrub(`${prefix}：接口返回了无效的 JSON 响应`));
  }
  const code = json.base_resp?.status_code;
  if (code !== 0) {
    const msg =
      json.base_resp?.status_msg || json.error?.message || json.message || "未知状态错误";
    const err = new Error(scrub(`${prefix} (${code}): ${msg}`));
    err.code = code;
    if (status) err.status = status;
    throw err;
  }
  return json;
}
