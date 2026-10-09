# 凭证机制：lane、面板状态与「未配置」提示

本文说明本 App 凭证设计里相对宿主（Hana 1.0.6-beta）能力的两处适配：凭证 lane 的
声明位置，以及媒体面板凭证状态如何被驱动。面向维护者/审阅者；普通用户只需读
README §3。

## 1. 本 App 不持有凭证

凭证**只**取自宿主的 **MiniMax Token Plan** 供应商（`provider:credentials` 门）。
取回可能是 `apiKey`，也可能是自定义请求头（`headers`）——两种都处理，不落盘、
不回显、不写日志。

优先顺序（高 → 低）：

1. **宿主上下文直接带来的凭证**（若宿主在某次调用里附带 `credentials`）；
2. **宿主在本次调用里暗示的凭证 provider**（`credentialProviderId`，若存在且不是本 App 自己）；
3. **MiniMax Token Plan 供应商**（缺省）。

三条都取不到时，`checkAuth` / 生成会报：
`未取得 MiniMax 凭证：请确认已在 设置 → 供应商 中配置可用的 MiniMax Token Plan，并已授予本应用 app/provider.credentials.read 权限。`

## 2. 凭证 lane 只能声明在运行时快照里

App 在运行时能力快照里声明一条凭证 lane：`minimax-token-plan`。lane **只能**声明在
运行时快照里——静态 manifest 的 `capabilities.media.*` 只接受 `models` 一个键，
写别的键会让整个 App 拒载（已用 `validate_app.mjs` 真机复现）。

App 自己的取凭证逻辑（`lib/auth.mjs`）与这条 lane 一致，且**不依赖**宿主是否读取
运行时 lane。

## 3. 为什么 manifest `authType` 是 `none`

宿主 1.0.6-beta 的媒体面板读 `getMediaProviderCredentialStatus` →
`getMediaCredentialLanes`，后者只读 **provider entry** 的
`capabilities.media.<kind>.credentialLanes`；该 entry 由 manifest 贡献构建，而
manifest 侧不认 `credentialLanes`。运行时快照里的 lane 虽被归一化保存进
`_runtimeMediaCapabilities`，但面板与 `resolveMediaModel` 都不查它——「凭证借自别的
provider」无法用 lane 表达给面板。

处理：把本 provider 的 manifest `authType` 声明为 **`none`**——含义是「宿主凭证存储
不是本 provider 的凭证权威，凭证由 App 自行解析」。面板的凭证状态随之由
`_credentialStatusForLane` 直接判为可用，不再显示 `no credentials`；与内置的
`jimeng-cli`（外部 CLI 自管凭证）同型。

## 4. 面板「未配置」提示：refresh() 抛错是唯一通道

`authType: none` 让面板恒报「已配置」，因此「Token Plan 是否真的配好」由能力源探测
透传：能力源每次被宿主询问都探一次 `provider:credentials`（无缓存）。取不到凭证时
**直接抛错**（`code: no_credentials` + 中文提示）：宿主捕获后把该 provider 置为
非就绪，面板随即显示 `unavailableReason: no_credentials` /
`unavailableMessage`（灰灯，即梦未装 CLI 时同款）。

抛错是唯一通道——宿主对成功 refresh 只存 `media`/`version`/`fingerprint` 并硬编码
`status: "ready"`，返回值里的附加字段到不了面板。

三种情况被刻意区分开：

| 探测结果 | 面板表现 |
|---|---|
| 取到 `apiKey` 或非空 `headers` | 正常，无提示 |
| 返回 `{ error }` / 空 key | 灰灯：`unavailableReason: no_credentials` + 中文提示 |
| 能力未授权 / 宿主无此门 / 探测异常 | **保持绿色**——这是权限或环境问题，不是供应商配置问题，生成时的报错会说明 |

「未授权不置灰」是有意的：权限问题不能伪装成供应商配置问题；真到生成那一步，App
的报错会把两个前置（配置供应商 + 授权）分别说清。

## 5. 代价与边界

- Token Plan 未配置期间，本 provider 在面板上整体置灰、模型列表收起；配好 key 后
  下一次面板刷新即恢复（探测无缓存）。
- 能力源每次被宿主询问都多一次 `provider:credentials` 总线往返；模型表本身是静态的，
  无额外开销。
- 若宿主未来改为读取运行时 lane，本 App 无需再改动即可正确显示凭证来源。
