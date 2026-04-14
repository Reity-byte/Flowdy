import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { layerSurfaceBytes, useLayerStore } from "../stores/layerStore";
import { documentEngineRef } from "../engine/documentEngineRef";

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
  const renameLayer = useLayerStore((s) => s.renameLayer);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  useEffect(() => {
    if (editingId) {
      const l = layers.find((x) => x.id === editingId);
      setEditingName(l?.name ?? "");
    }
  }, [editingId, layers]);

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
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              if (!documentEngineRef.current) return;
              documentEngineRef.current.flattenAll();
            }}
            className="w-full rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500 transition-colors shadow-sm"
          >
            Flatten
          </button>
        </div>
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
            <div className="min-w-0 flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="opacity-50 mr-2">{`#${layers.length - layers.indexOf(layer)}`}</span>
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
                  </button>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-0.5">
              <IconBtn label="Up" onClick={() => moveLayer(layer.id, "up")} disabled={layers.indexOf(layer) >= layers.length - 1}>↑</IconBtn>
              <IconBtn label="Down" onClick={() => moveLayer(layer.id, "down")} disabled={layers.indexOf(layer) <= 0}>↓</IconBtn>
              <IconBtn label="Delete" onClick={() => deleteLayer(layer.id)} disabled={layers.length <= 1}>×</IconBtn>
              <IconBtn
                label="Merge Up"
                onClick={() => {
                  if (!documentEngineRef.current) return;
                  documentEngineRef.current.mergeLayerUp(layer.id);
                }}
                disabled={layers.indexOf(layer) >= layers.length - 1}
              >⇧</IconBtn>
              <IconBtn
                label="Merge Down"
                onClick={() => {
                  if (!documentEngineRef.current) return;
                  documentEngineRef.current.mergeLayerDown(layer.id);
                }}
                disabled={layers.indexOf(layer) <= 0}
              >⇩</IconBtn>
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