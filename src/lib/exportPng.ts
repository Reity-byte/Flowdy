import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

/**
 * Opens a native save dialog and writes the PNG via the Tauri command
 * `save_png_base64` (Rust decodes base64 and uses `std::fs::write`).
 */
export async function exportPngDataUrl(dataUrl: string): Promise<void> {
  const path = await save({
    defaultPath: "artwork.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (path == null) return;
  await invoke("save_png_base64", { path, dataUrl });
}
