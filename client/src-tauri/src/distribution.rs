//! Immutable build identity; never derived from browser storage.
#[tauri::command]
pub fn distribution_info(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    crate::network::ensure_local(&window)?;
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/distribution.json")))
            .map_err(|_| "分发配置无效".to_string())?;
    // Live use retains this marker in each Mach-O slice, including optimized
    // release builds. The packager verifies it without launching the app.
    value["legalBuildStamp"] = serde_json::Value::String(concat!(
        "CODEX_REMOTE_LEGAL_SHA256:",
        include_str!(concat!(env!("OUT_DIR"), "/legal-digest.txt")),
        ":END"
    ).into());
    Ok(value)
}
