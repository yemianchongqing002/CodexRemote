# 打包与配置

服务运行在目标电脑，浏览器或 App 连接该服务。Windows 专用步骤见[Windows 指南](windows.md)，多平台客户端见[客户端说明](../client/README.md)。

## 构建与分发

服务端需要 Go 1.22 或更高版本：

```sh
go test ./...
make build
```

生成 `bin/codex-remote`。macOS 可分别构建：

```sh
GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o dist/macos-arm64/codex-remote ./cmd/codex-remote
GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o dist/macos-amd64/codex-remote ./cmd/codex-remote
```

网页资源随程序内嵌，目标电脑无需 Go、Node.js 或前端依赖。只分发目标架构的程序和说明，不包含个人聊天、口令或队列数据。使用自动启动时保留项目目录结构及 `AutoStartup` 目录。

## 启动与配置来源

以运行 Codex 桌面的用户启动。以下以 macOS 为例：

```sh
./bin/codex-remote --supervise=true --codex-home "$HOME/.codex"
```

默认监听 `127.0.0.1:8787`。首次生成 `~/.config/codex-remote/token`，将文件中的口令填入登录页。聊天目录异常可用 `--diagnose` 检查，桌面接收方可用 `--probe-thread 聊天ID` 探测。

初始启动参数由 B 保存为口令旁的 `token.supervisor.json`。A/B 恢复时只传配置路径、角色和会话标识；B 每次启动都根据配置重启 A。整组显式启动时按启动参数覆盖配置。角色和会话属于内部运行状态，不作为业务启动参数拼接。详见[守护说明](guardian.md)。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--listen` | `127.0.0.1:8787` | 服务监听地址 |
| `--codex-home` | `$CODEX_HOME` 或 `~/.codex` | 桌面聊天数据目录 |
| `--token-file` | `~/.config/codex-remote/token` | 服务口令及状态目录的位置 |
| `--read-only` | `false` | 关闭发送、排队和创建 |
| `--enable-send` | `true` | 允许发送；`--read-only` 优先 |
| `--allow-host` | 空 | 额外允许的域名，逗号分隔 |
| `--interval` | `3s` | 前台日志检查间隔，最小 1 秒 |
| `--ipc-socket` | Unix 为数据目录下 `ipc/ipc.sock`；Windows 为空 | 桌面 IPC 地址；Windows 需实际本机命名管道 |
| `--codex-binary` | macOS 为桌面内置路径；Windows/Linux 从 PATH 查找 | 本机会话创建和模型查询程序 |
| `--open-thread-on-send` | `true` | 找不到接收方时请求桌面打开聊天 |
| `--open-created-in-desktop` | `true` | 创建后交给桌面开始处理 |
| `--supervise` | `false` | 启动 A/B 双守护；自动启动脚本设为 true |
| `--guardian-config` | 口令路径加 `.supervisor.json` | 守护配置路径 |
| `--guardian-action` | 空 | `stop`、`check` 或 `repair` |
| `--diagnose` | `false` | 输出日志诊断后退出 |
| `--probe-thread` | 空 | 只读探测聊天接收方后退出 |

浏览器的连接别名和输入设置保存在本地，不修改服务配置；App 按连接隔离草稿，并统一管理输入和同步设置。

## 网络访问

直接监听 Tailscale IP：

```sh
tailscale ip -4
./bin/codex-remote --supervise=true --listen 100.100.100.100:8787
```

替换为实际 IP，客户端访问 `https://100.100.100.100:8787`。设备须位于同一 tailnet 且访问规则允许连接。

旧部署兼容（可选，项目默认不需要也不自动配置 Tailscale Serve）：

```sh
tailscale serve status
./bin/codex-remote --supervise=true --tls=false --listen 127.0.0.1:8787 --allow-host your-host.your-tailnet.ts.net
# 另一个终端中执行，先确认 8443 未用于其他服务：
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

访问 `https://your-host.your-tailnet.ts.net:8443`。停止此入口使用 `tailscale serve --https=8443 off`。新的自动启动脚本使用原生 TLS/8787，不再创建 Serve 配置，见[AutoStartup](../AutoStartup/README.md)。

普通局域网使用实际局域网 IP，例如 `--listen 192.168.1.10:8787`。具体监听 IP 自动进入 Host 允许列表；额外域名用 `--allow-host`。回环地址不能直接从手机访问。

## 自动启动与停止

统一使用[AutoStartup 脚本](../AutoStartup/README.md)：Windows 计划任务、macOS 用户级 LaunchAgent。外层健康检查负责双方无响应时的恢复。

整组停止使用：

```sh
./bin/codex-remote --guardian-action=stop
```

自定义配置时补充 `--guardian-config`。停止标记约束 A、B 和外层；恢复自启动、重启脚本或显式启动 B 可以重新启动。禁用登录自启动不结束当前服务。

## 数据文件

默认位于 `~/.config/codex-remote/`，自定义口令路径时存放在对应目录。

| 文件或目录 | 用途 |
| --- | --- |
| `token` | 服务访问口令 |
| `token.supervisor.json` | B 保存的业务启动配置 |
| `token.supervisor.json.run/` | 会话、角色记录、锁、停止标记和恢复日志 |
| `outbox.jsonl` | 请求元数据和回执 |
| `outbox.jsonl.queue/` | 等待投递的正文 |
| `outbox.jsonl.queue.images/` | 上传图片及桌面历史引用 |

更新程序保留上述状态；不要在运行中删除队列、锁或停止标记。Windows 暂存更新按[Windows 指南](windows.md)操作。轮换口令时先停止服务，更换口令文件后重新启动，客户端重新登录。

## 排查入口

- 无法连接：检查监听地址、进程、Tailscale 和防火墙。
- Host 拒绝：检查访问域名是否在允许列表。
- 聊天缺失：核对 `--codex-home` 并执行 `--diagnose`。
- 发送失败：检查桌面运行、IPC 及聊天接收方，见[Windows 指南](windows.md#桌面发送与排查)。
- 队列等待：核对聊天完成状态，可删除或立即引导，见[队列说明](queue-and-create.md)。
- 停止或恢复异常：按[守护日志](guardian.md#日志排查)追踪角色、PID 和会话。

开发检查统一见[验证说明](verification.md)。

服务名称统一使用操作系统的电脑显示名称，不再单独配置；客户端可保存本地连接别名。
