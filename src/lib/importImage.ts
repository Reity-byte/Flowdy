import { isTauri, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/**
 * Opens a native file picker (Tauri) or an `<input type=file>` (browser dev
 * mode) and resolves to the picked image as a data URL, or null if the user
 * cancelled. In Tauri, reading the file's bytes goes through the
 * `read_image_base64` Rust command since the frontend has no direct
 * filesystem access.
 */
export async function pickImageDataUrl(): Promise<string | null> {
  if (isTauri()) {
    const path = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (!path || Array.isArray(path)) return null;
    return await invoke<string>("read_image_base64", { path });
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    // Supported in Chromium-based webviews (this app's dev/browser target);
    // if unsupported elsewhere the promise simply doesn't resolve on cancel.
    input.oncancel = () => resolve(null);
    input.click();
  });
}
