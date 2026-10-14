//! App-owned service. No launch agents, shell scripts, downloads or shared installs.
use serde::Serialize;
use std::{fs, io, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use tauri::Manager;

#[derive(Clone, Serialize)]
pub struct LocalInfo {
    pub address: String,
    pub notice: String,
}
struct Running { child: Child, info: LocalInfo, token: String, _lock: fs::File }
impl Drop for Running {
    fn drop(&mut self) {
        // Closing the pipe asks Go to drain HTTP work and exit, even if the UI crashed.
        drop(self.child.stdin.take());
        let until = Instant::now() + Duration::from_secs(7);
        while Instant::now() < until {
            if !matches!(self.child.try_wait(), Ok(None)) { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Default)]
pub struct LocalService(Mutex<Option<Running>>);
impl LocalService {
    pub fn stop(&self) { self.0.lock().unwrap().take(); }
    fn start(&self, executable: &Path, state: &Path, data: &Path, notice: String) -> Result<(LocalInfo, String), String> {
        let mut running = self.0.lock().map_err(|_| "本地服务状态不可用")?;
        if let Some(current) = running.as_mut() {
            if matches!(current.child.try_wait(), Ok(None)) { return Ok((current.info.clone(), current.token.clone())); }
        }
        running.take();
        fs::create_dir_all(state).map_err(|_| "无法创建本地服务目录")?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(state, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护本地服务目录")?;
        }
        let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(state.join("instance.lock")).map_err(|_| "无法锁定本地服务")?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| "另一个 App 实例正在运行本地服务，请先退出另一实例")?;
        let ready = state.join("ready.json");
        match fs::remove_file(&ready) { Ok(()) => {}, Err(e) if e.kind() == io::ErrorKind::NotFound => {}, Err(_) => return Err("无法清理旧服务状态".into()) }
        let token = state.join("token");
        let mut command = Command::new(executable);
        command.args(["--app-managed", "--listen=127.0.0.1:0", "--require-token"])
            .arg(format!("--ready-file={}", ready.display()))
            .arg(format!("--token-file={}", token.display()))
            .arg(format!("--codex-home={}", data.display()))
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(feature="appstore")] command.arg("--read-only");
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let child = command.spawn().map_err(|_| "无法启动安装包内的本地服务，请重新安装完整版本")?;
        let mut pending = Running { child, info: LocalInfo { address: String::new(), notice }, token: String::new(), _lock: lock };
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            if !matches!(pending.child.try_wait(), Ok(None)) { return Err("本地服务启动失败：请检查 Codex 数据目录与系统权限".into()); }
            if let Ok(bytes) = fs::read(&ready) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if let Some(address) = value["address"].as_str() {
                        let url = url::Url::parse(address).map_err(|_| "本地服务地址无效")?;
                        if url.scheme() != "https" || url.host_str() != Some("127.0.0.1") || url.port().is_none() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() { return Err("本地服务未使用安全本机地址".into()); }
                        pending.info.address = address.into();
                        pending.token = fs::read_to_string(&token).map_err(|_| "无法读取本地服务凭证")?.trim().into();
                        let result = (pending.info.clone(), pending.token.clone());
                        *running = Some(pending);
                        return Ok(result);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("本地服务启动超时，请重试".into())
    }
}

fn bundled_executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位安装包")?;
    #[cfg(target_os="macos")]
    {
        let helper = executable.parent().ok_or("无法定位安装包")?.join("codex-remote-service");
        if helper.is_file() { return Ok(helper); }
    }
    let platform = if cfg!(target_os="windows") { "windows" } else { "darwin" };
    let arch = if cfg!(target_arch="aarch64") { "arm64" } else { "amd64" };
    let name = if cfg!(target_os="windows") { "codex-remote.exe" } else { "codex-remote" };
    let relative = format!("server-bundles/{platform}-{arch}/{name}");
    let helper = app.path().resource_dir().map_err(|_| "无法定位安装包资源")?.join(&relative);
    if helper.is_file() { return Ok(helper); }
    // Development uses the same generated payload, never a PATH lookup.
    #[cfg(debug_assertions)] {
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        if helper.is_file() { return Ok(helper); }
    }
    Err("安装包缺少本地服务程序，请重新构建完整版本".into())
}

#[tauri::command]
pub async fn local_service_start(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<LocalInfo, String> {
    crate::network::ensure_local(&window)?;
    let handle = app.clone();
    let (info, token) = tauri::async_runtime::spawn_blocking(move || {
        let root = handle.path().app_data_dir().map_err(|_| "无法定位应用数据目录")?.join("local-service");
        #[cfg(feature="appstore")]
        let (data, notice) = {
            let data = root.join("codex");
            fs::create_dir_all(&data).map_err(|_| "无法创建本机数据目录")?;
            (data, "本地服务已启动；本机尚未配置可访问的 Codex 会话与发送通道。".to_string())
        };
        #[cfg(not(feature="appstore"))]
        let (data, notice) = {
            let data = std::env::var_os("CODEX_HOME").map(PathBuf::from)
                .unwrap_or(handle.path().home_dir().map_err(|_| "无法定位用户目录")?.join(".codex"));
            if !data.is_dir() { return Err("本地服务已包含在 App 中；请先在本机安装并打开 Codex，建立会话后重试".into()); }
            (data, String::new())
        };
        handle.state::<LocalService>().start(&bundled_executable(&handle)?, &root, &data, notice)
    }).await.map_err(|_| "本地服务启动任务失败")??;
    app.state::<crate::network::Network>().login_local(&info.address, &token).await?;
    Ok(info)
}
