/**
 * lib/http-util.mjs
 *
 * 共享 HTTP 管道：请求头装配、响应文本读取、JSON 解析、HTTP 错误拼装、
 * 超时钳制与响应信封校验。**这些逻辑的唯一实现处**——其余模块一律从这里
 * 导入，不得再复制本地副本。
 *
 * 安全相关：scrub 作为全工程防密钥泄漏的唯一定义，统一处理 Bearer 与 sk- 凭据；
 * withAuth 统一合并 auth.headers 与 auth.apiKey。
 *
 * 信封语义：assertBaseRespOk 是 `base_resp.status_code` 判定语义的唯一来源——
 * **HTTP 2xx 且 `status_code === 0` 才算成功，`status_code` 缺失视为失败**。
 * 模块外的代码不再直接读 `base_resp`：需要判定时用 `hasBaseResp` + `assertBaseRespOk`，
 * 需要读取信封文案时用 `envelopeStatusMessage`。
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
 * 读取响应体为文本；读失败（连接被中途掐断等）返回 `""`。
 *
 * 收拢自 `readText` / `parseResponseText` / `parseText` 三处本地副本。
 */
export async function readResponseText(response) {
  try {
    return String(await response.text());
  } catch {
    return "";
  }
}

/**
 * 安全解析 JSON 文本：空串或解析失败返回 `null`。
 *
 * 收拢自各模块同构的本地 `parseJson`。
 */
export function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 已解析的响应体是否携带 `base_resp` 信封对象。
 *
 * 让 `base_resp` 这个字段名的所有提及都收敛在本模块内：调用方用本判定 + `assertBaseRespOk`
 * 表达「仅当信封存在时才校验」，用 `envelopeStatusMessage` 读取信封文案。
 *
 * @param {unknown} json 已解析的响应体
 */
export function hasBaseResp(json) {
  return Boolean(
    json && typeof json === "object" && !Array.isArray(json) && json.base_resp,
  );
}

/**
 * 信封是否携带一个**显式的非 0 状态码**（错误信封）。
 *
 * 注意与 `assertBaseRespOk` 的口径差异：本函数是「是否报错」的宽判定（缺 `status_code` 不算报错），
 * 供那些把「非 JSON / 非信封体」当作另一类情形单独处理的路径使用（`speech-client` 的 ASR
 * 字幕分支）。而 `assertBaseRespOk` 是「是否成功」的严判定，`status_code` 缺失即失败。
 *
 * @param {unknown} json 已解析的响应体
 */
export function isBaseRespError(json) {
  const code = json?.base_resp?.status_code;
  return code !== undefined && code !== null && code !== 0;
}

/**
 * 信封的 `status_msg` 文案；无信封或无声明的消息时返回 `""`。
 *
 * @param {unknown} json 已解析的响应体
 */
export function envelopeStatusMessage(json) {
  return (hasBaseResp(json) && json.base_resp.status_msg) || "";
}

/**
 * 组装一个已脱敏的 HTTP 错误（非 2xx 响应或传输层失败）。
 *
 * 收拢自三处本地 `apiError` / `formatApiError` / `formatHttpError`：
 *   - 文案优先级：信封 `status_msg` > `error.message` > `message` > 原始文本（截 300 字）
 *   - 结果一律经 `scrub` 脱敏，并挂上 `.status`
 *
 * @param {object}  [opts]
 * @param {string}  [opts.label]       错误前缀（如「Files 上传失败」）
 * @param {number}  [opts.status]      HTTP 状态（回显在文案里，并挂到 `.status`）
 * @param {string}  [opts.text]        原始响应文本
 * @param {string}  [opts.defaultLabel] 缺省前缀兼兜底文案
 */
export function httpError({ label, status, text, defaultLabel } = {}) {
  const prefix = label ?? defaultLabel ?? "MiniMax API 错误";
  const json = parseJsonSafe(text);
  const message =
    envelopeStatusMessage(json) ||
    json?.error?.message ||
    json?.message ||
    String(text ?? "").trim().slice(0, 300) ||
    defaultLabel ||
    "未知错误";
  const error = new Error(scrub(`${prefix} (${status}): ${message}`));
  error.status = status;
  return error;
}

/**
 * 把超时钳到宿主的单次出站硬上限内（毫秒），并给出正整数。
 *
 * 收拢自 `files-client.resolveTimeout` 与 `async-tts.resolveTimeout`（两副本逻辑相同）：
 * 缺省 / 非法值回落到上限，正值向下取整后不超过上限。
 *
 * @param {unknown} timeoutMs
 * @param {number}  [cap=30000] 宿主 RPC 硬上限
 */
export function clampHostTimeout(timeoutMs, cap = 30000) {
  const n = Number(timeoutMs);
  const candidate = Number.isFinite(n) && n > 0 ? n : cap;
  return Math.min(Math.floor(candidate), cap);
}

/**
 * 校验 MiniMax 响应信封：**HTTP 2xx 且 `base_resp.status_code === 0`** 才算成功。
 *
 * 语义的**单一来源**：
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
