# 本地 HTTPS 与首次自动信任

2026-10-01 实现。服务端与客户端都需更新；不需要域名、公共 CA、扫码或手动核对指纹，不修改用户的 Tailscale。

## 使用

服务端直接启动 `codex-remote`，默认 `--tls=true --listen :8787`。也可用现有自启动入口。客户端输入电脑 IP，默认连接 `https://IP:8787`。显式 HTTPS 地址未指定端口时仍按标准使用 443。网络可达性由用户现有局域网/VPN决定。

旧 HTTP 服务仍可显式输入 http:// 地址；服务端 `--tls=false` 保留旧 HTTP 部署方式，不自动降级、不自动迁移用户保存的地址。新客户端不再要求商店版服务必须使用公共可信证书。外部媒体仍要求 HTTPS。同源的 /api/media 与 /api/upload-image 完整 URL 转回原生已认证 API 请求，不向外链发送服务 cookie。

本次没有修改正在运行的用户服务，也没有更改 VPN 或系统证书信任库。使用新构建需由用户升级服务程序并重启。

## 身份和证书

- 服务端第一次启动生成 P-256 私钥，保存于访问口令文件旁的 `<token-file>.tls-key.pem`。Unix 权限 0600。使用用户私有目录保存并备份此文件，不与客户端分享。
- 证书为自签名、90 天有效，重启生成新证书但保持公钥；运行期间剩余不到 7 天时在新握手中续期。TLS 至少 1.2。文件损坏或权限不安全时报错，不静默替换身份。
- 原生客户端对所选服务按 origin（协议/主机/端口）保存 SHA-256 SPKI 公钥指纹至应用数据目录 trusted-servers.json；网页客户端桥接进程保存于 ~/.config/codex-remote-client/trust。
- 首次有效 TLS 握手证明私钥持有后自动保存公钥；后续必须匹配。Rust 仍验证握手签名和证书时间，禁用 TLS 会话恢复以避免重置后沿用旧验证状态。Node 使用 TLS 握手后读取 SPKI，完成比对前不把连接交给 HTTP 层。
- 这里使用公钥身份认证，不用公共 CA 链或域名 SAN 认证，因此支持自签名和 IP 访问；这是选定服务的专用策略，不用于外部网站或媒体。
- Rust 身份文件独占锁防止多个原生实例同时覆盖记录；损坏文件导致启动失败。身份变更会拒绝请求，界面显示“确认服务器已重置，重新信任”，用户操作后删除该 origin 的 pin、取消连接、清除会话，下一次连接重新 TOFU。
- 更换 IP/端口属于新的 origin，将重新首次信任；当前不做跨地址自动身份迁移。删除电脑列表项保留 pin，防止重新添加时无意绕过身份变化保护。

## 安全边界

TOFU 不防首次连接时的冒充或中间人。它提供加密及后续身份连续性，不等于服务器访问认证；现有 require-token 配置保持不变，免口令模式仍由监听地址和网络边界决定。证书不是客户端登录 token。

普通浏览器没有原生客户端的 pin 记录，直接打开服务 HTTPS 仍可能显示证书不受信任。网页客户端应通过本地 Node 桥接入口连接，桥接实现相同 TOFU 策略。旧客户端不会自动认识本地证书，需要一起升级。

守护进程从本机私钥推导公钥，验证自己的 HTTPS 健康检查，不信任网络返回的新身份。SSH 启动流程在远端仅检查端口就绪，最终由客户端验证 TLS 和服务类型。

## 验证

- Go 全套测试；localtls 测试真实握手、重启换证但公钥不变、不同私钥拒绝、损坏文件不重建。
- Rust appstore/direct 测试：真实 TLS 连接首次 pin、换证保持信任、换密钥拒绝且不发送 HTTP 凭据、重置信任、过期证书不建立首次信任。
- Node 回归测试与 scripts/test-local-tls.cjs：连接真实 Go 服务，重启、换证、换密钥、重置、重新加载 pin、HTTPS 守护健康检查。
- 尚不能代替 Windows/iOS 实机、真实网络、TestFlight 沙盒和苹果审核。配对方案完成不意味着隐私政策及 AI 数据共享许可问题已解决。

## 本次构建结果

Go 全套测试通过；Node 74 项通过；Rust direct 10 项通过、1 项本机网络探测按原设定跳过，appstore 4 项通过。真实 Go 双架构服务端在 Apple Silicon 上通过 HTTPS/TOFU/续期/换密钥/重置/守护健康检查联调。商店桌面/移动宽度界面场景通过；扩展 UI smoke 在模型选择器标签断言（ui-smoke.cjs:198）失败，尚未定位，不能宣称全量界面回归通过。

客户端：dist/macos-appstore/1.0.0-universal-signed-20261001-082842/CodexRemoteClient-1.0.0-macos-universal.pkg（1.0.0 / 1.0.5）。签名、图标、quarantine、描述文件及双架构打包校验通过，未上传。

服务端：dist/local-tls/1.0.0/codex-remote-macos-universal（双架构命令行构建，不是已公证的网站安装包）。未覆盖用户现有服务，未重启实际部署。真实 Intel/Windows/iOS 尚未实机测试。


## 2026-10-02：Apple 系统 TLS

- macOS/iOS 原生网络现在使用 reqwest → native-tls → Apple Security.framework / Secure Transport。最低 TLS 1.2；此后端目前协商 TLS 1.2，服务端现有 TLS 1.2+ 配置兼容。Windows/Linux 保留 Rustls，不改变服务端。
- Apple 端用系统 CommonCrypto 计算原有 SHA-256 SPKI 指纹，身份文件格式不变，无需清除已信任电脑。x509-parser 仅解析 DER 和有效期，不启用其签名验证引擎。
- `client/src-tauri/vendor/native-tls` 基于 crates.io 0.2.18，保留上游许可证。小范围补丁增加 Apple 握手后证书验证回调；异步 WouldBlock 恢复必须保留回调。只有完成系统 TLS 握手和本地有效期、公钥、重置代次检查后，才把流交给 HTTP 层。失败关闭连接，不发送凭据。未开启 TLS 会话恢复。
- 默认 native-tls 客户端仍执行系统 PKI 校验；自定义 TOFU 仅用于用户选定服务的专用 connector。未更改系统证书信任，也未放宽外部媒体/网页策略。
- 商店配置继续禁用 SSH 与嵌入 Tailscale。`python3 scripts/check-apple-system-tls.py` 检查 Mac 双架构/iOS 发布依赖不含 Rustls、Ring、OpenSSL、AWS-LC、SSH 引擎。`rustls-pki-types` 只提供证书数据类型；Cargo.lock 的测试/其他平台条目不代表打包进 Apple 商店应用。
- 两个平台的商店 Info.plist 声明 `ITSAppUsesNonExemptEncryption=false`，只适用于上述构建范围，不能套用到启用了 SSH/内置 Tailscale 的直装包。依赖变化时需重新审查。
- 本地测试服务仍使用 Rustls/rcgen，属于 dev-dependencies，不打进正式 App。同步与异步真实握手测试覆盖首次信任、同公钥换证、身份变化阻止 HTTP、过期拒绝、重置与旧代次拒绝。

本次验证完成：默认配置与 appstore 配置 Rust 库测试各 4 项通过；分发配置 Node 测试 4 项通过；三个 Apple 目标的正式依赖审计通过；iOS aarch64 cargo check 通过。Mac arm64/x86_64 通用 release App 构建完成，实际 Info.plist 的 `ITSAppUsesNonExemptEncryption` 为 false，版本 1.0.0 / 1.0.6，实际链接 Apple Security.framework。当前产物在 `.local/distributions/macos-appstore/target/universal-apple-darwin/release/bundle/macos/Codex Remote Client.app`，未签名、未上传。iOS 尚未实机验证。旧的已上传构建不会自动获得这些修改，需要重新签名、打包并上传新构建。
