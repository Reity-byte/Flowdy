import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

/**
 * Opens a native save dialog and writes the image via the Tauri command
 * `save_image_base64` (Rust decodes the data URL's base64 payload and uses
 * `std::fs::write`). Returns false if the user cancelled the dialog.
 */
export async function exportImageDataUrl(
  dataUrl: string,
  defaultFilename: string,
  extension: "png" | "jpg",
): Promise<boolean> {
  const path = await save({
    defaultPath: defaultFilename,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (path == null) return false;
  await invoke("save_image_base64", { path, dataUrl });
  return true;
}
