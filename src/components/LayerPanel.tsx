import { useEffect, useState } from "react";
import {
  Plus, ImagePlus, Eye, EyeOff, CornerDownRight, Lock, Unlock, ChevronUp, ChevronDown,
  ChevronRight, Settings2, Trash2, Copy, ChevronsUp, ChevronsDown, Folder,
  FolderOpen, FolderPlus, GripVertical, Layers as LayersIcon, Droplets, Paintbrush, Move,
} from "lucide-react";
import { useLayerStore, type BlendMode, type LayerMeta, type FolderMeta } from "../stores/layerStore";
import { useEditorStore } from "../stores/editorStore";
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

// --- Folder/z-order helpers -------------------------------------------------
// `layers` is the single source of truth for stacking order (bottom-to-top).
// A folder never has a z-order slot of its own — it's wherever its members
// currently sit, and every mutation below (moveLayerTo/moveFolderTo) keeps a
// folder's members CONTIGUOUS in that array. These helpers translate "drop
// this row here" (a visual, top-to-bottom panel position) into the
// array-order `beforeId` those store actions expect.

/** The id of whatever sits directly ABOVE `id` in z-order (i.e. rendered directly above it in the top-to-bottom panel), or null if `id` is already at the very top of the stack. */
function arrayNeighborAbove(layers: LayerMeta[], id: string): string | null {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0 || idx >= layers.length - 1) return null;
  return layers[idx + 1].id;
}

/** A folder's topmost member's id (appears first/at the top of its block in the panel), or null if it has no members yet. */
function topMemberIdOfFolder(layers: LayerMeta[], folderId: string): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].folderId === folderId) return layers[i].id;
  }
  return null;
}

/** A folder's bottom-most member's id (appears last/at the bottom of its block in the panel), or null if it has no members yet. */
function bottomMemberIdOfFolder(layers: LayerMeta[], folderId: string): string | null {
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].folderId === folderId) return layers[i].id;
  }
  return null;
}

type DisplayItem =
  | { type: "layer"; layer: LayerMeta }
  | { type: "folder"; folder: FolderMeta; memberIds: string[] };

/** Builds the top-to-bottom panel display list: empty folders pinned to the
 * top (see `FolderMeta`'s doc comment), then every layer/folder-block in
 * their real stacking order. Assumes folder membership is contiguous in
 * `layers` (guaranteed by moveLayerTo/moveFolderTo/deleteFolder) — a
 * dangling/non-contiguous `folderId` degrades gracefully to rendering those
 * layers as plain top-level rows rather than crashing. */
function buildDisplayItems(layers: LayerMeta[], folders: FolderMeta[]): DisplayItem[] {
  const reversed = [...layers].reverse(); // top-to-bottom
  const items: DisplayItem[] = [];

  const nonEmptyFolderIds = new Set(layers.map((l) => l.folderId).filter(Boolean) as string[]);
  for (const f of folders) {
    if (!nonEmptyFolderIds.has(f.id)) items.push({ type: "folder", folder: f, memberIds: [] });
  }

  let i = 0;
  while (i < reversed.length) {
    const layer = reversed[i];
    if (layer.folderId) {
      const folder = folders.find((f) => f.id === layer.folderId);
      const memberIds: string[] = [];
      const fid = layer.folderId;
      while (i < reversed.length && reversed[i].folderId === fid) {
        memberIds.push(reversed[i].id);
        i++;
      }
      if (folder) {
        items.push({ type: "folder", folder, memberIds });
      } else {
        for (const id of memberIds) {
          const l = reversed.find((x) => x.id === id)!;
          items.push({ type: "layer", layer: l });
        }
      }
    } else {
      items.push({ type: "layer", layer });
      i++;
    }
  }
  return items;
}

type DragState = { kind: "layer" | "folder"; id: string } | null;
type DropHint =
  | { kind: "into-folder"; folderId: string }
  | { kind: "edge"; rowId: string; rowType: "layer" | "folder"; edge: "top" | "bottom" }
  | null;

export function LayerPanel() {
  const layers = useLayerStore((s) => s.layers);
  const folders = useLayerStore((s) => s.folders);
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
  const addFolder = useLayerStore((s) => s.addFolder);
  const deleteLayer = useLayerStore((s) => s.deleteLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const toggleVisible = useLayerStore((s) => s.toggleVisible);
  const moveLayer = useLayerStore((s) => s.moveLayer);
  const setLayerOpacity = useLayerStore((s) => s.setLayerOpacity);
  const setLayerBlendMode = useLayerStore((s) => s.setLayerBlendMode);
  const toggleAlphaLock = useLayerStore((s) => s.toggleAlphaLock);
  const toggleClipping = useLayerStore((s) => s.toggleClipping);
  const toggleLayerLock = useLayerStore((s) => s.toggleLayerLock);
  const activeColor = useEditorStore((s) => s.color);
  const renameLayer = useLayerStore((s) => s.renameLayer);
  const renameFolder = useLayerStore((s) => s.renameFolder);
  const toggleFolderVisible = useLayerStore((s) => s.toggleFolderVisible);
  const toggleFolderCollapsed = useLayerStore((s) => s.toggleFolderCollapsed);
  const deleteFolder = useLayerStore((s) => s.deleteFolder);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKind, setEditingKind] = useState<"layer" | "folder">("layer");
  const [editingName, setEditingName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [drag, setDrag] = useState<DragState>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);

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
      if (editingKind === "layer") {
        const l = layers.find((x) => x.id === editingId);
        setEditingName(l?.name ?? "");
      } else {
        const f = folders.find((x) => x.id === editingId);
        setEditingName(f?.name ?? "");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, editingKind]);

  const startEditingLayer = (id: string) => { setEditingKind("layer"); setEditingId(id); };
  const startEditingFolder = (id: string) => { setEditingKind("folder"); setEditingId(id); };
  const commitEditingName = () => {
    if (!editingId) return;
    if (editingKind === "layer") {
      const l = layers.find((x) => x.id === editingId);
      renameLayer(editingId, editingName.trim() || l?.name || "Layer");
    } else {
      const f = folders.find((x) => x.id === editingId);
      renameFolder(editingId, editingName.trim() || f?.name || "Folder");
    }
    setEditingId(null);
  };

  // --- Drag & drop (pointer-based, not HTML5 native DnD — works on touch
  // too, which native `draggable` mostly doesn't). A row's grip handle
  // captures the pointer on down; move/up are handled on that same captured
  // element regardless of what's visually under the cursor, and
  // `document.elementFromPoint` finds the actual row being hovered. See the
  // z-order helpers above for how a drop position becomes a `moveLayerTo`/
  // `moveFolderTo` call. ---

  const beginDrag = (kind: "layer" | "folder", id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setDrag({ kind, id });
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const rowEl = el ? (el as Element).closest<HTMLElement>("[data-row-id]") : null;
    if (!rowEl) { setDropHint(null); return; }
    const rowId = rowEl.dataset.rowId!;
    const rowType = rowEl.dataset.rowType as "layer" | "folder";
    const nested = rowEl.dataset.nested === "true";

    if (drag.kind === "folder") {
      // Folders can't nest and can't drop onto themselves — only valid over
      // other top-level rows.
      if (nested || (rowType === "folder" && rowId === drag.id)) { setDropHint(null); return; }
      const rect = rowEl.getBoundingClientRect();
      const edge = e.clientY - rect.top < rect.height / 2 ? "top" : "bottom";
      setDropHint({ kind: "edge", rowId, rowType, edge });
      return;
    }

    // Dragging a layer.
    if (rowType === "folder") {
      setDropHint({ kind: "into-folder", folderId: rowId });
      return;
    }
    if (rowId === drag.id) { setDropHint(null); return; }
    const rect = rowEl.getBoundingClientRect();
    const edge = e.clientY - rect.top < rect.height / 2 ? "top" : "bottom";
    setDropHint({ kind: "edge", rowId, rowType: "layer", edge });
  };

  const endDrag = () => {
    if (drag && dropHint) commitDrop(drag, dropHint);
    setDrag(null);
    setDropHint(null);
  };

  function commitDrop(d: NonNullable<DragState>, hint: NonNullable<DropHint>) {
    const currentLayers = useLayerStore.getState().layers;
    const store = useLayerStore.getState();

    if (d.kind === "layer") {
      if (hint.kind === "into-folder") {
        const top = topMemberIdOfFolder(currentLayers, hint.folderId);
        const beforeId = top ? arrayNeighborAbove(currentLayers, top) : null;
        store.moveLayerTo(d.id, beforeId, hint.folderId);
        return;
      }
      if (hint.rowType === "layer") {
        const target = currentLayers.find((l) => l.id === hint.rowId);
        if (!target) return;
        const beforeId = hint.edge === "bottom" ? target.id : arrayNeighborAbove(currentLayers, target.id);
        store.moveLayerTo(d.id, beforeId, target.folderId ?? null);
      } else {
        // Edge of a folder header (its very top/bottom sliver): insert as a
        // top-level row directly above/below the whole folder block.
        const top = topMemberIdOfFolder(currentLayers, hint.rowId);
        const bottom = bottomMemberIdOfFolder(currentLayers, hint.rowId);
        const beforeId = hint.edge === "bottom" ? bottom : (top ? arrayNeighborAbove(currentLayers, top) : null);
        store.moveLayerTo(d.id, beforeId, null);
      }
      return;
    }

    // Dragging a folder header — only top-level edge drops are valid.
    if (hint.kind !== "edge") return;
    if (hint.rowType === "layer") {
      const target = currentLayers.find((l) => l.id === hint.rowId);
      if (!target) return;
      const beforeId = hint.edge === "bottom" ? target.id : arrayNeighborAbove(currentLayers, target.id);
      store.moveFolderTo(d.id, beforeId);
    } else {
      const top = topMemberIdOfFolder(currentLayers, hint.rowId);
      const bottom = bottomMemberIdOfFolder(currentLayers, hint.rowId);
      const beforeId = hint.edge === "bottom" ? bottom : (top ? arrayNeighborAbove(currentLayers, top) : null);
      store.moveFolderTo(d.id, beforeId);
    }
  }

  const rowEdgeHighlight = (rowId: string) =>
    dropHint?.kind === "edge" && dropHint.rowId === rowId ? dropHint.edge : null;

  const displayItems = buildDisplayItems(layers, folders);

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
            variant="secondary"
            onClick={() => addFolder()}
            className="w-full px-3 py-2 text-xs font-bold"
          >
            <FolderPlus size={14} strokeWidth={2} /> Add Folder
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
        <Button
          variant="warning"
          onClick={() => {
            if (!documentEngineRef.current) return;
            documentEngineRef.current.flattenAll();
          }}
          className="mt-2 w-full px-3 py-2 text-xs font-bold"
        >
          Flatten
        </Button>
      </div>
      <ul
        className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 custom-scrollbar"
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {displayItems.map((item) => {
          if (item.type === "folder") {
            return (
              <FolderRow
                key={item.folder.id}
                folder={item.folder}
                memberIds={item.memberIds}
                layers={layers}
                isEditing={editingId === item.folder.id && editingKind === "folder"}
                editingName={editingName}
                setEditingName={setEditingName}
                onStartEditing={() => startEditingFolder(item.folder.id)}
                onCommitEditing={commitEditingName}
                onCancelEditing={() => setEditingId(null)}
                isExpanded={expandedId === item.folder.id}
                onToggleExpanded={() => setExpandedId(expandedId === item.folder.id ? null : item.folder.id)}
                onToggleVisible={() => toggleFolderVisible(item.folder.id)}
                onToggleCollapsed={() => toggleFolderCollapsed(item.folder.id)}
                onDelete={() => deleteFolder(item.folder.id)}
                onMerge={() => documentEngineRef.current?.mergeFolder(item.folder.id)}
                onTransform={() => documentEngineRef.current?.startTransformForFolder(item.folder.id)}
                dragHandlePointerDown={beginDrag("folder", item.folder.id)}
                isDragSource={drag?.kind === "folder" && drag.id === item.folder.id}
                intoFolderHighlighted={dropHint?.kind === "into-folder" && dropHint.folderId === item.folder.id}
                edgeHighlight={rowEdgeHighlight(item.folder.id)}
                renderMember={(layer) => (
                  <LayerRow
                    key={layer.id}
                    layer={layer}
                    layers={layers}
                    activeLayerId={activeLayerId}
                    thumbRefreshKey={thumbRefreshKey}
                    nested
                    isEditing={editingId === layer.id && editingKind === "layer"}
                    editingName={editingName}
                    setEditingName={setEditingName}
                    onStartEditing={() => startEditingLayer(layer.id)}
                    onCommitEditing={commitEditingName}
                    onCancelEditing={() => setEditingId(null)}
                    isExpanded={expandedId === layer.id}
                    onToggleExpanded={() => setExpandedId(expandedId === layer.id ? null : layer.id)}
                    onSelect={() => setActiveLayer(layer.id)}
                    onToggleVisible={() => toggleVisible(layer.id)}
                    onMoveUp={() => moveLayer(layer.id, "up")}
                    onMoveDown={() => moveLayer(layer.id, "down")}
                    onDelete={() => { deleteLayer(layer.id); documentEngineRef.current?.resetHistoryAfterStructuralChange(); }}
                    onSetOpacity={(v) => { setLayerOpacity(layer.id, v); documentEngineRef.current?.setLayerOpacity(layer.id, v); }}
                    onSetBlendMode={(m) => { setLayerBlendMode(layer.id, m); documentEngineRef.current?.setLayerBlendMode(layer.id, m); }}
                    onToggleAlphaLock={() => toggleAlphaLock(layer.id)}
                    onToggleClipping={() => toggleClipping(layer.id)}
                    onToggleLock={() => toggleLayerLock(layer.id)}
                    onWhiteToTransparentGrayscale={() => documentEngineRef.current?.whiteToTransparentGrayscale(layer.id)}
                    onWhiteToTransparentColor={(tolerance) => documentEngineRef.current?.whiteToTransparentColor(layer.id, tolerance)}
                    onRecolorByAlpha={() => documentEngineRef.current?.recolorLayerByAlpha(layer.id, activeColor)}
                    onDuplicate={() => documentEngineRef.current?.duplicateLayer(layer.id)}
                    onMergeUp={() => documentEngineRef.current?.mergeLayerUp(layer.id)}
                    onMergeDown={() => documentEngineRef.current?.mergeLayerDown(layer.id)}
                    canAddLayer={canAddLayer}
                    dragHandlePointerDown={beginDrag("layer", layer.id)}
                    isDragSource={drag?.kind === "layer" && drag.id === layer.id}
                    edgeHighlight={rowEdgeHighlight(layer.id)}
                  />
                )}
              />
            );
          }
          const layer = item.layer;
          return (
            <LayerRow
              key={layer.id}
              layer={layer}
              layers={layers}
              activeLayerId={activeLayerId}
              thumbRefreshKey={thumbRefreshKey}
              isEditing={editingId === layer.id && editingKind === "layer"}
              editingName={editingName}
              setEditingName={setEditingName}
              onStartEditing={() => startEditingLayer(layer.id)}
              onCommitEditing={commitEditingName}
              onCancelEditing={() => setEditingId(null)}
              isExpanded={expandedId === layer.id}
              onToggleExpanded={() => setExpandedId(expandedId === layer.id ? null : layer.id)}
              onSelect={() => setActiveLayer(layer.id)}
              onToggleVisible={() => toggleVisible(layer.id)}
              onMoveUp={() => moveLayer(layer.id, "up")}
              onMoveDown={() => moveLayer(layer.id, "down")}
              onDelete={() => { deleteLayer(layer.id); documentEngineRef.current?.resetHistoryAfterStructuralChange(); }}
              onSetOpacity={(v) => { setLayerOpacity(layer.id, v); documentEngineRef.current?.setLayerOpacity(layer.id, v); }}
              onSetBlendMode={(m) => { setLayerBlendMode(layer.id, m); documentEngineRef.current?.setLayerBlendMode(layer.id, m); }}
              onToggleAlphaLock={() => toggleAlphaLock(layer.id)}
              onToggleClipping={() => toggleClipping(layer.id)}
              onToggleLock={() => toggleLayerLock(layer.id)}
              onWhiteToTransparentGrayscale={() => documentEngineRef.current?.whiteToTransparentGrayscale(layer.id)}
              onWhiteToTransparentColor={(tolerance) => documentEngineRef.current?.whiteToTransparentColor(layer.id, tolerance)}
              onRecolorByAlpha={() => documentEngineRef.current?.recolorLayerByAlpha(layer.id, activeColor)}
              onDuplicate={() => documentEngineRef.current?.duplicateLayer(layer.id)}
              onMergeUp={() => documentEngineRef.current?.mergeLayerUp(layer.id)}
              onMergeDown={() => documentEngineRef.current?.mergeLayerDown(layer.id)}
              canAddLayer={canAddLayer}
              dragHandlePointerDown={beginDrag("layer", layer.id)}
              isDragSource={drag?.kind === "layer" && drag.id === layer.id}
              edgeHighlight={rowEdgeHighlight(layer.id)}
            />
          );
        })}
      </ul>
    </div>
  );
}

// Thin highlighted bar shown above/below a row while something is being
// dragged over it — the only visual "you'll land here" feedback during drag.
function EdgeIndicator({ edge }: { edge: "top" | "bottom" | null }) {
  if (!edge) return null;
  return (
    <div
      className={`pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-shell-accent ${edge === "top" ? "-top-0.5" : "-bottom-0.5"}`}
    />
  );
}

type LayerRowProps = {
  layer: LayerMeta;
  layers: LayerMeta[];
  activeLayerId: string | null;
  thumbRefreshKey: string;
  nested?: boolean;
  isEditing: boolean;
  editingName: string;
  setEditingName: (s: string) => void;
  onStartEditing: () => void;
  onCommitEditing: () => void;
  onCancelEditing: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onSelect: () => void;
  onToggleVisible: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onSetOpacity: (v: number) => void;
  onSetBlendMode: (m: BlendMode) => void;
  onToggleAlphaLock: () => void;
  onToggleClipping: () => void;
  onToggleLock: () => void;
  onWhiteToTransparentGrayscale: () => void;
  onWhiteToTransparentColor: (tolerance: number) => void;
  onRecolorByAlpha: () => void;
  onDuplicate: () => void;
  onMergeUp: () => void;
  onMergeDown: () => void;
  canAddLayer: boolean;
  dragHandlePointerDown: (e: React.PointerEvent) => void;
  isDragSource: boolean;
  edgeHighlight: "top" | "bottom" | null;
};

/** A single layer's row — thumbnail, visibility, name, and a collapsible
 * Properties panel (opacity/blend mode/alpha lock/clip/duplicate/merge/move/
 * delete). Used both for top-level layers and for a folder's members
 * (`nested` just adds a little indent so membership reads visually). */
function LayerRow({
  layer, layers, activeLayerId, thumbRefreshKey, nested, isEditing, editingName, setEditingName,
  onStartEditing, onCommitEditing, onCancelEditing, isExpanded, onToggleExpanded, onSelect,
  onToggleVisible, onMoveUp, onMoveDown, onDelete, onSetOpacity, onSetBlendMode, onToggleAlphaLock,
  onToggleClipping, onToggleLock, onWhiteToTransparentGrayscale, onWhiteToTransparentColor,
  onRecolorByAlpha, onDuplicate, onMergeUp, onMergeDown, canAddLayer, dragHandlePointerDown,
  isDragSource, edgeHighlight,
}: LayerRowProps) {
  const [whiteStrength, setWhiteStrength] = useState(100);
  const idx = layers.indexOf(layer);
  // A grouped layer can only be reordered by dragging — a plain one-slot
  // swap has no folder concept and could silently split a folder's
  // contiguous members. A top-level layer's swap is also blocked the moment
  // it would cross into a folder's span, for the same reason.
  const isGrouped = !!layer.folderId;
  const aboveIsGrouped = idx < layers.length - 1 && !!layers[idx + 1]?.folderId;
  const belowIsGrouped = idx > 0 && !!layers[idx - 1]?.folderId;
  const moveUpDisabled = idx >= layers.length - 1 || isGrouped || aboveIsGrouped;
  const moveDownDisabled = idx <= 0 || isGrouped || belowIsGrouped;

  return (
    <li
      data-row-id={layer.id}
      data-row-type="layer"
      data-nested={nested ? "true" : "false"}
      className={`relative flex flex-col rounded-md border text-sm transition ${
        layer.id === activeLayerId ? "border-shell-accent bg-shell-border" : "border-transparent hover:border-shell-border"
      } ${isDragSource ? "opacity-40" : ""} ${nested ? "ml-4" : ""}`}
    >
      <EdgeIndicator edge={edgeHighlight} />
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          onPointerDown={dragHandlePointerDown}
          title="Drag to reorder"
          className="shrink-0 cursor-grab touch-none p-1 opacity-40 hover:opacity-80 active:cursor-grabbing"
        >
          <GripVertical size={14} strokeWidth={2} />
        </button>
        {/* Thumbnail (Section 14 follow-up): a real preview of the layer's
            own pixels, not just a name — the single biggest "looks like a
            real app's layers panel" win the visual-design feedback asked
            for. Checkerboard background shows through transparent areas. */}
        <LayerThumbnail layerId={layer.id} refreshKey={thumbRefreshKey} />
        <IconButton
          label={layer.visible ? "Hide layer" : "Show layer"}
          onClick={onToggleVisible}
          className="w-9 shrink-0 p-2"
        >
          {layer.visible ? <Eye size={16} strokeWidth={2} /> : <EyeOff size={16} strokeWidth={2} />}
        </IconButton>
        <div className={`min-w-0 flex-1 text-left ${layer.clippedToLayerBelow ? "ml-3" : ""}`}>
          <div className="flex items-center gap-2">
            <span className="opacity-50 mr-2">{`#${layers.length - idx}`}</span>
            {layer.clippedToLayerBelow && (
              <span className="opacity-50 -ml-1" title="Clipped to the layer below"><CornerDownRight size={13} strokeWidth={2} /></span>
            )}
            {isEditing ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={onCommitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") onCancelEditing();
                }}
                className="w-full bg-shell-panel border border-shell-border rounded px-2 py-1 text-sm text-shell-text"
              />
            ) : (
              <button
                type="button"
                onClick={onSelect}
                onDoubleClick={onStartEditing}
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
          onClick={onToggleExpanded}
          className="shrink-0 p-2"
        >{isExpanded ? <ChevronUp size={16} strokeWidth={2} /> : <Settings2 size={16} strokeWidth={2} />}</IconButton>
      </div>

      <Collapsible open={isExpanded}>
        <div className={`flex flex-col gap-2.5 px-3 py-2.5 ${isExpanded ? "border-t border-[color-mix(in_srgb,var(--shell-border),transparent_55%)]" : ""}`}>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={onMoveUp}
              disabled={moveUpDisabled}
              title={isGrouped ? "Drag to reorder a grouped layer" : undefined}
              className="flex-1 px-2 py-1.5 text-xs"
            >
              <ChevronUp size={13} strokeWidth={2} /> Move Up
            </Button>
            <Button
              variant="secondary"
              onClick={onMoveDown}
              disabled={moveDownDisabled}
              title={isGrouped ? "Drag to reorder a grouped layer" : undefined}
              className="flex-1 px-2 py-1.5 text-xs"
            >
              <ChevronDown size={13} strokeWidth={2} /> Move Down
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
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
              onChange={(e) => onSetOpacity(Number(e.target.value) / 100)}
              className="w-full accent-shell-accent"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="opacity-70">Blend Mode</span>
            <select
              value={layer.blendMode ?? "normal"}
              onChange={(e) => onSetBlendMode(e.target.value as BlendMode)}
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
                onClick={onToggleAlphaLock}
                title="Alpha Lock — clips painting to this layer's existing pixels"
                className="flex-1 px-2 py-1.5 text-xs"
              >
                <Lock size={13} strokeWidth={2} /> Alpha Lock
              </Button>
              <Button
                variant="secondary"
                onClick={onDuplicate}
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
              pressed={!!layer.locked}
              onClick={onToggleLock}
              title="Lock Layer — blocks every drawing/fill/select tool on this layer entirely"
              className="px-2 py-1.5 text-xs"
            >
              {layer.locked ? <Lock size={13} strokeWidth={2} /> : <Unlock size={13} strokeWidth={2} />} {layer.locked ? "Locked" : "Lock Layer"}
            </Button>
            <span className="text-[10px] leading-snug opacity-50">
              Unlike Alpha Lock (which still allows painting over existing
              pixels), a locked layer rejects every tool completely — nothing
              can draw, fill, or select-cut on it until unlocked.
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              pressed={layer.clippedToLayerBelow}
              onClick={onToggleClipping}
              disabled={idx <= 0}
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

          <div className="flex flex-col gap-2 border-t border-[color-mix(in_srgb,var(--shell-border),transparent_55%)] pt-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-50">White → Transparent</span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={onWhiteToTransparentGrayscale}
                title="Treats the layer as grayscale line art — lightness becomes transparency, ink becomes pure black"
                className="flex-1 px-2 py-1.5 text-xs"
              >
                <Droplets size={13} strokeWidth={2} /> Grayscale
              </Button>
              <Button
                variant="secondary"
                onClick={() => onWhiteToTransparentColor(whiteStrength)}
                title="Keeps original colors — brighter pixels become more transparent, regardless of hue; only black stays fully opaque"
                className="flex-1 px-2 py-1.5 text-xs"
              >
                <Droplets size={13} strokeWidth={2} /> Color
              </Button>
            </div>
            <label className="flex flex-col gap-1 text-xs">
              <span className="flex justify-between opacity-70">
                <span>Color mode strength</span>
                <span>{whiteStrength}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={whiteStrength}
                onChange={(e) => setWhiteStrength(Number(e.target.value))}
                className="w-full accent-shell-accent"
              />
            </label>
            <p className="text-[10px] leading-snug opacity-50">
              Destructive, one-shot — converts this layer's actual pixels now
              (undoable), doesn't stay adjustable afterward. Grayscale
              discards color entirely and keeps only darkness as an alpha
              mask; Color keeps hues but uses the same lightness-to-alpha
              idea — any bright color (not just literal white) becomes
              semi-transparent, only black is left untouched. Strength blends
              between no change (0%) and the full effect (100%).
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              onClick={onRecolorByAlpha}
              title="Select Opacity: recolor every drawn pixel using the current color, keeping each pixel's exact existing alpha"
              className="px-2 py-1.5 text-xs"
            >
              <Paintbrush size={13} strokeWidth={2} /> Recolor (Select Opacity)
            </Button>
            <span className="text-[10px] leading-snug opacity-50">
              ibis Paint's "Select Opacity": repaints this layer's strokes to
              the current color while keeping their existing opacity/edge
              softness exactly as drawn — handy for recoloring lineart
              without redrawing it. Destructive, one-shot.
            </span>
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={onMergeUp}
              disabled={idx >= layers.length - 1}
              className="flex-1 px-2 py-1.5 text-xs"
            >
              <ChevronsUp size={13} strokeWidth={2} /> Merge Up
            </Button>
            <Button
              variant="secondary"
              onClick={onMergeDown}
              disabled={idx <= 0}
              className="flex-1 px-2 py-1.5 text-xs"
            >
              <ChevronsDown size={13} strokeWidth={2} /> Merge Down
            </Button>
          </div>
        </div>
      </Collapsible>
    </li>
  );
}

type FolderRowProps = {
  folder: FolderMeta;
  memberIds: string[];
  layers: LayerMeta[];
  isEditing: boolean;
  editingName: string;
  setEditingName: (s: string) => void;
  onStartEditing: () => void;
  onCommitEditing: () => void;
  onCancelEditing: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onToggleVisible: () => void;
  onToggleCollapsed: () => void;
  onDelete: () => void;
  onMerge: () => void;
  onTransform: () => void;
  dragHandlePointerDown: (e: React.PointerEvent) => void;
  isDragSource: boolean;
  intoFolderHighlighted: boolean;
  edgeHighlight: "top" | "bottom" | null;
  renderMember: (layer: LayerMeta) => React.ReactNode;
};

/** A folder's header row (drag handle, visibility, collapse chevron, name,
 * Properties disclosure with Delete/Merge/Transform Folder) plus its
 * members — indented — when expanded. Purely organizational: no opacity/
 * blend mode of its own (see `FolderMeta`'s doc comment), just grouping +
 * visibility (Transform Folder is the one action that treats every member
 * as a single rigid unit, per the Transform tool's own folder-targeting). */
function FolderRow({
  folder, memberIds, layers, isEditing, editingName, setEditingName,
  onStartEditing, onCommitEditing, onCancelEditing, isExpanded, onToggleExpanded, onToggleVisible,
  onToggleCollapsed, onDelete, onMerge, onTransform, dragHandlePointerDown, isDragSource, intoFolderHighlighted,
  edgeHighlight, renderMember,
}: FolderRowProps) {
  const hasMembers = memberIds.length > 0;
  const membersInDisplayOrder = memberIds
    .map((id) => layers.find((l) => l.id === id))
    .filter((l): l is LayerMeta => !!l);

  return (
    <>
      <li
        data-row-id={folder.id}
        data-row-type="folder"
        className={`relative flex flex-col rounded-md border text-sm transition ${
          intoFolderHighlighted ? "border-shell-accent bg-shell-accent/15" : "border-transparent hover:border-shell-border"
        } ${isDragSource ? "opacity-40" : ""}`}
      >
        <EdgeIndicator edge={edgeHighlight} />
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            type="button"
            onPointerDown={dragHandlePointerDown}
            title="Drag to reorder the whole folder"
            className="shrink-0 cursor-grab touch-none p-1 opacity-40 hover:opacity-80 active:cursor-grabbing"
          >
            <GripVertical size={14} strokeWidth={2} />
          </button>
          <IconButton
            label={hasMembers ? (folder.collapsed ? "Expand folder" : "Collapse folder") : "No layers in this folder yet"}
            onClick={onToggleCollapsed}
            disabled={!hasMembers}
            className="w-7 shrink-0 p-1.5"
          >
            <ChevronRight size={14} strokeWidth={2} className={`transition-transform ${!folder.collapsed && hasMembers ? "rotate-90" : ""}`} />
          </IconButton>
          <IconButton
            label={folder.visible ? "Hide folder" : "Show folder"}
            onClick={onToggleVisible}
            className="w-9 shrink-0 p-2"
          >
            {folder.visible ? <Eye size={16} strokeWidth={2} /> : <EyeOff size={16} strokeWidth={2} />}
          </IconButton>
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              {folder.collapsed || !hasMembers ? <Folder size={15} strokeWidth={2} className="opacity-70" /> : <FolderOpen size={15} strokeWidth={2} className="opacity-70" />}
              {isEditing ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={onCommitEditing}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") onCancelEditing();
                  }}
                  className="w-full bg-shell-panel border border-shell-border rounded px-2 py-1 text-sm text-shell-text"
                />
              ) : (
                <button
                  type="button"
                  onDoubleClick={onStartEditing}
                  title={folder.name}
                  className="flex-1 text-left text-shell-text font-semibold w-full text-sm whitespace-normal"
                >
                  {folder.name}
                  <span className="ml-1.5 opacity-50 font-normal">{hasMembers ? `(${memberIds.length})` : "(empty)"}</span>
                </button>
              )}
            </div>
          </div>
          <IconButton
            label="Folder properties"
            pressed={isExpanded}
            onClick={onToggleExpanded}
            className="shrink-0 p-2"
          >{isExpanded ? <ChevronUp size={16} strokeWidth={2} /> : <Settings2 size={16} strokeWidth={2} />}</IconButton>
        </div>

        <Collapsible open={isExpanded}>
          <div className={`flex flex-col gap-2.5 px-3 py-2.5 ${isExpanded ? "border-t border-[color-mix(in_srgb,var(--shell-border),transparent_55%)]" : ""}`}>
            <p className="text-[10px] leading-snug opacity-50">
              Folders are organizational only — layers inside still blend
              individually with everything below, exactly as if they weren't
              grouped.
            </p>
            <Button
              variant="secondary"
              onClick={onTransform}
              disabled={!hasMembers}
              title="Transform this folder's layers together as one unit"
              className="px-2 py-1.5 text-xs"
            >
              <Move size={13} strokeWidth={2} /> Transform Folder
            </Button>
            <span className="text-[10px] leading-snug opacity-50">
              Applies the same move/scale/perspective/mesh warp to every
              (unlocked) layer in this folder at once, over the union of
              their content bounds — relative positions between them are
              preserved.
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={onMerge}
                disabled={memberIds.length < 2}
                title="Flatten this folder's layers into one"
                className="flex-1 px-2 py-1.5 text-xs"
              >
                <LayersIcon size={13} strokeWidth={2} /> Merge Folder
              </Button>
              <Button
                variant="danger"
                onClick={onDelete}
                className="flex-1 px-2 py-1.5 text-xs"
                title="Delete folder (layers inside are kept, ungrouped)"
              >
                <Trash2 size={13} strokeWidth={2} /> Delete Folder
              </Button>
            </div>
            <span className="text-[10px] leading-snug opacity-50">
              Delete Folder never deletes layers — it just ungroups them back
              to the top level, in their current stacking position.
            </span>
          </div>
        </Collapsible>
      </li>
      {!folder.collapsed && hasMembers && (
        <div className="flex flex-col gap-1">
          {membersInDisplayOrder.map((layer) => renderMember(layer))}
        </div>
      )}
    </>
  );
}
