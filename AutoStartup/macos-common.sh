#!/bin/bash
# Compatible with the Bash 3.2 shipped with macOS.
set -euo pipefail
startup_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$startup_dir/.." && pwd)"
state_dir="$project_dir/.local"
mkdir -p "$state_dir"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REMOTE_BINARY=''
TAILSCALE_BINARY=''
REMOTE_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
REMOTE_TOKEN_FILE="$HOME/.config/codex-remote/token"
REMOTE_PORT=8787
REMOTE_ALLOW_HOST=''
REMOTE_IPC_SOCKET=''
REMOTE_CODEX_BINARY=''
if [[ -f "$state_dir/macos-startup.conf" ]]; then
    source "$state_dir/macos-startup.conf"
fi
if [[ -z "$REMOTE_BINARY" ]]; then
    arch="$(uname -m)"
    [[ "$arch" != x86_64 ]] || arch=amd64
    for candidate in "$project_dir/bin/codex-remote" "$project_dir/dist/macos-$arch/codex-remote" "$project_dir/codex-remote"; do
        if [[ -x "$candidate" ]]; then REMOTE_BINARY="$candidate"; break; fi
    done
fi
if [[ -z "$TAILSCALE_BINARY" ]]; then
    TAILSCALE_BINARY="$(command -v tailscale || true)"
    if [[ -z "$TAILSCALE_BINARY" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
        TAILSCALE_BINARY=/Applications/Tailscale.app/Contents/MacOS/Tailscale
    fi
fi
validate_binaries() {
    [[ "$REMOTE_BINARY" = /* && -x "$REMOTE_BINARY" ]] || {
        echo '未找到 macOS 版 codex-remote。请放入 bin/codex-remote，或在 .local/macos-startup.conf 指定 REMOTE_BINARY 绝对路径。' >&2
        return 1
    }
    [[ "$REMOTE_PORT" =~ ^[0-9]+$ && ${#REMOTE_PORT} -le 5 ]] &&
        (( 10#$REMOTE_PORT >= 1 && 10#$REMOTE_PORT <= 65535 )) || {
        echo 'REMOTE_PORT 必须为 1 到 65535。' >&2; return 1;
    }
}
