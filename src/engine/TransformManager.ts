import { Container, Graphics, MeshSimple, PerspectiveMesh, Rectangle, Texture, type Renderer } from "pixi.js";

export type TransformMode = "translate" | "scale" | "perspective" | "mesh";

export type TransformBounds = { x: number; y: number; w: number; h: number };

type SourceLayer = {
  layerId: string;
  /** The pristine (pre-transform) snapshot, used to (re)build the texture and to restore the real layer on cancel. Never mutated after capture. */
  snapshot: HTMLCanvasElement;
  texture: Texture;
  mesh: PerspectiveMesh | MeshSimple;
};

type HandleKind =
  | { kind: "body" }
  | { kind: "corner"; index: 0 | 1 | 2 | 3 } // 0=TL,1=TR,2=BR,3=BL, in the OUTER quad regardless of subdivision
  | { kind: "edge"; index: 0 | 1 | 2 | 3 } // 0=top,1=right,2=bottom,3=left midpoints
  | { kind: "rotate" }
  | { kind: "meshPoint"; index: number }
  | null;

const ROTATE_HANDLE_DIST = 30;
const HANDLE_SIZE = 12;

/**
 * ibisPaint-style Transform tool: a single bounding-quad overlay that switches
 * behavior between four modes (see `TransformMode`) while sharing ONE
 * underlying representation — `points`, a flat, row-major grid of
 * `(divisionsX+1) * (divisionsY+1)` world-space (x,y) pairs. This is the
 * "compose across modes, don't discard" requirement made structural rather
 * than a rule to remember: every mode just moves points that are already
 * there.
 * - Translate: adds the same delta to every point.
 * - Scale/Rotate: scales/rotates every point about a pivot (the quad's own
 *   center — draggable pivot is a deferred nice-to-have, not v1).
 * - Perspective: moves one of the 4 OUTER corner points independently, with
 *   NO constraint — arbitrary quad. Rendered via Pixi's own `PerspectiveMesh`
 *   (true projective/homography interpolation, not a triangulated affine
 *   approximation — straight lines inside the content stay straight), which
 *   is only usable while the grid is still a plain 1x1 quad (its whole API is
 *   "4 corners in, projected texture out").
 * - Mesh: subdivides the grid (`setDivisions`) and every intersection becomes
 *   independently draggable, rendered via `MeshSimple` (a triangulated grid —
 *   correct per-cell affine mapping, not true per-cell perspective, which is
 *   the documented "good enough" tradeoff once the grid is finer than 1x1).
 *
 * Live preview is genuinely non-destructive: `start()` snapshots each source
 * layer's content, clears that same region from the REAL layer immediately
 * (so there's no double-vision between the untouched original and the
 * floating preview — same reasoning as `SelectionManager`'s eager cut), and
 * the transformed result only gets written back to real pixels on `apply()`
 * (via `renderer.extract`, reusing the exact GPU-rendered preview as the
 * source of truth for the final pixels — WYSIWYG by construction, no need to
 * hand-roll homography/bilinear resampling separately). `cancel()` restores
 * the untouched snapshot back to its original spot.
 */
export class TransformManager {
  public container = new Container();
  private meshLayer = new Container();
  private handleGfx = new Graphics();

  public mode: TransformMode = "translate";
  public divisionsX = 1;
  public divisionsY = 1;
  public active = false;

  private sources: SourceLayer[] = [];
  private originalBounds: TransformBounds | null = null;
  private points: Float32Array = new Float32Array(0);
  private uvs: Float32Array = new Float32Array(0);
  private indices: Uint32Array = new Uint32Array(0);
  /** Rotation (radians) baked into the INITIAL quad by `startFromExtracted` (carried over from a rotated Select-tool floating selection) — `start()`'s own sessions are never rotated. Tracked separately from `points` because Translate mode's own CPU-side bake (see `apply()`) needs to know the shape's fixed rotation independent of whatever the live point grid currently looks like. */
  private bakedInRotation = 0;
  /** Whether `sources`' current meshes have been through at least one real Pixi frame — set by `confirmRenderOnNextFrame()`. Gates the risky `renderer.extract`/`renderer.render` calls in `apply()`: calling either on a mesh that's never been rendered normally throws deep in Pixi's WebGL backend, and — confirmed live — can leave the RENDERER itself unable to produce further frames afterward (not just this manager stuck), which is worse than just this one edit failing. See `apply()`'s own doc comment. */
  private meshRenderConfirmed = false;
  private renderConfirmToken = 0;

  // Gesture state
  private dragHandle: HandleKind = null;
  private dragStartWorld: { x: number; y: number } | null = null;
  private dragStartPoints: Float32Array | null = null;
  private dragPivot: { x: number; y: number } | null = null;
  private dragStartAngle = 0;

  constructor() {
    this.container.addChild(this.meshLayer);
    this.container.addChild(this.handleGfx);
  }

  /** The outer quad's 4 corner point INDICES into `points` for the current subdivision — always the 4 extremes of the grid regardless of how finely it's subdivided. */
  private cornerIndices(): [number, number, number, number] {
    const cols = this.divisionsX + 1;
    const rows = this.divisionsY + 1;
    return [0, cols - 1, cols * rows - 1, cols * (rows - 1)]; // TL, TR, BR, BL
  }

  private pointAt(i: number): { x: number; y: number } {
    return { x: this.points[i * 2], y: this.points[i * 2 + 1] };
  }
  private setPointAt(i: number, x: number, y: number): void {
    this.points[i * 2] = x;
    this.points[i * 2 + 1] = y;
  }

  private buildUvs(divX: number, divY: number): Float32Array {
    const cols = divX + 1, rows = divY + 1;
    const uv = new Float32Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        uv[i * 2] = c / divX;
        uv[i * 2 + 1] = r / divY;
      }
    }
    return uv;
  }

  private buildIndices(divX: number, divY: number): Uint32Array {
    const cols = divX + 1;
    const idx: number[] = [];
    for (let r = 0; r < divY; r++) {
      for (let c = 0; c < divX; c++) {
        const i0 = r * cols + c;
        const i1 = i0 + 1;
        const i2 = i0 + cols;
        const i3 = i2 + 1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
    return new Uint32Array(idx);
  }

  /** Resets `meshRenderConfirmed` to false, then flips it true once a real animation frame has elapsed — a mesh just added to the live scene graph needs to go through Pixi's own normal ticker-driven render at least once before it's safe to touch with `renderer.render`/`renderer.extract` (see `apply()`). Called whenever brand-new mesh objects are created (`start`, `startFromExtracted`, `rebuildMeshes`). */
  private confirmRenderOnNextFrame(): void {
    this.meshRenderConfirmed = false;
    const token = ++this.renderConfirmToken;
    requestAnimationFrame(() => {
      if (token === this.renderConfirmToken) this.meshRenderConfirmed = true;
    });
  }

  private resetPointsToBounds(bounds: TransformBounds, divX: number, divY: number): Float32Array {
    const cols = divX + 1, rows = divY + 1;
    const pts = new Float32Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        pts[i * 2] = bounds.x + (bounds.w * c) / divX;
        pts[i * 2 + 1] = bounds.y + (bounds.h * r) / divY;
      }
    }
    return pts;
  }

  /** Bilinearly resamples `oldPoints` (a divX0 x divY0 grid over the SAME logical unit square) onto a new divX1 x divY1 resolution — used when mesh divisions change after the user has already warped points, so re-subdividing doesn't discard existing work (see the class doc comment). */
  private resamplePoints(oldPoints: Float32Array, divX0: number, divY0: number, divX1: number, divY1: number): Float32Array {
    const cols0 = divX0 + 1, rows0 = divY0 + 1;
    const cols1 = divX1 + 1, rows1 = divY1 + 1;
    const out = new Float32Array(cols1 * rows1 * 2);
    const at = (c: number, r: number) => {
      const i = (Math.min(rows0 - 1, Math.max(0, r)) * cols0 + Math.min(cols0 - 1, Math.max(0, c))) * 2;
      return { x: oldPoints[i], y: oldPoints[i + 1] };
    };
    for (let r = 0; r < rows1; r++) {
      const v = (r / divY1) * divY0;
      const r0 = Math.floor(v), r1 = Math.min(rows0 - 1, r0 + 1), fr = v - r0;
      for (let c = 0; c < cols1; c++) {
        const u = (c / divX1) * divX0;
        const c0 = Math.floor(u), c1 = Math.min(cols0 - 1, c0 + 1), fc = u - c0;
        const p00 = at(c0, r0), p10 = at(c1, r0), p01 = at(c0, r1), p11 = at(c1, r1);
        const topX = p00.x * (1 - fc) + p10.x * fc, topY = p00.y * (1 - fc) + p10.y * fc;
        const botX = p01.x * (1 - fc) + p11.x * fc, botY = p01.y * (1 - fc) + p11.y * fc;
        const i = (r * cols1 + c) * 2;
        out[i] = topX * (1 - fr) + botX * fr;
        out[i + 1] = topY * (1 - fr) + botY * fr;
      }
    }
    return out;
  }

  /** Starts a new transform session over one or more source layers, all sharing `bounds` as their initial quad. Clears `bounds` from each real layer immediately (eager, non-destructive-until-cancel — see class doc comment). */
  public start(
    layers: { layerId: string; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[],
    bounds: TransformBounds,
    zoom: number,
  ): void {
    this.cancelInternal(false);
    this.originalBounds = { ...bounds };
    this.bakedInRotation = 0;
    this.divisionsX = 1;
    this.divisionsY = 1;
    this.points = this.resetPointsToBounds(bounds, 1, 1);

    for (const layer of layers) {
      const w = Math.max(1, Math.round(bounds.w));
      const h = Math.max(1, Math.round(bounds.h));
      const snap = document.createElement("canvas");
      snap.width = w;
      snap.height = h;
      const sctx = snap.getContext("2d")!;
      sctx.drawImage(layer.canvas, bounds.x, bounds.y, w, h, 0, 0, w, h);

      layer.ctx.clearRect(bounds.x, bounds.y, w, h);

      const texture = Texture.from(snap);
      const mesh = this.makePerspectiveMesh(texture, this.points);
      this.meshLayer.addChild(mesh);
      this.sources.push({ layerId: layer.layerId, snapshot: snap, texture, mesh });
    }

    this.active = true;
    this.confirmRenderOnNextFrame();
    this.draw(zoom);
  }

  /**
   * Selection-bound entry point: `canvas` is ALREADY the exact extracted
   * (and, for a lasso, already alpha-masked to its outline) content —
   * `SelectionManager.takeFloatingContent()`'s own output — and the real
   * layer has ALREADY had `bounds` cleared (SelectionManager did that the
   * moment the selection was first cut). Unlike `start()`, this must NOT
   * re-crop or re-clear anything — the content handed in IS the source,
   * verbatim. `initialRotation` (radians) carries over whatever rotation the
   * Select tool's own handle had already applied, so switching from Select
   * to Transform mid-gesture doesn't silently drop it.
   */
  public startFromExtracted(
    layerId: string,
    canvas: HTMLCanvasElement,
    bounds: TransformBounds,
    zoom: number,
    initialRotation = 0,
  ): void {
    this.cancelInternal(false);
    this.originalBounds = { ...bounds };
    this.bakedInRotation = initialRotation;
    this.divisionsX = 1;
    this.divisionsY = 1;
    this.points = this.resetPointsToBounds(bounds, 1, 1);
    if (initialRotation) {
      const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
      const cos = Math.cos(initialRotation), sin = Math.sin(initialRotation);
      for (let i = 0; i < this.points.length; i += 2) {
        const rx = this.points[i] - cx, ry = this.points[i + 1] - cy;
        this.points[i] = cx + rx * cos - ry * sin;
        this.points[i + 1] = cy + rx * sin + ry * cos;
      }
    }

    const texture = Texture.from(canvas);
    const mesh = this.makePerspectiveMesh(texture, this.points);
    this.meshLayer.addChild(mesh);
    this.sources.push({ layerId, snapshot: canvas, texture, mesh });

    this.active = true;
    this.confirmRenderOnNextFrame();
    this.draw(zoom);
  }

  private makePerspectiveMesh(texture: Texture, points: Float32Array): PerspectiveMesh {
    return new PerspectiveMesh({
      texture,
      verticesX: 20,
      verticesY: 20,
      ...this.cornerXY(points),
    });
  }

  /**
   * `points` is stored row-major (TL, TR, ..., BL, ..., BR — the order a
   * grid naturally fills in), but `PerspectiveMesh`/`setCorners` needs its 4
   * corners specifically in CLOCKWISE order starting top-left (TL, TR, BR,
   * BL). For anything bigger than a 1x1 grid these are genuinely different
   * orderings (row-major's 3rd point is bottom-LEFT, not bottom-right) —
   * reading the array positionally as if they already matched produced a
   * self-intersecting "bowtie" quad instead of a rectangle (confirmed live:
   * the whole canvas rendered as a giant crossed hourglass shape). Always go
   * through `cornerIndices()` rather than assuming array order.
   */
  private cornerXY(points: Float32Array): { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number } {
    const [tl, tr, br, bl] = this.cornerIndices();
    return {
      x0: points[tl * 2], y0: points[tl * 2 + 1],
      x1: points[tr * 2], y1: points[tr * 2 + 1],
      x2: points[br * 2], y2: points[br * 2 + 1],
      x3: points[bl * 2], y3: points[bl * 2 + 1],
    };
  }

  private makeSimpleMesh(texture: Texture, points: Float32Array, uvs: Float32Array, indices: Uint32Array): MeshSimple {
    return new MeshSimple({ texture, vertices: points.slice(), uvs, indices, topology: "triangle-list" });
  }

  /** Rebuilds every source's Pixi mesh object from scratch — needed whenever switching between the 1x1 (PerspectiveMesh) and subdivided (MeshSimple) representations, since they're different Pixi classes. Cheap relative to a drag gesture (only called on mode/division changes, not per pointer-move). */
  private rebuildMeshes(): void {
    const useSimple = this.divisionsX > 1 || this.divisionsY > 1;
    for (const src of this.sources) {
      this.meshLayer.removeChild(src.mesh);
      try { src.mesh.destroy(); } catch { /* ignore */ }
      src.mesh = useSimple
        ? this.makeSimpleMesh(src.texture, this.points, this.uvs, this.indices)
        : this.makePerspectiveMesh(src.texture, this.points);
      this.meshLayer.addChild(src.mesh);
    }
    this.confirmRenderOnNextFrame();
  }

  private syncMeshesToPoints(): void {
    for (const src of this.sources) {
      if (src.mesh instanceof PerspectiveMesh) {
        const c = this.cornerXY(this.points);
        src.mesh.setCorners(c.x0, c.y0, c.x1, c.y1, c.x2, c.y2, c.x3, c.y3);
      } else {
        (src.mesh as MeshSimple).vertices = this.points;
      }
    }
  }

  /** Changes mesh subdivision (Mesh mode's X/Y division steppers). Bilinearly resamples the CURRENT point grid onto the new resolution rather than resetting to a flat rectangle, so prior warping survives a division-count change (see `resamplePoints`). Switches between PerspectiveMesh/MeshSimple as needed. */
  public setDivisions(divX: number, divY: number, zoom: number): void {
    divX = Math.max(1, Math.round(divX));
    divY = Math.max(1, Math.round(divY));
    if (divX === this.divisionsX && divY === this.divisionsY) return;
    this.points = this.resamplePoints(this.points, this.divisionsX, this.divisionsY, divX, divY);
    this.divisionsX = divX;
    this.divisionsY = divY;
    this.uvs = this.buildUvs(divX, divY);
    this.indices = this.buildIndices(divX, divY);
    this.rebuildMeshes();
    this.draw(zoom);
  }

  public setMode(mode: TransformMode, zoom: number): void {
    this.mode = mode;
    this.draw(zoom);
  }

  private currentCenter(): { x: number; y: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.points.length; i += 2) {
      minX = Math.min(minX, this.points[i]);
      maxX = Math.max(maxX, this.points[i]);
      minY = Math.min(minY, this.points[i + 1]);
      maxY = Math.max(maxY, this.points[i + 1]);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  /** Axis-aligned bounding box of the CURRENT (possibly moved/scaled/warped) point set — used at apply() time to know where to extract/draw the transformed result, which generally differs from `originalBounds` (where the content used to be). */
  private currentBoundingBox(): TransformBounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.points.length; i += 2) {
      minX = Math.min(minX, this.points[i]);
      maxX = Math.max(maxX, this.points[i]);
      minY = Math.min(minY, this.points[i + 1]);
      maxY = Math.max(maxY, this.points[i + 1]);
    }
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  // --- Hit testing -----------------------------------------------------

  public hitTest(worldX: number, worldY: number, zoom: number): HandleKind {
    if (!this.active) return null;
    const tol = HANDLE_SIZE / zoom;
    const corners = this.cornerIndices().map((i) => this.pointAt(i));

    if (this.mode === "scale") {
      const rotHandle = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 - ROTATE_HANDLE_DIST / zoom };
      if (Math.hypot(worldX - rotHandle.x, worldY - rotHandle.y) <= tol) return { kind: "rotate" };
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(worldX - corners[i].x, worldY - corners[i].y) <= tol) return { kind: "corner", index: i as 0 | 1 | 2 | 3 };
      }
      const edgeMids = [
        { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
        { x: (corners[1].x + corners[2].x) / 2, y: (corners[1].y + corners[2].y) / 2 },
        { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 },
        { x: (corners[3].x + corners[0].x) / 2, y: (corners[3].y + corners[0].y) / 2 },
      ];
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(worldX - edgeMids[i].x, worldY - edgeMids[i].y) <= tol) return { kind: "edge", index: i as 0 | 1 | 2 | 3 };
      }
      if (this.pointInQuad(worldX, worldY, corners)) return { kind: "body" };
      return null;
    }

    if (this.mode === "perspective") {
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(worldX - corners[i].x, worldY - corners[i].y) <= tol) return { kind: "corner", index: i as 0 | 1 | 2 | 3 };
      }
      if (this.pointInQuad(worldX, worldY, corners)) return { kind: "body" };
      return null;
    }

    if (this.mode === "mesh") {
      const n = this.points.length / 2;
      for (let i = 0; i < n; i++) {
        const p = this.pointAt(i);
        if (Math.hypot(worldX - p.x, worldY - p.y) <= tol) return { kind: "meshPoint", index: i };
      }
      return null;
    }

    // translate
    if (this.pointInQuad(worldX, worldY, corners)) return { kind: "body" };
    return null;
  }

  private pointInQuad(x: number, y: number, corners: { x: number; y: number }[]): boolean {
    // Standard point-in-polygon (ray casting) — correct for the possibly-
    // rotated/skewed/perspective quad, unlike an axis-aligned bounds check.
    let inside = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const xi = corners[i].x, yi = corners[i].y;
      const xj = corners[j].x, yj = corners[j].y;
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // --- Gesture lifecycle -------------------------------------------------

  public beginDrag(worldX: number, worldY: number, zoom: number): boolean {
    const hit = this.hitTest(worldX, worldY, zoom);
    if (!hit) return false;
    this.dragHandle = hit;
    this.dragStartWorld = { x: worldX, y: worldY };
    this.dragStartPoints = this.points.slice();
    this.dragPivot = this.currentCenter();
    if (hit.kind === "rotate") {
      this.dragStartAngle = Math.atan2(worldY - this.dragPivot.y, worldX - this.dragPivot.x);
    }
    return true;
  }

  public updateDrag(worldX: number, worldY: number, zoom: number, shiftKey: boolean): void {
    if (!this.dragHandle || !this.dragStartWorld || !this.dragStartPoints || !this.dragPivot) return;
    const dx = worldX - this.dragStartWorld.x;
    const dy = worldY - this.dragStartWorld.y;
    const start = this.dragStartPoints;
    const pivot = this.dragPivot;

    if (this.dragHandle.kind === "body" && this.mode === "translate") {
      for (let i = 0; i < this.points.length; i += 2) {
        this.points[i] = start[i] + dx;
        this.points[i + 1] = start[i + 1] + dy;
      }
    } else if (this.dragHandle.kind === "rotate") {
      const angle = Math.atan2(worldY - pivot.y, worldX - pivot.x) - this.dragStartAngle;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (let i = 0; i < this.points.length; i += 2) {
        const rx = start[i] - pivot.x, ry = start[i + 1] - pivot.y;
        this.points[i] = pivot.x + rx * cos - ry * sin;
        this.points[i + 1] = pivot.y + rx * sin + ry * cos;
      }
    } else if (this.dragHandle.kind === "corner" && this.mode === "scale") {
      const idx = this.cornerIndices()[this.dragHandle.index];
      const startCorner = { x: start[idx * 2], y: start[idx * 2 + 1] };
      const refX = startCorner.x - pivot.x, refY = startCorner.y - pivot.y;
      const curX = worldX - pivot.x, curY = worldY - pivot.y;
      let sx = Math.abs(refX) > 1e-3 ? curX / refX : 1;
      let sy = Math.abs(refY) > 1e-3 ? curY / refY : 1;
      if (shiftKey) {
        const s = Math.max(Math.abs(sx), Math.abs(sy)) * (sx < 0 || sy < 0 ? -1 : 1);
        sx = s; sy = s;
      }
      this.applyScale(start, pivot, sx, sy);
    } else if (this.dragHandle.kind === "edge" && this.mode === "scale") {
      const horizontal = this.dragHandle.index === 1 || this.dragHandle.index === 3; // right/left edges scale X only
      const cornerIdx = this.cornerIndices()[horizontal ? (this.dragHandle.index === 1 ? 1 : 3) : (this.dragHandle.index === 0 ? 1 : 2)];
      const startCorner = { x: start[cornerIdx * 2], y: start[cornerIdx * 2 + 1] };
      let sx = 1, sy = 1;
      if (horizontal) {
        const ref = startCorner.x - pivot.x;
        sx = Math.abs(ref) > 1e-3 ? (worldX - pivot.x) / ref : 1;
      } else {
        const ref = startCorner.y - pivot.y;
        sy = Math.abs(ref) > 1e-3 ? (worldY - pivot.y) / ref : 1;
      }
      this.applyScale(start, pivot, sx, sy);
    } else if (this.dragHandle.kind === "corner" && this.mode === "perspective") {
      const idx = this.cornerIndices()[this.dragHandle.index];
      this.setPointAt(idx, worldX, worldY);
    } else if (this.dragHandle.kind === "meshPoint") {
      this.setPointAt(this.dragHandle.index, start[this.dragHandle.index * 2] + dx, start[this.dragHandle.index * 2 + 1] + dy);
    }

    this.syncMeshesToPoints();
    this.draw(zoom);
  }

  private applyScale(start: Float32Array, pivot: { x: number; y: number }, sx: number, sy: number): void {
    for (let i = 0; i < this.points.length; i += 2) {
      this.points[i] = pivot.x + (start[i] - pivot.x) * sx;
      this.points[i + 1] = pivot.y + (start[i + 1] - pivot.y) * sy;
    }
  }

  public endDrag(): void {
    this.dragHandle = null;
    this.dragStartWorld = null;
    this.dragStartPoints = null;
    this.dragPivot = null;
  }

  public isDragging(): boolean {
    return this.dragHandle !== null;
  }

  // --- Rendering -----------------------------------------------------

  public draw(zoom: number): void {
    this.handleGfx.clear();
    if (!this.active) return;
    const corners = this.cornerIndices().map((i) => this.pointAt(i));
    const strokeWidth = 2 / zoom;

    this.handleGfx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) this.handleGfx.lineTo(corners[i].x, corners[i].y);
    this.handleGfx.closePath();
    this.handleGfx.stroke({ color: 0x0088ff, width: strokeWidth });

    const handleSize = HANDLE_SIZE / zoom;
    const drawHandle = (hx: number, hy: number, round = false) => {
      if (round) this.handleGfx.circle(hx, hy, handleSize / 2);
      else this.handleGfx.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      this.handleGfx.fill({ color: 0xffffff });
      this.handleGfx.stroke({ color: 0x0088ff, width: strokeWidth / 2 });
    };

    if (this.mode === "mesh") {
      // Interior grid lines + every draggable point.
      const cols = this.divisionsX + 1, rows = this.divisionsY + 1;
      for (let r = 0; r < rows; r++) {
        this.handleGfx.moveTo(this.points[(r * cols) * 2], this.points[(r * cols) * 2 + 1]);
        for (let c = 1; c < cols; c++) {
          const i = r * cols + c;
          this.handleGfx.lineTo(this.points[i * 2], this.points[i * 2 + 1]);
        }
      }
      for (let c = 0; c < cols; c++) {
        this.handleGfx.moveTo(this.points[c * 2], this.points[c * 2 + 1]);
        for (let r = 1; r < rows; r++) {
          const i = r * cols + c;
          this.handleGfx.lineTo(this.points[i * 2], this.points[i * 2 + 1]);
        }
      }
      this.handleGfx.stroke({ color: 0x0088ff, width: strokeWidth * 0.6 });
      for (let i = 0; i < cols * rows; i++) {
        const p = this.pointAt(i);
        drawHandle(p.x, p.y, true);
      }
    } else if (this.mode === "perspective") {
      for (const c of corners) drawHandle(c.x, c.y);
    } else if (this.mode === "scale") {
      for (const c of corners) drawHandle(c.x, c.y);
      const edgeMids = [
        { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
        { x: (corners[1].x + corners[2].x) / 2, y: (corners[1].y + corners[2].y) / 2 },
        { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 },
        { x: (corners[3].x + corners[0].x) / 2, y: (corners[3].y + corners[0].y) / 2 },
      ];
      for (const m of edgeMids) drawHandle(m.x, m.y);
      const rotDist = ROTATE_HANDLE_DIST / zoom;
      const topMid = edgeMids[0];
      const handlePos = { x: topMid.x, y: topMid.y - rotDist };
      this.handleGfx.moveTo(topMid.x, topMid.y);
      this.handleGfx.lineTo(handlePos.x, handlePos.y);
      this.handleGfx.stroke({ color: 0x0088ff, width: strokeWidth });
      drawHandle(handlePos.x, handlePos.y, true);
    }
    // translate mode: just the outline, no handles — drag anywhere inside.
  }

  // --- Apply / cancel -----------------------------------------------------

  /**
   * Bakes the current transform into every source layer's real pixel data.
   * Returns the affected layer ids, or `null` if there was nothing active to
   * apply. Two distinct real bugs were found and fixed here (both
   * contributed to the reported "I cant confirm anything I do with the
   * translate tool... Apply doesnt work either and overall I cant use the
   * whole canvas after doin any changes" — see below for which did what):
   *
   * 1. Translate mode is now baked by hand via plain Canvas2D, straight from
   *    each source's pristine (pre-session) snapshot — never through Pixi's
   *    GPU extract path at all. A pure translate never changes the content's
   *    shape (only its position, computed here from how far the shared
   *    centroid moved — see `currentCenter()` — which stays correct even if
   *    the quad carries a baked-in rotation from a rotated Select-tool
   *    selection), so Canvas2D can reproduce it exactly, with zero GPU
   *    involvement. This is the mode the bug was reported against, so it
   *    gets the unconditionally-safe path, sidestepping bug #2 below
   *    entirely for the common case.
   *
   * 2. Scale/Perspective/Mesh genuinely need the GPU (true projective/
   *    per-cell warp), so those still go through `renderer.extract.canvas`
   *    on the live preview mesh — but ONLY once `meshRenderConfirmed` is
   *    true (Pixi's own ticker has actually rendered this session's mesh
   *    through a normal frame at least once). Calling `renderer.extract` on
   *    a mesh that's never been through a real frame throws deep in Pixi's
   *    WebGL backend (`BindGroup.setResource` reading a null resource
   *    array) — confirmed live, reliably reproducible for a session created
   *    by the auto-restart in `DocumentCanvas.applyTransform`/
   *    `cancelTransform` when the user applies/cancels again before the
   *    next animation frame paints. Falls back to restoring the pristine
   *    snapshot (same as Cancel) instead — losing one edit to a rare timing
   *    race is an acceptable degraded outcome.
   *
   * A THIRD, separate and initially-confusing bug (not in this method, but
   * directly caused the "whole canvas frozen" half of the report and is
   * worth flagging here since it looks related): `teardown()` used to call
   * `src.texture.destroy(true)`, cascading into destroying the texture's
   * underlying GPU resource. That call alone — independent of the two bugs
   * above, reproducible even in a pure-Translate session that never touches
   * `renderer.extract`/`renderer.render` at all — left Pixi's renderer
   * unable to paint any further frames: the ticker kept reporting itself as
   * running (`started: true`, normal FPS) against an otherwise-correct scene
   * graph, but the visible canvas simply stopped updating, silently, with
   * no thrown error anywhere. Fixed in `teardown()` by calling `destroy()`
   * with no argument (Pixi's own default is `destroySource: false`).
   *
   * `teardown()` always runs in a `finally`: this manager must never be left
   * `active` with its own preview mesh/handles still on screen after
   * `apply()` returns, since that mesh renders on top of the whole board
   * (see `DocumentCanvas.init()`'s child-add order).
   */
  public apply(renderer: Renderer): string[] | null {
    if (!this.active || !this.sources.length) {
      this.cancelInternal(false);
      return null;
    }
    const box = this.currentBoundingBox();
    const frame = new Rectangle(box.x, box.y, box.w, box.h);
    const affected: string[] = [];
    try {
      for (const src of this.sources) {
        const rt = this.layerRuntimeById(src.layerId);
        if (!rt) continue;

        if (this.mode === "translate" && this.originalBounds) {
          this.bakeTranslateViaCanvas2D(src, rt, this.originalBounds);
          affected.push(src.layerId);
          continue;
        }

        if (this.meshRenderConfirmed) {
          try {
            const extracted = renderer.extract.canvas({ target: src.mesh, frame });
            rt.ctx.drawImage(extracted as unknown as CanvasImageSource, box.x, box.y);
            affected.push(src.layerId);
            continue;
          } catch (err) {
            console.error("Transform apply: extract failed for a layer, restoring its pre-transform pixels instead of losing them", err);
          }
        }

        // Not yet safe to touch the GPU (or extraction failed anyway) —
        // restore this source's own pristine pixels rather than leave its
        // already-cleared region blank or risk the renderer-corrupting
        // crash described above.
        if (this.originalBounds) {
          rt.ctx.clearRect(this.originalBounds.x, this.originalBounds.y, this.originalBounds.w, this.originalBounds.h);
          rt.ctx.drawImage(src.snapshot, this.originalBounds.x, this.originalBounds.y);
        }
      }
    } finally {
      this.teardown();
    }
    return affected;
  }

  /** Draws `src.snapshot` (its pristine, pre-session pixels) back into `rt.ctx` shifted by however far the shared centroid has moved since `origBounds`, preserving whatever rotation was baked in at session start (see `bakedInRotation`'s own doc comment). Correct for ANY translate-mode session because a pure translate never changes shape — only position. */
  private bakeTranslateViaCanvas2D(src: SourceLayer, rt: { ctx: CanvasRenderingContext2D }, origBounds: TransformBounds): void {
    const origCenter = { x: origBounds.x + origBounds.w / 2, y: origBounds.y + origBounds.h / 2 };
    const curCenter = this.currentCenter();
    if (this.bakedInRotation) {
      rt.ctx.save();
      rt.ctx.translate(curCenter.x, curCenter.y);
      rt.ctx.rotate(this.bakedInRotation);
      rt.ctx.drawImage(src.snapshot, -origBounds.w / 2, -origBounds.h / 2, origBounds.w, origBounds.h);
      rt.ctx.restore();
    } else {
      const dx = curCenter.x - origCenter.x, dy = curCenter.y - origCenter.y;
      rt.ctx.drawImage(src.snapshot, origBounds.x + dx, origBounds.y + dy);
    }
  }

  /** Looks up a layer's runtime by id — set by DocumentCanvas right before apply() via `bindRuntimeLookup`, since TransformManager doesn't own the runtime map itself. */
  private layerRuntimeById(id: string): { ctx: CanvasRenderingContext2D } | undefined {
    return this.runtimeLookup?.(id);
  }
  private runtimeLookup: ((id: string) => { ctx: CanvasRenderingContext2D } | undefined) | null = null;
  public bindRuntimeLookup(fn: (id: string) => { ctx: CanvasRenderingContext2D } | undefined): void {
    this.runtimeLookup = fn;
  }

  /** Discards the whole session, restoring every source layer's original (untouched) pixels — the transform never happened, from the layer's point of view. */
  public cancel(): void {
    this.cancelInternal(true);
  }

  private cancelInternal(restore: boolean): void {
    if (restore && this.originalBounds) {
      for (const src of this.sources) {
        const rt = this.layerRuntimeById(src.layerId);
        if (rt) {
          rt.ctx.clearRect(this.originalBounds.x, this.originalBounds.y, this.originalBounds.w, this.originalBounds.h);
          rt.ctx.drawImage(src.snapshot, this.originalBounds.x, this.originalBounds.y);
        }
      }
    }
    this.teardown();
  }

  private teardown(): void {
    for (const src of this.sources) {
      this.meshLayer.removeChild(src.mesh);
      try { src.mesh.destroy(); } catch { /* ignore */ }
      // `destroy()` with NO argument (Pixi's own default is `destroySource:
      // false`) — NOT `destroy(true)`. Confirmed live: passing `true` here
      // cascades into destroying the texture's underlying GPU resource
      // (`TextureSource`), which corrupts Pixi's renderer for every frame
      // after this one — the ticker keeps reporting itself as running
      // (`started: true`, normal FPS) against a scene graph that is
      // otherwise completely correct, but the VISIBLE canvas simply stops
      // repainting from that point on, silently, with no thrown error
      // anywhere (this was the actual cause of the reported "overall I cant
      // use the whole canvas after doin any changes" — not a logic bug in
      // this class, a too-aggressive cleanup call). Leaving the base
      // texture/resource alive costs a small, bounded amount of GPU memory
      // per Transform session (at most the size of whatever region was
      // being transformed, released whenever this Texture wrapper is later
      // garbage-collected) — a trivial, one-off cost, unlike a renderer that
      // silently stops rendering for the rest of the session.
      try { src.texture.destroy(); } catch { /* ignore */ }
    }
    this.sources = [];
    this.originalBounds = null;
    this.bakedInRotation = 0;
    this.points = new Float32Array(0);
    this.active = false;
    this.dragHandle = null;
    this.meshRenderConfirmed = false;
    this.renderConfirmToken++; // invalidates any still-pending confirmRenderOnNextFrame() callback from this session
    this.handleGfx.clear();
  }
}
