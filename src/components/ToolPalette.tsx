import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEditorStore, BRUSH_PRESETS, PresetId } from "../stores/editorStore";
import { renderBrushPreview } from "../engine/brushEngine";
import { Button } from "./Button";
import { Collapsible } from "./Collapsible";

/** Static thumbnail for a preset's own fixed settings — computed once per
 * preset (they never change), reusing the exact real dab-rendering path so
 * it can never mislead about how the brush actually looks (Section 12.3). */
function PresetThumbnail({ preset }: { preset: (typeof BRUSH_PRESETS)[PresetId] }) {
  const dataUrl = useMemo(() => {
    // Fixed dark stroke on a fixed white background — not theme colors.
    // The old light-gray-on-bg-shell-bg/50 combo was invisible in dark
    // theme (this session's report) and would have been just as invisible
    // in light theme too (light gray on a light background), since neither
    // color was actually guaranteed to contrast with the other.
    const canvas = renderBrushPreview({
      size: preset.size,
      hardness: preset.hardness,
      color: "#1a1a1a",
      brushStyle: preset.style,
      opacity: preset.opacity,
      intensity: preset.intensity,
    }, 96, 28);
    return canvas.toDataURL();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.style, preset.size, preset.hardness, preset.intensity]);
  return <img src={dataUrl} alt="" className="h-7 w-24 shrink-0 rounded bg-white" />;
}

export function ToolPalette() {
  const tool = useEditorStore((s) => s.tool);
  const activePresetId = useEditorStore((s) => s.activePresetId);
  const loadPreset = useEditorStore((s) => s.loadPreset);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const brushSize = useEditorStore((s) => s.brushSize);
  const brushHardness = useEditorStore((s) => s.brushHardness);
  const brushOpacity = useEditorStore((s) => s.brushOpacity);
  const intensity = useEditorStore((s) => s.intensity);
  const startTaper = useEditorStore((s) => s.startTaper);
  const endTaper = useEditorStore((s) => s.endTaper);
  const colorMix = useEditorStore((s) => s.colorMix);
  const brushStyle = useEditorStore((s) => s.brushStyle);
  const smudgeStrength = useEditorStore((s) => s.smudgeStrength);
  const stabilization = useEditorStore((s) => s.stabilization);
  const fillTolerance = useEditorStore((s) => s.fillTolerance);
  const setFillTolerance = useEditorStore((s) => s.setFillTolerance);
  const rulerEnabled = useEditorStore((s) => s.rulerEnabled);
  const setRulerEnabled = useEditorStore((s) => s.setRulerEnabled);

  const setBrushSize = useEditorStore((s) => s.setBrushSize);
  const setBrushHardness = useEditorStore((s) => s.setBrushHardness);
  const setBrushOpacity = useEditorStore((s) => s.setBrushOpacity);
  const setIntensity = useEditorStore((s) => s.setIntensity);
  const setStartTaper = useEditorStore((s) => s.setStartTaper);
  const setEndTaper = useEditorStore((s) => s.setEndTaper);
  const setColorMix = useEditorStore((s) => s.setColorMix);
  const setSmudgeStrength = useEditorStore((s) => s.setSmudgeStrength);
  const setStabilization = useEditorStore((s) => s.setStabilization);
  const color = useEditorStore((s) => s.color);

  const canPreview = tool === "brush" && brushStyle !== "blur" && brushStyle !== "smudge";
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canPreview || !previewRef.current) return;
    // Debounced, per Section 12.3's stretch goal — cheap since it's a tiny
    // fixed-size canvas, but no reason to re-render on every slider tick.
    const t = setTimeout(() => {
      const canvas = renderBrushPreview({ size: brushSize, hardness: brushHardness, color, brushStyle, opacity: brushOpacity, intensity }, 240, 48);
      const el = previewRef.current;
      if (!el) return;
      el.innerHTML = "";
      // Fixed white, not bg-shell-bg — the preview draws in the user's
      // actual brush color, which defaults to near-black, so a themed
      // (often dark) background made the whole preview invisible.
      canvas.className = "h-12 w-full rounded-lg bg-white";
      el.appendChild(canvas);
    }, 60);
    return () => clearTimeout(t);
  }, [canPreview, brushSize, brushHardness, brushOpacity, intensity, brushStyle, color]);

  return (
    <div className="flex flex-col gap-5">
      {canPreview && <div ref={previewRef} className="h-12 w-full rounded-lg border border-shell-border bg-white" />}

      {/* PRESETY PRO ŠTĚTEC */}
      {tool === "brush" && (
        <div className="relative">
          <Button
            variant="secondary"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="w-full justify-between px-3 py-2 text-sm"
          >
            {activePresetId ? BRUSH_PRESETS[activePresetId as PresetId].name : "Custom settings..."}
            <span className="opacity-60">{isMenuOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
          </Button>

          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
              <div className="absolute top-full left-0 mt-2 w-full bg-[#1a1a24] border border-shell-border rounded-lg shadow-2xl z-50 overflow-hidden flex flex-col">
                {Object.entries(BRUSH_PRESETS).map(([id, preset]) => (
                  <button
                    key={id}
                    onClick={() => { loadPreset(id as PresetId); setIsMenuOpen(false); }}
                    className={`flex items-center gap-3 px-3 py-2.5 hover:bg-shell-accent/20 transition-colors ${activePresetId === id ? 'bg-shell-accent/20 border-l-2 border-shell-accent' : 'border-l-2 border-transparent'}`}
                  >
                    <PresetThumbnail preset={preset} />
                    <span className="text-xs font-medium text-left">{preset.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tool === "fill" && (
        <div className="space-y-4">
          <Slider label="Tolerance" min={0} max={100} value={fillTolerance} onChange={setFillTolerance} suffix="%" />
        </div>
      )}

      {tool === "ruler" && (
        <div className="space-y-4">
          <label className="flex items-center justify-between text-xs">
            <span className="text-shell-text opacity-70 font-medium">Snap to Ruler</span>
            <input
              type="checkbox"
              checked={rulerEnabled}
              onChange={(e) => setRulerEnabled(e.target.checked)}
              className="h-4 w-4 accent-shell-accent cursor-pointer"
            />
          </label>
          <p className="text-xs opacity-50 leading-relaxed">
            Drag on the canvas to place a guide. Every other drawing tool will
            then snap its strokes onto it until you clear or disable it.
          </p>
        </div>
      )}

      {/* POSUVNÍKY */}
      {tool !== "fill" && tool !== "ruler" && (
      <div className="space-y-4">
        <Slider label="Size" min={1} max={120} value={brushSize} onChange={setBrushSize} suffix="px" />
        <Slider label="Hardness" min={0} max={100} value={Math.round(brushHardness * 100)} onChange={(v) => setBrushHardness(v / 100)} suffix="%" />
        <Slider label="Opacity" min={1} max={100} value={Math.round(brushOpacity * 100)} onChange={(v) => setBrushOpacity(v / 100)} suffix="%" />
        <hr className="border-shell-border my-2" />
        <Slider label="Flow (Intensity)" min={1} max={100} value={Math.round(intensity * 100)} onChange={(v) => setIntensity(v / 100)} suffix="%" />
        <Slider label="Stabilization" min={0} max={10} value={Math.round(stabilization)} onChange={setStabilization} />

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wider opacity-60 hover:opacity-90 transition"
        >
          Advanced
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <Collapsible open={showAdvanced}>
          <div className="space-y-4 pt-1">
            <Slider label="Start Taper" min={0} max={500} value={startTaper} onChange={setStartTaper} suffix="px" />
            <Slider label="End Taper" min={0} max={500} value={endTaper} onChange={setEndTaper} suffix="px" />
            {brushStyle === "smudge" ? (
              <Slider label="Smudge Strength" min={0} max={100} value={Math.round(smudgeStrength * 100)} onChange={(v) => setSmudgeStrength(v / 100)} suffix="%" />
            ) : brushStyle === "blur" ? null : (
              <Slider label="Color Mix" min={0} max={100} value={Math.round(colorMix * 100)} onChange={(v) => setColorMix(v / 100)} suffix="%" />
            )}
          </div>
        </Collapsible>
      </div>
      )}
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
      {/* accent-shell-accent, not accent-blue-500 — this slider used to stay
          fixed blue in every theme (found while migrating to the shared
          design-token system; every other slider in the app already used
          the themed accent). */}
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} className="h-1.5 w-full cursor-pointer accent-shell-accent bg-shell-bg rounded-full appearance-none" />
    </div>
  );
}
