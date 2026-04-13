import type { ReactNode } from "react";
import { layerSurfaceBytes, useLayerStore } from "../stores/layerStore";

export function LayerPanel() {
  const layers = useLayerStore((s) => s.layers);
  const activeLayerId = useLayerStore((s) => s.activeLayerId);
  const addLayer = useLayerStore((s) => s.addLayer);
  const layerCount = useLayerStore((s) => s.layers.length);
  const memoryBudgetMb = useLayerStore((s) => s.memoryBudgetMb);
  const canAddLayer = (layerCount + 1) * layerSurfaceBytes() <= memoryBudgetMb * 1024 * 1024;
  const deleteLayer = useLayerStore((s) => s.deleteLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const toggleVisible = useLayerStore((s) => s.toggleVisible);
  const moveLayer = useLayerStore((s) => s.moveLayer);

  const displayLayers = [...layers].reverse();

  return (
    <div className="flex flex-col h-full max-h-[35vh] min-h-0">
      <div className="mb-3">
        <button
          type="button"
          onClick={() => addLayer()}
          disabled={!canAddLayer}
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors shadow-sm"
        >
          + Add New Layer
        </button>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
        {displayLayers.map((layer) => (
          <li
            key={layer.id}
            className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm transition ${
              layer.id === activeLayerId ? "border-blue-500 bg-shell-border" : "border-transparent hover:border-shell-border"
            }`}
          >
            <button
              type="button"
              onClick={() => toggleVisible(layer.id)}
              className="w-7 shrink-0 rounded p-1 text-lg leading-none text-shell-text opacity-70 hover:opacity-100 hover:bg-shell-bg transition"
            >
              {layer.visible ? "◉" : "○"}
            </button>
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-shell-text font-medium"
              onClick={() => setActiveLayer(layer.id)}
            >
              {layer.name}
            </button>
            <div className="flex shrink-0 gap-0.5">
              <IconBtn label="Up" onClick={() => moveLayer(layer.id, "up")} disabled={layers.indexOf(layer) >= layers.length - 1}>↑</IconBtn>
              <IconBtn label="Down" onClick={() => moveLayer(layer.id, "down")} disabled={layers.indexOf(layer) <= 0}>↓</IconBtn>
              <IconBtn label="Delete" onClick={() => deleteLayer(layer.id)} disabled={layers.length <= 1}>×</IconBtn>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IconBtn(props: { children: ReactNode; onClick: () => void; disabled?: boolean; label: string; }) {
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} title={props.label} className="rounded px-1.5 py-0.5 text-shell-text opacity-70 hover:opacity-100 hover:bg-shell-bg disabled:cursor-not-allowed disabled:opacity-30 transition">
      {props.children}
    </button>
  );
}