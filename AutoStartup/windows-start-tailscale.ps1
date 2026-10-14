$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $projectDir '.local'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$serverExe = Join-Path $projectDir 'dist\windows-amd64\codex-remote.exe'
$tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
$dataDir = Join-Path $env:USERPROFILE '.codex'
$tokenPath = Join-Path $env:USERPROFILE '.config\codex-remote\token'
$guardianConfig = "$tokenPath.supervisor.json"
$startRequest = Join-Path $logDir 'guardian-start.request'
$failures = 0
$lastHealthExit = -1
function Write-GuardianLog([string]$message) {
    ('{0:o} guardian role=wrapper pid={1} {2}' -f [DateTime]::Now, $PID, $message) |
        Add-Content -LiteralPath (Join-Path $logDir 'startup.log')
}
$lastCheck = [DateTime]::UtcNow
$mutex = [Threading.Mutex]::new($false, 'Local\CodexRemoteTailscaleStartup')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    while ($true) {
        try {
            if ((Test-Path -LiteralPath $guardianConfig) -and -not (Test-Path -LiteralPath $startRequest)) {
                $now = [DateTime]::UtcNow
                if (($now - $lastCheck).TotalSeconds -gt 45) { $failures = 0 }
                $lastCheck = $now
                & $serverExe '--guardian-action=check' "--guardian-config=$guardianConfig" 2>> (Join-Path $logDir 'startup.log')
                $healthExit = $LASTEXITCODE
                if ($healthExit -eq 0 -or $healthExit -eq 2) {
                    if ($lastHealthExit -ne $healthExit) { Write-GuardianLog "event=health_state exit_code=$healthExit (0=healthy,2=stopped)" }
                    $failures = 0
                } else {
                    $failures++
                    Write-GuardianLog "event=health_failed failures=$failures/3 exit_code=$healthExit"
                    if ($failures -ge 3) {
                        & $serverExe '--guardian-action=repair' "--guardian-config=$guardianConfig" 1>> (Join-Path $logDir 'server.stdout.log') 2>> (Join-Path $logDir 'startup.log')
                        Write-GuardianLog "event=repair_command_finished exit_code=$LASTEXITCODE"
                        $failures = 0
                    }
                }
                $lastHealthExit = $healthExit
                Start-Sleep -Seconds 30
                continue
            }
            # A successful build can stage an update while the old server runs.
            # Apply only after all instances have exited, before starting the guardian.
            $pendingExe = Join-Path (Split-Path $serverExe -Parent) 'codex-remote-next.exe'
            $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'codex-remote.exe'" |
                Where-Object { $_.ExecutablePath -eq $serverExe })
            if ($existing) {
                Remove-Item -LiteralPath $startRequest -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 30
                continue
            }
            if (-not $existing -and (Test-Path -LiteralPath $pendingExe -PathType Leaf)) {
                if (Test-Path -LiteralPath $serverExe -PathType Leaf) {
                    Copy-Item -LiteralPath $serverExe -Destination (Join-Path $logDir 'codex-remote-previous.exe') -Force
                }
                Move-Item -LiteralPath $pendingExe -Destination $serverExe -Force
                ('{0:u} 已应用待更新服务程序' -f [DateTime]::Now) | Add-Content (Join-Path $logDir 'startup.log')
            }
            $tailStatus = (& $tailscaleExe status --json 2>$null | Out-String) | ConvertFrom-Json
            $tailHost = ([string]$tailStatus.Self.DNSName).TrimEnd('.')
            $tailAddress = @($tailStatus.TailscaleIPs | Where-Object { $_ -match '^100\.\d+\.\d+\.\d+$' }) | Select-Object -First 1
            if ($LASTEXITCODE -ne 0 -or $tailStatus.BackendState -ne 'Running' -or -not $tailHost -or -not $tailAddress) {
                Start-Sleep -Seconds 10
                continue
            }
            $arguments = @('--supervise=true', '--listen', "${tailAddress}:8787", '--codex-home', $dataDir,
                '--token-file', $tokenPath, '--allow-host', $tailHost,
                '--enable-send=true', '--read-only=false', '--ipc-socket', '\\.\pipe\codex-ipc')
            $quotedArguments = ($arguments | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' '
            foreach ($name in @('server.stdout.log', 'server.stderr.log')) {
                $logPath = Join-Path $logDir $name
                if (Test-Path -LiteralPath $logPath) {
                    Copy-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
                }
            }
            $child = Start-Process -FilePath $serverExe -ArgumentList $quotedArguments -WorkingDirectory $projectDir `
                -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $logDir 'server.stdout.log') `
                -RedirectStandardError (Join-Path $logDir 'server.stderr.log')
            $child.Id | Set-Content (Join-Path $logDir 'server.pid')
            Write-GuardianLog "event=child_spawned role=B target_pid=$($child.Id) readiness=pending"
            Remove-Item -LiteralPath $startRequest -Force -ErrorAction SilentlyContinue
        } catch {
            ('{0:u} {1}' -f [DateTime]::Now, $_.Exception.Message) |
                Add-Content (Join-Path $logDir 'startup.log')
        }
        Start-Sleep -Seconds 10
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
