//! Remote service startup with authenticated SSH and explicit host trust.
use crate::{host_process::run, service_probe::computer_url, net_address::tailnet_ip};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Default)]
pub struct Deployment {
    plans: Mutex<HashMap<String, Plan>>,
    busy: Mutex<()>,
}
struct Plan {
    session: ssh2::Session,
    service_address: String,
    service_port: u16,
    platform: String,
    created: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: String,
    target: String,
    platform: String,
    arch: String,
    address: String,
    tailscale_state: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    address: String,
    reachable: bool,
    detail: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    target: String,
    #[serde(default)]
    address: Option<String>,
    port: Option<u16>,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default, deserialize_with = "secret")]
    password: zeroize::Zeroizing<String>,
    #[serde(default)]
    trusted_fingerprint: String,
}
fn secret<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<zeroize::Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(zeroize::Zeroizing::new)
}
fn default_mode() -> String {
    "key".into()
}
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn valid_target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-@[]:".contains(c))
        && value.matches('@').count() <= 1
}
fn ssh_args(target: &str, port: Option<u16>) -> Vec<String> {
    let mut a = vec![
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        "ServerAliveInterval=10".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
    ];
    if let Some(p) = port {
        a.extend(["-p".into(), p.to_string()]);
    }
    a.push(target.into());
    a
}
fn remote(
    session: &ssh2::Session,
    command: &str,
    input: Option<&str>,
    seconds: u64,
) -> Result<String, String> {
    session.set_timeout((seconds * 1000) as u32);
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel
        .handle_extended_data(ssh2::ExtendedData::Merge)
        .map_err(|e| e.to_string())?;
    channel.exec(command).map_err(|e| e.to_string())?;
    if let Some(input) = input {
        channel
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    channel.send_eof().map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let n = channel
            .read(&mut buf)
            .map_err(|e| format!("SSH 连接中断，结果未确认：{e}"))?;
        if n == 0 {
            break;
        }
        if output.len() + n > 65536 {
            return Err("SSH 输出超出限制，请检查目标机器".into());
        }
        output.extend_from_slice(&buf[..n]);
    }
    channel.wait_close().map_err(|e| e.to_string())?;
    let output = String::from_utf8_lossy(&output).into_owned();
    if channel.exit_status().map_err(|e| e.to_string())? != 0 {
        return Err(format!("目标机器操作失败：{output}"));
    }
    Ok(output)
}
fn connect(
    app: &tauri::AppHandle,
    target: &mut SshTarget,
    config: &str,
    host: &str,
) -> Result<ssh2::Session, String> {
    use base64::Engine;
    use std::net::{TcpStream, ToSocketAddrs};
    let password = std::mem::take(&mut target.password);
    if !["key", "password", "tailscale"].contains(&target.mode.as_str()) {
        return Err("未知连接方式".into());
    }
    let field = |name: &str| {
        config
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name} ")))
    };
    if ["proxycommand", "proxyjump"]
        .iter()
        .any(|k| field(k).is_some_and(|v| v != "none"))
    {
        return Err("快速安装需要直连目标电脑，请填写内网或 Tailscale 地址，不使用跳板别名".into());
    }
    let port = target
        .port
        .or_else(|| field("port").and_then(|p| p.parse().ok()))
        .unwrap_or(22);
    if target.mode == "tailscale" && port != 22 {
        return Err("Tailscale SSH 使用端口 22".into());
    }
    let user = field("user").ok_or("请填写目标电脑的用户名")?;
    #[cfg(feature="embedded-tailscale")]
    let embedded_tcp = crate::embedded::dial(host,port)?;
    #[cfg(not(feature="embedded-tailscale"))]
    let embedded_tcp:Option<std::net::TcpStream> = None;
    let via_embedded=embedded_tcp.is_some();
    let tcp = if let Some(tcp)=embedded_tcp {tcp} else {
    let addresses = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .map_err(|_| "找不到目标机器，请检查地址")?;
    let tcp = addresses
        .filter_map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(10)).ok())
        .next()
        .ok_or("无法连接 SSH，请检查地址及目标电脑是否开启 SSH")?;
    tcp
    };
    if target.mode == "tailscale" && !via_embedded && !tcp.peer_addr().is_ok_and(|a| tailnet_ip(a.ip())) {
        return Err("Tailscale 模式请填写目标的 Tailscale IP 或 MagicDNS 名称".into());
    }
    let mut session = ssh2::Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(20000);
    session
        .handshake()
        .map_err(|e| format!("SSH 握手失败：{e}"))?;
    let (key, kind) = session.host_key().ok_or("目标未提供 SSH 主机密钥")?;
    let fingerprint = format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key))
    );
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("ssh_known_hosts");
    let mut known = session.known_hosts().map_err(|e| e.to_string())?;
    if path.exists() {
        known
            .read_file(&path, ssh2::KnownHostFileKind::OpenSSH)
            .map_err(|e| e.to_string())?;
    }
    // Read user trust too, but only write the application's own file.
    let mut trusted = known.check_port(host, port, key);
    if matches!(trusted, ssh2::CheckResult::NotFound) {
        let mut system = session.known_hosts().map_err(|e| e.to_string())?;
        if let Ok(home) = app.path().home_dir() {
            let _ = system.read_file(
                &home.join(".ssh/known_hosts"),
                ssh2::KnownHostFileKind::OpenSSH,
            );
            trusted = system.check_port(host, port, key);
        }
    }
    match trusted {
        ssh2::CheckResult::Match => {}
        ssh2::CheckResult::NotFound => {
            if target.trusted_fingerprint != fingerprint {
                return Err(format!("SSH_TRUST:{fingerprint}"));
            }
            let name = if port == 22 {
                host.to_owned()
            } else {
                format!("[{host}]:{port}")
            };
            known
                .add(&name, key, "Codex Remote", kind.into())
                .map_err(|e| e.to_string())?;
            known
                .write_file(&path, ssh2::KnownHostFileKind::OpenSSH)
                .map_err(|e| e.to_string())?;
        }
        _ => {
            return Err("这台电脑的 SSH 身份与已保存记录不一致，请核对电脑，未发送登录凭据".into())
        }
    }
    match target.mode.as_str() {
        "password" => {
            if password.is_empty() {
                return Err("请输入 SSH 登录密码".into());
            }
            session
                .userauth_password(user, &password)
                .map_err(|_| "SSH 密码登录失败，请检查用户名、密码和服务器密码登录设置")?;
        }
        "tailscale" => {
            // Tailscale SSH authenticates the tailnet identity using SSH's none method.
            let _ = session.auth_methods(user);
            if !session.authenticated() {
                return Err("Tailscale SSH 尚未授权。请确认双方已登录 Tailscale、目标已开启 Tailscale SSH，并完成访问规则要求的网页验证。Windows 或图形版 macOS 目标请改用密码/密钥模式和 Tailscale 地址。".into());
            }
        }
        _ => {
            if let Ok(mut agent) = session.agent() {
                if agent.connect().is_ok() && agent.list_identities().is_ok() {
                    if let Ok(identities) = agent.identities() {
                        for identity in identities {
                            if agent.userauth(user, &identity).is_ok() {
                                break;
                            }
                        }
                    }
                }
            }
            if !session.authenticated() {
                for identity in config
                    .lines()
                    .filter_map(|l| l.strip_prefix("identityfile "))
                {
                    let path = if let Some(rest) = identity.strip_prefix("~/") {
                        app.path().home_dir().map_err(|e| e.to_string())?.join(rest)
                    } else {
                        PathBuf::from(identity)
                    };
                    if path.is_file() {
                        let _ = session.userauth_pubkey_file(user, None, &path, None);
                    }
                    if session.authenticated() {
                        break;
                    }
                }
            }
            if !session.authenticated() {
                return Err("密钥登录失败。请将密钥加入 SSH agent，或在 SSH 配置中设置 IdentityFile；也可切换密码模式".into());
            }
        }
    }
    Ok(session)
}
fn powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn platform(output: &str) -> Option<(String, String)> {
    let words: Vec<_> = output.split_whitespace().collect();
    match words.as_slice() {
        ["Darwin", "arm64"] => Some(("darwin".into(), "arm64".into())),
        ["Darwin", "x86_64"] => Some(("darwin".into(), "amd64".into())),
        ["Windows", "ARM64"] => Some(("windows".into(), "arm64".into())),
        ["Windows", "AMD64"] => Some(("windows".into(), "amd64".into())),
        _ => None,
    }
}
fn address(host: &str) -> String {
    if host.contains(':') {
        format!("https://[{}]:8787", host.trim_matches(['[', ']']))
    } else {
        format!("https://{host}:8787")
    }
}
fn probe(app: &tauri::AppHandle, mut target: SshTarget) -> Result<Preview, String> {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        return Err("SSH 启动请使用桌面客户端；手机可连接已启动的服务".into());
    }
    if !valid_target(&target.target) || target.port == Some(0) {
        return Err("填写 SSH 主机或 user@host，可使用已有 SSH 配置别名".into());
    }
    let d = app.state::<Deployment>();
    let _busy = d.busy.try_lock().map_err(|_| "已有 SSH 操作正在进行")?;
    let mut args = ssh_args(&target.target, target.port);
    args.insert(0, "-G".into());
    let config = run("ssh", &args, None, 15)?;
    let host = config
        .lines()
        .find_map(|l| l.strip_prefix("hostname "))
        .ok_or("SSH 未返回目标地址")?
        .to_string();
    if !valid_target(&host) || host.contains('@') {
        return Err("SSH 目标地址不支持".into());
    }
    let service_url = computer_url(target.address.as_deref().unwrap_or(&address(&host)))?;
    if service_url.host_str().unwrap().trim_matches(['[', ']']) != host.trim_matches(['[', ']'])
    {
        return Err("连接目标必须与所选电脑地址一致".into());
    }
    let service_address = service_url.origin().ascii_serialization();
    let service_port = service_url.port_or_known_default().unwrap_or(8787);
    let session = connect(app, &mut target, &config, &host)?;
    let unix = remote(&session, "uname -s && uname -m", None, 20);
    let detected = unix.as_ref().ok().and_then(|s| platform(s));
    let (os, arch) = match detected {
        Some(v) => v,
        None => {
            let output = remote(
                &session,
                &powershell("Write-Output Windows; Write-Output $env:PROCESSOR_ARCHITECTURE"),
                None,
                20,
            )?;
            platform(&output).ok_or("远程启动仅支持 Windows/macOS 的 x64 和 ARM64")?
        }
    };
    let ts_command = if os == "windows" {
        powershell(
            r#"$t=Get-Command tailscale.exe -ErrorAction SilentlyContinue; if($t){& $t.Source status --json --peers=false} elseif(Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe"){& "$env:ProgramFiles\Tailscale\tailscale.exe" status --json --peers=false} else {Write-Output CODEX_TAILSCALE_MISSING}"#,
        )
    } else {
        r#"if command -v tailscale >/dev/null 2>&1; then tailscale status --json --peers=false; elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json --peers=false; elif [ -x /opt/homebrew/bin/tailscale ]; then /opt/homebrew/bin/tailscale status --json --peers=false; elif [ -x /usr/local/bin/tailscale ]; then /usr/local/bin/tailscale status --json --peers=false; else echo CODEX_TAILSCALE_MISSING; fi"#.into()
    };
    let tailscale_state = match remote(&session, &ts_command, None, 8) {
        Ok(output) if output.trim() == "CODEX_TAILSCALE_MISSING" => "NotInstalled".into(),
        Ok(output) => serde_json::from_str::<serde_json::Value>(&output)
            .ok()
            .and_then(|v| {
                v.get("BackendState")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "Unavailable".into()),
        Err(_) => "Unavailable".into(),
    };
    let id = format!(
        "{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let result = Preview {
        id: id.clone(),
        target: target.target.clone(),
        platform: os.clone(),
        arch: arch.clone(),
        address: service_address.clone(),
        tailscale_state,
    };
    let mut plans = d.plans.lock().map_err(|_| "SSH 连接状态不可用")?;
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
    if plans.len() >= 8 {
        plans.clear();
    }
    plans.insert(
        id,
        Plan {
            session,
            service_address,
            service_port,
            platform: os,
            created: Instant::now(),
        },
    );
    Ok(result)
}
fn start_service(app: &tauri::AppHandle, id: String) -> Result<Started, String> {
    let d = app.state::<Deployment>();
    let _busy = d.busy.try_lock().map_err(|_| "已有 SSH 操作正在进行")?;
    let p = d
        .plans
        .lock()
        .map_err(|_| "SSH 连接状态不可用")?
        .remove(&id)
        .ok_or("连接检查已失效，请重新检查 SSH")?;
    if p.created.elapsed() > Duration::from_secs(600) {
        return Err("连接检查已过期，请重新检查 SSH".into());
    }
    let template = if p.platform == "windows" {
        include_str!("start-windows.ps1")
    } else {
        include_str!("start-macos.sh")
    };
    let script = template.replace("__PORT__", &p.service_port.to_string());
    let output = if p.platform == "windows" {
        remote(&p.session, &powershell("[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))"), Some(&script), 45)
    } else {
        remote(&p.session, "/bin/sh -s", Some(&script), 45)
    }?;
    if !output.lines().any(|line| line.trim() == "CODEX_REMOTE_READY") {
        return Err("启动未确认，请检查目标电脑客户端".into());
    }
    let address = p.service_address;
    // The SSH side checks local health; this final check tests the client's LAN route.
    let builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .use_preconfigured_tls(crate::trust::config(&computer_url(&address)?)?)
        .no_proxy();
    #[cfg(feature="embedded-tailscale")]
    let builder=if let Some(proxy)=crate::embedded::proxy()? {builder.proxy(proxy)}else{builder};
    let client=builder.build()
        .map_err(|_| "连接检查初始化失败")?;
    #[derive(Deserialize)]
    struct ServiceStatus {
        adapter: String,
    }
    let reachable = client
        .get(format!("{address}/api/status"))
        .send()
        .ok()
        .filter(|r| r.status().is_success())
        .and_then(|r| r.json::<ServiceStatus>().ok())
        .is_some_and(|v| v.adapter == "desktop-rollout");
    Ok(Started {
        address,
        reachable,
        detail: if reachable {
            "已连接目标电脑上的服务".into()
        } else {
            "目标机器已确认服务启动，但客户端无法直连所选服务端口。请检查内网路由或目标防火墙后连接。"
                .into()
        },
    })
}
#[tauri::command]
pub async fn ssh_probe(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    target: SshTarget,
) -> Result<Preview, String> {
    crate::network::ensure_local(&window)?;
    tauri::async_runtime::spawn_blocking(move || probe(&app, target))
        .await
        .map_err(|_| "SSH 检查异常")?
}
#[tauri::command]
pub async fn ssh_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Started, String> {
    crate::network::ensure_local(&window)?;
    tauri::async_runtime::spawn_blocking(move || start_service(&app, id))
        .await
        .map_err(|_| "SSH 启动异常")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connectivity_requires_ssh_banner() {
        for (banner, expected) in [
            ("SSH-2.0-OpenSSH_test\r\n", "available"),
            ("notice\r\nSSH-1.99-test\r\n", "available"),
            ("HTTP/1.1 200 OK\r\n", "unavailable"),
            ("SSH-2.0-\r\n", "unavailable"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.write_all(banner.as_bytes()).unwrap();
            });
            assert_eq!(ssh_connectivity("127.0.0.1", port), expected);
            server.join().unwrap();
        }
    }
    #[test]
    fn tailscale_requires_tailnet_address() {
        for ip in ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"] {
            assert!(tailnet_ip(ip.parse().unwrap()));
        }
        for ip in ["192.168.1.2", "100.128.0.1", "127.0.0.1", "::1"] {
            assert!(!tailnet_ip(ip.parse().unwrap()));
        }
    }
    #[test]
    fn targets_are_not_shell_or_option_input() {
        for s in ["host", "user@10.0.0.2", "office-mac"] {
            assert!(valid_target(s));
        }
        for s in [
            "-oProxyCommand=bad",
            "host;id",
            "host\nwhoami",
            "$(id)",
            "a b",
            "a@b@c",
        ] {
            assert!(!valid_target(s));
        }
    }
    #[test]
    fn detect_only_supported_architectures() {
        assert_eq!(
            platform("Darwin\narm64\n"),
            Some(("darwin".into(), "arm64".into()))
        );
        assert!(platform("Linux x86_64").is_none());
        assert_eq!(address("::1"), "https://[::1]:8787");
    }
}

#[derive(Serialize)]
pub struct SshStatus {
    state: String,
    port: u16,
}

fn ssh_connectivity(host: &str, port: u16) -> &'static str {
    use std::net::{TcpStream, ToSocketAddrs};
    #[cfg(feature="embedded-tailscale")]
    match crate::embedded::dial(host,port) {
        Ok(Some(mut stream)) => {
            let _=stream.set_read_timeout(Some(Duration::from_millis(4500)));
            let mut banner=Vec::new();let mut chunk=[0;1024];
            while banner.len()<8192 {
                match stream.read(&mut chunk){Ok(0)|Err(_)=>return "unreachable",Ok(n)=>banner.extend_from_slice(&chunk[..n])}
                if String::from_utf8_lossy(&banner).lines().any(|s|s.starts_with("SSH-2.0-")||s.starts_with("SSH-1.99-")){return "available";}
            }
            return "unavailable";
        }
        Err(_)=>return "unreachable",
        Ok(None)=>{}
    }
    let deadline = Instant::now() + Duration::from_millis(4500);
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return "unreachable";
    };
    let mut state = "unreachable";
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return "unreachable";
        }
        let mut stream = match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => stream,
            Err(error) => {
                if error.kind() == std::io::ErrorKind::ConnectionRefused {
                    state = "closed";
                }
                continue;
            }
        };
        let mut banner = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() {
                return "unreachable";
            }
            let mut chunk = [0; 1024];
            match stream.read(&mut chunk) {
                Ok(0) => return "unavailable",
                Ok(n) => banner.extend_from_slice(&chunk[..n]),
                Err(_) => return "unreachable",
            }
            if String::from_utf8_lossy(&banner).lines().any(|line| {
                line.strip_prefix("SSH-2.0-")
                    .or_else(|| line.strip_prefix("SSH-1.99-"))
                    .is_some_and(|software| !software.is_empty())
            }) {
                return "available";
            }
            if banner.len() > 8192 {
                return "unavailable";
            }
        }
    }
    state
}

#[tauri::command]
pub async fn ssh_status(
    window: tauri::WebviewWindow,
    address: String,
    port: u16,
) -> Result<SshStatus, String> {
    crate::network::ensure_local(&window)?;
    let url = computer_url(&address)?;
    if port == 0 {
        return Err("SSH 端口无效".into());
    }
    let host = url.host_str().unwrap().trim_matches(['[', ']']).to_owned();
    let task = tauri::async_runtime::spawn_blocking(move || ssh_connectivity(&host, port));
    let state = match tokio::time::timeout(Duration::from_secs(5), task).await {
        Ok(result) => result.map_err(|_| "SSH 检查异常")?,
        Err(_) => "unreachable",
    };
    Ok(SshStatus {
        state: state.into(),
        port,
    })
}
