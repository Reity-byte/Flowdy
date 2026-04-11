import { useState } from "react";
import { useAppStore } from "../stores/appStore";

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
    void openEditor(undefined, w, h);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-shell-border bg-shell-panel p-6 shadow-2xl">
        <h2 className="mb-4 text-xl font-bold text-white">Create New Canvas</h2>
        
        <div className="flex flex-col gap-2 mb-6">
          {!useCustom && PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => handleCreate(preset.width, preset.height)}
              className="flex justify-between items-center w-full rounded-lg border border-shell-border bg-shell-bg p-3 hover:border-shell-accent hover:bg-slate-800 transition text-left"
            >
              <span className="font-semibold text-white">{preset.name}</span>
              <span className="text-xs text-slate-400">{preset.width} x {preset.height} px</span>
            </button>
          ))}

          <button
            onClick={() => setUseCustom(!useCustom)}
            className={`flex justify-between items-center w-full rounded-lg border p-3 transition text-left ${useCustom ? 'border-shell-accent bg-shell-bg' : 'border-shell-border bg-shell-bg hover:bg-slate-800'}`}
          >
            <span className="font-semibold text-white">Custom Size</span>
            <span className="text-xs text-slate-400">Configure</span>
          </button>

          {useCustom && (
            <div className="flex gap-3 p-3 border border-shell-border rounded-lg bg-shell-bg">
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Width (px)</label>
                <input type="number" value={customW} onChange={(e) => setCustomW(Number(e.target.value))} className="w-full bg-shell-panel border border-slate-700 rounded p-2 text-white outline-none focus:border-shell-accent" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Height (px)</label>
                <input type="number" value={customH} onChange={(e) => setCustomH(Number(e.target.value))} className="w-full bg-shell-panel border border-slate-700 rounded p-2 text-white outline-none focus:border-shell-accent" />
              </div>
              <button onClick={() => handleCreate(customW, customH)} className="self-end bg-shell-accent text-white px-4 py-2 rounded font-semibold hover:brightness-110">Create</button>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            setUseCustom(false);
            togglePopup(false);
          }}
          className="w-full rounded-lg border border-shell-border bg-shell-bg py-2 text-slate-300 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}