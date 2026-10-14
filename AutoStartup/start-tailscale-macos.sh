#!/bin/bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/macos-common.sh"
validate_binaries
cd "$project_dir"
umask 077
echo "HTTPS 服务端口：$REMOTE_PORT；客户端填写本机局域网或 VPN IP。首次连接自动信任。"
args=(--supervise=true --tls=true --listen ":$REMOTE_PORT" --codex-home "$REMOTE_CODEX_HOME"
      --token-file "$REMOTE_TOKEN_FILE" --enable-send=true --read-only=false)
[[ -z "$REMOTE_ALLOW_HOST" ]] || args+=(--allow-host "$REMOTE_ALLOW_HOST")
[[ -z "$REMOTE_IPC_SOCKET" ]] || args+=(--ipc-socket "$REMOTE_IPC_SOCKET")
[[ -z "$REMOTE_CODEX_BINARY" ]] || args+=(--codex-binary "$REMOTE_CODEX_BINARY")
# Keep an independent, low-frequency watchdog outside A/B. A persistent stop
# fence also survives launchd restarting this wrapper.
config="$REMOTE_TOKEN_FILE.supervisor.json"
start_request="$state_dir/guardian-start.request"
failures=0
last_code=-1
guardian_log() { printf '%s guardian role=wrapper pid=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$*" >&2; }
last_check=$(date +%s)
while true; do
    if [[ ! -f "$config" || -f "$start_request" ]]; then
        "$REMOTE_BINARY" "${args[@]}" &
        guardian_log "event=child_spawned role=B target_pid=$! readiness=pending"
        rm -f "$start_request"
        sleep 10
    fi
    now=$(date +%s)
    if (( now - last_check > 45 )); then failures=0; fi
    last_check=$now
    code=0
    "$REMOTE_BINARY" --guardian-action=check --guardian-config="$config" || code=$?
    if [[ "$code" = 0 || "$code" = 2 ]]; then
        if [[ "$last_code" != "$code" ]]; then guardian_log "event=health_state exit_code=$code (0=healthy,2=stopped)"; fi
        failures=0
    else
        failures=$((failures + 1))
        guardian_log "event=health_failed failures=$failures/3 exit_code=$code"
        if (( failures >= 3 )); then
            repair_code=0
            "$REMOTE_BINARY" --guardian-action=repair --guardian-config="$config" || repair_code=$?
            guardian_log "event=repair_command_finished exit_code=$repair_code"
            failures=0
        fi
    fi
    last_code=$code
    sleep 30
done
