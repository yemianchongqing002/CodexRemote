$ErrorActionPreference = 'Stop'
function Ready {
 $tcp = New-Object Net.Sockets.TcpClient
 try { $task = $tcp.ConnectAsync('127.0.0.1', __PORT__); return $task.Wait(2000) -and $tcp.Connected } catch { return $false } finally { $tcp.Dispose() }
}
if (Ready) { Write-Output CODEX_REMOTE_READY; exit 0 }
$task = Get-ScheduledTask -TaskName 'CodexRemote-SSH' -ErrorAction SilentlyContinue
if (!$task) { throw '目标电脑尚未配置服务。请在目标电脑单独下载并安装 Codex Remote 客户端，打开并启动服务。' }
if ($task.State -ne 'Running') { Start-ScheduledTask -InputObject $task }
for ($i=0; $i -lt 10; $i++) {
 if (Ready) { Write-Output CODEX_REMOTE_READY; exit 0 }
 Start-Sleep -Seconds 1
}
throw '已请求启动，但服务尚未就绪。请在目标电脑客户端检查服务状态。'
