use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_REPLY: usize = 32 * 1024 * 1024;

#[derive(Clone)]
struct Session {
    origin: Url,
    client: Client,
    epoch: u64,
}
struct Inner {
    active: Option<Session>,
    epoch: u64,
    cancel: CancellationToken,
    clients: HashMap<String, Client>,
    requests: HashMap<String, CancellationToken>,
    cancelled_requests: HashSet<String>,
    closed_streams: HashSet<String>,
    stream: Option<(String, CancellationToken)>,
}
impl Default for Inner {
    fn default() -> Self {
        Self {
            active: None,
            epoch: 0,
            cancel: CancellationToken::new(),
            clients: HashMap::new(),
            requests: HashMap::new(),
            cancelled_requests: HashSet::new(),
            closed_streams: HashSet::new(),
            stream: None,
        }
    }
}
#[derive(Default)]
pub struct Network(Mutex<Inner>);

impl Network {
    #[cfg(all(feature="local-service", desktop))]
    pub async fn login_local(&self, address: &str, token: &str) -> Result<(), String> {
        let url = origin(address)?;
        if url.host_str() != Some("127.0.0.1") { return Err("本地服务地址无效".into()); }
        let key = url.as_str().to_owned();
        #[cfg(feature="embedded-tailscale")]
        let key = format!("{}:{}", crate::embedded::enabled(), key);
        let client = Client::builder().cookie_store(true).no_proxy()
            .use_preconfigured_tls(crate::trust::config(&url)?)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8)).build().map_err(|_| "无法初始化本地连接")?;
        let response = client.post(url.join("api/login").unwrap())
            .json(&serde_json::json!({"token":token})).send().await.map_err(|_| "本地服务认证连接失败")?;
        if !response.status().is_success() { return Err("本地服务认证失败".into()); }
        self.0.lock().unwrap().clients.insert(key, client);
        Ok(())
    }
    pub fn forget_origin(&self,url:&Url){self.0.lock().unwrap().forget(url);}
    #[cfg(feature = "system-discovery")]
    pub fn reset_transport(&self) {
        self.pause();
        let mut inner=self.0.lock().unwrap();inner.active=None;inner.clients.clear();inner.epoch+=1;
    }
    pub fn pause(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.cancel.cancel();
        inner.requests.clear();
        if let Some((_, cancel)) = inner.stream.take() {
            cancel.cancel();
        }
    }
    fn snapshot(&self, epoch: u64) -> Result<(Session, CancellationToken), String> {
        let inner = self.0.lock().unwrap();
        let session = inner.active.as_ref().ok_or("请选择电脑")?;
        if session.epoch != epoch || inner.cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        Ok((session.clone(), inner.cancel.child_token()))
    }
}

pub fn ensure_local(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法读取窗口来源")?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    if !local {
        return Err("仅允许客户端内置页面访问连接".into());
    }
    Ok(())
}

fn origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "请输入完整的 http:// 或 https:// 地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("连接地址只能包含协议、主机和端口".into());
    }
    crate::service_probe::validate_transport(&url)?;
    Ok(url)
}

impl Inner {
    fn forget(&mut self, url: &Url) {
        let key = url.as_str();
        self.clients.retain(|k, _| k != key && k != &format!("true:{key}") && k != &format!("false:{key}"));
        if self.active.as_ref().is_some_and(|s| s.origin == *url) {
            self.cancel.cancel();
            for token in self.requests.values() { token.cancel(); }
            self.requests.clear();
            if let Some((_, token)) = self.stream.take() { token.cancel(); }
            self.active = None;
            self.epoch += 1;
        }
    }
}

#[tauri::command]
pub fn forget_connection(window: WebviewWindow, network: State<'_, Network>, address: String) -> Result<(), String> {
    ensure_local(&window)?;
    // Removal must also work for HTTP connections saved by an older build.
    let url = Url::parse(&address).map_err(|_| "无效连接地址")?;
    network.0.lock().unwrap().forget(&url);
    Ok(())
}

#[derive(Serialize)]
pub struct Active {
    epoch: u64,
    origin: String,
}

#[tauri::command]
pub fn activate(
    window: WebviewWindow,
    network: State<'_, Network>,
    address: String,
) -> Result<Active, String> {
    ensure_local(&window)?;
    let url = origin(&address)?;
    let mut inner = network.0.lock().unwrap();
    inner.cancel.cancel();
    inner.cancel = CancellationToken::new();
    inner.requests.clear();
    if let Some((_, token)) = inner.stream.take() {
        token.cancel();
    }
    let key = url.as_str().to_owned();
    #[cfg(feature="embedded-tailscale")]
    let key = format!("{}:{}",crate::embedded::enabled(),key);
    let client = if let Some(client) = inner.clients.get(&key) {
        client.clone()
    } else {
        if inner.clients.len() >= 20 {
            inner.clients.clear();
        }
        let builder = Client::builder()
            .cookie_store(true)
            .use_preconfigured_tls(crate::trust::config(&url)?)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(20));
        #[cfg(feature="embedded-tailscale")]
        let builder = if let Some(proxy)=crate::embedded::proxy()? {builder.proxy(proxy)}else{builder};
        let client = builder.build()
            .map_err(|_| "无法初始化网络")?;
        inner.clients.insert(key.clone(), client.clone());
        client
    };
    inner.epoch += 1;
    let epoch = inner.epoch;
    inner.active = Some(Session {
        origin: url,
        client,
        epoch,
    });
    Ok(Active {
        epoch,
        origin: key.trim_end_matches('/').to_owned(),
    })
}

#[tauri::command]
pub fn deactivate(window: WebviewWindow, network: State<'_, Network>) -> Result<(), String> {
    ensure_local(&window)?;
    network.pause();
    network.0.lock().unwrap().active = None;
    Ok(())
}
#[tauri::command]
pub fn pause_network(window: WebviewWindow, network: State<'_, Network>) -> Result<(), String> {
    ensure_local(&window)?;
    network.pause();
    Ok(())
}
#[tauri::command]
pub fn resume_network(
    window: WebviewWindow,
    network: State<'_, Network>,
    epoch: u64,
) -> Result<(), String> {
    ensure_local(&window)?;
    let mut inner = network.0.lock().unwrap();
    if inner.active.as_ref().map(|s| s.epoch) != Some(epoch) {
        return Err("cancelled".into());
    }
    if inner.cancel.is_cancelled() {
        inner.cancel = CancellationToken::new();
    }
    Ok(())
}

fn endpoint(session: &Session, path: &str, method: &str) -> Result<Url, String> {
    let route = path.split('?').next().unwrap_or("");
    let allowed = match method {
        "GET" => matches!(
            route,
            "/api/status" | "/api/privacy"
                | "/api/models"
                | "/api/guardian/status"
                | "/api/threads"
                | "/api/thread"
                | "/api/thread/live"
                | "/api/send-status"
                | "/api/queue"
                | "/api/media"
                | "/api/upload-image"
                | "/api/events"
        ),
        "POST" => matches!(
            route,
            "/api/login"
                | "/api/thread/interrupt"
                | "/api/thread/approval"
                | "/api/thread/permissions"
                | "/api/guardian/restart"
                | "/api/logout"
                | "/api/send"
                | "/api/upload-image"
                | "/api/upload-file"
                | "/api/queue/cancel"
                | "/api/queue/steer"
                | "/api/thread/create"
        ),
        _ => false,
    };
    if !allowed || path.contains('#') || path.contains('\\') {
        return Err("不支持的服务接口".into());
    }
    session.origin.join(path).map_err(|_| "无效接口地址".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    status: u16,
    body: String,
    content_type: String,
}

#[tauri::command]
pub async fn request(
    window: WebviewWindow,
    network: State<'_, Network>,
    epoch: u64,
    request_id: String,
    path: String,
    method: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<Reply, String> {
    ensure_local(&window)?;
    let (session, cancel) = network.snapshot(epoch)?;
    let url = endpoint(&session, &path, &method)?;
    if path.split('?').next() == Some("/api/events") {
        return Err("请使用事件订阅".into());
    }
    let payload = match body {
        Some(body) if body.len() <= (MAX_BODY + 2) / 3 * 4 => {
            STANDARD.decode(body).map_err(|_| "上传编码错误")?
        }
        Some(_) => return Err("请求超过 8 MiB".into()),
        None => Vec::new(),
    };
    if payload.len() > MAX_BODY {
        return Err("请求超过 8 MiB".into());
    }
    {
        let mut inner = network.0.lock().unwrap();
        if inner.active.as_ref().map(|s| s.epoch) != Some(epoch)
            || cancel.is_cancelled()
            || inner.cancelled_requests.remove(&request_id)
        {
            return Err("cancelled".into());
        }
        if inner.requests.len() >= 24 {
            return Err("请求过多，请稍候".into());
        }
        inner.requests.insert(request_id.clone(), cancel.clone());
    }
    let work = async {
        let mut builder = session
            .client
            .request(
                Method::from_bytes(method.as_bytes()).map_err(|_| "无效请求方法")?,
                url,
            )
            .timeout(Duration::from_secs(95));
        if method == "POST" {
            let kind = content_type.as_deref().unwrap_or("application/json");
            if !matches!(
                kind,
                "application/json"
                    | "application/octet-stream"
                    | "image/png"
                    | "image/jpeg"
                    | "image/gif"
            ) {
                return Err("不支持的请求格式".into());
            }
            builder = builder.header("Content-Type", kind).body(payload);
        }
        let mut response = builder
            .send()
            .await
            .map_err(|e| crate::trust::error(&e))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        if response.content_length().unwrap_or(0) > MAX_REPLY as u64 {
            return Err("客户端单个媒体最多 32 MiB".into());
        }
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "响应中断，请查询发送状态")?
        {
            if data.len() + chunk.len() > MAX_REPLY {
                return Err("响应超过 32 MiB".into());
            }
            data.extend_from_slice(&chunk);
        }
        Ok(Reply {
            status,
            body: STANDARD.encode(data),
            content_type,
        })
    };
    let result = tokio::select! { _ = cancel.cancelled() => Err("cancelled".into()), result = work => result };
    network.0.lock().unwrap().requests.remove(&request_id);
    result
}

#[tauri::command]
pub fn cancel_request(
    window: WebviewWindow,
    network: State<'_, Network>,
    request_id: String,
) -> Result<(), String> {
    ensure_local(&window)?;
    let mut inner = network.0.lock().unwrap();
    if let Some(token) = inner.requests.remove(&request_id) {
        token.cancel();
    } else {
        if inner.cancelled_requests.len() >= 128 {
            inner.cancelled_requests.clear();
        }
        inner.cancelled_requests.insert(request_id);
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct StreamEvent {
    kind: String,
    event: String,
    data: String,
}
fn notify(
    channel: &Channel<StreamEvent>,
    kind: &str,
    event: &str,
    data: &str,
) -> Result<(), String> {
    channel
        .send(StreamEvent {
            kind: kind.into(),
            event: event.into(),
            data: data.into(),
        })
        .map_err(|_| "cancelled".into())
}

#[tauri::command]
pub async fn stream(
    window: WebviewWindow,
    network: State<'_, Network>,
    epoch: u64,
    stream_id: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    ensure_local(&window)?;
    let (session, cancel) = network.snapshot(epoch)?;
    {
        let mut inner = network.0.lock().unwrap();
        if inner.active.as_ref().map(|s| s.epoch) != Some(epoch)
            || cancel.is_cancelled()
            || inner.closed_streams.remove(&stream_id)
        {
            return Ok(());
        }
        if let Some((_, previous)) = inner.stream.take() {
            previous.cancel();
        }
        inner.stream = Some((stream_id.clone(), cancel.clone()));
    }
    let work = async {
        let response = session
            .client
            .get(endpoint(&session, "/api/events", "GET")?)
            .send()
            .await
            .map_err(|e| crate::trust::error(&e))?;
        if response.status().as_u16() == 401 {
            return notify(&channel, "event", "expired", "");
        }
        if !response.status().is_success() {
            return Err("事件连接被服务拒绝".into());
        }
        notify(&channel, "open", "", "")?;
        let mut chunks = response.bytes_stream();
        let mut pending = Vec::new();
        let mut event = String::new();
        let mut data = String::new();
        loop {
            let chunk = tokio::time::timeout(Duration::from_secs(75), chunks.next())
                .await
                .map_err(|_| "事件连接超时")?;
            let Some(chunk) = chunk else {
                return Err("事件连接已关闭".into());
            };
            let chunk = chunk.map_err(|_| "事件连接中断")?;
            pending.extend_from_slice(&chunk);
            if pending.len() > 1024 * 1024 {
                return Err("事件响应过大".into());
            }
            while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                let line = String::from_utf8(pending.drain(..=end).collect())
                    .map_err(|_| "事件编码错误")?;
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !event.is_empty() || !data.is_empty() {
                        notify(
                            &channel,
                            "event",
                            if event.is_empty() { "message" } else { &event },
                            data.trim_end_matches('\n'),
                        )?;
                    }
                    event.clear();
                    data.clear();
                } else if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim_start_matches(' ').into();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push_str(value.strip_prefix(' ').unwrap_or(value));
                    data.push('\n');
                }
                if data.len() > 1024 * 1024 {
                    return Err("事件数据过大".into());
                }
            }
        }
    };
    let result = tokio::select! { _ = cancel.cancelled() => Ok(()), result = work => result };
    let mut inner = network.0.lock().unwrap();
    if inner.stream.as_ref().map(|(id, _)| id) == Some(&stream_id) {
        inner.stream = None;
    }
    result
}

#[tauri::command]
pub fn close_stream(
    window: WebviewWindow,
    network: State<'_, Network>,
    stream_id: String,
) -> Result<(), String> {
    ensure_local(&window)?;
    let mut inner = network.0.lock().unwrap();
    if inner.stream.as_ref().map(|(id, _)| id) == Some(&stream_id) {
        if let Some((_, token)) = inner.stream.take() {
            token.cancel();
        }
    } else {
        if inner.closed_streams.len() >= 128 {
            inner.closed_streams.clear();
        }
        inner.closed_streams.insert(stream_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forgetting_drops_cookie_client_and_cancels_only_selected_session() {
        let mut inner = Inner::default();
        let target = Url::parse("http://old.example/").unwrap();
        let other = "https://other.example/";
        let client = Client::builder().cookie_store(true).build().unwrap();
        inner.clients.insert(target.to_string(), client.clone());
        inner.clients.insert(other.into(), Client::new());
        inner.active = Some(Session { origin: target.clone(), client, epoch: 0 });
        let request = inner.cancel.child_token();
        inner.requests.insert("request".into(), request.clone());
        inner.forget(&Url::parse(other).unwrap());
        assert!(inner.active.is_some());
        assert!(!request.is_cancelled());
        assert!(inner.clients.contains_key(target.as_str()));
        inner.forget(&target);
        assert!(request.is_cancelled());
        assert!(inner.active.is_none());
        assert!(inner.clients.is_empty());
        assert_eq!(inner.epoch, 1);
    }
    #[test]
    fn origins_have_no_credentials_or_paths() {
        assert!(origin("https://100.100.100.100:8787").is_ok());
        assert!(origin("http://100.100.100.100:8787").is_ok());
        for value in [
            "file:///tmp/a",
            "https://user:secret@host/",
            "https://host/api",
            "https://host/?token=x",
        ] {
            assert!(origin(value).is_err());
        }
    }
    #[test]
    fn api_cannot_escape_selected_origin() {
        let session = Session {
            origin: origin("https://100.100.100.100:8787").unwrap(),
            client: Client::new(),
            epoch: 1,
        };
        for path in [
            "//evil.test/api/status",
            "https://evil.test/api/status",
            "/api/../secret",
            "/api/status#x",
        ] {
            assert!(endpoint(&session, path, "GET").is_err());
        }
        assert_eq!(
            endpoint(&session, "/api/status", "GET").unwrap().host_str(),
            Some("100.100.100.100")
        );
        assert!(endpoint(&session, "/api/thread/live?threadId=test", "GET").is_ok());
        for route in ["/api/thread/approval", "/api/thread/permissions"] {
            assert!(endpoint(&session, route, "POST").is_ok());
            assert!(endpoint(&session, route, "GET").is_err());
        }
    }
}
