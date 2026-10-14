param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Disable', 'Enable', 'Restart')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$taskName = 'CodexRemote-Tailscale'
$serverExe = [IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\windows-amd64\codex-remote.exe'))
$logDir = Join-Path (Split-Path $PSScriptRoot -Parent) '.local'
function Request-GuardianStart {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $logDir 'guardian-start.request') -Value 'start'
}

function Show-ConnectionInfo {
    $tokenPath = Join-Path $env:USERPROFILE '.config\codex-remote\token'
    $configPath = "$tokenPath.supervisor.json"
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            if ($config.service.listen) {
                $scheme = if ($config.service.tls) { 'https' } else { 'http' }
                Write-Host ('服务地址：{0}://{1}' -f $scheme, $config.service.listen)
            }
        } catch {
            Write-Host '服务地址请查看 server.stdout.log。'
        }
    } else {
        Write-Host '服务地址请查看 server.stdout.log。'
    }

    if (!$config -or !$config.service.requireToken) {
        Write-Host '内网免口令模式：客户端填写服务地址即可连接。' -ForegroundColor Cyan
        return
    }
    if ($config.service.tokenFile) { $tokenPath = $config.service.tokenFile }

    # First launch creates the token asynchronously. Only display it in the
    # management window; never forward it to the background service logs.
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($true) {
        try {
            if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
                $accessKey = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
                if ($accessKey.Length -ge 32) {
                    Write-Host '访问 Key（复制到客户端登录）：'
                    Write-Host $accessKey -ForegroundColor Cyan
                    return
                }
            }
        } catch {
            # The service may still be creating the file; retry briefly.
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 300
    }
    Write-Host "访问 Key 尚未就绪，服务启动后可从此文件复制：$tokenPath"
}

try {
    $task = Get-ScheduledTask -TaskName $taskName
    switch ($Action) {
        'Disable' {
            Disable-ScheduledTask -TaskName $taskName | Out-Null
            Write-Host '已取消登录后自动启动，当前运行的服务继续运行。' -ForegroundColor Green
        }
        'Enable' {
            Request-GuardianStart
            Enable-ScheduledTask -TaskName $taskName | Out-Null
            Start-ScheduledTask -TaskName $taskName
            Write-Host '已恢复登录后自动启动，并请求立即启动服务。' -ForegroundColor Green
        }
        'Restart' {
            $wasEnabled = $task.Settings.Enabled
            Stop-ScheduledTask -TaskName $taskName
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
                if ([DateTime]::UtcNow -gt $deadline) { throw '计划任务未能停止，请在任务计划程序中检查。' }
                Start-Sleep -Milliseconds 300
            }
            # Persist the stop intent before terminating either role, so peers
            # cannot revive each other during a full restart or binary replacement.
            $guardianConfig = Join-Path $env:USERPROFILE '.config\codex-remote\token.supervisor.json'
            if (Test-Path -LiteralPath $guardianConfig -PathType Leaf) {
                & $serverExe '--guardian-action=stop' "--guardian-config=$guardianConfig"
                if ($LASTEXITCODE -ne 0) { throw '双守护未能停止，请检查日志。' }
            }
            # Match the full executable path; never stop unrelated Codex processes.
            $instances = @(Get-CimInstance Win32_Process -Filter "Name = 'codex-remote.exe'" |
                Where-Object { $_.ExecutablePath -eq $serverExe })
            foreach ($instance in $instances) {
                $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($instance.ProcessId)"
                if ($current -and $current.ExecutablePath -eq $serverExe -and $current.CreationDate -eq $instance.CreationDate) {
                    Stop-Process -Id $instance.ProcessId -Force
                    Wait-Process -Id $instance.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
                }
            }
            try {
                Request-GuardianStart
                if (-not $wasEnabled) { Enable-ScheduledTask -TaskName $taskName | Out-Null }
                Start-ScheduledTask -TaskName $taskName
                $deadline = [DateTime]::UtcNow.AddSeconds(15)
                while ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
                    if ([DateTime]::UtcNow -gt $deadline) { throw '启动任务未进入运行状态，请检查任务计划程序。' }
                    Start-Sleep -Milliseconds 300
                }
            } finally {
                if (-not $wasEnabled) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
            }
            Write-Host '已重新启动后台任务；原有自动启动设置保持不变。' -ForegroundColor Green
        }
    }
    if ($Action -ne 'Disable') {
        Write-Host '服务会等待 Tailscale 就绪，继续使用允许发送模式。'
        Show-ConnectionInfo
        Write-Host ('服务日志：{0}' -f (Join-Path $logDir 'server.stderr.log'))
        Write-Host ('启动日志：{0}' -f (Join-Path $logDir 'startup.log'))
    }
    exit 0
} catch {
    Write-Host ('操作失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
