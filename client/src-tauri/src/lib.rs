#[cfg(all(feature = "local-service", desktop))]
mod local_service;
#[cfg(feature = "ssh-deploy")]
mod deploy;
mod distribution;
#[cfg(feature = "embedded-tailscale")]
mod embedded;
#[cfg(any(feature = "ssh-deploy", feature = "system-discovery"))]
mod host_process;
#[cfg(any(feature = "ssh-deploy", feature = "system-discovery"))]
mod net_address;
mod network;
mod trust;
mod service_probe;
#[cfg(feature = "system-discovery")]
mod tailscale;

use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_link(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    url: String,
) -> Result<(), String> {
    network::ensure_local(&window)?;
    let parsed = url::Url::parse(&url).map_err(|_| "无效链接")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("仅支持 HTTP/HTTPS 链接".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| "无法打开浏览器".into())
}

// Save only user-requested media to Downloads; never accept an output path.
#[tauri::command]
async fn save_media(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filename: String,
    body: String,
) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;
    network::ensure_local(&window)?;
    if filename.is_empty()
        || filename.len() > 240
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || filename.starts_with('.')
    {
        return Err("媒体文件名无效".into());
    }
    let file = std::path::Path::new(&filename);
    let ext = file
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov", "m4v"].contains(&ext.as_str()) {
        return Err("不支持的媒体扩展名".into());
    }
    if body.len() > 45 * 1024 * 1024 {
        return Err("媒体超过客户端下载限制".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "媒体数据无效")?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "无法定位下载文件夹")?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|_| "无法访问下载文件夹")?;
        let stem = std::path::Path::new(&filename)
            .file_stem()
            .unwrap()
            .to_string_lossy();
        for n in 0..1000 {
            let path = dir.join(if n == 0 {
                filename.clone()
            } else {
                format!("{stem} ({n}).{ext}")
            });
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut output) => {
                    if output
                        .write_all(&data)
                        .and_then(|_| output.sync_all())
                        .is_err()
                    {
                        drop(output);
                        let _ = std::fs::remove_file(&path);
                        return Err("保存失败，请检查磁盘空间和下载文件夹权限".to_string());
                    }
                    return Ok(path.to_string_lossy().into_owned());
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法在下载文件夹创建文件".to_string()),
            }
        }
        Err("同名文件过多，请整理下载文件夹后重试".to_string())
    })
    .await
    .map_err(|_| "保存任务失败".to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|_app| {
            trust::init(_app.path().app_data_dir()?.join("trusted-servers.json"))?;
            #[cfg(feature = "embedded-tailscale")]
            embedded::init(_app.path().app_data_dir()?);
            Ok(())
        })
        .manage(network::Network::default())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if !focused {
                    window.state::<network::Network>().pause();
                }
                let _ = window.emit("client-focus", *focused);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(all(feature = "local-service", desktop))]
                window.state::<local_service::LocalService>().stop();
                window.state::<network::Network>().pause();
                #[cfg(feature = "embedded-tailscale")]
                embedded::close();
            }
        });
    #[cfg(feature = "ssh-deploy")]
    let builder = builder.manage(deploy::Deployment::default());
    #[cfg(all(feature = "local-service", desktop))]
    let builder = builder.manage(local_service::LocalService::default());
    builder
        .invoke_handler(tauri::generate_handler![
            distribution::distribution_info,
            #[cfg(all(feature = "local-service", desktop))]
            local_service::local_service_start,
            service_probe::service_probe,
            network::activate,
            trust::trust_fingerprint,
            trust::reset_trust,
            network::deactivate,
            network::forget_connection,
            network::resume_network,
            network::pause_network,
            network::request,
            network::cancel_request,
            network::stream,
            network::close_stream,
            #[cfg(feature = "system-discovery")]
            tailscale::tailscale_status,
            #[cfg(feature = "system-discovery")]
            tailscale::tailscale_mode,
            #[cfg(feature = "system-discovery")]
            tailscale::tailscale_login,
            #[cfg(feature = "system-discovery")]
            tailscale::tailscale_open,
            #[cfg(feature = "ssh-deploy")]
            deploy::ssh_status,
            #[cfg(feature = "ssh-deploy")]
            deploy::ssh_probe,
            #[cfg(feature = "ssh-deploy")]
            deploy::ssh_start,
            open_link,
            save_media
        ])
        .build(tauri::generate_context!())
        .expect("Cannot run Codex Remote Client")
        .run(|app, event| {
            #[cfg(all(feature = "local-service", desktop))]
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<local_service::LocalService>().stop();
            }
            let _ = (app, event);
        });
}
