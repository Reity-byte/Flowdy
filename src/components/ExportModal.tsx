// src/components/ExportModal.tsx
import { documentEngineRef } from "../engine/documentEngineRef";
import { useAppStore } from "../stores/appStore";

export function ExportModal({ onClose }: { onClose: () => void }) {
  const showNotification = useAppStore((s) => s.showNotification);

  const handleExport = async (format: 'png' | 'jpg', scale: number) => {
    const engine = documentEngineRef.current;
    if (!engine) return;

    showNotification("Processing export...");
    const blob = await engine.exportAsBlob(format, scale);
    
    if (blob) {
      const filename = `artwork-${Date.now()}.${format}`;
      
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        try {
          const file = new File([blob], filename, { type: blob.type });
          await navigator.share({ files: [file], title: 'Flowdy Export' });
          showNotification("Export shared! ✅");
        } catch (e) { console.log("Cancelled"); }
      } else {
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
      }
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-4 backdrop-blur-sm">
      <div className="bg-shell-panel border border-shell-border p-6 rounded-2xl w-full max-w-sm shadow-2xl text-white">
        <h2 className="text-xl font-bold mb-4">Export Artwork</h2>
        <div className="space-y-4">
          <section>
            <p className="text-sm opacity-60 mb-2 font-bold uppercase">Quality / Resolution</p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleExport('png', 1)} className="bg-shell-bg p-3 rounded-xl border border-shell-border hover:bg-blue-600">Standard (1x)</button>
              <button onClick={() => handleExport('png', 2)} className="bg-shell-bg p-3 rounded-xl border border-shell-border hover:bg-blue-600">High-Res (2x)</button>
            </div>
          </section>
        </div>
        <button onClick={onClose} className="w-full mt-6 p-3 opacity-50 hover:opacity-100 font-bold uppercase tracking-widest text-xs">Cancel</button>
      </div>
    </div>
  );
}