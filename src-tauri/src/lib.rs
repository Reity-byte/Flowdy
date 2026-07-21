use base64::{engine::general_purpose::STANDARD, Engine};

#[tauri::command]
fn save_image_base64(path: String, data_url: String) -> Result<(), String> {
    if !(path.ends_with(".png") || path.ends_with(".jpg") || path.ends_with(".jpeg")) {
        return Err("Unsupported file extension".to_string());
    }
    // Data URLs look like `data:image/png;base64,<payload>` — strip up to the
    // first comma so this works for any image mime type, not just PNG.
    let b64 = data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(&data_url);
    let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Reads an image file from disk and returns it as a `data:` URL, so the
/// frontend (which picked the path via the native file-open dialog) can load
/// it into an `<img>`/canvas without needing filesystem access of its own.
#[tauri::command]
fn read_image_base64(path: String) -> Result<String, String> {
    let lower = path.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        return Err("Unsupported file extension".to_string());
    };

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_image_base64, read_image_base64])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
