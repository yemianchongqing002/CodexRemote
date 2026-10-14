//! Connection checks are independent of SSH deployment.
use serde::Serialize;
use std::{io::Read, time::Duration};
pub(crate) fn computer_url(address: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(address).map_err(|_| "无效电脑地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("无效电脑地址".into());
    }
    validate_transport(&url)?;
    Ok(url)
}

pub(crate) fn validate_transport(_url: &url::Url) -> Result<(), String> {
    Ok(())
}

#[derive(Serialize)]
pub struct ServiceProbe {
    address: String,
    state: String,
    name: String,
    release: Option<serde_json::Value>,
    #[serde(rename = "releaseState")]
    release_state: String,
}
#[tauri::command]
pub async fn service_probe(
    window: tauri::WebviewWindow,
    address: String,
) -> Result<ServiceProbe, String> {
    crate::network::ensure_local(&window)?;
    computer_url(&address)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = ServiceProbe {
            address: address.clone(),
            state: "unreachable".into(),
            name: String::new(),
            release: None,
            release_state: "unknown".into(),
        };
        let builder = reqwest::blocking::Client::builder()
            .use_preconfigured_tls(crate::trust::config(&computer_url(&address)?)?)
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        #[cfg(feature = "embedded-tailscale")]
        let builder = if let Some(proxy) = crate::embedded::proxy()? {
            builder.proxy(proxy)
        } else {
            builder
        };
        let client = builder.build().map_err(|_| "连接初始化失败")?;
        let response = match client.get(format!("{address}/api/status")).send() {
            Ok(response) => response,
            Err(e) => { let message=crate::trust::error(&e);if message.contains("TLS_IDENTITY_CHANGED"){return Err(message);}return Ok(result); }
        };
        {
            if response.status().as_u16() == 401 {
                result.state = "auth".into();
            } else if response.status().is_success() {
                let mut body = String::new();
                if response.take(1024 * 1024).read_to_string(&mut body).is_ok() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
                        if value["adapter"] == "desktop-rollout" {
                            result.state = "ready".into();
                            if let Some(release) = value.get("release").filter(|v| !v.is_null()) {
                                result.release = Some(release.clone());
                                result.release_state = "available".into();
                            }
                            result.name = value["connectionName"]
                                .as_str()
                                .or_else(|| value["hostName"].as_str())
                                .unwrap_or("")
                                .into();
                        } else {
                            result.state = "other".into();
                        }
                    } else {
                        result.state = "other".into();
                    }
                }
            } else {
                result.state = "other".into();
            }
        }
        if result.state == "ready" && result.release.is_none() {
            result.release_state = "unsupported".into();
        }
        if result.state == "auth" {
            if let Ok(response) = client.get(format!("{address}/api/version")).send() {
                if response.status().as_u16() == 404 {
                    result.release_state = "unsupported".into();
                } else if response.status().is_success() {
                    let mut body = String::new();
                    if response.take(1024 * 1024).read_to_string(&mut body).is_ok() {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
                            if value["adapter"] == "desktop-rollout" {
                                if let Some(release) = value.get("release").filter(|v| !v.is_null())
                                {
                                    result.release = Some(release.clone());
                                    result.release_state = "available".into();
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| "服务检查异常")?
}
