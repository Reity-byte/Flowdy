import { useEffect, useState } from "react";
import { Plus, ImagePlus, Eye, EyeOff, CornerDownRight, Lock, ChevronUp, ChevronDown, Settings2, Trash2, Copy, ChevronsUp, ChevronsDown } from "lucide-react";
import { useLayerStore, type BlendMode } from "../stores/layerStore";
import { useAppStore } from "../stores/appStore";
import { useHistoryStore } from "../stores/historyStore";
import { documentEngineRef } from "../engine/documentEngineRef";
import { pickImageDataUrl } from "../lib/importImage";
import { Button, IconButton } from "./Button";
import { Collapsible } from "./Collapsible";

/** Live thumbnail of a layer's actual pixels — reuses `DocumentCanvas.
 * getLayerThumbnail()` (the real runtime canvas, never a stale/cached
 * copy). `refreshKey` (layer count + history depth) is the cheap signal
 * for "content might have changed" — regenerating on every render would
 * mean a `toDataURL()` call per layer per render, which is wasteful for a
 * panel that re-renders on things unrelated to pixel content (e.g. typing
 * a rename). */
function LayerThumbnail({ layerId, refreshKey }: { layerId: string; refreshKey: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    setDataUrl(documentEngineRef.current?.getLayerThumbnail(layerId, 36) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerId, refreshKey]);
  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-shell-border bg-[repeating-conic-gradient(#3a3a44_0%_25%,transparent_0%_50%)] bg-[length:8px_8px]">
      {dataUrl && <img src={dataUrl} alt="" className="h-full w-full object-contain" />}
    </div>
  );
}

const BLEND_MODE_OPTIONS: { id: BlendMode; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" },
  { id: "add", label: "Add (Linear Dodge)" },
  { id: "darken", label: "Darken" },
  { id: "lighten", label: "Lighten" },
  { id: "difference", label: "Difference" },
  { id: "color", label: "Color" },
  { id: "luminosity", label: "Luminosity" },
];

// Blend modes decide how this layer's pixels combine with everything below
// it — one-line reminders since the names alone aren't self-explanatory.
const BLEND_MODE_DESCRIPTIONS: Record<BlendMode, string> = {
  normal: "Paints over what's below, as-is.",
  multiply: "Darkens — like stacking two see-through sheets. White below stays unchanged, black below stays black.",
  screen: "Lightens — the opposite of Multiply. Black below stays unchanged, white below stays white.",
  overlay: "Boosts contrast: darkens the dark areas below, lightens the light areas.",
  add: "Adds this layer's brightness to what's below — great for glows and light sources.",
  darken: "Keeps whichever is darker, this layer or what's below, pixel by pixel.",
  lighten: "Keeps whichever is lighter, this layer or what's below, pixel by pixel.",
  difference: "Shows how much this layer and what's below differ — identical colors turn black.",
  color: "Applies this layer's hue/saturation onto the brightness of what's below.",
  luminosity: "Applies this layer's brightness onto the hue/saturation of what's below.",
};

export function LayerPanel() {
  const layers = useLayerStore((s) => s.layers);
  const activeLayerId = useLayerStore((s) => s.activeLayerId);
  const addLayerFn = useLayerStore((s) => s.addLayer);
  const canAddLayerFn = useLayerStore((s) => s.canAddLayer);
  // Subscribed so this component re-renders when either changes.
  useLayerStore((s) => s.layers.length);
  useLayerStore((s) => s.memoryBudgetMb);
  // History depth changes on every committed stroke and on undo/redo — the
  // cheap "pixels might have changed" signal thumbnails refresh on.
  const historyDepth = useHistoryStore((s) => s.past.length);
  const thumbRefreshKey = `${layers.length}:${historyDepth}`;
  const canvasWidth = useAppStore((s) => s.canvasWidth);
  const canvasHeight = useAppStore((s) => s.canvasHeight);
  const canAddLayer = canAddLayerFn(canvasWidth, canvasHeight);
  const addLayer = () => addLayerFn(canvasWidth, canvasHeight);
  const deleteLayer = useLayerStore((s) => s.deleteLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const toggleVisible = useLayerStore((s) => s.toggleVisible);
  const moveLayer = useLayerStore((s) => s.moveLayer);
  const setLayerOpacity = useLayerStore((s) => s.setLayerOpacity);
  const setLayerBlendMode = useLayerStore((s) => s.setLayerBlendMode);
  const toggleAlphaLock = useLayerStore((s) => s.toggleAlphaLock);
  const toggleClipping = useLayerStore((s) => s.toggleClipping);

  const displayLayers = [...layers].reverse();
  const renameLayer = useLayerStore((s) => s.renameLayer);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleImportImage = async () => {
    if (importing || !documentEngineRef.current) return;
    setImporting(true);
    try {
      const dataUrl = await pickImageDataUrl();
      if (dataUrl) await documentEngineRef.current.importImageAsLayer(dataUrl);
    } catch (e) {
      useAppStore.getState().showNotification("Couldn't import that image");
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (editingId) {
      const l = layers.find((x) => x.id === editingId);
      setEditingName(l?.name ?? "");
    }
  }, [editingId, layers]);

  return (
    <div className="flex flex-col h-full max-h-[35vh] min-h-0">
      <div className="mb-3">
        <Button
          variant="primary"
          onClick={() => addLayer()}
          disabled={!canAddLayer}
          className="w-full px-3 py-2 text-xs font-bold"
        >
          <Plus size={14} strokeWidth={2.5} /> Add New Layer
        </Button>
        <div className="mt-2 flex gap-2">
          <Button
            variant="warning"
            onClick={() => {
              if (!documentEngineRef.current) return;
              documentEngineRef.current.flattenAll();
            }}
            className="w-full px-3 py-2 text-xs font-bold"
          >
            Flatten
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleImportImage()}
            disabled={importing || !canAddLayer}
            className="w-full px-3 py-2 text-xs font-bold"
          >
            {importing ? "Importing…" : <><ImagePlus size={14} strokeWidth={2} /> Import Image</>}
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
        {displayLayers.map((layer) => {
          const isExpanded = expandedId === layer.id;
          return (
          <li
            key={layer.id}
            className={`flex flex-col rounded-md border text-sm transition ${
              layer.id === activeLayerId ? "border-shell-accent bg-shell-border" : "border-transparent hover:border-shell-border"
            }`}
          >
            <div className="flex items-center gap-2 px-2 py-2">
              {/* Thumbnail (Section 14 follow-up): a real preview of the layer's
                  own pixels, not just a name — the single biggest "looks like a
                  real app's layers panel" win the visual-design feedback asked
                  for. Checkerboard background shows through transparent areas. */}
              <LayerThumbnail layerId={layer.id} refreshKey={thumbRefreshKey} />
              <IconButton
                label={layer.visible ? "Hide layer" : "Show layer"}
                onClick={() => toggleVisible(layer.id)}
                className="w-9 shrink-0 p-2"
              >
                {layer.visible ? <Eye size={16} strokeWidth={2} /> : <EyeOff size={16} strokeWidth={2} />}
              </IconButton>
              <div className={`min-w-0 flex-1 text-left ${layer.clippedToLayerBelow ? "ml-3" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="opacity-50 mr-2">{`#${layers.length - layers.indexOf(layer)}`}</span>
                  {layer.clippedToLayerBelow && (
                    <span className="opacity-50 -ml-1" title="Clipped to the layer below"><CornerDownRight size={13} strokeWidth={2} /></span>
                  )}
                  {editingId === layer.id ? (
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => {
                        renameLayer(layer.id, editingName.trim() || layer.name);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      className="w-full bg-shell-panel border border-shell-border rounded px-2 py-1 text-sm text-shell-text"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveLayer(layer.id)}
                      onDoubleClick={() => setEditingId(layer.id)}
                      title={layer.name}
                      className="flex-1 text-left text-shell-text font-medium w-full text-sm whitespace-normal"
                    >
                      {layer.name}
                      {layer.alphaLocked && <span className="ml-1 inline-block align-middle opacity-60" title="Alpha Locked"><Lock size={12} strokeWidth={2} /></span>}
                    </button>
                  )}
                </div>
              </div>
              {/* Move Up/Down and Delete moved into the Properties panel below
                  (Section 14 follow-up, "cramped controls" feedback) — four
                  icon buttons plus a thumbnail and the layer name genuinely
                  don't fit in one row at this panel's width. Reordering and
                  deleting are less frequent than toggling visibility/selecting
                  a layer, so they're a reasonable fit for progressive
                  disclosure — the same pattern this app already uses for
                  Advanced brush settings and the rest of this very panel. */}
              <IconButton
                label="Properties"
                pressed={isExpanded}
                onClick={() => setExpandedId(isExpanded ? null : layer.id)}
                className="shrink-0 p-2"
              >{isExpanded ? <ChevronUp size={16} strokeWidth={2} /> : <Settings2 size={16} strokeWidth={2} />}</IconButton>
            </div>

            <Collapsible open={isExpanded}>
              <div className={`flex flex-col gap-2.5 px-3 py-2.5 ${isExpanded ? "border-t border-[color-mix(in_srgb,var(--shell-border),transparent_55%)]" : ""}`}>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => moveLayer(layer.id, "up")}
                    disabled={layers.indexOf(layer) >= layers.length - 1}
                    className="flex-1 px-2 py-1.5 text-xs"
                  >
                    <ChevronUp size={13} strokeWidth={2} /> Move Up
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => moveLayer(layer.id, "down")}
                    disabled={layers.indexOf(layer) <= 0}
                    className="flex-1 px-2 py-1.5 text-xs"
                  >
                    <ChevronDown size={13} strokeWidth={2} /> Move Down
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      deleteLayer(layer.id);
                      documentEngineRef.current?.resetHistoryAfterStructuralChange();
                    }}
                    disabled={layers.length <= 1}
                    className="px-2.5 py-1.5 text-xs"
                    title="Delete layer"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </Button>
                </div>
                <p className="text-[10px] leading-snug opacity-50">
                  How this layer looks and combines with the layers below it.
                </p>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="flex justify-between opacity-70">
                    <span>Opacity — how see-through this layer is</span>
                    <span>{Math.round((layer.opacity ?? 1) * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round((layer.opacity ?? 1) * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100;
                      setLayerOpacity(layer.id, v);
                      documentEngineRef.current?.setLayerOpacity(layer.id, v);
                    }}
                    className="w-full accent-shell-accent"
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="opacity-70">Blend Mode</span>
                  <select
                    value={layer.blendMode ?? "normal"}
                    onChange={(e) => {
                      const mode = e.target.value as BlendMode;
                      setLayerBlendMode(layer.id, mode);
                      documentEngineRef.current?.setLayerBlendMode(layer.id, mode);
                    }}
                    className="w-full rounded border border-shell-border bg-shell-bg px-2 py-1 text-xs text-shell-text"
                  >
                    {BLEND_MODE_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                  <span className="text-[10px] leading-snug opacity-50">
                    {BLEND_MODE_DESCRIPTIONS[layer.blendMode ?? "normal"]}
                  </span>
                </label>

                <div className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      pressed={layer.alphaLocked}
                      onClick={() => toggleAlphaLock(layer.id)}
                      title="Alpha Lock — clips painting to this layer's existing pixels"
                      className="flex-1 px-2 py-1.5 text-xs"
                    >
                      <Lock size={13} strokeWidth={2} /> Alpha Lock
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => documentEngineRef.current?.duplicateLayer(layer.id)}
                      disabled={!canAddLayer}
                      title="Duplicate Layer"
                      className="flex-1 px-2 py-1.5 text-xs"
                    >
                      <Copy size={13} strokeWidth={2} /> Duplicate
                    </Button>
                  </div>
                  <span className="text-[10px] leading-snug opacity-50">
                    Alpha Lock: only paint over pixels already on this layer — new
                    strokes can't spill onto its transparent areas.
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <Button
                    variant="secondary"
                    pressed={layer.clippedToLayerBelow}
                    onClick={() => toggleClipping(layer.id)}
                    disabled={layers.indexOf(layer) <= 0}
                    title="Clip to the layer below — only show where that layer already has pixels"
                    className="px-2 py-1.5 text-xs"
                  >
                    <CornerDownRight size={13} strokeWidth={2} /> Clip to Layer Below
                  </Button>
                  <span className="text-[10px] leading-snug opacity-50">
                    Clipping Mask: this layer only shows through the shape of the
                    layer below it — paint stays inside its outline automatically.
                  </span>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => documentEngineRef.current?.mergeLayerUp(layer.id)}
                    disabled={layers.indexOf(layer) >= layers.length - 1}
                    className="flex-1 px-2 py-1.5 text-xs"
                  >
                    <ChevronsUp size={13} strokeWidth={2} /> Merge Up
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => documentEngineRef.current?.mergeLayerDown(layer.id)}
                    disabled={layers.indexOf(layer) <= 0}
                    className="flex-1 px-2 py-1.5 text-xs"
                  >
                    <ChevronsDown size={13} strokeWidth={2} /> Merge Down
                  </Button>
                </div>
              </div>
            </Collapsible>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
