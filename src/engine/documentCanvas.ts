import { Application, Container, Graphics, Point as PixiPoint, Sprite, Texture } from "pixi.js";
import { CHECKER_DARK, CHECKER_LIGHT } from "./artboardConfig";
import { useAppStore } from "../stores/appStore";
import { useHistoryStore, type DocumentSnapshot } from "../stores/historyStore";
import { useEditorStore } from "../stores/editorStore";
import { useLayerStore, type LayerMeta } from "../stores/layerStore";
import { brushSettingsForTool, HighPerformanceBrushStroke, flushDrawQueue, setImmediateMode } from "./brushEngine";
import { SelectionManager } from "./SelectionManager";

// OPRAVA TADY: Přidali jsme BrushSettings do importu
import type { BrushSettings, Point, PointerBrushSample } from "./brushTypes";

const CHECK_SIZE = 64;

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
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.clearRect(0, 0, w, h);
  return { canvas, ctx };
}

function updateCanvasTexture(sprite: Sprite): void {
  try {
    const res = sprite.texture.baseTexture.resource as any;
    const src = res?.source;
    // If source is a canvas and createImageBitmap is available, upload async
    if (typeof createImageBitmap !== 'undefined' && src && src instanceof HTMLCanvasElement) {
      // Capture reference to old texture to destroy after replacement
      const oldTex = sprite.texture;
      createImageBitmap(src).then((bmp) => {
        try {
          const newTex = Texture.from(bmp);
          sprite.texture = newTex;
          try { oldTex.destroy(true); } catch {}
        } catch (e) {
          // fallback to forcing update
          try { (sprite.texture.source as any).update(); } catch {}
        }
      }).catch(() => {
        try { (sprite.texture.source as any).update(); } catch {}
      });
    } else {
      // Fallback: synchronous update (canvas resource)
      try { (sprite.texture.source as any).update(); } catch {}
    }
  } catch (e) {
    try { (sprite.texture.source as any).update(); } catch {}
  }
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
  private spaceHeld = false;
  private panning = false;
  private panPointerStart = { x: 0, y: 0 };
  private panWorldStart = { x: 0, y: 0 };
  private readonly pointerScratch = new PixiPoint();

  // --- MULTI-TOUCH STAV ---
  private activePointers = new Map<number, { x: number, y: number }>();
  private initialPinchDist = 1;
  private initialPinchZoom = 1;
  private initialPinchAngle = 0;
  private initialPinchRotation = 0;
  private pinchWorldCenter: PixiPoint = new PixiPoint(); // NOVÉ: Kotevní bod pro rotaci
  private isPinching = false;

  getImageBounds() {
    return { width: this.width, height: this.height };
  }

  constructor(host: HTMLElement) {
    this.host = host;
  }

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
    });
    this.app = app;
    
    // Zabraňuje zoomování prohlížeče při scrollování s Ctrl
    document.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false });
    this.host.appendChild(app.canvas as HTMLCanvasElement);

    this.buildChecker();
    this.boardRoot.addChild(this.checker);
    this.boardRoot.addChild(this.layerRoot);
    this.boardRoot.addChild(this.selection.container);
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

    if (src) {
      try {
        const sw = src.canvas.width;
        const sh = src.canvas.height;
        const dw = dst.canvas.width;
        const dh = dst.canvas.height;
        if (sw !== dw || sh !== dh) {
          console.warn('mergeLayerDown: source/dest canvas size mismatch', { id, sw, sh, dw, dh });
        }
        dst.ctx.save();
        dst.ctx.setTransform(1, 0, 0, 1, 0, 0);
        dst.ctx.globalCompositeOperation = 'source-over';
        dst.ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, dw, dh);
        dst.ctx.restore();
        updateCanvasTexture(dst.sprite);
      } catch (e) {
        console.error('mergeLayerDown draw failed', e);
      }

      // Clean up the source runtime
      try { src.sprite.destroy(); } catch {}
      this.runtimes.delete(id);
    }

    // Remove metadata and sync engine state, then set active to the layer we merged into
    useLayerStore.getState().deleteLayer(id);
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(below.id);
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

    if (src) {
      try {
        const sw = src.canvas.width;
        const sh = src.canvas.height;
        const dw = dst.canvas.width;
        const dh = dst.canvas.height;
        if (sw !== dw || sh !== dh) {
          console.warn('mergeLayerUp: source/dest canvas size mismatch', { id, sw, sh, dw, dh });
        }
        dst.ctx.save();
        dst.ctx.setTransform(1, 0, 0, 1, 0, 0);
        dst.ctx.globalCompositeOperation = 'source-over';
        dst.ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, dw, dh);
        dst.ctx.restore();
        updateCanvasTexture(dst.sprite);
      } catch (e) {
        console.error('mergeLayerUp draw failed', e);
      }

      try { src.sprite.destroy(); } catch {}
      this.runtimes.delete(id);
    }

    useLayerStore.getState().deleteLayer(id);
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(above.id);
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
      if (src) {
        try {
          const sw = src.canvas.width;
          const sh = src.canvas.height;
          const dw = dst.canvas.width;
          const dh = dst.canvas.height;
          if (sw !== dw || sh !== dh) {
            console.warn('flattenAll: source/dest canvas size mismatch', { id, sw, sh, dw, dh });
          }
          dst.ctx.save();
          dst.ctx.setTransform(1, 0, 0, 1, 0, 0);
          dst.ctx.globalCompositeOperation = 'source-over';
          dst.ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, dw, dh);
          dst.ctx.restore();
          updateCanvasTexture(dst.sprite);
        } catch (e) {
          console.error('flatten draw failed', e);
        }

        try { src.sprite.destroy(); } catch {}
        this.runtimes.delete(id);
      }
      useLayerStore.getState().deleteLayer(id);
    }
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(bottom.id);
  }

  // Merge an array of layer ids into the lowest-index selected layer.
  public mergeSelected(ids: string[]): void {
    const layers = useLayerStore.getState().layers;
    if (!ids || ids.length <= 1) return;

    // Map ids to indices and sort descending so we draw higher indices first
    const byIndex = ids
      .map((id) => ({ id, idx: layers.findIndex((l) => l.id === id) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx);
    if (byIndex.length <= 1) return;

    const target = byIndex[0].id; // lowest index -> destination
    const dst = this.runtimes.get(target);
    if (!dst) return;

    // merge others into target (from highest to lowest to preserve stacking)
    for (let i = byIndex.length - 1; i >= 1; i--) {
      const sid = byIndex[i].id;
      const src = this.runtimes.get(sid);
      if (src) {
        try {
          const sw = src.canvas.width;
          const sh = src.canvas.height;
          const dw = dst.canvas.width;
          const dh = dst.canvas.height;
          if (sw !== dw || sh !== dh) {
            console.warn('mergeSelected: source/dest canvas size mismatch', { sid, sw, sh, dw, dh });
          }
          dst.ctx.save();
          dst.ctx.setTransform(1, 0, 0, 1, 0, 0);
          dst.ctx.globalCompositeOperation = 'source-over';
          dst.ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, dw, dh);
          dst.ctx.restore();
          updateCanvasTexture(dst.sprite);
        } catch (e) {
          console.error('mergeSelected draw failed', e);
        }

        try { src.sprite.destroy(); } catch {}
        this.runtimes.delete(sid);
      }
      useLayerStore.getState().deleteLayer(sid);
    }
    this.syncLayers(useLayerStore.getState().layers);
    useLayerStore.getState().setActiveLayer(target);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
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

  syncLayers(metas: LayerMeta[]): void {
    const ids = new Set(metas.map((m) => m.id));
    for (const id of [...this.runtimes.keys()]) {
      if (!ids.has(id)) {
        const rt = this.runtimes.get(id)!;
        rt.sprite.destroy();
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
    for (const meta of metas) {
      const rt = this.runtimes.get(meta.id);
      if (!rt) continue;
      rt.sprite.visible = meta.visible;
      this.layerRoot.addChild(rt.sprite);
    }
  }

  captureSnapshot(): DocumentSnapshot {
    const order = [...this.layerRoot.children] as Sprite[];
    const snaps: DocumentSnapshot = [];
    for (const spr of order) {
      const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
      if (!rt) continue;
      snaps.push({
        id: rt.id,
        data: rt.ctx.getImageData(0, 0, this.width, this.height),
      });
    }
    return snaps;
  }

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

  compositeToDataURL(): string {
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#ffffff"; 
    ctx.fillRect(0, 0, this.width, this.height);

    for (const spr of this.layerRoot.children as Sprite[]) {
      if (!spr.visible) continue;
      const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
      if (!rt) continue;
      ctx.drawImage(rt.canvas, 0, 0);
    }
    return c.toDataURL("image/png");
  }

  async exportAsBlob(format: string = "png", scale: number = 1): Promise<Blob | null> {
    return new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = this.width * scale;
      c.height = this.height * scale;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(null);
      
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff"; 
      ctx.fillRect(0, 0, this.width, this.height);

      for (const spr of this.layerRoot.children as Sprite[]) {
        if (!spr.visible) continue;
        const rt = Array.from(this.runtimes.values()).find((r) => r.sprite === spr);
        if (rt) ctx.drawImage(rt.canvas, 0, 0);
      }
      
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      c.toBlob((blob) => resolve(blob), mime, 0.95);
    });
  }

  private buildChecker(): void {
    const g = new Graphics();
    const cols = Math.ceil(this.width / CHECK_SIZE);
    const rows = Math.ceil(this.height / CHECK_SIZE);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const color = (i + j) % 2 === 0 ? CHECKER_DARK : CHECKER_LIGHT;
        g.rect(i * CHECK_SIZE, j * CHECK_SIZE, CHECK_SIZE, CHECK_SIZE).fill({ color });
      }
    }
    
    // TENTO ŘÁDEK PŘIDEJ ZPĚT: Nakreslí viditelný okraj papíru
    g.rect(0, 0, this.width, this.height).stroke({ width: 4, color: 0x475569 });
    
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

  private clampWorld(p: Point): Point {
    return {
      x: Math.min(this.width, Math.max(0, p.x)),
      y: Math.min(this.height, Math.max(0, p.y)),
    };
  }

  private pointerSample(e: PointerEvent, world: Point): PointerBrushSample {
    const w = this.clampWorld(world);
    return {
      x: w.x, y: w.y, t: performance.now(),
      pressure: Number.isFinite(e.pressure) ? e.pressure : 0.5,
      pointerType: e.pointerType || "mouse",
    };
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.app) return;
    e.preventDefault();

    let dx = e.deltaX;
    let dy = e.deltaY;
    
    if (e.deltaMode === 1) { dx *= 20; dy *= 20; } 
    else if (e.deltaMode === 2) { dx *= 50; dy *= 50; }

    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.app.renderer.events.mapPositionToPoint(this.pointerScratch, e.clientX, e.clientY);
      
      // Zjistíme, nad jakým bodem plátna myš zrovna stojí
      const worldPos = this.world.toLocal(this.pointerScratch);

      const zoomFactor = Math.exp(-dy * 0.005);
      this.zoom = Math.min(20, Math.max(0.05, this.zoom * zoomFactor));

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
    
    // SHORTCUTS: Funguje pro Windows (Ctrl) i Mac (Cmd)
    const isZ = e.key.toLowerCase() === 'z' || e.code === 'KeyZ';
    const isMod = e.ctrlKey || e.metaKey;

    if (isMod && isZ) {
      e.preventDefault();
      e.stopPropagation(); // Zabraňuje konfliktu s prohlížečem
      
      const history = useHistoryStore.getState();
      const app = useAppStore.getState();

      if (e.shiftKey) {
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

    // MOBILE UNDO: Klepnutí 2 prsty
    if (this.activePointers.size === 2) {
      this.drawing = false;
      this.stroking = false;
      this.panning = false;
      this.isPinching = true;

      const snap = useHistoryStore.getState().undo();
      if (snap) {
        this.restoreSnapshot(snap);
        useAppStore.getState().showNotification("Undo");
      }

      const pts = Array.from(this.activePointers.values());
      this.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.initialPinchZoom = this.zoom;

      this.initialPinchAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      this.initialPinchRotation = this.rotation;

      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
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
    
    // VÝHYBKA PRO SELECT TOOL
    if (tool === "select") {
      const ctx = this.getActiveCtx();
      // Pošleme kontext manažerovi, aby mohl lepit staré pixely
      this.selection.startSelection(world.x, world.y, this.zoom, ctx);
      
      // Nutno překreslit plátno (pro případ, že jsme právě přilepili starý výběr zpět)
      const rt = this.getActiveRuntime();
      if (rt) updateCanvasTexture(rt.sprite);
      
      return; 
    }

    const ctx = this.getActiveCtx();
    if (!ctx) return; // Pojistka, pokud není aktivní žádná vrstva

    this.drawing = true;
    this.stroking = true;
    const settings = this.getBrushSettings();
    this.brush.down(ctx, this.pointerSample(e, world), settings);
    const rt = this.getActiveRuntime();
    if (rt) updateCanvasTexture(rt.sprite);
    try { setImmediateMode(true); } catch {}
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.app) return;

    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Fyzický pinch zoom na obrazovce
    if (this.isPinching && this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const currentCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      const currentAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);

      if (this.initialPinchDist > 0) {
        const scale = currentDist / this.initialPinchDist;
        
        this.zoom = Math.min(20, Math.max(0.05, this.initialPinchZoom * scale));
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

    // TAŽENÍ MODRÉHO RÁMEČKU NEBO JEHO OBSAHU
    if (this.selection.isSelecting || this.selection.isMoving) {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.selection.updateSelection(world.x, world.y, this.zoom);
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
    this.brush.move(ctx, this.pointerSample(e, world), settings);
    const rt = this.getActiveRuntime();
    if (rt) updateCanvasTexture(rt.sprite);
  };

  private onLostPointerCapture = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) this.isPinching = false;
    if (this.panning) this.panning = false;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      this.isPinching = false;
    }

    if (this.panning) {
      this.panning = false;
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    // --- NOVÉ: UKONČENÍ VÝBĚRU A TAŽENÍ ---
    if (this.selection.isSelecting || this.selection.isMoving) {
      const activeCtx = this.getActiveCtx();
      this.selection.endSelection(activeCtx);
      
      // Důležité: Překreslíme vrstvu, protože jsme z ní vyřízli (nebo do ní vlepili) pixely
      const rt = this.getActiveRuntime();
      // Ensure any queued draws are flushed before updating texture
      try { flushDrawQueue(); } catch {}
      if (rt) updateCanvasTexture(rt.sprite);
      
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      return;
    }

    // --- ZBYTEK FUNKCE PRO KRESLENÍ ZŮSTÁVÁ ---
    if (this.drawing) {
      const ctx = this.getActiveCtx();
      const world = this.screenToWorld(e.clientX, e.clientY);
      if (ctx && this.stroking) {
        this.brush.flush(ctx, this.pointerSample(e, world), this.getBrushSettings());
        // Ensure flush draws are executed before we snapshot/update
        try { flushDrawQueue(); } catch {}
        const rt = this.getActiveRuntime();
        if (rt) updateCanvasTexture(rt.sprite);
      }
      this.drawing = false;
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      if (this.stroking) {
        this.stroking = false;
        this.onStrokeCommitted?.();
      }
      try { setImmediateMode(false); } catch {}
    }
  };

  onStrokeCommitted?: () => void;

  private getBrushSettings(): BrushSettings {
    const { 
      tool, brushSize, brushHardness, brushOpacity, color, 
      intensity, startTaper, endTaper, colorMix, brushStyle 
    } = useEditorStore.getState();
    
    // OPRAVA: Ochrana typu pro TypeScript. 
    // Pokud je tool "select", tváříme se jako "brush", aby TS nenadával.
    const safeTool = (tool === "select" ? "brush" : tool) as "brush" | "eraser";

    return brushSettingsForTool({ 
      size: brushSize, 
      hardness: brushHardness, 
      opacity: brushOpacity, 
      color,
      intensity, 
      startTaper, 
      endTaper, 
      colorMix,
      brushStyle 
    }, safeTool);
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

  public async activateEyedropper(): Promise<string | null> {
    if (!("EyeDropper" in window)) return null;
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