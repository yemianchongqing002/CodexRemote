param(
    [ValidateSet('amd64', 'arm64')]
    [string]$Arch = 'amd64'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$oldOS = $env:GOOS
$oldArch = $env:GOARCH
$oldCGO = $env:CGO_ENABLED
Push-Location $root
try {
    $env:GOOS = 'windows'
    $env:GOARCH = $Arch
    $env:CGO_ENABLED = '0'
    $destination = Join-Path $root "dist/windows-$Arch"
    New-Item -ItemType Directory -Force $destination | Out-Null
    go build -trimpath -ldflags='-s -w' -o "$destination/codex-remote.exe" ./cmd/codex-remote
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
    Copy-Item docs/windows.md "$destination/README-windows.md"
    Compress-Archive -Path "$destination/codex-remote.exe", "$destination/README-windows.md" -DestinationPath "dist/codex-remote-windows-$Arch.zip" -Force
    Write-Host "Created dist/codex-remote-windows-$Arch.zip"
} finally {
    $env:GOOS = $oldOS
    $env:GOARCH = $oldArch
    $env:CGO_ENABLED = $oldCGO
    Pop-Location
}
