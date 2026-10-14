/**
 * lib/download-host.mjs
 *
 * 下载 URL 的 host 纵深校验（T6）。
 *
 * 远端任务返回的 `content.url` / Files 的 `download_url` 是**外部输入**：过去
 * `downloadToFile` 完全信任它，唯一的约束是 `manifest.json` 里那串宽通配
 * `allowedHosts`（`*.aliyuncs.com` / `*.minimax.cn` / `*.hailuoai.com` …）。宽通配
 * 是宿主的出站策略，不是接收端的判断——本模块在发起请求前把「成品从 MiniMax 侧
 * CDN 下载」这件事写成**一处显式常量**，域名变更时错误信息直接指向它。
 *
 * 纯函数、无 IO、无宿主依赖，可离线单测。
 */

/**
 * MiniMax 成品 CDN 的显式白名单——**唯一可扩常量**。
 *
 * 条目形如 `"*.aliyuncs.com"`：匹配该域本身（`aliyuncs.com`）与其任意深度的子域
 * （`a.aliyuncs.com` / `a.b.aliyuncs.com`），**不**匹配后缀相同的仿冒域
 * （`evil-aliyuncs.com`、`aliyuncs.com.evil.com`）。前缀 `*.` 可省略，两种写法等价。
 *
 * MiniMax 侧 CDN 域名变更（实测为 `*.aliyuncs.com`，见 docs/known-limitations.md）时，
 * 改这里并同步 `manifest.json` 的 `network.allowedHosts`（放行出站）。本常量是下载被拒
 * 时错误信息指向的修改点。
 */
export const DOWNLOAD_HOST_SUFFIXES = ["*.aliyuncs.com"];

/** 把白名单条目归一为裸域：去空白、小写、去前导 `*.` / `.`。 */
function normaliseSuffix(suffix) {
  return String(suffix ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\./, "");
}

/**
 * `host` 是否落在某个白名单域内。
 *
 * 匹配严格为「相等」或「以 `.` + 域结尾」，**不用天真 `endsWith`**——否则
 * `evil-aliyuncs.com` 会被 `aliyuncs.com` 误放行。
 *
 * @param {string} host     已小写的裸主机名（无端口）
 * @param {string[]} [suffixes]
 */
export function isDownloadHostAllowed(host, suffixes = DOWNLOAD_HOST_SUFFIXES) {
  const target = String(host ?? "").trim().toLowerCase();
  if (!target) return false;
  for (const suffix of suffixes ?? []) {
    const base = normaliseSuffix(suffix);
    if (!base) continue;
    if (target === base || target.endsWith(`.${base}`)) return true;
  }
  return false;
}

/**
 * 校验下载 URL：协议限 http(s)、带主机名、且主机落在 `suffixes` 白名单内。
 *
 * 不通过即抛错。白名单不命中时的提示必须指向唯一修改点（`DOWNLOAD_HOST_SUFFIXES`）：
 * MiniMax 换 CDN 会让下载失败，这条文案是排查的起点。错误信息**只回带主机名**，
 * 不回带完整 URL——CDN 下载链接常带签名查询串，不进日志以免泄漏。
 *
 * 大小写与端口容错：URL 解析后取 `hostname`（已去端口）并小写，`HTTPS://A.ALIYUNCS.COM:443/x`
 * 归一为 `a.aliyuncs.com`。
 *
 * @param {string} url
 * @param {string[]} [suffixes]
 * @returns {string} 校验通过的原始 URL（trim 后）
 */
export function assertDownloadHost(url, suffixes = DOWNLOAD_HOST_SUFFIXES) {
  const raw = String(url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("下载 URL 无效：需要一个 http(s) 绝对 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`下载 URL 协议不受支持：${parsed.protocol}（仅支持 http/https）`);
  }
  // 尾点（FQDN 全限定写法 a.aliyuncs.com.）归一掉，避免等价主机被误拒。
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new Error("下载 URL 缺少主机名");
  if (!isDownloadHostAllowed(host, suffixes)) {
    throw new Error(
      `下载被拒绝：${host} 不在 MiniMax CDN 白名单内；` +
        "MiniMax CDN 域名可能变更，请更新 DOWNLOAD_HOST_SUFFIXES（lib/download-host.mjs）",
    );
  }
  return raw;
}
