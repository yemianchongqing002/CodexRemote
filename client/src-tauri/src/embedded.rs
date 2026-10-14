//! Optional, statically linked userspace Tailscale. No system daemon state is read.
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Mutex, OnceLock,
};
static FORCE: AtomicU8 = AtomicU8::new(0);
static ROOT: OnceLock<std::path::PathBuf> = OnceLock::new();
#[derive(Clone)]
struct Node {
    handle: i32,
    forward: usize,
    address: String,
    proxy: String,
    api: String,
}
static NODE: Mutex<Option<Node>> = Mutex::new(None);
unsafe extern "C" {
    fn codex_forward_start(node: i32, port: u16) -> *mut std::ffi::c_void;
    fn codex_forward_stop(forward: *mut std::ffi::c_void);
    fn gethostname(name: *mut std::ffi::c_char, len: usize) -> i32;
    fn tailscale_new() -> i32;
    fn tailscale_set_dir(sd: i32, dir: *const std::ffi::c_char) -> i32;
    fn tailscale_set_hostname(sd: i32, hostname: *const std::ffi::c_char) -> i32;
    fn tailscale_set_logfd(sd: i32, fd: i32) -> i32;
    fn tailscale_loopback(
        sd: i32,
        address: *mut std::ffi::c_char,
        len: usize,
        proxy: *mut std::ffi::c_char,
        api: *mut std::ffi::c_char,
    ) -> i32;
    fn tailscale_close(sd: i32) -> i32;
}
pub fn init(dir: std::path::PathBuf) {
    let dir = dir.join("embedded-tailscale");
    let restore = dir.join("tailscaled.state").is_file();
    let _ = ROOT.set(dir);
    if restore {
        std::thread::spawn(|| {
            if node().is_err() {
                eprintln!("内嵌服务入口启动失败");
            }
        });
    }
}
pub fn force(value: u8) {
    FORCE.store(value, Ordering::SeqCst);
}
pub fn enabled() -> bool {
    match FORCE.load(Ordering::SeqCst) {
        1 => true,
        2 => false,
        _ => !crate::tailscale::detect().installed,
    }
}
pub fn tailnet(host: &str) -> bool {
    let h = host.trim_matches(['[', ']']).to_lowercase();
    h.parse().is_ok_and(crate::net_address::tailnet_ip) || h.ends_with(".ts.net")
}
fn normalized_hostname(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let raw = lower.strip_suffix(".local").unwrap_or(&lower);
    let mut base = String::new();
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base = base.trim_matches('-');
    let base = base.get(..54).unwrap_or(base).trim_end_matches('-');
    format!("{}-inclient", if base.is_empty() { "device" } else { base })
}
fn machine_hostname() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .output()
    {
        if output.status.success() && !output.stdout.is_empty() {
            return normalized_hostname(&String::from_utf8_lossy(&output.stdout));
        }
    }
    let mut buf = [0u8; 256];
    if unsafe { gethostname(buf.as_mut_ptr().cast(), buf.len() - 1) } == 0 {
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        return normalized_hostname(&String::from_utf8_lossy(&buf[..end]));
    }
    normalized_hostname("device")
}
fn node() -> Result<Node, String> {
    let mut state = NODE.lock().map_err(|_| "内嵌网络锁定失败")?;
    if let Some(n) = state.as_ref() {
        return Ok(n.clone());
    }
    let dir = ROOT.get().ok_or("内嵌网络尚未初始化")?;
    std::fs::create_dir_all(dir).map_err(|_| "无法创建网络状态目录")?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护网络状态目录")?;
    let dir = std::ffi::CString::new(dir.to_string_lossy().as_bytes()).map_err(|_| "目录无效")?;
    let hostname = std::ffi::CString::new(machine_hostname()).map_err(|_| "设备名称无效")?;
    unsafe {
        let handle = tailscale_new();
        if handle < 0 {
            return Err("内嵌网络初始化失败".into());
        }
        let mut address = [0i8; 256];
        let mut proxy = [0i8; 33];
        let mut api = [0i8; 33];
        if tailscale_set_dir(handle, dir.as_ptr()) != 0
            || tailscale_set_hostname(handle, hostname.as_ptr()) != 0
            || tailscale_set_logfd(handle, -1) != 0
            || tailscale_loopback(
                handle,
                address.as_mut_ptr(),
                address.len(),
                proxy.as_mut_ptr(),
                api.as_mut_ptr(),
            ) != 0
        {
            tailscale_close(handle);
            return Err("内嵌网络启动失败".into());
        }
        let forward = codex_forward_start(handle, 8787);
        if forward.is_null() {
            tailscale_close(handle);
            return Err("内嵌服务入口启动失败".into());
        }
        let read = |p: *const i8| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
        let n = Node {
            handle,
            forward: forward as usize,
            address: read(address.as_ptr()),
            proxy: read(proxy.as_ptr()),
            api: read(api.as_ptr()),
        };
        *state = Some(n.clone());
        Ok(n)
    }
}
fn api(endpoint: &str, post: bool) -> Result<serde_json::Value, String> {
    let n = node()?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "网络初始化失败")?;
    let url = format!("http://{}/localapi/v0/{endpoint}", n.address);
    let r = if post {
        client.post(url).body("{}")
    } else {
        client.get(url)
    }
    .header("Sec-Tailscale", "localapi")
    .basic_auth("", Some(n.api))
    .send()
    .map_err(|_| "内嵌网络请求失败")?;
    if !r.status().is_success() {
        return Err("内嵌网络操作失败".into());
    }
    if post {
        Ok(serde_json::Value::Null)
    } else {
        r.json().map_err(|_| "网络状态无效".into())
    }
}
pub fn status() -> Result<serde_json::Value, String> {
    api("status", false)
}
pub fn login() -> Result<(), String> {
    api("start", true)?;
    api("login-interactive", true)?;
    Ok(())
}
pub fn proxy() -> Result<Option<reqwest::Proxy>, String> {
    if !enabled() {
        return Ok(None);
    }
    let n = node()?;
    let url = format!("socks5h://tsnet:{}@{}", n.proxy, n.address);
    Ok(Some(reqwest::Proxy::custom(move |target| {
        if target.host_str().is_some_and(tailnet) {
            Some(url.clone())
        } else {
            None
        }
    })))
}
pub fn dial(host: &str, port: u16) -> Result<Option<std::net::TcpStream>, String> {
    if !tailnet(host) || !enabled() {
        return Ok(None);
    }
    let n = node()?;
    socks::Socks5Stream::connect_with_password(
        n.address.as_str(),
        (host.trim_matches(['[', ']']), port),
        "tsnet",
        &n.proxy,
    )
    .map(|s| Some(s.into_inner()))
    .map_err(|_| "内嵌网络无法连接 SSH".into())
}
pub fn close() {
    if let Ok(mut state) = NODE.lock() {
        if let Some(n) = state.take() {
            unsafe {
                codex_forward_stop(n.forward as *mut std::ffi::c_void);
                tailscale_close(n.handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_only_tailnet_destinations() {
        assert!(tailnet("100.64.10.14"));
        assert!(tailnet("mac.example.ts.net"));
        assert!(!tailnet("127.0.0.1"));
        assert!(!tailnet("example.com"));
        assert!(!tailnet("100.128.0.1"));
    }
    #[test]
    #[ignore = "starts an isolated unsigned-in node"]
    fn linked_library_starts_without_system_state() {
        init(std::env::temp_dir().join(format!("codex-native-ts-test-{}", std::process::id())));
        let s = status().expect("embedded status");
        assert_eq!(s["BackendState"], "NeedsLogin");
        close();
    }
}
