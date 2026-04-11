import { useEditorStore } from "../stores/editorStore";

export function ToolPalette() {
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
    <div className="flex flex-col gap-4 rounded-lg border border-shell-border bg-shell-panel p-4">
      <div className="space-y-3">
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
        <span className="text-shell-text opacity-70">{props.label}</span>
        <span className="tabular-nums font-bold text-shell-text">{Math.round(props.value)}{props.suffix ?? ""}</span>
      </div>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} className="h-2 w-full cursor-pointer accent-shell-accent" />
    </div>
  );
}