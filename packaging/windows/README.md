# Windows SSH bootstrap

在 macOS/Linux 安装 `msitools`，运行：

```sh
node scripts/build-ssh-msi.cjs
```

可用 `GO_BINARY`、`WIXL_BINARY` 指定工具。输出 `dist/ssh-setup/CodexRemote-EnableSSH-x64.msi`，面向 Windows x64。

在目标 Windows 双击 MSI 并确认 UAC。安装包以系统权限执行固定的 `codex-remote.exe --enable-ssh`，检查/安装系统 OpenSSH Server、设置 sshd 自动启动、启用 SSH 防火墙规则，并检查本机 22 端口。安装失败会返回 Windows Installer 错误；Windows 功能安装可能需要网络、更新源或重启。需要详细日志时运行 `msiexec /i CodexRemote-EnableSSH-x64.msi /l*v ssh-setup.log`。

此包只准备 SSH，不安装或以管理员身份运行 Codex Remote 常驻服务，不修改账号密码、Codex 数据或 SSH 身份验证配置。之后回网页，通过运行 Codex 的用户账号进行远程服务安装。

OpenSSH 是系统共享功能。卸载本引导包只删除引导程序，保留 SSH 和防火墙配置；MSI 失败回滚也不自动撤销已完成的系统 SSH 配置。已有 SSH 使用非 22 端口时，不重写端口，检查会提示核对。可在管理员终端单独执行 `codex-remote.exe --enable-ssh` 重试。

该 MSI 暂未签名，生成及静态检查可在 Mac 完成；UAC、系统功能安装和 Windows Installer 执行结果需在 Windows 验证。
