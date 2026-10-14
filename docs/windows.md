# Windows 服务与客户端

## 运行服务

服务程序为 `codex-remote.exe`，网页资源已内嵌。以运行 Codex 桌面的同一 Windows 用户启动：

```powershell
.\codex-remote.exe --supervise=true --listen 127.0.0.1:8787 --ipc-socket '\\.\pipe\codex-ipc'
```

管道参数须使用目标电脑实际的 `\\.\pipe\名称`。发送默认开启；仅查看时添加 `--read-only`。浏览器打开监听地址，在登录页输入服务口令：

```powershell
Get-Content "$HOME\.config\codex-remote\token"
```

默认聊天目录为 `$CODEX_HOME` 或 `$HOME\.codex`，可用 `--codex-home` 指定。口令和队列默认存放在当前用户配置目录，使用 NTFS ACL 保护。

## 手机及多机器访问

运行 `tailscale ip -4` 获取目标电脑地址，将启动命令中的监听地址改为实际 IP，例如 `100.100.100.100:8787`。手机浏览器或客户端连接 `http://100.100.100.100:8787`。防火墙和 Tailscale 访问规则需允许该连接。

服务统一使用操作系统的电脑显示名称。浏览器可在设置中保存本地别名，App 可在连接列表管理多台机器。

## 桌面发送与排查

桌面须提供兼容的 follower 协议。管道存在不等于协议可用，可先在桌面打开目标聊天，再探测：

```powershell
.\codex-remote.exe --ipc-socket '\\.\pipe\实际管道名称' --probe-thread '实际聊天ID'
```

探测不会发送消息或打开窗口。发送时默认启用 `--open-thread-on-send=true`：找不到接收方会请求桌面打开聊天，再确认接收方。可设置为 `false` 关闭自动打开。

| 提示 | 排查 |
| --- | --- |
| 需要指定本机命名管道 | 补充或修正 `--ipc-socket` |
| 无法连接桌面 | 检查桌面运行状态、用户和实际管道名 |
| 找不到聊天接收方 | 在桌面打开聊天，检查自动定位及协议探测结果 |
| 新建会话找不到程序 | 用 `--codex-binary` 指定本机 Codex 程序 |

消息提交后的不确定回执不会自动重发。新建聊天依赖本机 `codex.exe`、`codex://` 协议和桌面 IPC。协议验证范围见[验证说明](verification.md)。

## 自动启动、停止与更新

[AutoStartup](../AutoStartup/README.md) 管理登录自启动及重启。脚本默认开启双守护，A 直接服务客户端，B 负责启动和恢复 A。

运行中的程序使用待更新文件替换：

1. 将新服务放到 `dist/windows-amd64/codex-remote-next.exe`。
2. 双击 `AutoStartup/windows-重启服务.cmd`。
3. 脚本停止任务和 A/B，备份并替换程序，再启动 B。

整组停止使用 `--guardian-action=stop`；停止标记也约束外层任务。保留口令、队列及图片数据。详细命令和日志位置见[守护说明](guardian.md)。

## 构建

项目根目录执行：

```powershell
go test ./...
.\scripts\package-windows.ps1
```

产物为 `dist/windows-amd64/codex-remote.exe` 和 `dist/codex-remote-windows-amd64.zip`；ARM64 使用 `-Arch arm64`。该脚本直接写目标 EXE，须确保它未运行。正在运行时先编译到独立目录，再暂存更新：

```powershell
go build -trimpath -ldflags='-s -w' -o dist/server-windows-x64/codex-remote.exe ./cmd/codex-remote
Copy-Item dist/server-windows-x64/codex-remote.exe dist/windows-amd64/codex-remote-next.exe -Force
```

## Windows 客户端

分发目录为 `dist/client-windows-x64`：

- `CodexRemoteClient.exe`：直接运行。
- `CodexRemoteClient-0.1.0-x64-setup.exe`：安装包。

两者是同一个客户端的不同分发方式。A/B 守护属于服务端；客户端不包含独立守护程序。构建及平台支持见[客户端说明](../client/README.md)。
