import { useState } from "react";
import { useAppStore } from "../stores/appStore";
import { Button } from "./Button";

const PRESETS = [
  { name: "Square", width: 2048, height: 2048 },
  { name: "Screen Size (16:9)", width: 1920, height: 1080 },
  { name: "4K UHD", width: 3840, height: 2160 },
  { name: "A4 Print", width: 2480, height: 3508 }
];

export function NewCanvasModal() {
  const isOpen = useAppStore((s) => s.isNewCanvasPopupOpen);
  const togglePopup = useAppStore((s) => s.toggleNewCanvasPopup);
  const openEditor = useAppStore((s) => s.openEditor);

  const [useCustom, setUseCustom] = useState(false);
  const [customW, setCustomW] = useState(2048);
  const [customH, setCustomH] = useState(2048);

  if (!isOpen) return null;

  const handleCreate = (w: number, h: number) => {
    const width = Math.round(w);
    const height = Math.round(h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || width > 8192 || height < 64 || height > 8192) {
      useAppStore.getState().showNotification("Size must be 64–8192 px");
      return;
    }
    void openEditor(undefined, width, height);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-shell-border bg-shell-panel p-6 shadow-2xl">
        <h2 className="mb-4 text-xl font-bold text-white">Create New Canvas</h2>

        <div className="flex flex-col gap-2 mb-6">
          {!useCustom && PRESETS.map((preset) => (
            <Button
              key={preset.name}
              variant="secondary"
              onClick={() => handleCreate(preset.width, preset.height)}
              className="w-full justify-between p-3 text-left"
            >
              <span className="font-semibold text-white">{preset.name}</span>
              <span className="text-xs text-slate-400">{preset.width} x {preset.height} px</span>
            </Button>
          ))}

          <Button
            variant="secondary"
            pressed={useCustom}
            onClick={() => setUseCustom(!useCustom)}
            className="w-full justify-between p-3 text-left"
          >
            <span className="font-semibold text-white">Custom Size</span>
            <span className="text-xs text-slate-400">Configure</span>
          </Button>

          {useCustom && (
            <div className="flex gap-3 p-3 border border-shell-border rounded-lg bg-shell-bg">
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Width (px)</label>
                <input type="number" min={64} max={8192} value={customW} onChange={(e) => setCustomW(Number(e.target.value))} className="w-full bg-shell-panel border border-slate-700 rounded p-2 text-white outline-none focus:border-shell-accent" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Height (px)</label>
                <input type="number" min={64} max={8192} value={customH} onChange={(e) => setCustomH(Number(e.target.value))} className="w-full bg-shell-panel border border-slate-700 rounded p-2 text-white outline-none focus:border-shell-accent" />
              </div>
              <Button variant="primary" onClick={() => handleCreate(customW, customH)} className="self-end px-4 py-2 font-semibold">Create</Button>
            </div>
          )}
        </div>

        <Button
          variant="secondary"
          onClick={() => {
            setUseCustom(false);
            togglePopup(false);
          }}
          className="w-full py-2"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
