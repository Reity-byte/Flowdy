import { useState } from "react";
import { useEditorStore, BRUSH_PRESETS, PresetId } from "../stores/editorStore";

export function ToolPalette() {
  const tool = useEditorStore((s) => s.tool);
  const activePresetId = useEditorStore((s) => s.activePresetId);
  const loadPreset = useEditorStore((s) => s.loadPreset);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const brushSize = useEditorStore((s) => s.brushSize);
  const brushHardness = useEditorStore((s) => s.brushHardness);
  const brushOpacity = useEditorStore((s) => s.brushOpacity);
  const intensity = useEditorStore((s) => s.intensity);
  const startTaper = useEditorStore((s) => s.startTaper);
  const endTaper = useEditorStore((s) => s.endTaper);
  const colorMix = useEditorStore((s) => s.colorMix);

  const setBrushSize = useEditorStore((s) => s.setBrushSize);
  const setBrushHardness = useEditorStore((s) => s.setBrushHardness);
  const setBrushOpacity = useEditorStore((s) => s.setBrushOpacity);
  const setIntensity = useEditorStore((s) => s.setIntensity);
  const setStartTaper = useEditorStore((s) => s.setStartTaper);
  const setEndTaper = useEditorStore((s) => s.setEndTaper);
  const setColorMix = useEditorStore((s) => s.setColorMix);

  return (
    <div className="flex flex-col gap-5">
      {/* PRESETY PRO ŠTĚTEC */}
      {tool === "brush" && (
        <div className="relative">
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="flex w-full items-center justify-between bg-shell-bg text-sm text-white px-3 py-2 rounded-lg border border-shell-border hover:border-blue-500 transition-colors"
          >
            {activePresetId ? BRUSH_PRESETS[activePresetId as PresetId].name : "Vlastní nastavení..."}
            <span className="text-xs opacity-60">{isMenuOpen ? "▲" : "▼"}</span>
          </button>

          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
              <div className="absolute top-full left-0 mt-2 w-full bg-[#1a1a24] border border-shell-border rounded-lg shadow-2xl z-50 overflow-hidden flex flex-col">
                {Object.entries(BRUSH_PRESETS).map(([id, preset]) => (
                  <button
                    key={id}
                    onClick={() => { loadPreset(id as PresetId); setIsMenuOpen(false); }}
                    className={`flex items-center justify-between px-3 py-3 hover:bg-blue-600/20 transition-colors ${activePresetId === id ? 'bg-blue-600/20 border-l-2 border-blue-500' : 'border-l-2 border-transparent'}`}
                  >
                    <span className="text-xs font-medium text-left">{preset.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* POSUVNÍKY */}
      <div className="space-y-4">
        <Slider label="Size" min={1} max={120} value={brushSize} onChange={setBrushSize} suffix="px" />
        <Slider label="Hardness" min={0} max={100} value={Math.round(brushHardness * 100)} onChange={(v) => setBrushHardness(v / 100)} suffix="%" />
        <Slider label="Opacity" min={1} max={100} value={Math.round(brushOpacity * 100)} onChange={(v) => setBrushOpacity(v / 100)} suffix="%" />
        <hr className="border-shell-border my-2" />
        <Slider label="Flow (Intensity)" min={1} max={100} value={Math.round(intensity * 100)} onChange={(v) => setIntensity(v / 100)} suffix="%" />
        <Slider label="Start Taper" min={0} max={500} value={startTaper} onChange={setStartTaper} suffix="px" />
        <Slider label="End Taper" min={0} max={500} value={endTaper} onChange={setEndTaper} suffix="px" />
        <Slider label="Color Mix" min={0} max={100} value={Math.round(colorMix * 100)} onChange={(v) => setColorMix(v / 100)} suffix="%" />
      </div>
    </div>
  );
}

function Slider(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void; suffix?: string; }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-shell-text opacity-70 font-medium">{props.label}</span>
        <span className="tabular-nums font-bold text-shell-text">{Math.round(props.value)}{props.suffix ?? ""}</span>
      </div>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} className="h-1.5 w-full cursor-pointer accent-blue-500 bg-shell-bg rounded-full appearance-none" />
    </div>
  );
}