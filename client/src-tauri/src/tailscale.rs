//! Read-only Tailscale discovery. Only reduced device metadata reaches the UI.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};
use tauri_plugin_opener::OpenerExt;

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawPeer {
    #[serde(rename = "HostName")]
    name: String,
    #[serde(rename = "DNSName")]
    dns: String,
    #[serde(rename = "OS")]
    os: String,
    #[serde(rename = "Online")]
    online: bool,
    #[serde(rename = "TailscaleIPs")]
    ips: Option<Vec<String>>,
    #[serde(rename = "sshHostKeys")]
    ssh_keys: Option<Vec<String>>,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawStatus {
    #[serde(rename = "BackendState")]
    state: String,
    #[serde(rename = "Self")]
    self_peer: Option<RawPeer>,
    #[serde(rename = "Peer")]
    peers: Option<HashMap<String, RawPeer>>,
    #[serde(rename = "TailscaleIPs")]
    ips: Option<Vec<String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    name: String,
    dns: String,
    pub address: String,
    os: String,
    online: bool,
    ssh: bool,
    is_self: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    state: String,
    ips: Vec<String>,
    peers: Vec<Peer>,
}
fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    paths.extend(
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        .map(PathBuf::from),
    );
    #[cfg(target_os = "windows")]
    if let Some(root) = std::env::var_os("ProgramFiles") {
        paths.push(PathBuf::from(root).join("Tailscale/tailscale.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path).map(|p| {
            p.join(if cfg!(windows) {
                "tailscale.exe"
            } else {
                "tailscale"
            })
        }));
    }
    paths.into_iter().filter(|p| p.is_file()).collect()
}
fn reduced(raw: RawStatus) -> Status {
    let running = raw.state == "Running";
    let mut self_peer = raw.self_peer.unwrap_or_default();
    if self_peer.ips.as_ref().is_none_or(|ips| ips.is_empty()) {
        self_peer.ips = raw.ips.clone();
    }
    if self_peer.name.is_empty() {
        self_peer.name = "本机".into();
    }
    let mut seen = std::collections::HashSet::new();
    let mut peers: Vec<_> = std::iter::once((self_peer, true))
        .chain(
            raw.peers
                .unwrap_or_default()
                .into_values()
                .map(|p| (p, false)),
        )
        .filter_map(|(p, is_self)| {
            let address = p
                .ips
                .as_ref()?
                .iter()
                .find(|ip| ip.parse().is_ok_and(crate::net_address::tailnet_ip))?
                .clone();
            if !seen.insert(address.clone()) {
                return None;
            }
            Some(Peer {
                name: p.name,
                dns: p.dns.trim_end_matches('.').into(),
                address,
                os: p.os,
                online: if is_self { running } else { p.online },
                is_self,
                ssh: p.ssh_keys.is_some_and(|keys| !keys.is_empty()),
            })
        })
        .collect();
    peers.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then(b.online.cmp(&a.online))
            .then(a.name.cmp(&b.name))
    });
    Status {
        installed: true,
        state: raw.state,
        ips: raw.ips.unwrap_or_default(),
        peers,
    }
}
pub fn detect() -> Status {
    let paths = candidates();
    for path in &paths {
        if let Ok(output) = crate::host_process::run(
            &path.to_string_lossy(),
            &["status".into(), "--json".into()],
            None,
            5,
        ) {
            if let Ok(raw) = serde_json::from_str::<RawStatus>(&output) {
                return reduced(raw);
            }
        }
    }
    Status {
        installed: !paths.is_empty(),
        state: if paths.is_empty() {
            "NotInstalled"
        } else {
            "Unavailable"
        }
        .into(),
        ips: vec![],
        peers: vec![],
    }
}
fn current_status() -> Result<serde_json::Value, String> {
    #[cfg(feature = "embedded-tailscale")]
    if crate::embedded::enabled() {
        let raw = crate::embedded::status()?;
        let auth = raw["AuthURL"].as_str().unwrap_or("");
        let auth = url::Url::parse(auth).ok().filter(|u|u.scheme()=="https" && u.host_str()==Some("login.tailscale.com")).map(|u|u.to_string()).unwrap_or_default();
        let status: RawStatus = serde_json::from_value(raw).map_err(|_|"网络状态无效")?;
        let mut v=serde_json::to_value(reduced(status)).map_err(|e|e.to_string())?;
        v["source"]="embedded".into();v["embeddedAvailable"]=true.into();v["authUrl"]=auth.into();return Ok(v);
    }
    let mut v=serde_json::to_value(detect()).map_err(|e|e.to_string())?;
    v["source"]="system".into();v["embeddedAvailable"]=cfg!(feature="embedded-tailscale").into();Ok(v)
}
#[tauri::command]
pub async fn tailscale_status(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    crate::network::ensure_local(&window)?;
    tauri::async_runtime::spawn_blocking(current_status).await.map_err(|_|"网络检测失败")?
}
#[tauri::command]
pub async fn tailscale_mode(window:tauri::WebviewWindow,network:tauri::State<'_,crate::network::Network>,mode:String)->Result<serde_json::Value,String>{
    crate::network::ensure_local(&window)?;
    if !["auto","system","embedded"].contains(&mode.as_str()){return Err("无效网络模式".into());}
    network.reset_transport();
    #[cfg(feature="embedded-tailscale")]
    crate::embedded::force(match mode.as_str(){"embedded"=>1,"system"=>2,_=>0});
    tailscale_status(window).await
}
#[tauri::command]
pub async fn tailscale_login(window:tauri::WebviewWindow)->Result<(),String>{
    crate::network::ensure_local(&window)?;
    #[cfg(feature="embedded-tailscale")]
    return tauri::async_runtime::spawn_blocking(crate::embedded::login).await.map_err(|_|"网络登录失败")?;
    #[cfg(not(feature="embedded-tailscale"))]
    Err("此构建未启用内嵌网络".into())
}
#[tauri::command]
pub fn tailscale_open(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::network::ensure_local(&window)?;
    #[cfg(target_os = "macos")]
    if std::path::Path::new("/Applications/Tailscale.app").is_dir() {
        return app
            .opener()
            .open_path("/Applications/Tailscale.app", None::<&str>)
            .map_err(|_| "无法打开 Tailscale".into());
    }
    app.opener()
        .open_url("https://tailscale.com/download", None::<&str>)
        .map_err(|_| "无法打开安装说明".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn includes_self_first_with_top_level_ip_fallback() {
        let raw=serde_json::from_str(r#"{"BackendState":"Running","TailscaleIPs":["100.64.1.1"],"Self":{"HostName":"My Mac","Online":false},"Peer":{"duplicate":{"TailscaleIPs":["100.64.1.1"]},"other":{"TailscaleIPs":["100.64.1.2"],"Online":true}}}"#).unwrap();
        let s = reduced(raw);
        assert_eq!(s.peers.len(), 2);
        assert!(s.peers[0].is_self);
        assert!(s.peers[0].online);
        assert_eq!(s.peers[0].name, "My Mac");
    }
    #[test]
    fn discovery_filters_addresses_and_uses_ssh_evidence() {
        let raw=serde_json::from_str(r#"{"BackendState":"Running","Peer":{"a":{"HostName":"online","DNSName":"office.ts.net.","OS":"windows","Online":true,"TailscaleIPs":["100.64.1.2"]},"b":{"HostName":"offline","Online":false,"TailscaleIPs":["100.64.1.3"],"sshHostKeys":["ssh-ed25519 key"]},"c":{"TailscaleIPs":["127.0.0.1"]}},"User":{"secret":"not forwarded"}}"#).unwrap();
        let s = reduced(raw);
        assert_eq!(s.peers.len(), 2);
        assert!(!s.peers[0].ssh);
        assert!(s.peers[1].ssh);
        assert_eq!(s.peers[0].dns, "office.ts.net");
        assert!(!serde_json::to_string(&s).unwrap().contains("secret"));
        assert!(reduced(
            serde_json::from_str(r#"{"BackendState":"NeedsLogin","Peer":null}"#).unwrap()
        )
        .peers
        .is_empty());
    }
    #[test]
    #[ignore = "reads local Tailscale state"]
    fn local_detection() {
        let s = detect();
        assert!(s.installed);
        println!("state={}, peers={}", s.state, s.peers.len());
    }
}
