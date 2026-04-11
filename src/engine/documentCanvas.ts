import {
  Application,
  Container,
  Graphics,
  Point as PixiPoint,
  Sprite,
  Texture,
} from "pixi.js";
import {
  CHECKER_DARK,
  CHECKER_LIGHT,
} from "./artboardConfig";
import { useAppStore } from "../stores/appStore";
import { brushSettingsForTool, HighPerformanceBrushStroke } from "./brushEngine";
import type { BrushSettings, Point, PointerBrushSample } from "./brushTypes";
import type { LayerMeta } from "../stores/layerStore";
import type { DocumentSnapshot } from "../stores/historyStore";
import { useEditorStore } from "../stores/editorStore";
import { useLayerStore } from "../stores/layerStore";

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
  const src = sprite.texture.source;
  src.update();
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
  
  private drawing = false;
  private stroking = false;
  private brush = new HighPerformanceBrushStroke();
  private spaceHeld = false;
  private panning = false;
  private panPointerStart = { x: 0, y: 0 };
  private panWorldStart = { x: 0, y: 0 };
  private readonly pointerScratch = new PixiPoint();

  // --- MULTI-TOUCH STAV ---
  private activePointers = new Map<number, { x: number, y: number }>();
  private initialPinchDist = 1;
  private initialPinchZoom = 1;
  private initialPinchCenter = { x: 0, y: 0 };
  private initialPinchPan = { x: 0, y: 0 };
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
    document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault() }, { passive: false });
    this.host.appendChild(app.canvas as HTMLCanvasElement);

    this.buildChecker();
    this.boardRoot.addChild(this.checker);
    this.boardRoot.addChild(this.layerRoot);
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
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
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
        // OPRAVA TADY: Přidáno (this.width, this.height)
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

  exportAsBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = this.width;
      c.height = this.height;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(null);
      
      // Bílé pozadí
      ctx.fillStyle = "#ffffff"; 
      ctx.fillRect(0, 0, this.width, this.height);

      // Vykreslení všech viditelných vrstev
      for (const spr of this.layerRoot.children as Sprite[]) {
        if (!spr.visible) continue;
        const rt = [...this.runtimes.values()].find((r) => r.sprite === spr);
        if (!rt) continue;
        ctx.drawImage(rt.canvas, 0, 0);
      }
      
      // Převod na skutečný soubor (Blob) místo obřího textového řetězce
      c.toBlob((blob) => resolve(blob), "image/png");
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
    // OPRAVA OPTICKÉHO KLAMU: Přidáme jasný rámeček kolem celého plátna!
    g.rect(0, 0, this.width, this.height).stroke({ width: 2, color: 0x475569 });
    this.checker = g;
  }

  private applyWorldTransform(): void {
    this.world.position.set(this.pan.x, this.pan.y);
    this.world.scale.set(this.zoom);
  }

  private screenToWorld(clientX: number, clientY: number): Point {
    if (!this.app) return { x: 0, y: 0 };
    this.app.renderer.events.mapPositionToPoint(this.pointerScratch, clientX, clientY);
    return {
      x: (this.pointerScratch.x - this.pan.x) / this.zoom,
      y: (this.pointerScratch.y - this.pan.y) / this.zoom,
    };
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
      const sx = this.pointerScratch.x;
      const sy = this.pointerScratch.y;
      const beforeX = (sx - this.pan.x) / this.zoom;
      const beforeY = (sy - this.pan.y) / this.zoom;

      const zoomFactor = Math.exp(-dy * 0.005);
      const nextZoom = Math.min(20, Math.max(0.05, this.zoom * zoomFactor));

      this.zoom = nextZoom;
      this.pan.x = sx - beforeX * this.zoom;
      this.pan.y = sy - beforeY * this.zoom;
    } else {
      if (e.shiftKey && dx === 0) this.pan.x -= dy;
      else { this.pan.x -= dx; this.pan.y -= dy; }
    }
    this.applyWorldTransform();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space") this.spaceHeld = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") this.spaceHeld = false;
  };

  // --- OPRAVA MULTI-TOUCH A PINCH ZOOMU ---
  private onPointerDown = (e: PointerEvent): void => {
    if (!this.app) return;
    try { (this.app.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Pokud se dotknou 2 prsty, aktivuj Multi-Touch Zoom a přeruš kreslení
    if (this.activePointers.size === 2) {
      this.drawing = false;
      this.stroking = false;
      this.panning = false;
      this.isPinching = true;

      const pts = Array.from(this.activePointers.values());
      this.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.initialPinchZoom = this.zoom;
      this.initialPinchCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this.initialPinchPan = { ...this.pan };
      return;
    } else if (this.activePointers.size > 2) {
      return;
    }

    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      this.panning = true;
      this.panPointerStart = { x: e.clientX, y: e.clientY };
      this.panWorldStart = { ...this.pan };
      return;
    }

    if (this.isPinching || e.button !== 0) return;

    const world = this.screenToWorld(e.clientX, e.clientY);
    const ctx = this.getActiveCtx();
    if (!ctx) return;

    this.drawing = true;
    this.stroking = true;
    const settings = this.getBrushSettings();
    this.brush.down(ctx, this.pointerSample(e, world), settings);
    const rt = this.getActiveRuntime();
    if (rt) updateCanvasTexture(rt.sprite);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Fyzický pinch zoom na obrazovce
    if (this.isPinching && this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const currentCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      if (this.initialPinchDist > 0) {
        const scale = currentDist / this.initialPinchDist;
        const nextZoom = Math.min(20, Math.max(0.05, this.initialPinchZoom * scale));
        const ratio = nextZoom / this.initialPinchZoom;
        
        this.zoom = nextZoom;
        this.pan.x = currentCenter.x - (this.initialPinchCenter.x - this.initialPinchPan.x) * ratio;
        this.pan.y = currentCenter.y - (this.initialPinchCenter.y - this.initialPinchPan.y) * ratio;
        this.applyWorldTransform();
      }
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

    if (this.drawing) {
      const ctx = this.getActiveCtx();
      const world = this.screenToWorld(e.clientX, e.clientY);
      if (ctx && this.stroking) {
        this.brush.flush(ctx, this.pointerSample(e, world), this.getBrushSettings());
        const rt = this.getActiveRuntime();
        if (rt) updateCanvasTexture(rt.sprite);
      }
      this.drawing = false;
      try { (this.app?.canvas as HTMLCanvasElement)?.releasePointerCapture(e.pointerId); } catch {}
      if (this.stroking) {
        this.stroking = false;
        this.onStrokeCommitted?.();
      }
    }
  };

  onStrokeCommitted?: () => void;

  private getBrushSettings(): BrushSettings {
    const { 
      tool, brushSize, brushHardness, brushOpacity, color, 
      intensity, startTaper, endTaper, colorMix, brushStyle 
    } = useEditorStore.getState();
    
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
    }, tool);
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