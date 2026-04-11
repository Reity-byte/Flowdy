use base64::{engine::general_purpose::STANDARD, Engine};

#[tauri::command]
fn save_png_base64(path: String, data_url: String) -> Result<(), String> {
    let b64 = data_url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&data_url);
    let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_png_base64])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
