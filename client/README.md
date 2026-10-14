# Codex Remote Client

独立的 Tauri 2 客户端，目标平台为 Windows、macOS、Linux、Android 和 iOS。已生成 Windows x64 EXE 和安装包，其他平台需在对应环境构建和验证。每台被控电脑独立运行 Go 服务。

## 独立客户端界面

`client/ui` 是客户端界面的唯一源码目录，桌面及移动原生包的 `frontendDist`、管理网页入口都使用该目录。它已从监听服务的 `internal/server/web` 剥离，后者保留独立的单机网页，后续客户端界面修改无需同步到单机网页。

- `ui/connections.js`：电脑列表与悬浮切换。
- `ui/connect.js`：一个地址输入框（含已发现电脑选项）和一个“连接”按钮。IP / hostname 默认端口 8787，也支持完整 URL 和自定义端口。
- `ui/deploy.js`：仅在需要时打开的桌面 SSH 安装向导。
- `ui/runtime.js`、`web/adapter.js`、`src-tauri/src/network.rs`：共享客户端逻辑与平台适配。

连接前独立检查目标 `/api/status`，不会切断当前电脑。确认服务可用后自动命名、保存并连接；需要认证则进入登录流程；无法连接或返回其他服务时显示安装与排查指引，不误报“未安装”、不自动重复部署，也不保存失败的设备。网页连接失败后先检查 SSH，通过账号登录并上传、校验、安装服务；Windows SSH 不可用时可下载开启 SSH 的 MSI，在目标运行后返回重试。原生端也使用 SSH 安装。安装保留端口冲突检查及程序哈希校验，Windows 自动部署要求管理员 SSH 会话。

## 独立的网页客户端（本机测试）

在 `client` 目录执行 `npm run web`，打开 **http://127.0.0.1:4173**。这是管理多台电脑的客户端入口，和电脑上的 8787 监听服务不同。可用 `CLIENT_WEB_PORT` 修改端口。

网页直接使用 `client/ui` 客户端界面：启动页只有电脑列表和添加按钮；添加表单在弹窗中打开，标题左侧按钮浮出电脑列表，可在聊天时直接切换。浏览器与桌面有各自的本地连接列表，不自动复制真实电脑数据。

`web/adapter.js` 适配共享 Runtime，`web/server.cjs` 提供本机网络代理，支持真实服务请求、SSE、媒体、上传、发送和设置；登录 Cookie 仅留在测试服务内存，按浏览器会话和目标地址隔离。只代理选中的电脑和已知 API，不开放远程网页来源，不改变监听服务的 CORS 或认证规则。测试服务重启后，口令模式需重新登录。

Tailscale 检测读取运行测试服务的电脑；SSH 自动安装当前仅桌面原生版提供，网页会明确提示，不能把网页视为已有 SSH 安装能力。其他设备访问时运行 `npm run web:tailscale`，自动绑定本机 Tailscale IPv4 地址，终端会输出访问链接。其他设备需已连接可互访的 Tailscale 网络；不会绑定所有网卡。HTTP Tailscale 地址已兼容浏览器非安全上下文中的随机 ID 生成。普通服务端网页仍保持单机模式。

```sh
npm run web
```

## 使用流程

服务启用 `--supervise=true` 后，可在设置中检查、重启服务。客户端直接连接 A，A/B 互相守护；连接中断时等待自动恢复后重试。详见[守护说明](../docs/guardian.md)。

1. 在“我的电脑”添加名称和完整服务地址，例如 `https://100.100.100.100:8787`，或直接填写电脑 IP（默认 HTTPS/8787）。不接受地址中的口令、查询参数或路径。
2. 点击机器卡片，默认免口令服务会直接连接；启用口令的服务才需要输入口令。连接列表最多 20 台，仅选中的服务会被访问。
3. 通过标题左侧电脑按钮展开悬浮列表并直接切换机器；名称始终显示在聊天顶部。地址修改创建新的本地身份，避免复用旧机器草稿。
4. 发送快捷键、更新方式和打开会话位置是 App 全局设置。项目折叠、草稿、图片引用、阅读位置、待确认请求分别按连接 ID 保存。

口令不保存到 localStorage、配置文件或日志。原生 HTTP 客户端将登录 Cookie 保存在内存，并按服务 origin（含协议、主机、端口）隔离；切换机器可复用内存中的会话，口令模式下彻底关闭 App 后需重新输入口令；默认免口令模式不需要。当前版本没有跨设备设置同步、持久化密码保险库或系统推送。

本地草稿和待确认请求使用 App 的本地存储，关闭后可恢复；它们与图片文件本身不同，图片仍在对应服务电脑上。移除连接不会删除电脑上的聊天、图片或队列。

## 省电约束

- 机器列表不轮询在线状态，显示的是上次成功连接时间，不把历史状态当作实时在线。
- 只有选中的机器有请求与一个 SSE 订阅；手动更新模式不订阅 SSE。
- 切换时先保存旧机器状态，再取消原生网络，重新载入同一份本地页面。迟到响应通过连接代次和前端生命周期代次丢弃。
- 页面后台、锁屏可见性变化或原生窗口失焦时，取消网络并停止前端同步；回到前台后补齐。原生取消是额外保护，不只依赖浏览器定时器节流。
- 排队留在服务端；App 退出不取消已经提交的任务。传输中断的发送按原有规则查询结果，不自动重发。
- 静态页面、脚本、渲染库随 App 打包；不为每台机器保留一个远端网页。
- 媒体按需读取，客户端媒体缓存上限 64 MiB，单个媒体上限 32 MiB，串行加载避免同时解码大量图片。停止操作时不轮询、不常亮屏幕、不申请后台常驻服务或电池优化豁免。

桌面失焦也会暂停同步，打开文件选择器可能触发暂停；上传尚未完成时需要重选，已提交的消息仍以服务端回执为准。移动端生命周期与耗电的验证范围见[验证说明](../docs/verification.md)。

## Windows 分发命名

`dist/client-windows-x64` 统一使用以下名称：

- `CodexRemoteClient.exe`：直接运行的客户端。
- `CodexRemoteClient-<版本>-x64-setup.exe`：同一客户端的安装包。

不另建守护版客户端别名。A/B 守护属于服务端 `codex-remote.exe`。

## 分发框架与 Apple 版本

Apple 渠道使用独立分发入口：`npm run build:ios:appstore`、`npm run build:macos:appstore`，默认生成无签名产物，不上传商店。macOS 默认生成 Intel + Apple Silicon 通用包，最低支持 macOS 12；构建需要安装两个 Rust macOS target。当前客户端与配套服务版本为 1.0.0，旧 0.2.x 服务需更新。配置校验、模块裁剪、SDK 接口及后续订阅接入见[分发装配说明](../docs/distribution.md)。本阶段支付、广告、统计与推送均未启用。

## 开发与构建

先安装对应平台的 [Tauri 开发环境](https://tauri.app/start/prerequisites/)（Rust、Node、Windows WebView2/C++ 工具或相应平台依赖）。在 `client` 目录执行：

```sh
npm install
npm run dev
# 发布构建：
npm run build
```

Tauri 直接打包 `client/ui` 静态资源，无需单独构建前端。

Android 需要 Android SDK/NDK 和 JDK；iOS 需要 Mac、Xcode 和签名团队：

```sh
npm run tauri -- icon src-tauri/icons/icon.png
npm run android -- init
npm run android -- dev
# 在 Mac 上：
npm run ios -- init
npm run ios -- dev
```

### 从 Xcode 安装到 iPhone

本工程的 Rust 构建脚本需要正在运行的 Tauri CLI 提供构建参数。直接打开 `.xcodeproj` 后点击 Run，可能连接到已退出的 CLI，报 `failed to read CLI options` / `Connection refused`。请先在 `client` 目录运行以下命令，并保持终端不退出，再到打开的 Xcode 中选择手机并点击 Run：

```sh
npm run ios -- dev --open --release --no-dev-server
```

此命令使用 Release 编译并禁用静态开发服务器。手机保持解锁，Signing & Capabilities 选择自己的团队并开启自动签名。如果出现 `project.pbxproj: Operation not permitted`，在工程 Build Settings 中将 `User Script Sandboxing`（`ENABLE_USER_SCRIPT_SANDBOXING`）设为 `No`，以允许 Tauri 构建脚本读取和更新生成工程。

只构建签名 Release 包时，使用 `npm run ios -- build --target aarch64 --export-method debugging`。这里的 `debugging` 是开发签名导出方式，不是 Debug 编译配置；免费 Personal Team 的描述文件有效期仍受 Apple 限制。

iOS 最低版本为 16。各平台使用系统 WebView，并在对应环境完成签名和打包。[Tauri 配置说明](https://tauri.app/develop/configuration-files/)

### iOS App Store 打包

示例 Bundle ID 为 `com.example.codexremoteclient`，签名前必须设置自己的 Apple Team ID（`YOURTEAMID` 仅为占位符）。已有生成工程不会自动同步所有设置：检查 `src-tauri/gen/apple/project.yml` 和 Xcode 工程中的 Bundle ID 与 Team。SSH 静态库依赖 zlib，Xcode target 的 Other Linker Flags 需包含 `$(inherited) -lz`；生成目录被 Git 忽略，重新执行 iOS init 后需要重新设置。

首次发布若自动开发签名因团队没有登记设备而失败，可先生成无签名归档，再用公司分发签名导出，无需为了 App Store 分发登记测试设备：

```sh
# 在 client 目录执行；Go 不在 PATH 时设置 GO_BINARY 为 go 的绝对路径。
npm run ios -- build --target aarch64 --export-method app-store-connect --no-sign --archive-only --ci
```

使用 `xcodebuild -exportArchive` 导出该归档，ExportOptions 设置 `method=app-store-connect`、`destination=export`、`signingStyle=automatic`、`teamID=YOURTEAMID`，并传入 `-allowProvisioningUpdates`。本机需要已登录有证书管理权限的 Apple 开发者账号。导出后的 IPA 通过 Transporter 上传；本地成功导出和签名校验不代表已通过 App Store 上传校验或审核。

客户端仍依赖系统 Tailscale 或其他可达网络，不安装或启动 VPN。HTTP/HTTPS 请求由原生层发送，使用现有服务 Cookie 接口，不放宽 Go 服务的 CORS、Host 检查或身份认证。HTTPS 对服务连接使用本地证书和首次使用信任（TOFU）：验证 TLS 握手签名与证书有效期，并固定保存服务器公钥。首次自动信任不防首次中间人攻击；以后公钥变化阻止连接，需显式重置信任。详见 [本地 TLS](../docs/local-tls.md)。

## 验证

不编译的检查：

```sh
npm test
node --check ../internal/server/web/runtime.js
node --check ../internal/server/web/connections.js
node --check ../internal/server/web/app.js
rustfmt --edition 2021 --check src-tauri/src/lib.rs src-tauri/src/network.rs
```

可选共享 UI 检查（安装 Chrome 后，使用模拟桥接和合成聊天，不连接真实服务）：

```sh
node tests/ui-smoke.cjs "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

它验证桌面连接列表、手机设置/聊天布局、无横向溢出、无 JavaScript 异常，以及机器列表无网络请求。截图保存在项目 `.local/client-preview/`。这不能替代 Tauri 的原生构建、IPC 和真机测试。

原生测试：`cargo test --manifest-path src-tauri/Cargo.toml --features desktop-direct`。真机检查连接切换、图片上传、断网恢复及锁屏返回。

## 边界

远端只提供 API 数据，客户端不加载远端 HTML 作为有原生权限的页面。原生命令只接受内置窗口来源，请求限定为现有 API 路径，不跟随重定向、不向网页暴露 Cookie。外部 HTTP/HTTPS 链接交由系统浏览器打开。

Windows 使用 `node_modules/.bin/tauri.cmd build --bundles nsis` 生成安装包，手动安装更新。其他平台的发布包需分别构建与验证。

### 图片与文件附件

输入框下方的“＋”可选择图片或普通文件，也支持拖放。每条消息最多 4 个附件，每个附件非空且不超过 8 MiB。PNG/JPEG/GIF 以图片输入发送；其他文件保存在目标电脑的附件目录中，发送时附上本地路径供会话读取，具体读取能力取决于目标电脑的工具与权限。上传的文件不会自动执行。上传和发送需要更新后的客户端与服务端。

## SSH 快速部署

桌面客户端的电脑列表提供 SSH 快速安装，提供账号密码、Tailscale SSH 和密钥三种方式，首次主机身份可在客户端确认，一键上传、安装和连接；支持 Windows/macOS x64、ARM64 服务包。目标机器需要已开启 SSH、已安装 Codex，并以目标用户登录桌面。手机端连接部署后的 HTTP 服务，当前不执行 SSH 安装。详见[部署说明](../docs/ssh-deployment.md)。

客户端发行构建会通过 `scripts/bundle-servers.cjs` 编译并携带四种服务程序，需要 Go；可用 `GO_BINARY` 指定编译器。直接使用 Cargo 开发时，先手动运行该脚本。

### 内嵌 Tailscale 试用

网页界面仍是共享的 `ui/`，原生/网页桥接负责网络。构建 libtailscale 后，添加电脑页面的“网络连接设置”可切换到内嵌模式并用自己的 Tailscale 账号登录。macOS 原生试用使用 `npm run dev:embedded`，网页预览仍使用 `npm run web:tailscale`。完整构建命令、当前平台限制和测试范围见 [内嵌网络说明](../docs/embedded-tailscale.md)。
