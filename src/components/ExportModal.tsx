// src/components/ExportModal.tsx
import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { documentEngineRef } from "../engine/documentEngineRef";
import { useAppStore } from "../stores/appStore";
import { exportImageDataUrl } from "../lib/exportPng";
import { Button } from "./Button";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function ExportModal({ onClose }: { onClose: () => void }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [transparent, setTransparent] = useState(false);

  const handleExport = async (format: 'png' | 'jpg', scale: number) => {
    const engine = documentEngineRef.current;
    if (!engine) return;

    showNotification("Processing export...");
    const blob = await engine.exportAsBlob(format, scale, format === 'png' && transparent);
    if (!blob) return;

    const filename = `artwork-${Date.now()}.${format}`;

    // Anchor-download of a blob: URL is unreliable inside Tauri's webviews
    // (WKWebView/Android), so use the native save dialog there instead.
    if (isTauri()) {
      try {
        const dataUrl = await blobToDataUrl(blob);
        const saved = await exportImageDataUrl(dataUrl, filename, format);
        if (saved) {
          showNotification("Artwork exported! ✅");
          onClose();
        }
      } catch (e) {
        showNotification("Export failed");
      }
      return;
    }

    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        const file = new File([blob], filename, { type: blob.type });
        await navigator.share({ files: [file], title: 'Flowdy Export' });
        showNotification("Export shared! ✅");
      } catch (e) {
        if ((e as Error).name !== "AbortError") showNotification("Export failed");
      }
      onClose();
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    showNotification("Artwork exported! ✅");
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-4 backdrop-blur-sm">
      <div className="bg-shell-panel border border-shell-border p-6 rounded-2xl w-full max-w-sm shadow-2xl text-white">
        <h2 className="text-xl font-bold mb-4">Export Artwork</h2>
        <div className="space-y-4">
          <section>
            <p className="text-sm opacity-60 mb-2 font-bold uppercase">PNG</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => handleExport('png', 1)} className="p-3">Standard (1x)</Button>
              <Button variant="secondary" onClick={() => handleExport('png', 2)} className="p-3">High-Res (2x)</Button>
            </div>
            <label className="flex items-center gap-2 mt-3 text-sm opacity-80 cursor-pointer">
              <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
              Transparent background
            </label>
          </section>
          <section>
            <p className="text-sm opacity-60 mb-2 font-bold uppercase">JPG</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => handleExport('jpg', 1)} className="p-3">Standard (1x)</Button>
              <Button variant="secondary" onClick={() => handleExport('jpg', 2)} className="p-3">High-Res (2x)</Button>
            </div>
          </section>
        </div>
        <Button variant="ghost" onClick={onClose} className="w-full mt-6 p-3 font-bold uppercase tracking-widest text-xs">Cancel</Button>
      </div>
    </div>
  );
}
