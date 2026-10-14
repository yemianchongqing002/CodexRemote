# 自动启动与重启

脚本以当前登录用户运行，等待 Tailscale 就绪后启动 B；B 保存配置并启动直接监听客户端的 A。A/B 互相检查，外层脚本兜底双方无响应。停止标记同时约束三者，详见[双守护与日志](../docs/guardian.md)。

保留整个项目目录结构。脚本不编译程序，不修改访问口令或队列数据。桌面发送须满足目标电脑的 Codex 运行及 IPC 配置要求。

## Windows

计划任务名称为 `CodexRemote-Tailscale`，须预先注册为当前用户登录后运行 `windows-start-tailscale.ps1`。服务路径为 `dist/windows-amd64/codex-remote.exe`，脚本读取当前 Tailscale IP，监听其 8787 端口。

| 入口 | 作用 |
| --- | --- |
| `windows-取消自启动.cmd` | 禁用下次登录自动启动，当前服务继续运行 |
| `windows-恢复自启动.cmd` | 启用任务并请求启动 |
| `windows-重启服务.cmd` | 停止任务和 A/B，应用待更新文件并重新启动，保留原自启动设置 |
| `windows-manage-startup.ps1` | 上述入口的管理实现 |
| `windows-start-tailscale.ps1` | 网络等待、启动及外层健康检查 |

服务更新：将新程序放到 `dist/windows-amd64/codex-remote-next.exe`，双击重启入口。原程序备份到 `.local/codex-remote-previous.exe`。

默认管道参数在启动脚本中为 `\\.\pipe\codex-ipc`，需要与本机桌面一致。服务名等启动参数也在该脚本中设置。

恢复自启动或重启后，提示窗口显示服务地址；默认免口令模式无需 Key。显式启用口令时，窗口显示访问 Key，首次启动最多等待 15 秒读取，未就绪时显示口令文件路径。Key 只显示在操作窗口，不写入后台服务日志；此提示不代表服务已经就绪。

## macOS

使用当前用户的 LaunchAgent。先准备对应架构的服务程序，放在 `bin/codex-remote`、`dist/macos-arm64/codex-remote`（Intel 为 `macos-amd64`）或项目根目录。

| 入口 | 作用 |
| --- | --- |
| `macOS-安装自启动.command` | 安装/更新 LaunchAgent 并启动 |
| `macOS-取消自启动.command` | 禁用下次登录自动启动，当前服务继续运行 |
| `macOS-恢复自启动.command` | 恢复自动启动并启动服务 |
| `macOS-重启服务.command` | 重启并保留本组脚本记录的自启动设置 |
| `macOS-开启HTTPS.command` | 启动原生 HTTPS，不配置 Tailscale Serve |

可将 `macos-startup.conf.example` 复制到项目 `.local/macos-startup.conf`，填写程序、数据目录、IPC、端口或额外域名，路径使用绝对路径。

macOS 服务默认监听 8787，自动生成本地 TLS 身份，提供 HTTPS。双击开启 HTTPS 入口即可启动，不需要域名、不申请公共证书，也不会修改 Tailscale。客户端填写本机局域网或已有 VPN IP，首次自动信任。标准浏览器仍可能提示自签名证书不受信任。详见[本地 TLS](../docs/local-tls.md)。

LaunchAgent 位于 `~/Library/LaunchAgents/local.codex-remote.tailscale.plist`。移动项目后重新运行安装入口。若传输丢失执行权限，在项目根目录执行 `chmod +x AutoStartup/*.command`。

## 停止和日志

禁用登录自启动与停止服务是两个操作。整组停止命令及停止标记说明见[守护文档](../docs/guardian.md#手动操作)。

Windows 日志位于项目 `.local/`，macOS 位于 `~/Library/Logs/CodexRemote/`。紧急恢复后新进程日志位于守护配置旁的 `.run/recovery.log`，详见[日志排查](../docs/guardian.md#日志排查)。
