import { Application, Container, Graphics, Point as PixiPoint, Sprite, Texture, type BLEND_MODES } from "pixi.js";
// Registers the filter-based implementations for every blend mode beyond the
// GPU-native set (normal/add/multiply/screen/erase/subtract) — without this,
// setting sprite.blendMode to e.g. 'darken'/'lighten'/'difference'/'color'/
// 'luminosity'/'overlay' silently renders as if it were 'normal'.
import "pixi.js/advanced-blend-modes";
import { ARTBOARD_BORDER, ARTBOARD_FILL } from "./artboardConfig";
import { useAppStore } from "../stores/appStore";
import { useHistoryStore, type DocumentSnapshot } from "../stores/historyStore";
import { useEditorStore } from "../stores/editorStore";
import { useLayerStore, type LayerMeta } from "../stores/layerStore";
import { brushSettingsForTool, HighPerformanceBrushStroke, flushDrawQueue, setImmediateMode } from "./brushEngine";
import { SelectionManager } from "./SelectionManager";
import { RulerManager } from "./RulerManager";
import { TransformManager } from "./TransformManager";
import { floodFillCanvas } from "./floodFill";
import { whiteToTransparentGrayscale, whiteToTransparentColor, recolorByAlpha } from "./layerFilters";
import { hexToRgb } from "../lib/color";
import type { BrushSettings, Point, PointerBrushSample } from "./brushTypes";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;
// WheelEvent.deltaMode: 0 = pixels (used as-is), 1 = lines, 2 = pages.
// These multipliers convert line/page deltas to an approximate pixel scale.
const WHEEL_LINE_MULTIPLIER = 20;
const WHEEL_PAGE_MULTIPLIER = 50;

type LayerRuntime = {
  id: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  sprite: Sprite;
};

function makeLayerSurface(w: number, h: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  // Every layer gets a full-canvas getImageData on every single stroke
  // commit (captureSnapshot, for undo history) and a full-canvas
  // putImageData on every undo/redo (restoreSnapshot) — willReadFrequently
  // keeps the layer software-backed from the start, avoiding a GPU→CPU
  // readback stall on those calls (measured live: ~18ms average, occasional
  // ~30-55ms spikes, dropping to a consistent ~8ms with this hint, on a
  // 2048×2048 canvas — see the performance-pass Alpha Log entry). Same
  // reasoning already applied to `preStroke`/`smudgeSurface` in
  // brushEngine.ts. Doesn't affect `drawImage`-based paths (texture
  // upload, blitAndDiscard, duplicateLayer) — measured no difference there
  // either way, and it's a pure storage-backend hint per spec regardless,
  // never a rendering/output difference.
  const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.clearRect(0, 0, w, h);
  return { canvas, ctx };
}

function updateCanvasTexture(sprite: Sprite): void {
  try { (sprite.texture.source as any).update(); } catch {}
}

/** Whether a keyboard event's target is somewhere the user is typing text (an input/textarea, or a contenteditable element) — global shortcuts like Ctrl+Z or Delete must not fire there, both because those keys can be ordinary input and because e.g. Ctrl+Z has its own native "undo this text edit" meaning inside a focused field. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

export class DocumentCanvas {
  private host: HTMLElement;
  private app: Application | null = null;
  private world = new Container();
  private boardRoot = new Container();
  private checker!: Graphics;
  private layerRoot = new Container();
  private runtimes = new Map<string, LayerRuntime>();

  private width = 2048;
  private height = 2048;
  private pan = { x: 40, y: 40 };
  private zoom = 0.45;
  private rotation = 0;
  
  private drawing = false;
  private stroking = false;
  private brush = new HighPerformanceBrushStroke();
  private selection = new SelectionManager();
  private ruler = new RulerManager();
  private transform = new TransformManager();
  private spaceHeld = false;
  private panning = false;
  private panPointerStart = { x: 0, y: 0 };
  private panWorldStart = { x: 0, y: 0 };
  private readonly pointerScratch = new PixiPoint();

  // Recompositing a stroke's wet buffer onto the real layer (full-canvas
  // clear+drawImage) and pushing the result to the GPU as a texture is far
  // more expensive than stamping a dab, so it's coalesced to at most once per
  // animation frame instead of once per pointermove — high-poll-rate mice/
  // tablets can fire pointer events well past display refresh rate, and none
  // of the extra recomposites in between would ever actually be shown.
  private pendingRecomposite: { ctx: CanvasRenderingContext2D; settings: BrushSettings; rt: LayerRuntime } | null = null;
  private recomposeRafId: number | null = null;

  // --- MULTI-TOUCH STAV ---
  private activePointers = new Map<number, { x: number, y: number }>();
  private initialPinchDist = 1;
  private initialPinchZoom = 1;
  private initialPinchAngle = 0;
  private initialPinchRotation = 0;
  private pinchWorldCenter: PixiPoint = new PixiPoint(); // NOVÉ: Kotevní bod pro rotaci
  private isPinching = false;
  private pinchStartTime = 0;
  private pinchMaxMovement = 0;
  private pinchStartPositions = new Map<number, { x: number, y: number }>();
  private unsubEditorTool: (() => void) | null = null;
  private unsubRulerSync: (() => void) | null = null;
  /** Set by `startTransformForFolder` right before it flips `tool` to "transform", so the tool-switch subscription knows to target that folder instead of the default (active layer/selection) behavior — see the subscription's own comment. */
  private pendingFolderTransformId: string | null = null;

  // --- SELECTION GESTURE STAV (ibis-Paint-style pinch/rotate on a floating
  // selection, redirected here instead of driving canvas zoom/pan/rotate) ---
  private selectionGesture = false;
  private selectionGestureStartDist = 1;
  private selectionGestureStartAngle = 0;
  private selectionGestureInitialRect: { x: number, y: number, w: number, h: number } | null = null;
  private selectionGestureInitialRotation = 0;

  /** Artboard size in world pixels (fixed for the life of the document). */
  getImageBounds() {
    return { width: this.width, height: this.height };
  }

  /** Set by `destroy()` — see `init()`'s own comment for why `init()` must re-check this after its `await` instead of assuming a call to `destroy()` can only ever happen after `init()` has already returned. */
  private destroyed = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** Creates the PixiJS application, mounts it into `host`, and wires up pointer/keyboard/wheel handlers. Call once before any other method.
   *
   * React StrictMode (dev only) deliberately mounts effects twice — mount,
   * cleanup, mount again — synchronously, well before this method's `await
   * app.init(...)` below has had a chance to resolve. If `destroy()` (the
   * effect's cleanup) runs during that gap, it correctly no-ops (nothing's
   * been attached yet), but this method would otherwise carry on regardless
   * once the await resolves — attaching window keydown/pointer listeners
   * for an instance that's already supposed to be dead, with no cleanup
   * left to ever remove them (the component's cleanup function already ran
   * once and won't run again for this abandoned instance). Confirmed live:
   * exactly this caused Ctrl+Z/Enter to fire multiple times per keypress
   * after repeated mount cycles, each one calling `history.undo()`/etc.
   * again on the same shared store. Re-checking `destroyed` right after the
   * `await` and bailing out (tearing down the just-created app instead of
   * finishing setup) closes the gap. */
  async init(): Promise<void> {
    this.width = useAppStore.getState().canvasWidth;
    this.height = useAppStore.getState().canvasHeight;
    const app = new Application();
    await app.init({
      resizeTo: this.host,
      backgroundAlpha: 1,
      background: 0x1a1d24,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: "webgl",
      // Advanced per-layer blend modes (darken/lighten/difference/color/
      // luminosity/overlay/etc., registered via the "pixi.js/advanced-blend-
      // modes" import above) are implemented as filters that need to sample
      // what's already been rendered — WebGL can't do that against the
      // canvas it's currently drawing to, so Pixi renders to an offscreen
      // "back buffer" texture first when this is enabled. Without it, those
      // blend modes silently no-op (renders as if it were 'normal').
      useBackBuffer: true,
    });

    if (this.destroyed) {
      // destroy() already ran (see this method's own doc comment) while the
      // above await was pending — tear down what was just created instead
      // of continuing to attach listeners nothing will ever remove.
      try { app.destroy(true, { children: true, texture: true }); } catch {}
      return;
    }
    this.app = app;

    // Zabraňuje zoomování prohlížeče při scrollování s Ctrl
    document.addEventListener("wheel", this.preventBrowserZoom, { passive: false });
    this.host.appendChild(app.canvas as HTMLCanvasElement);

    this.buildChecker();
    this.boardRoot.addChild(this.checker);
    this.boardRoot.addChild(this.layerRoot);
    this.boardRoot.addChild(this.selection.container);
    this.boardRoot.addChild(this.ruler.container);
    this.boardRoot.addChild(this.transform.container);
    this.world.addChild(this.boardRoot);
    app.stage.addChild(this.world);
    this.applyWorldTransform();
    this.transform.bindRuntimeLookup((id) => this.runtimes.get(id));

    const canvas = app.canvas as HTMLCanvasElement;
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("lostpointercapture", this.onLostPointerCapture);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    
    // Globální event listenery pro klávesnici (lepší zachycení zkratek)
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    // Leaving the select tool must paste back any floating selection —
    // otherwise it silently disappears from save/export while invisible to
    // every other tool.
    this.unsubEditorTool = useEditorStore.subscribe((state, prevState) => {
      if (prevState.tool === "select" && state.tool !== "select") {
        this.commitActiveSelection();
      }
      // Entering Transform starts a session automatically (selection-bound if
      // one is active, otherwise the active layer's own content) — matches
      // "tapping the tool" being the whole interaction, no separate "start"
      // step. `startTransformForFolder` sets `pendingFolderTransformId`
      // just before flipping `tool`, so a folder-targeted start (from the
      // layer panel's "Transform Folder" button) takes priority over this
      // default single-layer/selection behavior when both would otherwise
      // fire on the same tick.
      if (prevState.tool !== "transform" && state.tool === "transform") {
        if (this.pendingFolderTransformId) {
          const folderId = this.pendingFolderTransformId;
          this.pendingFolderTransformId = null;
          this.beginTransformForFolder(folderId);
        } else {
          this.beginTransformDefault();
        }
      }
      // Leaving Transform bakes the current preview into real pixels — same
      // "tool switch commits" convention as Select, and matches the spec's
      // own "until Apply, or the tool is deselected/another tool chosen."
      if (prevState.tool === "transform" && state.tool !== "transform") {
        this.applyTransform();
      }
    });

    // Ruler shape/enabled are plain store state (cheap, reactive UI toggles);
    // the guide's actual placed geometry stays engine-side in RulerManager
    // (per-document interaction state), so only these two flags need syncing in.
    this.unsubRulerSync = useEditorStore.subscribe((state, prevState) => {
      if (state.rulerType !== prevState.rulerType) {
        this.ruler.setType(state.rulerType, this.zoom);
      }
      if (state.rulerEnabled !== prevState.rulerEnabled) {
        this.ruler.setEnabled(state.rulerEnabled, this.zoom);
      }
      // Same split as the ruler above — transformMode/meshDivisions are cheap
      // reactive UI state the ToolPalette owns; the actual point-grid/gesture
      // state lives engine-side in TransformManager.
      if (state.transformMode !== prevState.transformMode) {
        this.transform.setMode(state.transformMode, this.zoom);
      }
      if (state.meshDivisionsX !== prevState.meshDivisionsX || state.meshDivisionsY !== prevState.meshDivisionsY) {
        this.transform.setDivisions(state.meshDivisionsX, state.meshDivisionsY, this.zoom);
      }
    });
  }

  /** Removes the placed drawing guide entirely — called from the Ruler tool's "Clear" button via `documentEngineRef`. */
  public clearRuler(): void {
    this.ruler.clear(this.zoom);
  }

  /** Whether a drawing guide has been placed (used to show/hide the "Clear Ruler" button). */
  public isRulerPlaced(): boolean {
    return this.ruler.placed;
  }

  // Force a synchronous resize to match the host element's CSS size.
  // Useful when surrounding layout changes (animations/transition) don't
  // immediately trigger PIXI's ResizeObserver or when we need an explicit refresh.
  public forceResize(): void {
    if (!this.app) return;
    const w = Math.max(0, this.host.clientWidth);
    const h = Math.max(0, this.host.clientHeight);
    try {
      this.app.renderer.resize(w, h);
      const canvas = this.app.view as HTMLCanvasElement;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    } catch (e) {
      // ignore resize errors
    }
  }

  /**
   * Forces one extra, immediate render pass of the whole stage. The actual
   * cause of the "canvas frozen after Transform" bug was a too-aggressive
   * `texture.destroy(true)` call in `TransformManager`'s teardown (see that
   * file's `apply()` doc comment) — already fixed there. This is kept as a
   * cheap, harmless belt-and-suspenders nudge after a Transform session ends
   * (`applyTransform`/`cancelTransform`): safe to call because by this point
   * the just-torn-down mesh is already gone from the scene graph, so it's
   * just an ordinary extra re-render of a clean scene, the same thing the
   * ticker would do on its own next tick anyway.
   */
  private forceRepaint(): void {
    if (!this.app) return;
    try { this.app.renderer.render(this.app.stage); } catch { /* best-effort */ }
  }

  // Merge the specified layer down into the layer below it (if any).
  // This composites the pixel backing stores and removes the upper layer from
  // the runtime and the layer store metadata.
  // Layer merges/flatten/delete destroy runtimes outright with no way to
  // reconstruct them, so old history entries referencing those layer ids
  // would restore incorrectly (restoreSnapshot silently skips missing
  // layers). Reset history to a single baseline at the new state instead.
  public resetHistoryAfterStructuralChange(): void {
    useHistoryStore.getState().clear(this.captureSnapshot());
    useAppStore.getState().showNotification("History cleared");
    useAppStore.getState().markDirty();
  }

  // Composites src's full canvas onto dst (replacing dst's texture), then
  // destroys src's runtime since it's being merged away. Shared by
  // mergeLayerDown/mergeLayerUp/flattenAll.
  private blitAndDiscard(src: LayerRuntime, dst: LayerRuntime, label: string): void {
    try {
      const sw = src.canvas.width;
      const sh = src.canvas.height;
      const dw = dst.canvas.width;
      const dh = dst.canvas.height;
      if (sw !== dw || sh !== dh) {
        console.warn(`${label}: source/dest canvas size mismatch`, { sw, sh, dw, dh });
      }
      dst.ctx.save();
      dst.ctx.setTransform(1, 0, 0, 1, 0, 0);
      dst.ctx.globalCompositeOperation = 'source-over';
      dst.ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, dw, dh);
      dst.ctx.restore();
      updateCanvasTexture(dst.sprite);
    } catch (e) {
      console.error(`${label} draw failed`, e);
    }

    try { src.sprite.destroy({ texture: true, textureSource: true }); } catch {}
    this.runtimes.delete(src.id);
  }

  public mergeLayerDown(id: string): void {
    const layers = useLayerStore.getState().layers;
    const idx = layers.findIndex((l) => l.id === id);
    if (idx <= 0) return; // nothing below to merge into

    const below = layers[idx - 1];
    const src = this.runtimes.get(id);
    const dst = this.runtimes.get(below.id);
    if (!dst) {
      // If destination missing, just remove metadata
      useLayerStore.getState().deleteLayer(id);
      return;
    }

    if (src) this.blitAndDiscard(src, dst, 'mergeLayerDown');

    // Remove metadata and sync engine state, then set active to the layer we merged into
    useLayerStore.getState().deleteLayer(id);
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(below.id);
    this.resetHistoryAfterStructuralChange();
  }

  // Merge the specified layer up into the layer above it (if any).
  public mergeLayerUp(id: string): void {
    const layers = useLayerStore.getState().layers;
    const idx = layers.findIndex((l) => l.id === id);
    if (idx < 0 || idx >= layers.length - 1) return; // nothing above to merge into

    const above = layers[idx + 1];
    const src = this.runtimes.get(id);
    const dst = this.runtimes.get(above.id);
    if (!dst) {
      useLayerStore.getState().deleteLayer(id);
      return;
    }

    if (src) this.blitAndDiscard(src, dst, 'mergeLayerUp');

    useLayerStore.getState().deleteLayer(id);
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(above.id);
    this.resetHistoryAfterStructuralChange();
  }

  // Flatten all layers into a single bottom-most layer. Preserves bottom layer id.
  public flattenAll(): void {
    const layers = useLayerStore.getState().layers;
    if (layers.length <= 1) return;

    const bottom = layers[0];
    const dst = this.runtimes.get(bottom.id);
    if (!dst) return;

    // Merge each layer into bottom from top to bottom+1
    for (let i = layers.length - 1; i >= 1; i--) {
      const id = layers[i].id;
      const src = this.runtimes.get(id);
      if (src) this.blitAndDiscard(src, dst, 'flattenAll');
      useLayerStore.getState().deleteLayer(id);
    }
    // Only one layer survives, so any folder's membership is now vacuous —
    // clear them all rather than leaving empty ghost folders in the panel.
    useLayerStore.setState({ folders: [] });
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(bottom.id);
    this.resetHistoryAfterStructuralChange();
  }

  /** Tears down all listeners, the Pixi application, and layer runtimes. Call on unmount; the instance is unusable afterward. */
  destroy(): void {
    // Set FIRST — see init()'s own comment: if init()'s `await app.init(...)`
    // is still pending when this runs, this flag is how it finds out it
    // should abort once that await resolves, instead of finishing setup for
    // an instance that's already supposed to be dead.
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("wheel", this.preventBrowserZoom);
    this.unsubEditorTool?.();
    this.unsubEditorTool = null;
    this.unsubRulerSync?.();
    this.unsubRulerSync = null;
    if (this.app) {
      const canvas = this.app.canvas as HTMLCanvasElement;
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointercancel", this.onPointerUp);
      canvas.removeEventListener("lostpointercapture", this.onLostPointerCapture);
      canvas.removeEventListener("wheel", this.onWheel);
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
    this.runtimes.clear();
  }

  /** Reconciles Pixi sprite runtimes with `layerStore`'s layer list: creates surfaces for new layers, destroys removed ones, and rebuilds stacking order/visibility. Call whenever the layer list changes. */
  syncLayers(metas: LayerMeta[]): void {
    const ids = new Set(metas.map((m) => m.id));
    for (const id of [...this.runtimes.keys()]) {
      if (!ids.has(id)) {
        const rt = this.runtimes.get(id)!;
        rt.sprite.destroy({ texture: true, textureSource: true });
        this.runtimes.delete(id);
      }
    }

    for (const meta of metas) {
      if (!this.runtimes.has(meta.id)) {
        const { canvas, ctx } = makeLayerSurface(this.width, this.height);
        const texture = Texture.from(canvas);
        const sprite = new Sprite(texture);
        sprite.position.set(0, 0);
        this.runtimes.set(meta.id, { id: meta.id, canvas, ctx, sprite });
      }
    }

    // A folder is purely organizational (no opacity/blend mode of its own —
    // see FolderMeta's doc comment), but hiding it must still hide every
    // member's actual rendering. Computed here rather than baked into each
    // layer's own stored `visible` flag, so toggling the folder back on
    // restores each member's own prior visibility exactly, instead of
    // clobbering it.
    const folders = useLayerStore.getState().folders;
    const isFolderVisible = (folderId?: string | null): boolean => {
      if (!folderId) return true;
      const f = folders.find((x) => x.id === folderId);
      return f ? f.visible : true;
    };

    this.layerRoot.removeChildren();
    // `metas` runs bottom-of-stack to top-of-stack (later entries render on top).
    // A run of consecutive clipped layers all clip to the same base — the
    // nearest non-clipped layer beneath the whole run, not a chain of each
    // clipped layer masking the next. A clipped layer with no non-clipped
    // layer below it (bottom of the whole stack) gets mask = null, which
    // renders it normally — matches Procreate's "clip silently deactivates".
    let baseSprite: Sprite | null = null;
    for (const meta of metas) {
      const rt = this.runtimes.get(meta.id);
      if (!rt) continue;
      rt.sprite.visible = meta.visible && isFolderVisible(meta.folderId);
      rt.sprite.alpha = meta.opacity ?? 1;
      rt.sprite.blendMode = (meta.blendMode ?? "normal") as BLEND_MODES;
      this.layerRoot.addChild(rt.sprite);

      if (meta.clippedToLayerBelow) {
        rt.sprite.mask = baseSprite;
      } else {
        rt.sprite.mask = null;
        baseSprite = rt.sprite;
      }
    }
  }

  /**
   * "Merge Folder": flattens every member of `folderId` into its bottom-most
   * member (same underlying blit-and-discard mechanism as mergeLayerUp/Down/
   * flattenAll), then removes the folder — its purpose (grouping several
   * layers) no longer applies once they're one layer. A no-op-but-safe
   * folder with 0-1 members just gets ungrouped (deleteFolder) with nothing
   * to blit.
   */
  public mergeFolder(folderId: string): void {
    const layers = useLayerStore.getState().layers;
    const members = layers.filter((l) => l.folderId === folderId);
    if (members.length < 2) {
      useLayerStore.getState().deleteFolder(folderId);
      return;
    }

    // `members` preserves `layers`' own bottom-to-top order (Array.filter
    // keeps relative order), so members[0] is the bottom-most — the same
    // "merge everything above down into the bottom one" shape flattenAll uses.
    const bottom = members[0];
    const dst = this.runtimes.get(bottom.id);
    if (!dst) return;

    for (let i = members.length - 1; i >= 1; i--) {
      const src = this.runtimes.get(members[i].id);
      if (src) this.blitAndDiscard(src, dst, 'mergeFolder');
      useLayerStore.getState().deleteLayer(members[i].id);
    }
    useLayerStore.getState().deleteFolder(folderId);
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(bottom.id);
    this.resetHistoryAfterStructuralChange();
  }

  /** Live-updates a layer's opacity without a full syncLayers pass (for smooth slider dragging). Store state is the source of truth for persistence; this just keeps the Pixi sprite in sync immediately. */
  public setLayerOpacity(id: string, opacity: number): void {
    const rt = this.runtimes.get(id);
    if (rt) rt.sprite.alpha = Math.min(1, Math.max(0, opacity));
  }

  /** Live-updates a layer's blend mode without a full syncLayers pass. */
  public setLayerBlendMode(id: string, blendMode: string): void {
    const rt = this.runtimes.get(id);
    if (rt) rt.sprite.blendMode = blendMode as BLEND_MODES;
  }

  /** Duplicates a layer's metadata (inserted directly above the source) and copies its pixel content into the new runtime. */
  public duplicateLayer(id: string): void {
    const src = this.runtimes.get(id);
    if (!src) return;
    const newId = useLayerStore.getState().duplicateLayerMeta(id, this.width, this.height);
    if (!newId) {
      useAppStore.getState().showNotification("Not enough memory for another layer");
      return;
    }
    this.syncLayers(useLayerStore.getState().layers);
    const dst = this.runtimes.get(newId);
    if (dst) {
      dst.ctx.drawImage(src.canvas, 0, 0);
      updateCanvasTexture(dst.sprite);
    }
    useAppStore.getState().markDirty();
  }

  /** ibis Paint-style "White to Transparency" (grayscale variant) on the given layer — see layerFilters.ts's own doc comment for the exact formula. One-shot destructive action, recorded as a normal undo step. Takes an explicit `layerId` (not "whichever layer is active") to match every other per-layer panel action (duplicateLayer, mergeLayerUp/Down, etc.) — the panel can have a non-active layer's Properties open. */
  public whiteToTransparentGrayscale(layerId: string): void {
    const rt = this.runtimes.get(layerId);
    if (!rt) return;
    if (this.blockIfLayerLocked(layerId)) return;
    whiteToTransparentGrayscale(rt.ctx);
    updateCanvasTexture(rt.sprite);
    this.onStrokeCommitted?.(layerId);
  }

  /** ibis Paint-style "White to Transparency" (color variant, strength 0-100) on the given layer — see layerFilters.ts's own doc comment (luminance-driven, not "distance from literal white" — a bright saturated color becomes semi-transparent too, not just near-white pixels). One-shot destructive action, recorded as a normal undo step. */
  public whiteToTransparentColor(layerId: string, strength: number): void {
    const rt = this.runtimes.get(layerId);
    if (!rt) return;
    if (this.blockIfLayerLocked(layerId)) return;
    whiteToTransparentColor(rt.ctx, strength);
    updateCanvasTexture(rt.sprite);
    this.onStrokeCommitted?.(layerId);
  }

  /** ibis Paint's "Select Opacity" recolor: repaints the given layer's hue to `hexColor` while preserving each pixel's existing alpha exactly (see layerFilters.ts's own doc comment) — recolor lineart/strokes without losing their antialiased edges. One-shot destructive action, recorded as a normal undo step. */
  public recolorLayerByAlpha(layerId: string, hexColor: string): void {
    const rt = this.runtimes.get(layerId);
    if (!rt) return;
    if (this.blockIfLayerLocked(layerId)) return;
    recolorByAlpha(rt.ctx, hexToRgb(hexColor));
    updateCanvasTexture(rt.sprite);
    this.onStrokeCommitted?.(layerId);
  }

  /** Loads an image and adds it as a new layer, scaled (preserving aspect ratio) to fit within the artboard and centered — then immediately drops the user into the Select tool's move/resize/rotate handles around exactly the placed image (not the whole layer/artboard), so repositioning or resizing it doesn't require manually switching to Select and marquee-dragging it by hand. */
  public async importImageAsLayer(dataUrl: string): Promise<void> {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.src = dataUrl;
    });

    // Bake in any selection floating on the CURRENTLY active layer before we
    // switch layers below — selectRegion() assumes the ctx it's given is
    // wherever a pending float actually belongs, and that's about to become
    // the brand new image layer, not whatever was active a moment ago.
    this.commitActiveSelection();

    if (!useLayerStore.getState().addLayer(this.width, this.height)) {
      useAppStore.getState().showNotification("Not enough memory for another layer");
      return;
    }
    this.syncLayers(useLayerStore.getState().layers);

    const newId = useLayerStore.getState().activeLayerId;
    const rt = newId ? this.runtimes.get(newId) : null;
    if (!rt || !newId) return;

    const scale = Math.min(this.width / img.width, this.height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (this.width - dw) / 2;
    const dy = (this.height - dh) / 2;
    rt.ctx.drawImage(img, dx, dy, dw, dh);
    updateCanvasTexture(rt.sprite);

    useLayerStore.getState().renameLayer(newId, "Imported Image");

    useEditorStore.getState().setTool("select");
    this.selection.selectRegion(rt.ctx, { x: dx, y: dy, w: dw, h: dh }, this.zoom);
    updateCanvasTexture(rt.sprite);

    useAppStore.getState().markDirty();
  }

  // Pastes a floating selection back into its layer, if one exists, without
  // recording an undo step. Used internally so reads (snapshot/export) never
  // silently lose the pixels a floating selection is holding. Returns
  // whether anything was actually baked in.
  private bakeFloatingSelection(): boolean {
    if (!this.selection.hasSelection) return false;
    const ctx = this.getActiveCtx();
    if (!ctx) return false;
    const committed = this.selection.commitSelection(ctx);
    if (committed) {
      try { flushDrawQueue(); } catch {}
      const rt = this.getActiveRuntime();
      if (rt) updateCanvasTexture(rt.sprite);
    }
    return committed;
  }

  // Public version for callers outside the capture/export path (e.g. leaving
  // the select tool): also records an undo step, since it's a real mutation
  // the user should be able to undo.
  /** Whether a selection is currently floating (cut but not yet committed) — used to show/hide the "Done" button. */
  public isSelectionActive(): boolean {
    return this.selection.hasSelection;
  }

  public commitActiveSelection(): void {
    if (this.bakeFloatingSelection()) {
      this.onStrokeCommitted?.(useLayerStore.getState().activeLayerId ?? undefined);
    }
  }

  /**
   * Delete/Backspace: clears a floating selection's content instead of
   * pasting it back — matching typical raster-editor "delete selection"
   * behavior. No new undo step is needed here: `startSelection`'s cut
   * (`extractPixels`/`extractLassoPixels`) already cleared exactly the
   * selection's own shape (not just its bounding box — the lasso path is
   * respected there already) out of the real layer and recorded THAT as the
   * undo step the moment the selection was made. The floating sprite this
   * discards is only ever a preview of what committing would paste back;
   * however far it's since been dragged/resized, the real layer's pixels
   * have been sitting in their already-cleared state the whole time, so
   * discarding it here doesn't change anything that hasn't already been
   * recorded. Returns whether there was a selection to delete.
   */
  public deleteSelection(): boolean {
    if (!this.selection.hasSelection) return false;
    this.selection.discardFloatingSelection();
    return true;
  }

  // --- Transform tool ------------------------------------------------------
  //
  // Entry points: entering the Transform tool (Toolbox click) auto-starts a
  // session via `beginTransformDefault` (selection-bound if a selection is
  // floating, otherwise the active layer's own content); the layer panel's
  // "Transform Folder" button calls `startTransformForFolder` instead, which
  // takes priority for that one tool-switch (see `pendingFolderTransformId`).
  // Leaving the tool (or switching target while already in it) auto-applies.
  //
  // Known v1 limitations, deliberately scoped out rather than half-built:
  // folder-targeting and an active selection are mutually exclusive (any
  // floating selection is committed before a folder-transform starts, not
  // combined with it); Cancel restores the original PIXELS exactly, but
  // (unlike the full spec) does not re-instate the original selection
  // afterward — the user is left with no active selection, same as if they'd
  // committed it normally.

  /** Full-canvas alpha scan for a layer's non-transparent content bounding box, padded — the "derive the transform box from actual content, not the whole canvas" requirement. One-shot cost (tool-entry only, not a hot path), same class of cost as Fill's own full-canvas getImageData. Returns null if the layer is fully transparent. */
  private computeContentBounds(ctx: CanvasRenderingContext2D): { x: number; y: number; w: number; h: number } | null {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        if (data[(rowOff + x) * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = 20;
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const x2 = Math.min(w, maxX + 1 + pad);
    const y2 = Math.min(h, maxY + 1 + pad);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  /** Default Transform entry (Toolbox click): selection-bound if a selection is currently floating on the active layer, otherwise the active layer's own content bounds. */
  private beginTransformDefault(): void {
    const activeLayerId = useLayerStore.getState().activeLayerId;
    if (!activeLayerId) return;
    const rt = this.runtimes.get(activeLayerId);
    if (!rt) return;
    if (this.blockIfLayerLocked(activeLayerId)) return;

    const floating = this.selection.takeFloatingContent();
    if (floating) {
      // The selection was already cut from this layer (its ctx already
      // reflects the hole) — no NEW clear happens here, but the sprite's
      // texture still needs a refresh in case anything changed it since.
      this.transform.startFromExtracted(activeLayerId, floating.canvas, floating.rect, this.zoom, floating.rotation);
      updateCanvasTexture(rt.sprite);
      return;
    }

    const bounds = this.computeContentBounds(rt.ctx);
    if (!bounds) {
      useAppStore.getState().showNotification("Nothing to transform on this layer");
      return;
    }
    // start() clears `bounds` from rt.ctx immediately (eager, non-destructive-
    // until-cancel) — the sprite's GPU texture won't reflect that clear on
    // its own, so it must be refreshed here or the stale (pre-clear) texture
    // stays visible underneath the floating preview mesh.
    this.transform.start([{ layerId: activeLayerId, canvas: rt.canvas, ctx: rt.ctx }], bounds, this.zoom);
    updateCanvasTexture(rt.sprite);
  }

  /** Folder-targeted transform: the union of every non-locked member's own content bounds (hidden members included, per the agreed folder-scoping convention), applying the identical transform to each member's own content independently — relative positions between them are preserved because they all share the same underlying point grid. */
  private beginTransformForFolder(folderId: string): void {
    // Folder-targeting and an active selection are mutually exclusive in this
    // version — commit any floating selection first rather than attempt to
    // combine them (see this section's own doc comment).
    this.commitActiveSelection();

    const members = useLayerStore.getState().layers.filter((l) => l.folderId === folderId && !l.locked);
    if (members.length === 0) {
      useAppStore.getState().showNotification("Nothing to transform in this folder");
      return;
    }
    let union: { x: number; y: number; w: number; h: number } | null = null;
    const targets: { layerId: string; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];
    for (const l of members) {
      const rt = this.runtimes.get(l.id);
      if (!rt) continue;
      const b = this.computeContentBounds(rt.ctx);
      if (!b) continue;
      targets.push({ layerId: l.id, canvas: rt.canvas, ctx: rt.ctx });
      if (!union) {
        union = { ...b };
      } else {
        const x2 = Math.max(union.x + union.w, b.x + b.w);
        const y2 = Math.max(union.y + union.h, b.y + b.h);
        union.x = Math.min(union.x, b.x);
        union.y = Math.min(union.y, b.y);
        union.w = x2 - union.x;
        union.h = y2 - union.y;
      }
    }
    if (!union || targets.length === 0) {
      useAppStore.getState().showNotification("Nothing to transform in this folder");
      return;
    }
    this.transform.start(targets, union, this.zoom);
    // Same texture-refresh requirement as the single-layer path above, for
    // every member layer start() just cleared.
    for (const t of targets) {
      const rt = this.runtimes.get(t.layerId);
      if (rt) updateCanvasTexture(rt.sprite);
    }
  }

  /** Public entry point for the layer panel's "Transform Folder" button. */
  public startTransformForFolder(folderId: string): void {
    if (useEditorStore.getState().tool === "transform") {
      // Already in Transform for some other target — bake that one in first
      // (same "switching away applies" convention as leaving the tool
      // entirely), since setTool() below would no-op (already "transform")
      // and never fire the subscription that would otherwise do this.
      this.applyTransform();
      this.beginTransformForFolder(folderId);
    } else {
      this.pendingFolderTransformId = folderId;
      useEditorStore.getState().setTool("transform");
    }
  }

  /** Whether a Transform session is currently active (preview floating, Apply/Cancel meaningful) — polled the same way `isSelectionActive()` already is, since this is engine-owned interaction state, not store state. */
  public isTransformActive(): boolean {
    return this.transform.active;
  }

  /**
   * Bakes the current preview into real pixels (see `TransformManager.apply`'s
   * own doc comment for exactly how) and records one undo step. If the
   * Transform tool is still selected afterward (this wasn't triggered by
   * switching to a different tool), immediately starts a fresh default
   * session — matches "the tool always has something to transform while
   * it's selected" rather than leaving a dead, handle-less Transform tool
   * active until the user switches away and back.
   *
   * Ends with `forceRepaint()` — see that method's own doc comment for why:
   * in short, tearing down a Transform session's mesh/texture can leave the
   * VISIBLE canvas stuck on a stale frame even though the engine's own state
   * is fully correct afterward, which is exactly the reported "overall I
   * cant use the whole canvas after doin any changes."
   */
  public applyTransform(): void {
    if (this.transform.active && this.app) {
      const affected = this.transform.apply(this.app.renderer);
      if (affected && affected.length) {
        for (const id of affected) {
          const rt = this.runtimes.get(id);
          if (rt) updateCanvasTexture(rt.sprite);
        }
        useAppStore.getState().markDirty();
        // More than one layer changed (a folder transform) — don't pass a
        // single changedLayerId, or captureSnapshot's structural-sharing
        // optimization would wrongly reuse a stale snapshot for the OTHER
        // affected layers, assuming only the one passed in changed.
        this.onStrokeCommitted?.(affected.length === 1 ? affected[0] : undefined);
      }
    }
    if (useEditorStore.getState().tool === "transform") {
      this.beginTransformDefault();
    }
    this.forceRepaint();
  }

  /** Discards the whole session, restoring every affected layer's original untouched pixels. Same auto-restart behavior as `applyTransform()` when the tool is still selected — see that method's own doc comment for why this also ends with `forceRepaint()`. */
  public cancelTransform(): void {
    if (this.transform.active) {
      this.transform.cancel();
      for (const rt of this.runtimes.values()) updateCanvasTexture(rt.sprite);
    }
    if (useEditorStore.getState().tool === "transform") {
      this.beginTransformDefault();
    }
    this.forceRepaint();
  }

  // When `changedLayerId` is given, layers other than it reuse the ImageData
  // reference from the previous history entry instead of re-reading pixels.
  // Safe because history entries are only ever read via putImageData, never
  // mutated, so sharing references across entries is structural sharing.
  captureSnapshot(changedLayerId?: string): DocumentSnapshot {
    const order = [...this.layerRoot.children] as Sprite[];
    const snaps: DocumentSnapshot = [];
    const prevSnapshot = changedLayerId
      ? useHistoryStore.getState().past.at(-1)
      : undefined;
    for (const spr of order) {
      const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
      if (!rt) continue;
      if (changedLayerId && rt.id !== changedLayerId && prevSnapshot) {
        const prevEntry = prevSnapshot.find((e) => e.id === rt.id);
        if (prevEntry) {
          snaps.push(prevEntry);
          continue;
        }
      }
      snaps.push({
        id: rt.id,
        data: rt.ctx.getImageData(0, 0, this.width, this.height),
      });
    }
    return snaps;
  }

  /** Writes a history snapshot's pixel data back into the matching layer runtimes (used by undo/redo). Entries for layer ids that no longer exist are silently skipped. Caller is responsible for pushing/popping the history stack. */
  restoreSnapshot(snap: DocumentSnapshot | null): void {
    if (!snap) return;
    for (const entry of snap) {
      const rt = this.runtimes.get(entry.id);
      if (!rt) continue;

      try {
        let imgData = entry.data as any;
        if (!(imgData instanceof ImageData)) {
          imgData = new ImageData(
            new Uint8ClampedArray(imgData.data),
            imgData.width || this.width,
            imgData.height || this.height
          );
        }
        rt.ctx.putImageData(imgData, 0, 0);
        updateCanvasTexture(rt.sprite);
      } catch (e) {
        console.error("Failed to restore layer data:", e);
      }
    }
  }

  /** Maps a layer's Pixi `BLEND_MODES` string to the Canvas2D `globalCompositeOperation` it visually matches. Most blend-mode names are identical between the two APIs (CSS `mix-blend-mode` and Canvas2D share a vocabulary); only "normal" and "add" need translating. */
  private static blendModeToCanvasOp(mode: string): GlobalCompositeOperation {
    if (mode === "normal") return "source-over";
    if (mode === "add") return "lighter";
    return mode as GlobalCompositeOperation;
  }

  /**
   * Merges every visible layer onto one transparent-backed canvas, honoring
   * opacity and blend mode — unlike `compositeToDataURL`/`exportAsBlob`
   * (which only check `visible`, fine for a flattened *export* where there's
   * nothing left to composite against, but not accurate enough here). Used
   * by the Fill tool's "sample all layers" mode so a fill's boundary
   * detection sees line art on a different layer the same way the eye does,
   * even though the actual paint still only ever lands on the active layer
   * (see `floodFillCanvas`'s `sampleImageData` param).
   */
  private compositeVisibleLayersForSampling(): ImageData {
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    for (const spr of this.layerRoot.children as Sprite[]) {
      if (!spr.visible) continue;
      const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
      if (!rt) continue;
      ctx.save();
      ctx.globalAlpha = spr.alpha;
      ctx.globalCompositeOperation = DocumentCanvas.blendModeToCanvasOp(spr.blendMode as string);
      ctx.drawImage(rt.canvas, 0, 0);
      ctx.restore();
    }
    return ctx.getImageData(0, 0, this.width, this.height);
  }

  // Used for the gallery preview thumbnail, so it's downscaled — a full-res
  // PNG data URL per saved project would bloat the IndexedDB record and cost
  // a full-resolution decode just to show a small card.
  compositeToDataURL(maxDim: number = 512): string {
    this.bakeFloatingSelection();
    const scale = Math.min(1, maxDim / Math.max(this.width, this.height));
    const outW = Math.max(1, Math.round(this.width * scale));
    const outH = Math.max(1, Math.round(this.height * scale));

    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.scale(scale, scale);

    for (const spr of this.layerRoot.children as Sprite[]) {
      if (!spr.visible) continue;
      const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
      if (!rt) continue;
      ctx.drawImage(rt.canvas, 0, 0);
    }
    return c.toDataURL("image/png");
  }

  /** Composites all visible layers onto an opaque (unless `transparent`) canvas at `scale`× the artboard size and encodes it as PNG or JPEG. `transparent` is ignored for JPEG, which has no alpha channel. */
  async exportAsBlob(format: string = "png", scale: number = 1, transparent: boolean = false): Promise<Blob | null> {
    this.bakeFloatingSelection();
    return new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = this.width * scale;
      c.height = this.height * scale;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(null);

      ctx.scale(scale, scale);
      // JPEG has no alpha channel, so it always needs an opaque backing fill.
      if (!transparent || format === 'jpg') {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, this.width, this.height);
      }

      for (const spr of this.layerRoot.children as Sprite[]) {
        if (!spr.visible) continue;
        const rt = Array.from(this.runtimes.values()).find((r) => r.sprite === spr);
        if (rt) ctx.drawImage(rt.canvas, 0, 0);
      }
      
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      c.toBlob((blob) => resolve(blob), mime, 0.95);
    });
  }

  // The artboard is exported onto an opaque white background (see
  // exportAsBlob/compositeToDataURL), so it's shown as solid white paper
  // rather than a transparency checkerboard.
  private buildChecker(): void {
    const g = new Graphics();
    g.rect(0, 0, this.width, this.height).fill({ color: ARTBOARD_FILL });
    g.rect(0, 0, this.width, this.height).stroke({ width: 4, color: ARTBOARD_BORDER });
    this.checker = g;
  }

  private applyWorldTransform(): void {
    this.world.position.set(this.pan.x, this.pan.y);
    this.world.scale.set(this.zoom);
    this.world.rotation = this.rotation; // Přidána rotace
  }

  // ZCELA PŘEPSÁNO: Nyní to za nás počítá PixiJS
  private screenToWorld(clientX: number, clientY: number): Point {
    if (!this.app) return { x: 0, y: 0 };
    this.app.renderer.events.mapPositionToPoint(this.pointerScratch, clientX, clientY);
    // toLocal automaticky zohlední pan, zoom i rotaci
    const local = this.world.toLocal(this.pointerScratch); 
    return { x: local.x, y: local.y };
  }

  private pointerSample(e: PointerEvent, world: Point): PointerBrushSample {
    return {
      x: world.x, y: world.y, t: performance.now(),
      pressure: Number.isFinite(e.pressure) ? e.pressure : 0.5,
      pointerType: e.pointerType || "mouse",
    };
  }

  private preventBrowserZoom = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.app) return;
    e.preventDefault();

    let dx = e.deltaX;
    let dy = e.deltaY;
    
    if (e.deltaMode === 1) { dx *= WHEEL_LINE_MULTIPLIER; dy *= WHEEL_LINE_MULTIPLIER; }
    else if (e.deltaMode === 2) { dx *= WHEEL_PAGE_MULTIPLIER; dy *= WHEEL_PAGE_MULTIPLIER; }

    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.app.renderer.events.mapPositionToPoint(this.pointerScratch, e.clientX, e.clientY);
      
      // Zjistíme, nad jakým bodem plátna myš zrovna stojí
      const worldPos = this.world.toLocal(this.pointerScratch);

      const zoomFactor = Math.exp(-dy * 0.005);
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * zoomFactor));

      // Simulujeme novou pozici (zatím bez úpravy pan)
      this.world.scale.set(this.zoom);
      this.world.position.set(this.pan.x, this.pan.y);

      // Podíváme se, kam nám náš bod na plátně po zoomu "utekl"
      const newScreenPos = this.world.toGlobal(worldPos);

      // A posuneme kameru tak, aby se vrátil zpět pod myš
      this.pan.x += this.pointerScratch.x - newScreenPos.x;
      this.pan.y += this.pointerScratch.y - newScreenPos.y;
    } else {
      // Rotace na PC pomocí Shift + Kolečko
      if (e.shiftKey) { 
        this.app.renderer.events.mapPositionToPoint(this.pointerScratch, e.clientX, e.clientY);
        const worldPos = this.world.toLocal(this.pointerScratch);
        
        this.rotation += dy * 0.005;
        
        this.world.rotation = this.rotation;
        this.world.position.set(this.pan.x, this.pan.y);
        const newScreenPos = this.world.toGlobal(worldPos);
        this.pan.x += this.pointerScratch.x - newScreenPos.x;
        this.pan.y += this.pointerScratch.y - newScreenPos.y;
      }
      else { 
        // Normální posun
        this.pan.x -= dx; this.pan.y -= dy; 
      }
    }
    this.applyWorldTransform();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space") this.spaceHeld = true;

    // None of the shortcuts below should fire while the user is typing
    // somewhere else in the UI (a layer-rename box, a future numeric field,
    // etc.) — both because "z"/"y" are ordinary letters someone might be
    // typing, and because Ctrl/Cmd+Z has its own native meaning (undo the
    // text edit) inside a focused text field that this must not clobber.
    if (isEditableTarget(e.target)) return;

    // SHORTCUTS: Funguje pro Windows (Ctrl) i Mac (Cmd). Redo accepts both
    // Ctrl+Shift+Z and the Windows-standard Ctrl+Y.
    //
    // `e.key` ALONE, not `e.code` — on a QWERTZ layout (German/Czech/
    // Austrian/Swiss keyboards) the Y and Z keys are physically swapped
    // versus QWERTY, so `e.code` (which always reports the QWERTY REFERENCE
    // position, not the printed key) reports 'KeyY' for the physical key
    // printed "Z" and vice versa. The previous `e.key === 'z' || e.code ===
    // 'KeyZ'` check OR'd both together, so pressing the physical "Z" key
    // made `isZ` true via `e.key` AND `isY` true via `e.code` at the same
    // time — every undo attempt also satisfied the redo condition, and redo
    // was checked first, so undo could never win (reported bug: "ctrl+z and
    // y both redirect to redo"). `e.key` alone already reflects the actual
    // character the user's own layout produces, which is what a letter-based
    // shortcut should key off in the first place.
    const key = e.key.toLowerCase();
    const isZ = key === 'z';
    const isY = key === 'y';
    const isMod = e.ctrlKey || e.metaKey;
    const isRedo = isMod && ((isZ && e.shiftKey) || isY);
    const isUndo = isMod && isZ && !e.shiftKey;

    if (isRedo || isUndo) {
      e.preventDefault();
      e.stopPropagation(); // Zabraňuje konfliktu s prohlížečem

      const history = useHistoryStore.getState();
      const app = useAppStore.getState();

      // A floating selection isn't part of any history snapshot; restoring
      // one while it floats must drop it rather than paste it somewhere it
      // doesn't belong (and would otherwise duplicate it on the next click).
      if (this.selection.hasSelection) {
        this.selection.discardFloatingSelection();
      }
      // Same reasoning for an in-progress Transform preview — it isn't part
      // of any history snapshot either, so undo/redo must cancel (not apply)
      // it first rather than leave it floating on top of a just-restored past
      // state.
      if (this.transform.active) {
        this.cancelTransform();
      }

      if (isRedo) {
        const snap = history.redo();
        if (snap) {
          this.restoreSnapshot(snap);
          app.showNotification("Redo");
        }
      } else {
        const snap = history.undo();
        if (snap) {
          this.restoreSnapshot(snap);
          app.showNotification("Undo");
        }
      }
      return;
    }

    if ((e.key === "Delete" || e.key === "Backspace") && this.selection.hasSelection) {
      e.preventDefault();
      this.deleteSelection();
    }

    if (this.transform.active) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.applyTransform();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancelTransform();
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") this.spaceHeld = false;
  };

  // --- OPRAVA MULTI-TOUCH A PINCH ZOOMU ---
private onPointerDown = (e: PointerEvent): void => {
    if (!this.app) return;
    try { (this.app.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // MOBILE UNDO: Klepnutí 2 prsty (fired on pointerup only if it turns out
    // to be a quick tap, not a pinch/rotate gesture — see onPointerUp).
    if (this.activePointers.size === 2) {
      this.drawing = false;
      this.stroking = false;
      this.panning = false;

      const pts = Array.from(this.activePointers.values());
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;

      // ibis Paint-style redirect: a 2-finger gesture starting *inside* an
      // active floating selection drives its scale/rotation instead of the
      // canvas's, so pinch/twist feels the same whether or not something is
      // selected — it just acts on whatever's under your fingers.
      const worldCenter = this.screenToWorld(cx, cy);
      if (
        useEditorStore.getState().tool === "select" &&
        this.selection.hasSelection &&
        this.selection.isPointInside(worldCenter.x, worldCenter.y)
      ) {
        this.selectionGesture = true;
        this.selectionGestureStartDist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        this.selectionGestureStartAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        this.selectionGestureInitialRect = { ...this.selection.currentRect! };
        this.selectionGestureInitialRotation = this.selection.rotation;
        return;
      }

      this.isPinching = true;
      this.pinchStartTime = performance.now();
      this.pinchMaxMovement = 0;
      this.pinchStartPositions = new Map(this.activePointers);

      this.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.initialPinchZoom = this.zoom;

      this.initialPinchAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      this.initialPinchRotation = this.rotation;

      this.app.renderer.events.mapPositionToPoint(this.pointerScratch, cx, cy);
      this.world.toLocal(this.pointerScratch, undefined, this.pinchWorldCenter);

      return;
    }

    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      this.panning = true;
      this.panPointerStart = { x: e.clientX, y: e.clientY };
      this.panWorldStart = { ...this.pan };
      return;
    }

    if (this.isPinching || e.button !== 0) return;

    // Ensure any pending batched draw ops are flushed before starting a new stroke
    try { flushDrawQueue(); } catch {}

    const world = this.screenToWorld(e.clientX, e.clientY);
    const tool = useEditorStore.getState().tool;

    if (tool === "ruler") {
      this.ruler.startEdit(world.x, world.y, this.zoom);
      return;
    }

    if (tool === "transform") {
      this.transform.beginDrag(world.x, world.y, this.zoom);
      return;
    }

    if (tool === "fill") {
      const ctx = this.getActiveCtx();
      if (!ctx) return;
      const activeLayerId = useLayerStore.getState().activeLayerId;
      if (this.blockIfLayerLocked(activeLayerId)) return;
      const px = Math.round(world.x);
      const py = Math.round(world.y);
      const { color, fillTolerance, fillSampleAllLayers } = useEditorStore.getState();
      const activeLayer = useLayerStore.getState().layers.find((l) => l.id === activeLayerId);
      const rgb = hexToRgb(color);
      const sampleImageData = fillSampleAllLayers ? this.compositeVisibleLayersForSampling() : undefined;
      const filled = floodFillCanvas(
        ctx,
        px,
        py,
        { r: rgb.r, g: rgb.g, b: rgb.b, a: 255 },
        fillTolerance,
        activeLayer?.alphaLocked ?? false,
        sampleImageData
      );
      if (filled) {
        const rt = this.getActiveRuntime();
        if (rt) updateCanvasTexture(rt.sprite);
        this.onStrokeCommitted?.(activeLayerId ?? undefined);
      }
      return;
    }

    // VÝHYBKA PRO SELECT TOOL
    if (tool === "select") {
      const ctx = this.getActiveCtx();
      // A locked layer can't have a NEW selection cut out of it (that's a
      // pixel mutation — clearRect on the source). An already-floating
      // selection (from before the layer got locked) can still be
      // moved/resized/committed — narrow edge case, not worth blocking too.
      if (!this.selection.hasSelection && this.blockIfLayerLocked(useLayerStore.getState().activeLayerId)) {
        return;
      }
      // Sync shape mode before starting; only matters for a fresh drag — a
      // handle-grab or move on an existing floating selection ignores it.
      this.selection.mode = useEditorStore.getState().selectMode;
      // Pošleme kontext manažerovi, aby mohl lepit staré pixely
      const didCommit = this.selection.startSelection(world.x, world.y, this.zoom, ctx);

      // Nutno překreslit plátno (pro případ, že jsme právě přilepili starý výběr zpět)
      const rt = this.getActiveRuntime();
      if (rt) updateCanvasTexture(rt.sprite);

      if (didCommit) {
        this.onStrokeCommitted?.(useLayerStore.getState().activeLayerId ?? undefined);
      }

      return;
    }

    const ctx = this.getActiveCtx();
    if (!ctx) return; // Pojistka, pokud není aktivní žádná vrstva
    if (this.blockIfLayerLocked(useLayerStore.getState().activeLayerId)) return;

    this.drawing = true;
    this.stroking = true;
    this.syncBrushTuning();
    const settings = this.getBrushSettings();
    const paintWorld = this.ruler.snapPoint(world.x, world.y);
    this.brush.down(ctx, this.pointerSample(e, paintWorld), settings);
    const rt = this.getActiveRuntime();
    if (rt) updateCanvasTexture(rt.sprite);
    try { setImmediateMode(true); } catch {}
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.app) return;

    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Selection pinch/rotate gesture (redirected from canvas zoom — see onPointerDown)
    if (this.selectionGesture && this.activePointers.size === 2 && this.selectionGestureInitialRect) {
      const pts = Array.from(this.activePointers.values());
      const currentDist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const currentAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);

      const scale = currentDist / this.selectionGestureStartDist;
      const rotDelta = currentAngle - this.selectionGestureStartAngle;

      const r = this.selectionGestureInitialRect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const nw = r.w * scale;
      const nh = r.h * scale;
      const newRect = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
      const newRotation = this.selectionGestureInitialRotation + rotDelta;

      this.selection.setTransform(newRect, newRotation, this.zoom);
      return;
    }

    // Fyzický pinch zoom na obrazovce
    if (this.isPinching && this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const currentCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      const currentAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);

      // Track how far either finger has strayed from its start position, so
      // onPointerUp can tell a quick two-finger tap (undo) apart from an
      // actual pinch/rotate gesture (which must not also trigger undo).
      for (const [id, pos] of this.activePointers) {
        const start = this.pinchStartPositions.get(id);
        if (start) {
          const d = Math.hypot(pos.x - start.x, pos.y - start.y);
          if (d > this.pinchMaxMovement) this.pinchMaxMovement = d;
        }
      }

      if (this.initialPinchDist > 0) {
        const scale = currentDist / this.initialPinchDist;
        
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.initialPinchZoom * scale));
        this.rotation = this.initialPinchRotation + (currentAngle - this.initialPinchAngle);

        this.world.scale.set(this.zoom);
        this.world.rotation = this.rotation;
        this.world.position.set(this.pan.x, this.pan.y);

        this.app.renderer.events.mapPositionToPoint(this.pointerScratch, currentCenter.x, currentCenter.y);
        const newScreenPos = this.world.toGlobal(this.pinchWorldCenter);

        this.pan.x += this.pointerScratch.x - newScreenPos.x;
        this.pan.y += this.pointerScratch.y - newScreenPos.y;

        this.applyWorldTransform();
      }
      return;
    }

    // TAŽENÍ MODRÉHO RÁMEČKU NEBO JEHO OBSAHU (včetně tažení rohové úchytky)
    if (this.selection.isSelecting || this.selection.isMoving || this.selection.activeHandle) {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.selection.updateSelection(world.x, world.y, this.zoom, e.shiftKey);
      return;
    }

    if (this.transform.isDragging()) {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.transform.updateDrag(world.x, world.y, this.zoom, e.shiftKey);
      return;
    }

    if (this.ruler.isEditing) {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.ruler.updateEdit(world.x, world.y, this.zoom);
      return;
    }

    if (this.panning) {
      const dx = e.clientX - this.panPointerStart.x;
      const dy = e.clientY - this.panPointerStart.y;
      this.pan.x = this.panWorldStart.x + dx;
      this.pan.y = this.panWorldStart.y + dy;
      this.applyWorldTransform();
      return;
    }

    if (!this.drawing || this.isPinching) return;
    const world = this.screenToWorld(e.clientX, e.clientY);
    const ctx = this.getActiveCtx();
    if (!ctx) return;
    const settings = this.getBrushSettings();
    const paintWorld = this.ruler.snapPoint(world.x, world.y);
    this.brush.move(ctx, this.pointerSample(e, paintWorld), settings);
    const rt = this.getActiveRuntime();
    if (rt) this.scheduleRecomposite(ctx, settings, rt);
  };

  /** Coalesces recomposite()+texture-upload to at most one per animation frame; later calls before the frame fires just replace the pending (ctx/settings/rt) with the latest, since only the final state before paint matters. */
  private scheduleRecomposite(ctx: CanvasRenderingContext2D, settings: BrushSettings, rt: LayerRuntime): void {
    this.pendingRecomposite = { ctx, settings, rt };
    if (this.recomposeRafId !== null) return;
    this.recomposeRafId = requestAnimationFrame(() => {
      this.recomposeRafId = null;
      const pending = this.pendingRecomposite;
      this.pendingRecomposite = null;
      if (!pending) return;
      this.brush.recomposite(pending.ctx, pending.settings);
      updateCanvasTexture(pending.rt.sprite);
    });
  }

  /** Cancels any recompose scheduled by scheduleRecomposite without running it — used when a synchronous recomposite (e.g. flush()'s final one) is about to supersede it. */
  private cancelScheduledRecomposite(): void {
    if (this.recomposeRafId !== null) {
      cancelAnimationFrame(this.recomposeRafId);
      this.recomposeRafId = null;
    }
    this.pendingRecomposite = null;
  }

  private onLostPointerCapture = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      this.isPinching = false;
      this.selectionGesture = false;
      this.selectionGestureInitialRect = null;
    }
    if (this.panning) this.panning = false;
    if (this.drawing || this.stroking) {
      this.drawing = false;
      this.stroking = false;
      try { setImmediateMode(false); } catch {}
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      const wasPinching = this.isPinching;
      this.isPinching = false;
      this.selectionGesture = false;
      this.selectionGestureInitialRect = null;

      // MOBILE UNDO: only a quick, mostly-stationary two-finger tap counts;
      // an actual pinch-zoom or two-finger rotate must not also undo.
      if (wasPinching) {
        const duration = performance.now() - this.pinchStartTime;
        if (duration < 250 && this.pinchMaxMovement < 10) {
          if (this.selection.hasSelection) {
            this.selection.discardFloatingSelection();
          }
          const snap = useHistoryStore.getState().undo();
          if (snap) {
            this.restoreSnapshot(snap);
            useAppStore.getState().showNotification("Undo");
          }
        }
      }
    }

    if (this.panning) {
      this.panning = false;
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    if (this.ruler.isEditing) {
      this.ruler.endEdit();
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    // --- NOVÉ: UKONČENÍ VÝBĚRU A TAŽENÍ ---
    if (this.selection.isSelecting || this.selection.isMoving || this.selection.activeHandle) {
      const activeCtx = this.getActiveCtx();
      const didExtract = this.selection.endSelection(activeCtx);

      // Důležité: Překreslíme vrstvu, protože jsme z ní vyřízli (nebo do ní vlepili) pixely
      const rt = this.getActiveRuntime();
      // Ensure any queued draws are flushed before updating texture
      try { flushDrawQueue(); } catch {}
      if (rt) updateCanvasTexture(rt.sprite);

      // Cutting a new selection out mutates the layer's pixels (clearRect),
      // so it needs its own undo step; resizing/moving the floating overlay
      // doesn't touch the layer until it's committed.
      if (didExtract) {
        this.onStrokeCommitted?.(useLayerStore.getState().activeLayerId ?? undefined);
      }

      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    if (this.transform.isDragging()) {
      this.transform.endDrag();
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    // --- ZBYTEK FUNKCE PRO KRESLENÍ ZŮSTÁVÁ ---
    if (this.drawing) {
      // flush() does its own synchronous, final recomposite — drop any
      // still-pending RAF-scheduled one so it can't run afterward and
      // clobber the finished stroke with a stale in-progress state.
      this.cancelScheduledRecomposite();
      const ctx = this.getActiveCtx();
      const world = this.screenToWorld(e.clientX, e.clientY);
      const paintWorld = this.ruler.snapPoint(world.x, world.y);
      if (ctx && this.stroking) {
        this.brush.flush(ctx, this.pointerSample(e, paintWorld), this.getBrushSettings());
        // Ensure flush draws are executed before we snapshot/update
        try { flushDrawQueue(); } catch {}
        const rt = this.getActiveRuntime();
        if (rt) updateCanvasTexture(rt.sprite);
      }
      this.drawing = false;
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      if (this.stroking) {
        this.stroking = false;
        this.onStrokeCommitted?.(useLayerStore.getState().activeLayerId ?? undefined);
      }
      try { setImmediateMode(false); } catch {}
    }
  };

  /**
   * Set by the caller (see CanvasStage) to push a history entry whenever the
   * engine finishes a pixel-mutating action — a brush stroke, a new
   * selection cut, or a selection paste. `changedLayerId`, when given, is
   * passed straight through to `captureSnapshot` for its structural-sharing
   * optimization; the engine never pushes history on its own.
   */
  onStrokeCommitted?: (changedLayerId?: string) => void;

  /** Pushes the store's current stabilization value (0-10) into the brush engine's own tuning. Called once per stroke, on pointer down — HighPerformanceBrushStroke.setTuning merges into the running tuning without resetting stroke state, so this just needs to run before flush()'s post-stroke stabilization pass reads tuning.stabilization at the end of this same stroke. */
  private syncBrushTuning(): void {
    this.brush.setTuning({ stabilization: useEditorStore.getState().stabilization });
  }

  private getBrushSettings(): BrushSettings {
    const {
      tool, brushSize, brushHardness, brushOpacity, color,
      intensity, startTaper, endTaper, colorMix, brushStyle, smudgeStrength
    } = useEditorStore.getState();

    // Only the eraser tool erases; every other paint-capable tool (brush,
    // blur, smudge — select never reaches here) behaves like "brush" as far
    // as brushSettingsForTool's isEraser flag is concerned.
    const safeTool = (tool === "eraser" ? "eraser" : "brush") as "brush" | "eraser";

    const activeLayerId = useLayerStore.getState().activeLayerId;
    const activeLayer = useLayerStore.getState().layers.find((l) => l.id === activeLayerId);

    return brushSettingsForTool({
      size: brushSize,
      hardness: brushHardness,
      opacity: brushOpacity,
      color,
      intensity,
      startTaper,
      endTaper,
      colorMix,
      brushStyle,
      alphaLocked: activeLayer?.alphaLocked ?? false,
      smudgeStrength,
    }, safeTool);
  }

  /** Renders a small preview of a layer's actual current pixels, scaled to
   * fit `size`×`size` preserving aspect ratio — reuses the layer's real
   * runtime canvas directly (not a cached/stale copy), so it's always
   * up to date whenever it's called. Returns `null` if the layer doesn't
   * exist. Used by `LayerPanel`'s thumbnails (Section 14 follow-up). */
  public getLayerThumbnail(id: string, size = 32): string | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    const w = rt.canvas.width;
    const h = rt.canvas.height;
    if (w <= 0 || h <= 0) return null;
    const scale = Math.min(size / w, size / h);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    octx.drawImage(rt.canvas, 0, 0, w, h, 0, 0, tw, th);
    return out.toDataURL();
  }

  private getActiveCtx(): CanvasRenderingContext2D | null {
    const id = useLayerStore.getState().activeLayerId;
    if (!id) return null;
    return this.runtimes.get(id)?.ctx ?? null;
  }

  private getActiveRuntime(): LayerRuntime | null {
    const id = useLayerStore.getState().activeLayerId;
    if (!id) return null;
    return this.runtimes.get(id) ?? null;
  }

  /**
   * Full layer lock (`LayerMeta.locked`, distinct from Alpha Lock — see its
   * own doc comment) blocks every pixel-mutating entry point: painting
   * (brush/eraser/blur/smudge), Fill, starting a new Select cut, and the
   * white-to-transparent/recolor-by-alpha layer actions. Shows a
   * notification and returns true so callers can just `if (...) return;`.
   */
  private blockIfLayerLocked(id: string | null | undefined): boolean {
    if (!id) return false;
    const locked = !!useLayerStore.getState().layers.find((l) => l.id === id)?.locked;
    if (locked) useAppStore.getState().showNotification("Layer is locked");
    return locked;
  }

  /** Returns the picked hex color, "unsupported" if the browser lacks the EyeDropper API, or null if the user cancelled. */
  public async activateEyedropper(): Promise<string | "unsupported" | null> {
    if (!("EyeDropper" in window)) return "unsupported";
    try {
      // @ts-ignore
      const eyeDropper = new window.EyeDropper();
      const result = await eyeDropper.open();
      return result.sRGBHex;
    } catch (e) {
      return null;
    }
  }
}