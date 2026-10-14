# 双进程守护

同一个 `codex-remote` 程序运行两个角色：A 直接提供网页和聊天接口，B 负责启动和恢复 A。A 同时检查 B，必要时恢复 B。

```text
系统启动任务 → 外层检查脚本 → B ⇄ 本机管理通道 ⇄ A ← 网页 / App
```

Windows 使用当前用户的命名管道，macOS/Linux 使用私有 Unix socket。聊天流量直接进入 A。HTTPS 仍可通过 Tailscale Serve 接入 A。

## 启动与配置

`AutoStartup` 脚本通过 `--supervise=true` 先启动 B：

```powershell
.\codex-remote.exe --supervise=true --listen 100.100.100.100:8787 --ipc-socket '\\.\pipe\codex-ipc'
```

首次或整组停止后启动，B 将服务设置保存到口令文件旁的 `token.supervisor.json`，校验后启动 A。可通过 `--guardian-config` 指定配置路径。

配置包括服务监听地址、名称、数据目录、口令文件路径、桌面 IPC 和发送设置；不保存访问口令正文、进程 PID 或原始命令行。运行状态单独保存在配置文件旁的 `.run` 目录。

A、B 恢复对方时只传配置路径、角色和会话标识，业务设置始终从文件读取。已有角色运行时，重复启动不会覆盖配置。

**B 每次启动都会重新读取配置并重启 A，包括被 A 恢复的情况。** 配置无效时保留当前 A，错误写入日志。业务启动配置由 B 写入；App 的本地设置不修改该文件。

## 健康检查与恢复

- 每 30 秒检查一次，连续失败 3 次才恢复；启动宽限期为 90 秒。
- B 检查 A 的管理响应、HTTP 响应及核心状态锁；A 检查 B 的管理响应和检查循环是否正常。
- 电脑休眠造成检查间隔过长时，清零之前的失败次数。
- 恢复时先请求正常退出，最多等待 55 秒，再按已核实的进程身份终止。
- A、B 各有单实例锁；正常恢复使用协调锁。对方持锁且健康检查失败时，紧急回收通过已核实的进程身份进行，不依赖这把锁。
- 进程身份包含角色、会话、实例及创建时间，不只依赖 PID。
- 进程身份记录保留备份；会话状态损坏时退出并交给外层恢复。无法确认仍占用角色的进程身份时，停止操作明确报错。

A 不可用时，网页和 App 会暂时断开，需要等待自动恢复。Windows/macOS 启动脚本每 30 秒检查一次；双方连续三次无响应时，先回收整组，再启动 B，由 B 重启 A。检查只运行短时本机命令，不增加常驻服务进程，也不经过公网。

## 手动操作

网页/App 设置中的“检查服务”查看双守护状态，“重启服务”由 A 通知 B 重启 A。Codex 桌面和已提交到桌面的任务继续运行，未确认的发送先核对结果。

整组停止：

```powershell
.\codex-remote.exe --guardian-action=stop --guardian-config 'C:\用户目录\.config\codex-remote\token.supervisor.json'
```

停止操作先写入独立停止标记，再结束 B 和 A，并确认两个角色均已释放。A、B 和外层启动脚本都遵守停止标记，停止后不会自行复活。双击恢复自启动、重启服务，或显式启动 B，可重新启动。B 仍按启动参数覆盖配置。

外层紧急恢复与主动停止并发时，以主动停止为准；紧急恢复中途失败可以重试。手动启动而没有外层任务时，双方同时假死仍需手动恢复。

外层使用 `--guardian-action=check` 检查：退出码 0 表示可由双守护维持，1 表示需要恢复，2 表示主动停止。`--guardian-action=repair` 执行紧急恢复；恢复后的进程日志位于 `<守护配置路径>.run/recovery.log`。

## 接口

- `GET /api/guardian/status`：A/B 状态、PID 和启动次数。
- `POST /api/guardian/restart`：请求 B 重启 A；202 表示已接收，重复请求有 15 秒冷却。

接口沿用服务登录鉴权。B 暂不可用时，重启请求返回失败，由 A 的健康检查恢复 B。

## 日志排查

- Windows：项目 `.local/startup.log` 查看外层检测及紧急恢复；`.local/server.stderr.log` 查看 A/B 守护事件，`server.stdout.log` 查看服务启动信息。通过 Windows 启动脚本启动前保留上一份为同名 `.previous` 文件。
- macOS：`~/Library/Logs/CodexRemote/server.stderr.log` 查看外层和 A/B 事件，`server.stdout.log` 查看服务启动信息。
- 外层紧急恢复之后：新 B/A 的日志写入 `<守护配置路径>.run/recovery.log`。外层的 `repair_child_spawned` 会记录这个位置。

守护事件带时间及时区、角色、PID、会话标识和 `event`。恢复及停止结果带耗时和错误；不记录访问口令、IPC 实例凭据或消息正文。正常健康检查不逐次记录，只记录失败计数、恢复和状态变化。

排查时沿同一会话、目标 PID 查看：`health_failed`（具体 IPC/HTTP 原因及失败次数）→ `restart_trigger`（触发原因）→ `recovery_begin` → `reclaim_begin` → `force_terminate`（若正常退出超时）→ `child_spawned` → 新进程 `role_ready`。`child_spawned` 只表示进程已创建，不能当作服务已就绪。

主动停止看 `stop_begin`、`stop_fence_written`、`reclaim_end`、`stop_end`；持锁故障看 `control_lock_failed`、`emergency_reclaim`；双方故障看外层失败计数和 `repair_begin` / `repair_end`。被强制终止的进程可能没有自身退出日志，应查看控制方的回收日志。

## 测试

```sh
go test ./internal/supervisor ./internal/server
node scripts/test-guardian.cjs dist/server-windows-x64/codex-remote.exe
```

进程测试使用临时目录和回环端口，覆盖配置隔离、A 恢复 B、B 重启 A、读取修改后的配置、A 崩溃恢复及整组停止。按实际检查周期执行，耗时数分钟。

测试执行状态见[验证说明](verification.md)。
