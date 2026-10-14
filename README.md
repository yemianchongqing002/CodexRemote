# Codex Remote

通过浏览器或独立客户端，经局域网 / Tailscale 查看电脑上的 Codex 聊天，发送文字与图片、排队、引导及在项目中创建会话。每台目标电脑独立运行服务，客户端统一管理多台电脑的连接。

服务端采用 Go，网页资源内嵌；客户端采用 Tauri，共用网页源码。聊天从桌面日志读取，发送通过目标电脑的 Codex 桌面 IPC 完成。模型和审批沿用桌面聊天的设置。

## 开始使用

| 需求 | 文档 |
| --- | --- |
| Windows 服务启动、打包与桌面连接 | [Windows 指南](docs/windows.md) |
| 通用构建、网络与配置参数 | [打包与配置](docs/packaging-and-configuration.md) |
| 登录自启动、应用待更新服务程序 | [AutoStartup](AutoStartup/README.md) |
| A/B 双守护、停止、恢复及日志 | [守护说明](docs/guardian.md) |
| 多机器客户端与各平台构建 | [客户端](client/README.md) |
| libtailscale 源码保存方式、修改与更新 | [第三方依赖说明](third_party/libtailscale/README.md) |
| 文字、图片、排队与新建聊天 | [输入与队列](docs/queue-and-create.md) |
| Markdown、媒体和手机布局 | [内容显示](docs/mobile-rendering.md) |
| 架构、发送协议、验证范围 | [设计](docs/design.md)、[发送](docs/sending.md)、[验证](docs/verification.md) |

## 本机运行

构建需要 Go 1.22 或更高版本；运行服务无需安装 Go 或 Node.js。

```sh
go build -o bin/codex-remote ./cmd/codex-remote
./bin/codex-remote --supervise=true
```

默认监听 `127.0.0.1:8787`，读取 `$CODEX_HOME` 或 `~/.codex`。默认内网免口令，无需口令文件。添加 `--require-token` 可启用原有口令认证，口令保存在 `~/.config/codex-remote/token`。发送默认开启，`--read-only` 可关闭发送、排队和创建。

Windows 发送还需指定桌面的实际本机管道，例如 `--ipc-socket '\\.\pipe\codex-ipc'`，详见 Windows 指南。

桌面客户端支持通过密码、Tailscale SSH 或密钥一键部署服务，详见[免口令与 SSH 安装](docs/ssh-deployment.md)。

## 日常操作

- 按项目查找聊天；输入区点击“发送”默认排队，每个聊天最多 5 条。每条队列消息可删除或立即引导。
- 支持已有聊天的文字、选图、图片粘贴和拖放；每条最多 4 张，每张 8 MiB。
- 默认回车发送、Shift + 回车换行。“设置”浮窗统一管理发送快捷键、更新方式、打开会话位置及连接名称。
- 输入框右下角可选择目标电脑的模型、Fast 和思考深度，修改后随下一条消息发送，无需应用按钮，详见[输入与队列](docs/queue-and-create.md#模型fast-与思考深度)。
- 找不到聊天接收方时，默认请求桌面打开对应聊天，再确认并发送；桌面程序须运行且 IPC 可用。
- 页面或客户端进入后台时暂停同步；电脑上的队列继续处理。结果不确定的消息先核对，不自动重发。

## 网络与守护

手机和电脑接入同一 Tailscale 网络。服务可直接监听 Tailscale IP，或只监听回环地址并由 Tailscale Serve 提供 HTTPS。局域网直连使用实际局域网 IP。客户端添加完整 HTTP/HTTPS 地址即可。

`--supervise=true` 先启动 B，再由 B 启动直接监听客户端的 A。A 负责恢复 B，B 每次启动都会重启 A。自动启动脚本另有低频健康检查，兜底双方无响应的情况。停止和日志说明统一见[守护文档](docs/guardian.md)。

## 同步与边界

查看不调用模型；消息落盘后才同步，不保证逐 token 显示。默认前台 SSE，无订阅时不持续扫描聊天；队列存在时仍检查对应聊天的完成状态。手动更新模式关闭自动同步。

桌面日志和 follower 协议属于版本相关适配。网页不提供审批、任意命令执行或完整工具界面；客户端支持的平台与实测范围见[验证说明](docs/verification.md)。
