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
import { floodFillCanvas } from "./floodFill";
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

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** Creates the PixiJS application, mounts it into `host`, and wires up pointer/keyboard/wheel handlers. Call once before any other method. */
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
    this.app = app;

    // Zabraňuje zoomování prohlížeče při scrollování s Ctrl
    document.addEventListener("wheel", this.preventBrowserZoom, { passive: false });
    this.host.appendChild(app.canvas as HTMLCanvasElement);

    this.buildChecker();
    this.boardRoot.addChild(this.checker);
    this.boardRoot.addChild(this.layerRoot);
    this.boardRoot.addChild(this.selection.container);
    this.boardRoot.addChild(this.ruler.container);
    this.world.addChild(this.boardRoot);
    app.stage.addChild(this.world);
    this.applyWorldTransform();

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
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(bottom.id);
    this.resetHistoryAfterStructuralChange();
  }

  /** Tears down all listeners, the Pixi application, and layer runtimes. Call on unmount; the instance is unusable afterward. */
  destroy(): void {
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
      rt.sprite.visible = meta.visible;
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

  /** Loads an image and adds it as a new layer, scaled (preserving aspect ratio) to fit within the artboard and centered. */
  public async importImageAsLayer(dataUrl: string): Promise<void> {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.src = dataUrl;
    });

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
    
    // SHORTCUTS: Funguje pro Windows (Ctrl) i Mac (Cmd). Redo accepts both
    // Ctrl+Shift+Z and the Windows-standard Ctrl+Y.
    const isZ = e.key.toLowerCase() === 'z' || e.code === 'KeyZ';
    const isY = e.key.toLowerCase() === 'y' || e.code === 'KeyY';
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

    if (tool === "fill") {
      const ctx = this.getActiveCtx();
      if (!ctx) return;
      const px = Math.round(world.x);
      const py = Math.round(world.y);
      const { color, fillTolerance } = useEditorStore.getState();
      const activeLayerId = useLayerStore.getState().activeLayerId;
      const activeLayer = useLayerStore.getState().layers.find((l) => l.id === activeLayerId);
      const rgb = hexToRgb(color);
      const filled = floodFillCanvas(
        ctx,
        px,
        py,
        { r: rgb.r, g: rgb.g, b: rgb.b, a: 255 },
        fillTolerance,
        activeLayer?.alphaLocked ?? false
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