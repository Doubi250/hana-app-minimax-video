# 已知限制

- **本地参考素材经 base64 内联**进请求体。受宿主 RPC 传输预算约束：**单文件 ≤12MB、
  总量 ≤16MB**，超出会明确报错提示压缩。参考素材越大，提交越慢。
- **下载依赖 CDN 支持 Range 分片**（8MB 一片）。服务器忽略 `Range` 时走整段下载，
  单次 RPC 仍受 30 秒限制 —— 大文件可能因此超时失败，可稍后重试。
- 下载总大小保护上限 1GB。
- **成品视频从 MiniMax 侧 CDN 下载**（实测为 `*.aliyuncs.com`），故 `network.allowedHosts`
  需覆盖该域；CDN 域名变更时须同步更新白名单（README §6 故障表有对应条目）。
- 单次 RPC 上限 30 秒：这是宿主进程间的硬约束，不是可以调优的参数。
- **面板凭证状态恒为「已配置」**（`authType: none` 的设计代价）：「Token Plan 是否真的
  配好」由能力源探测透传为灰灯/提示，但面板上的「已配置」字样本身不反映真实凭证状态。
  机制详见 [credential-mechanism.md](credential-mechanism.md)。
