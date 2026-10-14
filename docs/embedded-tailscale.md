# 内嵌 Tailscale 接入约定

## GitHub 账号操作约束

用户明确要求：不得擅自操作其 GitHub 账号。讨论需要 Fork 不代表授权执行；Fork、推送、创建仓库、PR 等账号操作，都必须先说明具体动作并取得明确确认。不得未经确认读取账号凭据或利用已登录状态执行操作。完整约束见项目根目录 `AGENTS.md`。


源码随项目保存在 `third_party/libtailscale/source`，上游为 tailscale/libtailscale，固定提交见 `third_party/libtailscale/source.json`；不自动跟随主分支，不使用 NovaScale 产品代码。

用户登录自己的 Tailscale 账号，使用 Tailscale 官方网络服务。产品不托管用户的 Tailscale 账号，不随包分发共享 auth key，也不把不同用户加入产品方的公共 tailnet。嵌入代码按 BSD-3-Clause 保留许可与版权声明；依赖及云服务条款另外适用。

## 连接选择

- 桌面端发现系统 Tailscale 已安装且 Running：使用系统网络，不启动内嵌节点。
- 已安装但 NeedsLogin、Stopped 或检测失败：提示恢复系统服务，不把检测错误当作未安装，不静默创建第二个节点。
- 确认未安装：使用内嵌节点，引导用户通过官方登录页面授权。
- iOS/iPadOS 无法依赖其他 App 安装状态检测。提供系统连接与内嵌连接选择，不能把 PATH 中找不到 CLI 当作未安装。
- 浏览器模式检测的是运行网页服务的电脑，不是打开页面的 iPad。
- 系统节点与内嵌节点拥有不同身份和地址；不得读取、复制系统节点的状态或私钥。切换连接方式时取消旧请求、重新连接，不复用另一个节点身份下的会话。

## 运行边界

桌面客户端和后台服务应由同一个本地网络组件管理节点身份，避免争用同一个 state 目录或创建两个重复节点。移动端状态只属于自身 App 沙盒。用户注销内嵌节点不能注销系统 Tailscale。

HTTP、SSE、媒体、上传和 SSH 必须一起接入选定传输；仅启动 libtailscale 并不会给系统安装路由，现有 reqwest/fetch/TcpStream 不会自动经过用户态网络。使用内嵌 dial 或经认证的本机代理，代理凭据不得发送到网页。

服务端监听必须区分操作系统监听与 tailnet 内监听；内嵌节点的地址不能直接传给 net.Listen。用户已明确要求默认同时支持本机、局域网、系统及内嵌 Tailscale；默认监听已改为全部系统接口。已有 tailnet 访问规则继续生效，并需要校验访问身份。

## 本地源码和构建

完整上游源码位于 `third_party/libtailscale/source`，固定提交见相邻的 `source.json`。构建直接读取本地源码，不执行 GitHub clone、fetch 或任何账号操作；Go 依赖仍按 go.sum 从公开模块代理下载并校验。

```sh
GO_BINARY=/path/to/go node scripts/build-libtailscale.cjs macos-arm64
node scripts/build-tailscale-host.cjs
cd client
npm run web:tailscale
# 原生桌面试用：
npm run dev:embedded
```

构建脚本也支持 ios-arm64、ios-sim-arm64 和 macos-x64，静态库输出位于 `.local/libtailscale-build`。当前固定 Go 1.25.5，避免 Go 1.27 与依赖 JSON API 不兼容。不要把本机 `.local` 状态或构建产物提交到源码中。

网页预览通过本机子进程静态链接 libtailscale，以带认证的 SOCKS 通道连接 tailnet。原生 macOS/iOS 通过 Cargo 的 `embedded-tailscale` feature 静态链接同一份库。普通构建不默认启用该实验功能，原生分发需使用 `npm run build:embedded`（移动构建同样传递 feature）。

## 试用入口和当前范围

“添加新电脑 → 网络连接设置 → 试用内嵌网络”。默认优先系统 Tailscale；没有系统安装且此构建具备内嵌组件时启用内嵌。已安装但停止或无法读取状态时不会自动回退。可以显式选择系统网络（包括 iOS 上由系统 VPN 提供的路由）。选择目前只在本次应用/网页服务运行期间生效；重新启动恢复自动选择。

点击“登录 Tailscale”，等官方登录地址准备好后再次点击打开登录页面；完成后点击“重新检测”更新设备列表。内嵌节点名称为 `<当前机器名>-inclient`（macOS 优先 LocalHostName；移除 `.local` 后缀、规范成 DNS 标签并保留 `-inclient` 后缀），与已安装系统 Tailscale 的节点不同。账号授权需要用户本人完成，不共享 auth key。

HTTP、SSE、媒体、上传、服务探测和 SSH（含端口检测与安装后的检查）已接入客户端传输选择。内嵌通道仅处理 Tailscale IP 和完整 `.ts.net` 主机名；局域网与公网地址保持原有连接方式。认证代理的密码和 LocalAPI 凭据只留在本地进程内，不传给网页。

网页模式状态目录：`~/.config/codex-remote/embedded-tailscale-web`；原生客户端：App 数据目录下的 `embedded-tailscale`，目录权限 0700。两者是独立试用节点，避免多个进程争用状态。切换模式取消当前客户端连接并清除会话，但不关闭已启动的内嵌入站节点。已有内嵌状态会在 App/网页服务下次启动时恢复。

客户端与现有 Go 服务现在共用 App 的内嵌节点（见下节）。本次不包含新的服务启停 UI；Windows 内嵌网络仍需要适配。

macOS 静态链接与未登录节点启动已验证；iOS ARM64 静态库已编译，但尚未进行 iPad 真机、后台恢复和 App Store 发布验证。现已通过本机系统 Tailscale 节点访问已登录的内嵌节点；跨物理设备验证尚未执行。

## 服务端并行入口

Go 服务无参数启动默认 `:8787`，并为通配监听创建私有 loopback 桥接监听。随机端口和每次启动生成的密钥写入 `~/.config/codex-remote/network/8787.bridge`（目录 0700、文件 0600），停止时删除。服务重启后桥接读取新描述符。显式指定单 IP（例如 `--listen 127.0.0.1:8787`）不创建内嵌桥接。

`scripts/tailscale-forward.c` 由网页 helper 与 Rust 原生客户端共用。它在已有节点上调用 `tailscale_listen`，收到连接后向本机服务认证，并传递节点地址和真实 tailnet 对端 IP，再双向转发原始字节。不会改写 Host、Origin、Cookie 或 HTTP 内容，SSE、媒体和上传共用此通道，并发上限 64。App 退出后内嵌入口关闭，独立运行的服务仍保留系统网络入口。

服务端通配监听时自动允许当前系统接口 IP，以及经过桥接认证的内嵌节点 IP。请求时重新读取系统接口，因此网络变化无需重启；未知 Host 和跨来源 Origin 仍被拒绝。内嵌入口当前固定为 8787；自定义 --listen 端口只影响系统监听，尚无自定义内嵌端口 UI。

libtailscale 接收文件描述符时的对端地址映射问题已在本地源码修正，详见 third_party/libtailscale/LOCAL_CHANGES.md，没有推送 GitHub。

本机实测五个入口：127.0.0.1、192.168.1.2、系统 Tailscale IPv4 100.64.10.14、内嵌 IPv4 100.64.10.12 和内嵌 IPv6，连续 30 次请求成功；内嵌 IPv4/IPv6 的 SSE 收到事件，跨来源请求仍返回 403。系统 Tailscale IPv6 从本机访问仍超时，尚未验证其他设备到该地址的连接。
