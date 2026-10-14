//! TOFU applies only to the selected service transport, never external web/media URLs.
#[cfg(all(target_vendor = "apple", test))]
use rustls::pki_types::CertificateDer;
#[cfg(not(target_vendor = "apple"))]
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
#[cfg(not(target_vendor = "apple"))]
use sha2::{Digest, Sha256};
#[cfg(any(not(target_vendor = "apple"), test))]
use std::sync::Arc;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{State, WebviewWindow};
use url::Url;
use x509_parser::prelude::*;

#[derive(Debug)]
struct Pins {
    path: PathBuf,
    values: BTreeMap<String, String>,
    generations: BTreeMap<String, u64>,
    _lock: fs::File,
}
static PINS: OnceLock<Mutex<Pins>> = OnceLock::new();
pub fn init(path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(path.parent().ok_or("Invalid trust path")?)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| "另一个客户端正在使用服务器身份记录，请先关闭它")?;
    let values = match fs::read(&path) {
        Ok(data) => serde_json::from_slice(&data)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    PINS.set(Mutex::new(Pins {
        path,
        values,
        generations: BTreeMap::new(),
        _lock: lock,
    }))
    .map_err(|_| "Trust already initialized")?;
    Ok(())
}
impl Pins {
    fn save(&self, values: &BTreeMap<String, String>) -> Result<(), String> {
        use std::io::Write;
        let tmp = self.path.with_extension("pending");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp).map_err(|_| "无法保存服务器身份")?;
        f.write_all(&serde_json::to_vec(values).map_err(|_| "身份数据编码失败")?)
            .and_then(|_| f.sync_all())
            .map_err(|_| "无法保存服务器身份")?;
        drop(f);
        fs::rename(tmp, &self.path).map_err(|_| "无法保存服务器身份")?;
        Ok(())
    }
    fn check(&mut self, origin: &str, pin: &str, commit: bool) -> Result<(), String> {
        if let Some(old) = self.values.get(origin) {
            if old != pin {
                return Err("TLS_IDENTITY_CHANGED：服务器身份已变化，连接已阻止。确认服务器重装后可重新信任。".into());
            }
        } else if commit {
            let mut next = self.values.clone();
            next.insert(origin.into(), pin.into());
            self.save(&next)?;
            self.values = next;
        }
        Ok(())
    }
}
#[cfg(not(target_vendor = "apple"))]
fn fingerprint(cert: &CertificateDer<'_>) -> Result<String, rustls::Error> {
    let (_, x) = X509Certificate::from_der(cert.as_ref())
        .map_err(|_| rustls::Error::General("无效服务器证书".into()))?;
    let digest = Sha256::digest(x.public_key().raw);
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}
#[cfg(not(target_vendor = "apple"))]
fn check(
    origin: &str,
    cert: &CertificateDer<'_>,
    commit: bool,
    generation: u64,
) -> Result<(), rustls::Error> {
    let pin = fingerprint(cert)?;
    let mut pins = PINS
        .get()
        .ok_or_else(|| rustls::Error::General("身份存储未初始化".into()))?
        .lock()
        .map_err(|_| rustls::Error::General("身份存储不可用".into()))?;
    if pins.generations.get(origin).copied().unwrap_or(0) != generation {
        return Err(rustls::Error::General("身份已重置，请重新连接".into()));
    }
    pins.check(origin, &pin, commit)
        .map_err(rustls::Error::General)
}
#[cfg(not(target_vendor = "apple"))]
#[derive(Debug)]
struct Verifier {
    origin: String,
    generation: u64,
    provider: Arc<rustls::crypto::CryptoProvider>,
}
#[cfg(not(target_vendor = "apple"))]
impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let (_, x) = X509Certificate::from_der(cert.as_ref())
            .map_err(|_| rustls::Error::General("无效服务器证书".into()))?;
        let now = now.as_secs() as i64;
        if now < x.validity().not_before.timestamp() || now > x.validity().not_after.timestamp() {
            return Err(rustls::Error::General(
                "服务器证书过期或尚未生效，请检查时间并更新服务".into(),
            ));
        }
        check(&self.origin, cert, false, self.generation)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let valid = rustls::crypto::verify_tls12_signature(
            m,
            c,
            s,
            &self.provider.signature_verification_algorithms,
        )?;
        check(&self.origin, c, true, self.generation)?;
        Ok(valid)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let valid = rustls::crypto::verify_tls13_signature(
            m,
            c,
            s,
            &self.provider.signature_verification_algorithms,
        )?;
        check(&self.origin, c, true, self.generation)?;
        Ok(valid)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
#[cfg(not(target_vendor = "apple"))]
pub fn config(url: &Url) -> Result<rustls::ClientConfig, String> {
    let generation = PINS
        .get()
        .ok_or("身份存储未初始化")?
        .lock()
        .map_err(|_| "身份存储不可用")?
        .generations
        .get(&url.origin().ascii_serialization())
        .copied()
        .unwrap_or(0);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS 初始化失败")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Verifier {
            origin: url.origin().ascii_serialization(),
            generation,
            provider,
        }))
        .with_no_client_auth();
    // Every new connection must verify the current identity; no resumption across resets.
    cfg.resumption = rustls::client::Resumption::disabled();
    Ok(cfg)
}
// Apple Secure Transport performs the handshake/signature checks. This callback
// runs before reqwest can send HTTP bytes; it preserves our origin-scoped SPKI TOFU.
#[cfg(target_vendor = "apple")]
fn apple_verify(origin: &str, der: &[u8], generation: u64) -> Result<(), String> {
    let (remaining, x) = X509Certificate::from_der(der).map_err(|_| "无效服务器证书")?;
    if !remaining.is_empty() || !x.validity().is_valid() {
        return Err("服务器证书过期或尚未生效，请检查时间并更新服务".into());
    }
    // CommonCrypto is supplied by Apple; keep existing SHA-256 SPKI pins compatible.
    #[link(name = "System")]
    extern "C" {
        fn CC_SHA256(data: *const std::ffi::c_void, len: u32, out: *mut u8) -> *mut u8;
    }
    let spki = x.public_key().raw;
    let len = u32::try_from(spki.len()).map_err(|_| "服务器公钥过大")?;
    let mut digest = [0u8; 32];
    // SAFETY: spki is valid for len bytes; digest is a writable 32-byte SHA-256 buffer.
    unsafe {
        CC_SHA256(spki.as_ptr().cast(), len, digest.as_mut_ptr());
    }
    let pin: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let mut pins = PINS
        .get()
        .ok_or("身份存储未初始化")?
        .lock()
        .map_err(|_| "身份存储不可用")?;
    if pins.generations.get(origin).copied().unwrap_or(0) != generation {
        return Err("身份已重置，请重新连接".into());
    }
    pins.check(origin, &pin, true)
}
#[cfg(target_vendor = "apple")]
pub fn config(url: &Url) -> Result<native_tls::TlsConnector, String> {
    let origin = url.origin().ascii_serialization();
    let generation = PINS
        .get()
        .ok_or("身份存储未初始化")?
        .lock()
        .map_err(|_| "身份存储不可用")?
        .generations
        .get(&origin)
        .copied()
        .unwrap_or(0);
    let mut builder = native_tls::TlsConnector::builder();
    builder
        .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
        .apple_peer_verifier(move |der| apple_verify(&origin, der, generation));
    builder.build().map_err(|_| "TLS 初始化失败".into())
}
pub fn error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut cause: Option<&dyn Error> = Some(e);
    while let Some(c) = cause {
        let text = c.to_string();
        if text.contains("TLS_IDENTITY_CHANGED") {
            return "TLS_IDENTITY_CHANGED：服务器身份已变化，连接已阻止。请在连接检查中确认后重新信任。".into();
        }
        cause = c.source();
    }
    "无法建立安全连接，请检查服务地址、服务端版本与系统时间".into()
}
#[tauri::command]
pub fn trust_fingerprint(window: WebviewWindow, address: String) -> Result<Option<String>, String> {
    crate::network::ensure_local(&window)?;
    let url = crate::service_probe::computer_url(&address)?;
    let pins = PINS
        .get()
        .ok_or("身份存储未初始化")?
        .lock()
        .map_err(|_| "身份存储不可用")?;
    Ok(pins
        .values
        .get(&url.origin().ascii_serialization())
        .cloned())
}
#[tauri::command]
pub fn reset_trust(
    window: WebviewWindow,
    network: State<'_, crate::network::Network>,
    address: String,
    expected: String,
) -> Result<(), String> {
    crate::network::ensure_local(&window)?;
    let url = crate::service_probe::computer_url(&address)?;
    let mut pins = PINS
        .get()
        .ok_or("身份存储未初始化")?
        .lock()
        .map_err(|_| "身份存储不可用")?;
    let origin = url.origin().ascii_serialization();
    if pins.values.get(&origin) != Some(&expected) {
        return Err("身份记录已变化，请重新检查".into());
    }
    let mut next = pins.values.clone();
    next.remove(&origin);
    pins.save(&next)?;
    pins.values = next;
    *pins.generations.entry(origin).or_default() += 1;
    drop(pins);
    network.forget_origin(&url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn certificate(
        key: &rcgen::KeyPair,
    ) -> (
        CertificateDer<'static>,
        rustls::pki_types::PrivateKeyDer<'static>,
    ) {
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(key)
            .unwrap();
        (
            cert.der().clone(),
            rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
    }
    #[test]
    fn real_tls_tofu_renewal_changed_identity_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path().join("pins.json")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("https://{}", listener.local_addr().unwrap())).unwrap();
        let expired_key = rcgen::KeyPair::generate().unwrap();
        let mut expired_params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        expired_params.not_after = rcgen::date_time_ymd(2000, 1, 1);
        let expired = expired_params.self_signed(&expired_key).unwrap();
        #[cfg(not(target_vendor = "apple"))]
        {
            let verifier = Verifier {
                origin: url.origin().ascii_serialization(),
                generation: 0,
                provider: Arc::new(rustls::crypto::ring::default_provider()),
            };
            assert!(verifier
                .verify_server_cert(
                    expired.der(),
                    &[],
                    &ServerName::try_from("localhost").unwrap(),
                    &[],
                    UnixTime::now()
                )
                .is_err());
            assert!(
                !dir.path().join("pins.json").exists(),
                "Invalid certificate must not establish first trust"
            );
        }
        #[cfg(target_vendor = "apple")]
        assert!(apple_verify(url.as_str().trim_end_matches('/'), expired.der(), 0).is_err());
        let first = rcgen::KeyPair::generate().unwrap();
        let other = rcgen::KeyPair::generate().unwrap();
        let certs = vec![
            (
                expired.der().clone(),
                rustls::pki_types::PrivatePkcs8KeyDer::from(expired_key.serialize_der()).into(),
            ),
            certificate(&first),
            certificate(&first),
            certificate(&other),
            certificate(&other),
        ];
        let server = std::thread::spawn(move || {
            let mut requests = 0;
            for (cert, key) in certs {
                let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key)
                .unwrap();
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let connection = rustls::ServerConnection::new(Arc::new(cfg)).unwrap();
                let mut stream = rustls::StreamOwned::new(connection, socket);
                let mut data = [0; 4096];
                if let Ok(n) = stream.read(&mut data) {
                    if n > 0 {
                        requests += 1;
                        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
                    }
                }
            }
            requests
        });
        let request = || {
            reqwest::blocking::Client::builder()
                .no_proxy()
                .use_preconfigured_tls(config(&url).unwrap())
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap()
                .get(url.as_str())
                .header("Authorization", "test-secret")
                .send()
        };
        assert!(
            request().is_err(),
            "Expired certificate must fail during a real handshake"
        );
        assert!(!dir.path().join("pins.json").exists());
        assert_eq!(request().unwrap().text().unwrap(), "ok");
        let saved = fs::read(dir.path().join("pins.json")).unwrap();
        assert_eq!(request().unwrap().text().unwrap(), "ok");
        assert_eq!(fs::read(dir.path().join("pins.json")).unwrap(), saved);
        let failure = request().unwrap_err();
        assert!(error(&failure).contains("TLS_IDENTITY_CHANGED"));
        {
            let mut pins = PINS.get().unwrap().lock().unwrap();
            let empty = BTreeMap::new();
            pins.save(&empty).unwrap();
            pins.values = empty;
            *pins
                .generations
                .entry(url.origin().ascii_serialization())
                .or_default() += 1;
        }
        assert_eq!(request().unwrap().text().unwrap(), "ok");
        assert_ne!(fs::read(dir.path().join("pins.json")).unwrap(), saved);
        assert_eq!(
            server.join().unwrap(),
            3,
            "Changed key must fail before sending HTTP credentials"
        );

        #[cfg(target_vendor = "apple")]
        {
            // Exercise tokio-native-tls's nonblocking handshake continuations too.
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let async_url =
                Url::parse(&format!("https://{}", listener.local_addr().unwrap())).unwrap();
            let server = std::thread::spawn(move || {
                let mut requests = 0;
                for (cert, key) in [certificate(&first), certificate(&other)] {
                    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
                        rustls::crypto::ring::default_provider(),
                    ))
                    .with_safe_default_protocol_versions()
                    .unwrap()
                    .with_no_client_auth()
                    .with_single_cert(vec![cert], key)
                    .unwrap();
                    let (socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut stream = rustls::StreamOwned::new(
                        rustls::ServerConnection::new(Arc::new(cfg)).unwrap(),
                        socket,
                    );
                    if let Ok(n) = stream.read(&mut [0u8; 4096]) {
                        if n > 0 {
                            requests += 1;
                            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
                        }
                    }
                }
                requests
            });
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .use_preconfigured_tls(config(&async_url).unwrap())
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .unwrap();
                assert_eq!(
                    client
                        .get(async_url.as_str())
                        .send()
                        .await
                        .unwrap()
                        .text()
                        .await
                        .unwrap(),
                    "ok"
                );
                let err = client
                    .get(async_url.as_str())
                    .header("Authorization", "must-not-leak")
                    .send()
                    .await
                    .unwrap_err();
                assert!(error(&err).contains("TLS_IDENTITY_CHANGED"));
            });
            assert_eq!(
                server.join().unwrap(),
                1,
                "Async changed identity must not receive HTTP credentials"
            );
            let stale_generation = 0;
            let origin = async_url.origin().ascii_serialization();
            *PINS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .generations
                .entry(origin.clone())
                .or_default() += 1;
            let fresh = rcgen::KeyPair::generate().unwrap();
            assert!(
                apple_verify(&origin, certificate(&fresh).0.as_ref(), stale_generation)
                    .unwrap_err()
                    .contains("重置")
            );
        }
    }
}
