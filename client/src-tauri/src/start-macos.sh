set -eu
# Only wait for a listener here; the client verifies TLS identity and /api/status after SSH.
ready(){ /usr/bin/nc -z -w 2 127.0.0.1 __PORT__ >/dev/null 2>&1; }
if ready; then echo CODEX_REMOTE_READY; exit 0; fi
plist="$HOME/Library/LaunchAgents/local.codex-remote.ssh.plist"
if [ ! -f "$plist" ]; then echo '目标电脑尚未配置服务。请在目标电脑单独下载并安装 Codex Remote 客户端，打开并启动服务。' >&2; exit 1; fi
uid=$(id -u)
if ! launchctl print "gui/$uid/local.codex-remote.ssh" >/dev/null 2>&1; then launchctl bootstrap "gui/$uid" "$plist"; fi
launchctl kickstart "gui/$uid/local.codex-remote.ssh"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if ready; then echo CODEX_REMOTE_READY; exit 0; fi
 sleep 1
done
echo '已请求启动，但服务尚未就绪。请在目标电脑客户端检查服务状态。' >&2
exit 1
