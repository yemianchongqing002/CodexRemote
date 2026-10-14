use std::{fs, path::Path};

// Keep Cargo/Xcode builds self-contained too: no Node hook or symlinks required.
fn sync_vendor(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        if !source.join(entry.file_name()).exists() {
            if entry.file_type()?.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let output = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            sync_vendor(&entry.path(), &output)?;
        } else {
            let content = fs::read(entry.path())?;
            if fs::read(&output).ok().as_deref() != Some(content.as_slice()) {
                fs::write(output, content)?;
            }
        }
    }
    Ok(())
}

fn prepare_distribution(root: &Path) {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    println!("cargo:rerun-if-env-changed=CODEX_DISTRIBUTION");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let enabled = |name: &str| std::env::var_os(name).is_some();
    let local_service = enabled("CARGO_FEATURE_LOCAL_SERVICE");
    let store = enabled("CARGO_FEATURE_APPSTORE");
    let ssh = enabled("CARGO_FEATURE_SSH_DEPLOY");
    let discovery = enabled("CARGO_FEATURE_SYSTEM_DISCOVERY");
    let embedded = enabled("CARGO_FEATURE_EMBEDDED_TAILSCALE");
    let selected = std::env::var("CODEX_DISTRIBUTION").ok();
    let legal_source = root.join("../ui/legal.js");
    println!("cargo:rerun-if-changed={}", legal_source.display());
    let legal_bytes = fs::read(&legal_source).expect("Read legal documents");
    let profile = if store {
        assert!(
            !ssh && !discovery && !embedded,
            "App Store cannot include host SDKs or deployment"
        );
        let id = selected.expect("App Store builds require the distribution build entry point");
        assert!(
            ["ios-appstore", "macos-appstore"].contains(&id.as_str()),
            "Unknown distribution"
        );
        let file = root.join("../distributions").join(format!("{id}.json"));
        println!("cargo:rerun-if-changed={}", file.display());
        let p: Value = serde_json::from_slice(&fs::read(file).expect("Read distribution"))
            .expect("Parse distribution");
        let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
        assert_eq!(
            p["platform"].as_str(),
            Some(os.as_str()),
            "Distribution target mismatch"
        );
        assert_eq!(p["id"], id);
        assert_eq!(p["schemaVersion"], 1);
        assert_eq!(p["channel"], "appstore");
        assert_eq!(p["updates"], "store");
        assert_eq!(
            p["modules"],
            json!({"billing":"disabled","ads":"disabled","analytics":"disabled","push":"disabled"}),
            "SDK adapter not implemented"
        );
        assert_eq!(
            p["capabilities"],
            json!({"sshDeploy":false,"systemDiscovery":false,"embeddedTailscale":false,"serverBundles":os=="macos","localService":os=="macos"})
        );
        let config: Value = serde_json::from_str(
            &std::env::var("TAURI_CONFIG").expect("Use distribution build configuration"),
        )
        .unwrap();
        assert_eq!(
            config["bundle"]["resources"],
            json!([]),
            "Store resources must exclude server bundles"
        );
        assert_eq!(config["bundle"]["externalBin"], json!([]));
        assert_eq!(local_service, os == "macos", "Local helper is macOS-only in Store builds");
        if os == "macos" {
            assert_eq!(config["build"]["features"], json!(["appstore", "local-service"]));
            assert!(config["bundle"]["macOS"]["files"]["MacOS/codex-remote-service"].is_string());
        } else {
            assert!(config["build"]["beforeBuildCommand"].is_null());
            assert_eq!(config["build"]["features"], json!(["appstore"]));
        }
        // Hash the very snapshot embedded by Tauri, not a separate receipt that
        // could be refreshed without recompiling the executable.
        let frontend = Path::new(config["build"]["frontendDist"].as_str().expect("Frontend snapshot"));
        assert!(frontend.is_absolute(), "Use the distribution build entry point");
        let legal_snapshot = frontend.join("legal.js");
        println!("cargo:rerun-if-changed={}", legal_snapshot.display());
        assert_eq!(fs::read(&legal_snapshot).expect("Read bundled legal documents"), legal_bytes,
            "Policy snapshot is stale; rerun the distribution build entry point");
        p
    } else {
        assert!(selected.is_none(), "Distribution requires appstore feature");
        json!({"schemaVersion":1,"id":"direct","platform":std::env::var("CARGO_CFG_TARGET_OS").unwrap(),"channel":"direct",
            "branding":{"productName":"Codex Remote Client"},"modules":{"billing":"disabled","ads":"disabled","analytics":"disabled","push":"disabled"},
            "capabilities":{"sshDeploy":ssh,"systemDiscovery":discovery,"embeddedTailscale":embedded,"serverBundles":local_service,"localService":local_service && ["macos", "windows"].contains(&std::env::var("CARGO_CFG_TARGET_OS").unwrap().as_str())},"updates":"manual"})
    };
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    fs::write(out.join("legal-digest.txt"), format!("{:x}", Sha256::digest(&legal_bytes)))
        .expect("Write compiled legal digest");
    fs::write(
        out.join("distribution.json"),
        serde_json::to_vec(&profile).unwrap(),
    )
    .expect("Write distribution identity");
}

fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    prepare_distribution(&root);
    let source = root.join("../../internal/server/web/vendor");
    println!("cargo:rerun-if-changed={}", source.display());
    sync_vendor(&source, &root.join("../ui/vendor")).expect("prepare client renderer assets");
    if std::env::var_os("CARGO_FEATURE_EMBEDDED_TAILSCALE").is_some() {
        let target = std::env::var("TARGET").unwrap();
        let folder = match target.as_str() {
            "aarch64-apple-darwin" => "macos-arm64",
            "x86_64-apple-darwin" => "macos-x64",
            "aarch64-apple-ios" => "ios-arm64",
            "aarch64-apple-ios-sim" => "ios-sim-arm64",
            _ => panic!("embedded-tailscale currently supports macOS and iOS only"),
        };
        let lib = root.join("../../.local/libtailscale-build").join(folder);
        assert!(
            lib.join("libtailscale.a").exists(),
            "Build scripts/build-libtailscale.cjs first"
        );
        cc::Build::new()
            .file(root.join("../../scripts/tailscale-forward.c"))
            .include(&lib)
            .compile("codex_forward");
        println!(
            "cargo:rerun-if-changed={}",
            root.join("../../scripts/tailscale-forward.c").display()
        );
        println!("cargo:rustc-link-search=native={}", lib.display());
        println!("cargo:rustc-link-lib=static=tailscale");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=resolv");
        println!(
            "cargo:rerun-if-changed={}",
            lib.join("libtailscale.a").display()
        );
    }
    tauri_build::build()
}
