# 分发装配与 Apple 首批配置

> 2026-10-09 一体化服务修复进行中：macOS 普通版和商店版现在共用包内服务启动路径，构建号为 1.0.7 的商店候选包尚不能提交审核或用于完整聊天录制。现有服务仍依赖本机 Codex 数据、桌面 IPC 与 Codex 程序；商店沙盒接入方案尚待确定，候选包的本机服务暂时只读。不要把“构建通过/包含辅助程序”视为“聊天功能验证通过”。

本阶段实现构建隔离和 SDK 接口，保留现有聊天与连接行为。包含 `ios-appstore`、`macos-appstore` 两个配置；支付、广告、统计和推送均为 `disabled`，不表示已接入 StoreKit、开通订阅或具备上架资格。不会因为模块关闭而授予付费权益，也不新增购买弹窗。

## 分层与入口

- `client/distributions/*.json`：平台、渠道、品牌、SDK 选择和能力。不得包含私钥或服务端秘密。
- `scripts/build-distribution.cjs`：严格校验配置，生成独立前端目录和 Tauri 覆盖配置，再调用本机 Tauri CLI。
- `client/src-tauri/build.rs`：验证目标操作系统与 Cargo features、禁止 App Store 混入 SSH/主机发现/内嵌网络，输出编译进程序的分发身份。
- `client/src-tauri/src/distribution.rs`：向内置窗口提供只读身份，不接受浏览器存储或远程配置覆盖。
- `client/ui/distribution.js`：加载身份并装配 SDK 服务，配置失败时不回退到权限更多的版本。
- `client/ui/services.js`：业务使用的支付、广告、统计、推送接口。当前仅包含明确返回 `unsupported` 的禁用适配器；权益快照返回 `unconfigured` 和空授权列表。

分发配置在构建时决定代码和资源，在启动时初始化共享 UI；用户是否付费属于未来的权益层，不应写成发行配置中的 `isPro`。

## 本地使用

在 `client` 目录运行：

```sh
# 只校验并显示配置，不启动 SDK、不连接账号
npm run distribution -- ios-appstore --check
npm run distribution -- macos-appstore --check

# 生成 .local/distributions/<id>/ui 和 tauri.conf.json
npm run distribution -- ios-appstore --prepare
npm run distribution -- macos-appstore --prepare

# macOS + Xcode 下构建无签名产物，不上传、不导出正式签名
npm run build:ios:appstore
npm run build:macos:appstore
```

构建入口不接受额外 Tauri/Cargo 参数覆盖模块选择。iOS 使用 `--no-sign --archive-only --ci`；macOS 使用 `--no-sign --ci`，仅生成 `.app`。使用 `universal-apple-darwin` 构建 ARM64 + x86_64 通用包，最低 macOS 12.0，商店分类为 Developer Tools。首次构建前运行 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`。各分发使用独立 Cargo target 目录。iOS 需要已有 Tauri/Xcode 生成工程；正式签名、商品配置、真机验证和提交商店属于后续工作。不要用默认 `npm run ios -- build` 代替分发入口，它仍使用原有直接分发配置。

`--prepare` 产物供检查使用；实际构建请使用 `--build` 或上述 npm 脚本，确保 `CODEX_DISTRIBUTION`、Tauri 配置及 Cargo feature 一致。重新生成只替换该分发自己的生成前端目录，清除旧 SDK 文件，不修改共享 UI 源码或其他渠道。

## 构建隔离

Apple 配置使用 `appstore` feature，不包含 `desktop-direct`、`ssh-deploy`、`system-discovery` 或 `embedded-tailscale`。`ssh2`、SSH 使用的哈希库和密码清理依赖改为按 feature 引入；其他依赖树可能自行依赖同名通用库，因此不以整个依赖树绝无 SHA 库作为判断标准。

iOS 不带本地服务。macOS 使用 `bundle-local-service.cjs` 生成 universal Go 辅助程序，放入 `Contents/MacOS/codex-remote-service`；不把 Windows 部署包或用户数据带入商店包。生成前端剔除 `deploy.js`，隐藏 SSH 设置。原生层不编译/注册 SSH 和主机 Tailscale 命令，直接调用这些 IPC 命令也不可用。连接失败时提供地址、网络和目标服务检查提示，不再进入 SSH 登录流程。

`service_probe.rs` 保留所有渠道共有的服务与版本检查。系统网络仍可连接 LAN/Tailscale 地址；不提供本机 Tailscale CLI 发现或内嵌 VPN。macOS 配置添加 App Sandbox、入站/出站网络及下载目录读写 entitlement；辅助程序单独签名并继承父进程沙盒；需要通过正式签名后的沙盒真机验证。iOS 继续使用现有 Info.plist 和最低系统版本。

原有 `npm run dev/build` 使用 Tauri 配置中的 `desktop-direct` feature，保留桌面行为。直接运行 Cargo 不会读取 Tauri CLI 的 feature 选择，验证旧桌面功能时需显式传入：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --features desktop-direct
```

网页本机开发服务使用独立的 `web-local` 身份，继续提供现有本机能力；它不是可公开部署的商店授权服务。

## 业务调用与新增 SDK

```js
await Distribution.ready;
const { billing, ads } = Distribution.services;
const result = await ads.show({ placement: 'reward_extra_usage' });
// 当前为 { status: 'unsupported', reason: 'provider_disabled' }
// 不得将 unsupported、cancelled、pending 或仅展示完成解释为奖励/付款成功。
```

支付契约：`listOffers / purchase / restore / manageSubscription`；广告契约：`show`；统计契约：`track`；推送契约：`requestPermission`。业务传逻辑广告位或商品 ID，由供应商适配器映射，不把厂商参数放进聊天页面。

接入实际供应商时需要同时完成：

1. 新增该供应商的 JS/原生适配器、必要的可选依赖和权限资源；在构建入口与 Rust 校验中登记支持的平台、feature 和能力。未登记的供应商现在直接导致构建失败。
2. 扩展服务装配，提供准确的 capability 与统一结果。购买至少区分 completed/pending/cancelled/failed；广告收益只来自可信奖励事件，且去重。空实现不能假装成功。
3. 为实际 SDK 实现生命周期：按供应商要求在适当同意/权限条件下初始化、按需加载、隔离失败、退出账号清除用户关联。当前 disabled 适配器无后台任务、无网络、无第三方初始化；本阶段没有假设一个已经可用的通用 SDK 生命周期引擎。
4. 添加渠道依赖裁剪、拒绝不合法组合、取消/失败/重复回调测试及原生真机验证，再在分发 JSON 选择该 provider。

Apple 支付下一步需要 StoreKit 原生桥接、商品映射、交易验证与更新监听、恢复和订阅管理。跨 Apple/Windows 共享权益再引入独立账号/权益后端；不要让用户电脑上的 Go 服务充当交易权威，不把聊天数据送进计费服务。

## 验证与边界

`npm test` 包含分发配置错误、未知 SDK、生成资源清理/隔离、禁用 SDK 不授予权益、原生身份加载失败以及商店版连接不调用 SSH/发现命令的测试。Rust 测试验证拆分后旧桌面代码的行为；两个 Apple target 还需分别编译检查。

本次本地验证：65 项 Node 测试通过；桌面原生测试 8 项通过，1 项读取真实 Tailscale 状态的测试保持忽略；iOS ARM64 与 macOS 编译检查通过；商店版和原有网络设置的桌面/手机界面测试通过。已生成无签名 macOS Debug `.app`，核对包内没有服务二进制、部署脚本，原生符号不包含 SSH/Tailscale 实现。拒绝混入桌面 feature、拒绝目标平台不匹配，以及 SSH/OpenSSL 依赖裁剪均已验证。尚未生成或验证 iOS Xcode archive、正式签名产物与真机商店流程。

编译成功不等于已验证 Swift/Xcode 链接、签名、Sandbox 实机运行、商店购买或审核。发布前需检查最终 `.app`/archive、签名权限与隐私声明；有实际 SDK 后再验证对应的隐私清单和渠道要求。

参考：[Tauri 配置合并](https://v2.tauri.app/develop/configuration-files/)、[Tauri App Store 分发](https://v2.tauri.app/distribute/app-store/)。

## 1.0 发布版本

客户端包、Tauri、Cargo、关于页面和服务版本统一为 1.0.0，配套兼容范围为 `1.0.0 ≤ version < 1.1.0`。仍报告 0.2.x 的旧服务需要更新；不绕过它声明的兼容上限。通用包包含 Intel x86_64 与 Apple Silicon ARM64，不支持 PowerPC、32 位 Intel 或 macOS 12 以前的系统。

## macOS 商店正式签名

在仓库根目录先完成通用 Release 构建，再执行本地签名打包：

```sh
node scripts/build-distribution.cjs macos-appstore --build
python3 scripts/package-macos-appstore.py \
  --profile /absolute/path/CodexRemotemacOSAppStore.provisionprofile \
  --installer-identity '3rd Party Mac Developer Installer: Company (TEAMID)'
```

钥匙串必须已有与描述文件匹配的 Apple Distribution 证书和私钥，以及同团队的 Mac Installer Distribution 证书和私钥。脚本检查描述文件平台、有效期、App ID、证书配对、版本与通用架构；将应用复制到独立的 `dist/macos-appstore/<version>-universal-signed-<timestamp>` 目录，嵌入描述文件并从中生成团队和应用标识 entitlements，然后签名 `.app`、生成签名 `.pkg` 并执行本地签名校验。生成目录包含 SHA-256 和签名元数据。若未来添加嵌套可执行代码，脚本会拒绝打包，需先增加对应的逐层签名步骤。

描述文件路径通过参数传入，私钥仅从钥匙串使用，不写入仓库。此命令不会上传；将输出 `.pkg` 添加到 Transporter 后，由苹果执行上传验证。通过本地校验不代表已经通过上传验证或 App Review，也不代表已完成签名沙盒下的端到端运行验证。

## 首次上架问题记录（2026-09-30）

### 1. 图标缺少 512pt @2x：90236

Transporter 报错：`Missing required icon. The application bundle does not have an icon in ICNS format containing a 512pt x 512pt @2x image.`

原因：原来的 `client/scripts/generate-icons.cjs` 只向 `icon.icns` 写入了 `ic09`（512×512 像素）。512pt @2x 实际要求 1024×1024 像素，已有的 512×512 图像不能代替该尺寸。

修复：保持原图标的绘制逻辑，按各尺寸重新生成图像；ICNS 加入标准与 Retina 表示，特别是 `ic10` 的 1024×1024 图像；`icon.png` 同时更新为 1024×1024。重新构建通用 Release 应用、签名并打包，不能只修改已经签名的包内资源。

验证：用系统 `iconutil --convert iconset` 展开 ICNS，用 `sips -g pixelWidth -g pixelHeight` 确认 `icon_512x512@2x.png` 为 1024×1024。签名打包脚本的 `verify_store_icon` 同时检查待签名应用和最终 `.pkg` 解包后的实际图标，缺少所需图像时直接失败。已验证旧图标被检查拒绝，新图标通过。

处理结果：修复图标的构建于当天 20:30:22 被 Transporter 报告 `UPLOAD SUCCEEDED with no errors`，但后续苹果处理阶段又发现下面的扩展属性问题。上传完成不等于后续处理完成或审核通过。

### 2. 包含 com.apple.quarantine 扩展属性：91109

苹果处理阶段报错：`Invalid package contents`，指出应用包内的 `Contents/embedded.provisionprofile` 带有 `com.apple.quarantine`，要求移除应用内所有文件的该属性后重新上传。

`com.apple.quarantine` 是 macOS 文件系统的扩展属性（extended attribute / xattr），不是文件正文，也不是签名证书。浏览器等应用会给下载文件附加这一来源标记，供系统安全检查使用；存在该标记不表示文件含有病毒。它与代码签名、苹果公证和描述文件各自负责不同的事情。

本次原因：浏览器下载的 `.provisionprofile` 原文件确实带有该属性。打包后，它仍出现在嵌入应用的描述文件上。原先只检查图标与签名完整性，未检查扩展属性，因此本地签名校验通过仍可能被苹果拒绝。

修复流程：

1. 将应用复制到独立的打包目录，嵌入描述文件。
2. 在签名前递归检查这个待打包副本，移除 `com.apple.quarantine`。不修改 Downloads 中的原始描述文件，不清空无关属性，也不修改系统安全设置。
3. 再次确认副本不含该属性，然后重新签名应用并生成签名 `.pkg`。
4. 使用 `pkgutil --expand-full` 展开最终 `.pkg`，重新检查实际载荷的扩展属性、图标和应用签名；任何检查失败均不作为可交付包。

代码位置：`scripts/package-macos-appstore.py` 的 `check_quarantine` 负责检查和清理，只在待签名副本上启用清理；最终解包检查仅验证，不修补已经生成的包。

手工只读检查示例：

```sh
# 列出下载文件的扩展属性名称
xattr /absolute/path/CodexRemotemacOSAppStore.provisionprofile
# 查看待检查应用及其内部文件的扩展属性
xattr -r '/absolute/path/Codex Remote Client.app'
```

本地验证：带 quarantine 的测试文件会被检查拒绝；清理后文件正文不变；原下载描述文件的属性保留；最终包解包后的 quarantine、ICNS 和签名检查通过。

此次修复保持应用版本 `1.0.0`，将 macOS 构建号递增为 `1.0.1`（在 `scripts/build-distribution.cjs` 的 `bundle.macOS.bundleVersion` 中配置）。新包位于 `dist/macos-appstore/1.0.0-universal-signed-20260930-203406/`，尚待重新上传并确认苹果处理结果。

### 上传排查时的注意事项

- 区分本地检查、Transporter 上传、苹果后台处理、App Review 四个阶段；前一阶段成功不能替代后一阶段的结果。
- Transporter 日志可能先列出同版本上一次失败记录，再执行本次上传。以本次最终结果判断上传状态，同时在 App Store Connect 确认后续处理状态。
- 每次修复都交付新的输出目录，并明确应用版本和构建号，避免将旧任务或旧安装包重新上传。
- 本次上架签名包用于 Transporter；本地直接运行被商店描述文件拦截属于另一类问题，不能通过删除签名权限或关闭系统安全检查来处理。运行测试应使用 TestFlight 或独立的开发签名测试包。

## macOS 上架代码审查（2026-09-30）

范围：`macos-appstore` 构建入口、原生 IPC/网络/媒体保存、前端存储与内容渲染、Cargo features、最终通用应用的 plist/动态依赖和签名包。结论是本次静态审查与本地构建验证结果，不等于苹果审核结论；没有在本次任务中登录修改商店资料、提交审核或测试 Intel 实机。iOS 需要单独检查其生成工程和隐私配置。

### 已修复的新增问题

- **局域网权限说明缺失**：`network.rs` 和 `service_probe.rs` 支持连接用户指定的局域网电脑，原 macOS Info.plist 没有用途说明。新增 `client/distributions/macos-appstore.Info.plist`，通过 Tauri 的 `bundle.macOS.infoPlist` 合并 `NSLocalNetworkUsageDescription`；已在构建产物中核对实际中文说明。依据：[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。此声明不代替用户授权，TestFlight 仍需验证首次允许、拒绝和再次授权后的行为。
- **打包防回归检查不足**：在已有图标、quarantine、证书、描述文件和架构检查之外，增加本地网络说明非空、App Sandbox 必须开启、调试权限必须关闭、拒绝 setuid/setgid 文件的检查。新构建号为 `1.0.2`，应用版本保持 `1.0.0`。

### 尚需完成，不能宣布全部合规

| 项目 | 当前证据与下一步 |
| --- | --- |
| 隐私政策入口（部分完成） | 初始连接列表及关于页加入可离线阅读的数据说明；正式公开隐私政策 URL、支持邮箱与运营数据处理事实尚待提供。草稿见 privacy-policy-draft.md，不能将应用内说明冒充完整公开政策。 |
| 审核可访问性 | 当前首次启动必须添加服务器，没有内置完整演示模式。需准备隔离的审核服务、测试凭据、使用步骤和样例数据，不能要求审核人员访问开发者私人电脑。 |
| 远程服务分类 | 客户端通过 HTTP API 显示会话、发送请求、处理远端批准，而非屏幕流；也支持非局域网地址。需审慎评估远程客户端相关规则 4.2.7 的适用性，这是解释和产品定位风险，不能仅凭应用名称断言符合或违反。不要在审核资料中隐瞒实际架构。 |
| 产品名称和品牌 | 当前名称包含 Codex。应确认第三方名称使用权限及避免官方关联误解；本次没有验证商标授权，也没有擅自更名。 |
| 明文 HTTP（已修复） | `address.js` 对无协议地址补 HTTP；Rust 网络层允许 HTTP，登录 token、消息和附件可能经明文传输。现已在商店版前端及 Rust 连接/探测入口强制 HTTPS，并保留证书验证。无协议地址默认 HTTPS/443；网站直发渠道保留原行为。旧 HTTP 连接需部署受信任 TLS 终端后重新添加。 |
| 本地数据保留（已修复） | 删除电脑清除对应 localStorage/sessionStorage 命名空间及原生 cookie 客户端，取消请求/流，阻止页面退出重新写入草稿。其他电脑及全局偏好保留。删除不会撤销服务器会话、删除远端记录或已下载文件；应用内已有说明。 |
| 隐私标签与清单 | 未发现项目自带 `PrivacyInfo.xcprivacy`。这本身不足以证明 macOS 包必然不合规。应按实际 SDK、API 和数据流决定清单内容；不要为通过检查机械填空清单或声称无数据收集。正式 App Privacy 问卷尚未核对，运营方是否接收/保留服务器数据需确认。 |
| 加密出口问卷 | 网络依赖使用 rustls；没有自动写入 `ITSAppUsesNonExemptEncryption=false`。必须按实际加密使用与苹果问卷完成声明，不能从“支持 HTTPS”直接推断最终答案。 |

隐私政策、审核访问、名称与远程客户端风险参考：[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)（5.1.1、2.1、4.1、4.2.7）。数据披露参考：[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)；SDK 要求参考：[Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)。上表中对项目的适用性与风险判断是代码审查推断，不是苹果预审结果。

### 本次检查未发现明显问题的部分

- 商店版 Cargo features 不含 `ssh-deploy`、`system-discovery`、`embedded-tailscale`；实际 feature 树未匹配到 `libssh2`、`openssl-sys` 或 `macos-private-api`。不能用包含其他渠道依赖的 Cargo.lock 直接认定商店包包含它们。
- 包内 Resources 仅有图标；共享 UI 编译嵌入程序，没有服务器 sidecar。JS 库从打包资源加载；聊天 HTML 经转义/DOMPurify，Mermaid 使用 strict 模式，没有发现业务代码通过 eval 执行远程消息的路径。
- 原生 IPC 校验内置窗口来源；网络 API 路径采用允许列表，重定向关闭，未发现关闭 TLS 证书校验的代码。
- 出站网络和用户主动下载媒体使用对应沙盒权限；保存接口不接受任意目录，限制媒体扩展名和大小，不覆盖已有同名文件。没有增加 Full Disk Access、摄像头、麦克风或通讯录权限。
- 未启用支付、广告、分析、推送 SDK；没有商店外自更新流程或后台自动部署入口。以后启用 SDK/付费时需要重新审查。
- 通用二进制的动态依赖为系统框架/系统库，没有构建机绝对路径依赖。这不构成完整的私有 API 扫描，苹果后台分析仍需通过。

### TestFlight 验收清单

连接审核用服务；首次局域网授权允许/拒绝；IPv6-only 网络；登录/退出/删除连接；发送消息和附件、取消请求；沙盒下载媒体；外部链接打开；后台暂停和恢复；断网与旧服务版本提示；Intel 与 Apple Silicon 分别验证。未执行的项目应保持待验证，不应从编译成功推定通过。


### 安全修复后的发布准备

下一构建号为 1.0.3，版本仍为 1.0.0。商店版服务必须提供 HTTPS：
在服务电脑或受控反向代理部署有效证书，域名应与证书匹配，并将 HTTPS 转发至原服务。不要在公网暴露原 HTTP 端口，不要关闭证书验证。反向代理需支持事件流、附件上传和足够的流式响应超时。实际域名/证书配置尚待服务管理员提供和验收。

审核资料草稿见 appstore-review-notes.md；测试凭据不写入仓库。待运营资料齐全后再发布隐私政策和填写 App Store Connect 的隐私/加密问卷。当前没有代用户提交审核。

### 1.0.3 构建验证结果

- Node 测试 70 项通过；追加网页桥接“删除后 cookie 不再复用”的检查通过。
- 商店 feature 下 Rust 3 项测试通过：HTTPS/origin 限制、API 路径边界、删除连接取消请求并移除 cookie 客户端。
- 隔离 Chromium 界面测试：商店版桌面/手机宽度、离线数据说明打开关闭、HTTPS 默认地址、删除电脑流程通过。使用模拟桥接，不代替 TestFlight 实机测试。
- arm64 和 x86_64 Release 构建完成。最终包已校验图标、quarantine、应用签名、安装包签名与描述文件匹配。
- 本次包：`dist/macos-appstore/1.0.0-universal-signed-20260930-205822/CodexRemoteClient-1.0.0-macos-universal.pkg`，尚未上传或提交审核。

## 第二轮复查（2026-10-01）

对象为 1.0.0 / 1.0.3 已签名通用包及当前源码。本轮只检查和记录，未修改运行代码、重新打包或提交审核。

### 新发现

- **高优先级：第三方 AI 数据共享许可缺失。** 现行 5.1.2(i) 明确涵盖第三方 AI。数据说明仅可选打开，只有关闭按钮，只写可能调用 AI 提供方；没有准确展示接收方、取得分享前明确许可。app.js 附件选择直接上传（第 517 行）、发送（第 658 行）、新建会话（第 680 行）均无许可检查。如果内容包含个人数据并由远端转交第三方 AI，这是合规缺口。应由服务提供真实接收方/用途信息，在首次传输前取得可拒绝的明确许可，接收方变化后重新确认。附件先上传自托管服务与随后转交 AI 是两个阶段，不意味着选择时已传给 AI。
- **中优先级：HTTPS 限制未覆盖外部媒体。** runtime.js 的 setMedia 对非 /api/ 资源直接设置 src；rich.js 允许 HTTP/HTTPS，CSP 允许 HTTP 图片/音视频。外部媒体需用户点击才加载，并非历史页自动请求；仍可能明文加载或在 WebKit 中失败。应在商店版补资源校验及 CSP 限制，并给出错误说明。这是安全/功能风险，不能单凭 HTTP 判定必然拒审。

### 仍未关闭

正式隐私政策链接（5.1.1）、可用审核服务和测试凭据（2.1）、品牌及服务使用权限（4.1(c)、5.2）、隐私标签与加密问卷、商店截图/支持 URL/年龄分级仍待确认。本次未登录核验商店字段。第三方声明不替代授权。4.2.7 对当前 API 客户端的适用性仍需结合实际架构确认，不能视为所有远程 API 应用的禁令。未发现 PrivacyInfo.xcprivacy 本身不足以判定 macOS 包违规，仍需结合具体 API/SDK 分析。TestFlight 沙盒、IPv6-only 和两类 Mac 实机流程仍待验收。

依据：[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[SDK 要求](https://developer.apple.com/support/third-party-SDK-requirements/)、[加密出口说明](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)。

### 原包复验

原 1.0.3 包重新展开后，版本/Bundle ID 正确，arm64+x86_64，严格签名检查、1024 图标及 quarantine 检查通过。沙盒仅包含出站网络和下载目录权限，无调试权限。SHA256 仍为 c930906a0d509d9bc4b48df7b9e88f1f249f6fa69e0ab7b4daaa864525d5a79d。未替换包；这些检查通过不等于完整审核通过。

## 外部媒体 HTTPS 修复（2026-10-01）

商店版在媒体加载和外部媒体下载入口检查 HTTPS；等待分发配置完成后才加载。HTTP 地址显示错误，不自动改写协议。本地 blob/图片预览及通过已验证 HTTPS 服务获取的 API 媒体保留。macOS/iOS 商店构建的 CSP 同时移除 img-src/media-src 的 HTTP 来源，防止页面层绕过；本地 IPC 地址保持不变。Node 72 项测试通过。

此修改不为 Go 服务自动启用 TLS。服务仍使用 HTTP listener，8787 可照常启动；商店客户端必须使用另行配置的有效 HTTPS 入口。现有 Tailscale Serve 部署路径见 docs/packaging-and-configuration.md 与 AutoStartup/README.md，需配置真实域名的 allow-host，检查监听端口冲突及网络可达性。尚未对用户实际服务做端到端连接验证。

1.0.4 双架构 Release 与最终签名包检查通过：dist/macos-appstore/1.0.0-universal-signed-20261001-073619/CodexRemoteClient-1.0.0-macos-universal.pkg。未上传；服务端 TLS 和 AI 许可待完成。


## 本地 TLS / TOFU 落地（2026-10-01）

取代之前“所有服务必须使用公共可信 HTTPS 证书”的方案。服务端默认本地自签名 HTTPS/8787，保留显式 --tls=false；原生和本地网页桥接客户端首次自动固定公钥，后续身份变化阻止请求，显式重置时清除登录会话。证书续期保持公钥。macOS 启动脚本不再配置 Tailscale Serve，也不要求额外域名。外部媒体 HTTPS 限制保留，同源 API 媒体转已认证通道。设计、风险、文件位置及升级方式见 [local-tls.md](local-tls.md)。

客户端构建号更新为 1.0.5；应用和服务版本仍为 1.0.0。本次更新不代表 AI 数据共享许可、正式隐私政策或 App Store 审核准备已经完成。
# 首次启动协议与 AI 共享许可（2026-10-01）

客户端首次启动统一展示用户协议和隐私政策，协议确认及可选 AI 共享选择分开保存。版本来源 `client/ui/legal.js`。更改实质条款时更新 `version`；常规功能更新不更改它。确认记录只存在本机，不能视为已撤销远端访问凭据或已删除远端数据。

由于服务器由用户自托管，启动时无法知道所有实际接收方。使用 AI 前还需确认服务器公布的实际名单；同一服务器、名单和用途保持不变时不重复确认。服务管理员在口令文件旁建立 `<token-file>.privacy.json`：

```json
{
  "schemaVersion": 1,
  "purpose": "将用户提交的消息、附件和必要上下文用于其请求的 AI 任务。请补充实际用途和处理规则。",
  "recipients": [
    { "name": "填写实际 AI 服务商或数据接收方名称", "privacyURL": "https://填写实际政策域名/privacy" }
  ]
}
```

此示例不是有效运营声明，不应原样启用。需包括所有上游服务商/网关和项目配置可能使用的接收方；变更 AI 配置时同步更新声明。不能仅凭模型名推断运营主体。文件不包含 API key、token 或密码；服务每次读取，修改后无需重启。文件缺失或无效时返回 `configured:false`，新客户端禁止共享但允许读取已有内容。旧客户端没有此许可流程，服务端摘要检查只是保护新客户端确认与提交之间的一致性。

正式发布前，在 `client/ui/legal.js` 补全、核准 `supportEmail`、`privacyURL`、`termsURL` 及全文，然后设置 `published:true`，导出并发布 HTML，实际验证公开链接。`node scripts/export-legal.cjs --check` 和签名脚本阻止未补全的发布；本地测试和未签名编译不受影响。当前隐私清单仅接入 macOS 包，iOS 归档仍需单独验证资源放置及其 API 用途。

## 本地服务生命周期与验证

- `local-service` feature 由普通桌面 `desktop-direct` 和 macOS 商店配置共同启用。UI 在现有协议确认后调用 `local_service_start`，自动添加稳定的“本机”连接；现有远程选择不被覆盖。
- 服务仅监听随机的 `127.0.0.1` 端口，启用 TLS 和访问口令；凭证只在原生进程间使用，不写入浏览器存储。它不取代正在运行的 8787 服务，也不开放远程入站能力。
- App 持有服务的标准输入管道；正常退出或异常退出时 EOF 触发 Go 关闭服务。不同于旧版独立 A/B 守护安装，这条路径不创建 LaunchAgent，也不在 App 退出后无提示常驻。
- 普通版读取既有 `CODEX_HOME` 或 `~/.codex`；商店候选版仅使用自己的容器数据目录，暂时只读。不能冒充已验证的完整一体化聊天体验。
- `python3 scripts/test-app-managed-service.py` 使用临时空目录测试真实辅助程序启动、认证、退出和不安全启动参数拒绝，不访问用户会话。
- 签名脚本对辅助程序先签名，再签外层 App；辅助程序仅使用 `app-sandbox` 和 `inherit`，禁止未知嵌套代码。
- Go 辅助程序包含 Go TLS。macOS 的旧 `ITSAppUsesNonExemptEncryption=false` 自动声明已经移除，需重新核实出口合规分类；`check-apple-system-tls.py` 现在明确只覆盖 Rust 客户端，不能用于证明整个安装包仅使用 Apple 加密。

剩余发布条件：确定并实现沙盒下的 Codex 接入方案、真实发送/回复测试、沙盒签名包真机运行、出口合规核实、完整审核视频。当前未上传新版、未修改 App Store Connect。

### 2026-10-09 本机验证记录

普通 `.app` 与 universal 商店候选 `.app` 均构建通过。独立 bundle ID 的临时签名沙盒副本已真机启动：协议确认后自动启动 Go 辅助程序并连接，界面显示只读、0 条会话；退出 App 后对应监听端口消失。没有把该空界面录制为功能完成视频。辅助程序签名和 App 深层校验通过，但这不是 App Store 发行签名验证。

正式 `.pkg` 签名入口目前明确阻止生成新的可提交安装包，避免重复交付“签名正确但主要功能不可用”的包。完成上述发布条件后再解除检查。现有 1.0.6 安装版、已有独立守护服务及之前的签名产物未被替换。
