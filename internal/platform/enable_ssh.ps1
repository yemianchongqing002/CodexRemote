$ErrorActionPreference = 'Stop'
try {
 $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
 $principal = [Security.Principal.WindowsPrincipal]::new($identity)
 if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '需要管理员权限。' }
 Write-Output '正在检查 OpenSSH Server...'
 $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
 if ($capability.State -ne 'Installed') {
  Write-Output '正在安装 OpenSSH Server，可能需要几分钟，请保持网络连接...'
  $result = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  if ($result.RestartNeeded) { throw 'Windows 要求重启。请重启后再次运行开启 SSH。' }
 }
 Set-Service -Name sshd -StartupType Automatic
 Start-Service -Name sshd
 $rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
 if ($rule) {
  Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Action Allow
 } else {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
 }
 (Get-Service sshd).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
 $connection = [Net.Sockets.TcpClient]::new()
 try {
  $attempt = $connection.ConnectAsync('127.0.0.1',22)
  if (!$attempt.Wait(5000) -or !$connection.Connected) { throw 'sshd 已启动，但默认 SSH 端口 22 未确认，请检查现有 SSH 端口配置。' }
 } finally { $connection.Dispose() }
 Write-Output 'CODEX_REMOTE_SSH_READY'
 Write-Output 'OpenSSH Server 已启动，已设置开机启动，防火墙规则已启用。'
 exit 0
} catch {
 [Console]::Error.WriteLine($_.Exception.Message)
 exit 1
}
