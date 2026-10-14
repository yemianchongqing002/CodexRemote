#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" = Darwin ]] || { echo '此脚本只能在 macOS 上运行。' >&2; exit 1; }
source "$(cd "$(dirname "$0")" && pwd)/macos-common.sh"
label=local.codex-remote.tailscale
domain="gui/$(id -u)"
target="$domain/$label"
plist="$HOME/Library/LaunchAgents/$label.plist"
disabled_marker="$state_dir/macos-startup.disabled"
log_dir="$HOME/Library/Logs/CodexRemote"
xml() { printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }
write_plist() {
    validate_binaries
    mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
    local temporary
    temporary="$(mktemp "$plist.XXXXXX")"
    cat > "$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$(xml "$startup_dir/start-tailscale-macos.sh")</string></array>
<key>WorkingDirectory</key><string>$(xml "$project_dir")</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>$(xml "$log_dir/server.stdout.log")</string>
<key>StandardErrorPath</key><string>$(xml "$log_dir/server.stderr.log")</string>
</dict></plist>
EOF
    if ! /usr/bin/plutil -lint "$temporary"; then rm -f "$temporary"; return 1; fi
    chmod 600 "$temporary"
    mv -f "$temporary" "$plist"
}
unload_if_loaded() {
    if launchctl print "$target" >/dev/null 2>&1; then launchctl bootout "$target"; fi
    if [[ -f "$REMOTE_TOKEN_FILE.supervisor.json" ]]; then
        "$REMOTE_BINARY" --guardian-action=stop --guardian-config="$REMOTE_TOKEN_FILE.supervisor.json"
    fi
}
action="${1:-}"
case "$action" in
    https)
        validate_binaries
        echo '启用服务端原生 HTTPS，本地自动生成证书；不会修改 Tailscale 配置。'
        if [[ -f "$plist" ]]; then
            exec /bin/bash "$startup_dir/manage-macos.sh" restart
        else
            exec /bin/bash "$startup_dir/manage-macos.sh" install
        fi
        ;;
    install|enable)
        write_plist
        unload_if_loaded
        touch "$state_dir/guardian-start.request"
        launchctl enable "$target"
        launchctl bootstrap "$domain" "$plist"
        rm -f "$disabled_marker"
        echo '已安装/恢复登录后自动启动，并请求立即启动服务。'
        ;;
    disable)
        launchctl disable "$target"
        touch "$disabled_marker"
        echo '已取消登录后自动启动，当前运行的服务继续运行。'
        ;;
    restart)
        validate_binaries
        [[ -f "$plist" ]] || { echo '请先双击 macOS-安装自启动.command。' >&2; exit 1; }
        restore_disabled() {
            if [[ -f "$disabled_marker" ]]; then launchctl disable "$target"; fi
        }
        trap restore_disabled EXIT
        unload_if_loaded
        touch "$state_dir/guardian-start.request"
        launchctl enable "$target"
        launchctl bootstrap "$domain" "$plist"
        echo '已重新启动后台任务；原有自动启动设置保持不变。'
        ;;
    *) echo 'Usage: manage-macos.sh install|enable|disable|restart|https' >&2; exit 1 ;;
esac
if [[ "$action" != disable ]]; then
    echo '等待 Tailscale 就绪后启动，允许发送；实际访问地址见日志：'
    echo "$log_dir/server.stdout.log"
    echo "错误日志：$log_dir/server.stderr.log"
fi
