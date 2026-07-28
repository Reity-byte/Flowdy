import { Container, Graphics, Sprite, Texture } from "pixi.js";

/**
 * Rectangular marquee select tool: draws the selection outline/handles,
 * cuts the enclosed pixels out of a layer into a floating overlay sprite
 * that can be dragged/resized, and pastes it back into a 2D canvas context
 * on commit. Callers (DocumentCanvas) drive the interaction lifecycle via
 * startSelection → updateSelection → endSelection and decide when to call
 * commitSelection/discardFloatingSelection.
 */
export class SelectionManager {
  public container = new Container();
  private graphics = new Graphics();
  public floatingSprite = new Sprite(); 

  public isSelecting = false;
  public isMoving = false;
  public activeHandle: 'tl' | 'tr' | 'bl' | 'br' | 'rotate' | null = null; // Který roh (nebo rotace) držíme?
  public hasSelection = false;
  /** Rotation of the floating selection, radians, about its own center. */
  public rotation = 0;
  /** Shape mode for the *next* marquee drag — synced from the editor store by the caller before each startSelection(). Once a selection is cut, editing (move/resize/rotate/commit) is shape-agnostic, so this only matters while `isSelecting` is true. */
  public mode: 'rect' | 'lasso' = 'rect';
  /** Raw world-space points traced during an in-progress lasso drag. */
  public lassoPoints: { x: number, y: number }[] = [];

  public startPoint: { x: number, y: number } | null = null;
  public currentRect: { x: number, y: number, w: number, h: number } | null = null;

  private moveStartPoint: { x: number, y: number } | null = null;
  private initialRectPos: { x: number, y: number, w: number, h: number } | null = null;
  private initialRotation = 0;
  private tempCanvas: HTMLCanvasElement | null = null;

  constructor() {
    this.floatingSprite.anchor.set(0.5, 0.5);
    this.container.addChild(this.floatingSprite);
    this.container.addChild(this.graphics);
  }

  /** Screen-distance (world units) the rotate handle sits above top-center — matches draw()'s rendering. */
  private static readonly ROTATE_HANDLE_DIST = 30;

  // Rotates world point (x, y) into the selection rect's local (unrotated) space around its center.
  private toLocal(x: number, y: number): { x: number, y: number } {
    if (!this.currentRect || !this.rotation) return { x, y };
    const r = this.currentRect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const dx = x - cx;
    const dy = y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  // Zjistí, zda jsme klikli přesně na nějaký roh (úchytku) nebo na úchytku rotace
  private getHitHandle(x: number, y: number, zoom: number): 'tl' | 'tr' | 'bl' | 'br' | 'rotate' | null {
    if (!this.currentRect || !this.hasSelection) return null;
    const p = this.toLocal(x, y);
    const handleSize = 12 / zoom;
    const tolerance = (handleSize / 2) + (5 / zoom); // Mírná tolerance pro dotyk prstem

    const rx = this.currentRect.x;
    const ry = this.currentRect.y;
    const rw = this.currentRect.w;
    const rh = this.currentRect.h;

    const check = (hx: number, hy: number) => Math.abs(p.x - hx) <= tolerance && Math.abs(p.y - hy) <= tolerance;

    if (check(rx, ry)) return 'tl';           // Top-Left
    if (check(rx + rw, ry)) return 'tr';      // Top-Right
    if (check(rx, ry + rh)) return 'bl';      // Bottom-Left
    if (check(rx + rw, ry + rh)) return 'br'; // Bottom-Right

    const rotDist = SelectionManager.ROTATE_HANDLE_DIST / zoom;
    if (check(rx + rw / 2, ry - rotDist)) return 'rotate';

    return null;
  }

  /** Whether world point (x, y) falls inside the current selection rect. */
  public isPointInside(x: number, y: number): boolean {
    if (!this.currentRect || !this.hasSelection) return false;
    const p = this.toLocal(x, y);
    const rx = this.currentRect.x;
    const ry = this.currentRect.y;
    const rw = this.currentRect.w;
    const rh = this.currentRect.h;
    return p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh;
  }

  /** Directly sets the rect/rotation and refreshes the floating sprite + outline — used by touch pinch/rotate gesture redirection, which computes the new transform itself rather than driving a single handle. */
  public setTransform(rect: { x: number, y: number, w: number, h: number }, rotation: number, zoom: number): void {
    if (!this.hasSelection) return;
    this.currentRect = rect;
    this.rotation = rotation;
    this.updateFloatingTransform();
    this.draw(zoom);
  }

  /** Syncs the floating sprite's position/size/rotation to `currentRect`/`rotation`. Sprite anchor is (0.5, 0.5) so position is always the rect's center. */
  private updateFloatingTransform(): void {
    if (!this.currentRect) return;
    const r = this.currentRect;
    this.floatingSprite.position.set(r.x + r.w / 2, r.y + r.h / 2);
    this.floatingSprite.width = Math.abs(r.w);
    this.floatingSprite.height = Math.abs(r.h);
    this.floatingSprite.rotation = this.rotation;
  }

  /** Returns true if a previously floating selection was pasted back (so callers can record an undo step). */
  public startSelection(x: number, y: number, zoom: number, activeCtx: CanvasRenderingContext2D | null): boolean {
    // 1. Zkontrolujeme, jestli se netrefil do rohu pro změnu velikosti
    const hitHandle = this.getHitHandle(x, y, zoom);
    if (hitHandle) {
      this.activeHandle = hitHandle;
      this.moveStartPoint = { x, y };
      this.initialRectPos = { ...this.currentRect! };
      this.initialRotation = this.rotation;
      return false;
    }

    // 2. Kliknutí dovnitř -> Přesouvání celého výběru
    if (this.isPointInside(x, y)) {
      this.isMoving = true;
      this.moveStartPoint = { x, y };
      this.initialRectPos = { ...this.currentRect! };
      return false;
    }

    // 3. Kliknutí mimo -> Přilepení
    let didCommit = false;
    if (this.hasSelection && activeCtx) {
      didCommit = this.commitSelection(activeCtx);
    }

    // 4. Začátek nového výběru
    this.isSelecting = true;
    this.hasSelection = false;
    this.rotation = 0;
    this.floatingSprite.visible = false;
    this.startPoint = { x, y };
    this.currentRect = { x, y, w: 0, h: 0 };
    this.lassoPoints = this.mode === 'lasso' ? [{ x, y }] : [];
    this.draw(zoom);
    return didCommit;
  }

  /** Continues whichever gesture startSelection began — resizing via a corner handle, rotating, dragging the floating overlay, or dragging out a new marquee rect. No-op if none is in progress. `shiftKey` locks corner-resize to the selection's original aspect ratio (Photoshop/Illustrator convention). */
  public updateSelection(x: number, y: number, zoom: number, shiftKey: boolean = false) {
    // LOGIKA PRO ROTACI
    if (this.activeHandle === 'rotate' && this.moveStartPoint && this.initialRectPos) {
      const cx = this.initialRectPos.x + this.initialRectPos.w / 2;
      const cy = this.initialRectPos.y + this.initialRectPos.h / 2;
      const startAngle = Math.atan2(this.moveStartPoint.y - cy, this.moveStartPoint.x - cx);
      const curAngle = Math.atan2(y - cy, x - cx);
      this.rotation = this.initialRotation + (curAngle - startAngle);
      this.updateFloatingTransform();
      this.draw(zoom);
      return;
    }

    // LOGIKA PRO ZMĚNU VELIKOSTI (TRANSFORMACE) — dx/dy computed in the rect's
    // local (unrotated) axes around its initial center, so a corner drag
    // still resizes along the rect's own edges once it's been rotated.
    if (this.activeHandle && this.moveStartPoint && this.initialRectPos && this.currentRect) {
      const cx = this.initialRectPos.x + this.initialRectPos.w / 2;
      const cy = this.initialRectPos.y + this.initialRectPos.h / 2;
      const cos = Math.cos(-this.rotation);
      const sin = Math.sin(-this.rotation);
      const toLocalFromInitCenter = (px: number, py: number) => {
        const dx0 = px - cx, dy0 = py - cy;
        return { x: cx + dx0 * cos - dy0 * sin, y: cy + dx0 * sin + dy0 * cos };
      };
      const localStart = toLocalFromInitCenter(this.moveStartPoint.x, this.moveStartPoint.y);
      const localCur = toLocalFromInitCenter(x, y);
      const dx = localCur.x - localStart.x;
      const dy = localCur.y - localStart.y;

      let nx = this.initialRectPos.x;
      let ny = this.initialRectPos.y;
      let nw = this.initialRectPos.w;
      let nh = this.initialRectPos.h;

      if (this.activeHandle === 'tl') { nx += dx; ny += dy; nw -= dx; nh -= dy; }
      else if (this.activeHandle === 'tr') { ny += dy; nw += dx; nh -= dy; }
      else if (this.activeHandle === 'bl') { nx += dx; nw -= dx; nh += dy; }
      else if (this.activeHandle === 'br') { nw += dx; nh += dy; }

      // Shift held: lock to the selection's original aspect ratio, anchored at the
      // corner opposite the one being dragged (Photoshop/Illustrator convention).
      // Use the more dominant of the two deltas as the driving scale so the drag
      // still feels responsive to whichever axis the pointer moved further along.
      if (shiftKey && this.initialRectPos.w !== 0 && this.initialRectPos.h !== 0) {
        const scaleX = Math.abs(nw) / Math.abs(this.initialRectPos.w);
        const scaleY = Math.abs(nh) / Math.abs(this.initialRectPos.h);
        const scale = Math.max(scaleX, scaleY);
        const signW = nw < 0 ? -1 : 1;
        const signH = nh < 0 ? -1 : 1;
        nw = signW * Math.abs(this.initialRectPos.w) * scale;
        nh = signH * Math.abs(this.initialRectPos.h) * scale;

        if (this.activeHandle === 'tl') { nx = this.initialRectPos.x + this.initialRectPos.w - nw; ny = this.initialRectPos.y + this.initialRectPos.h - nh; }
        else if (this.activeHandle === 'tr') { nx = this.initialRectPos.x; ny = this.initialRectPos.y + this.initialRectPos.h - nh; }
        else if (this.activeHandle === 'bl') { nx = this.initialRectPos.x + this.initialRectPos.w - nw; ny = this.initialRectPos.y; }
        else if (this.activeHandle === 'br') { nx = this.initialRectPos.x; ny = this.initialRectPos.y; }
      }

      this.currentRect = { x: nx, y: ny, w: nw, h: nh };

      // Aktualizace plovoucí textury v reálném čase
      this.updateFloatingTransform();

      this.draw(zoom);
      return;
    }

    // LOGIKA PRO POSOUVÁNÍ
    if (this.isMoving && this.moveStartPoint && this.initialRectPos && this.currentRect) {
      const dx = x - this.moveStartPoint.x;
      const dy = y - this.moveStartPoint.y;

      this.currentRect.x = this.initialRectPos.x + dx;
      this.currentRect.y = this.initialRectPos.y + dy;

      this.updateFloatingTransform();
      this.draw(zoom);
      return;
    }

    // LOGIKA PRO VYTVÁŘENÍ RÁMEČKU (lasso: traces the raw path; rect: axis-aligned box)
    if (this.isSelecting && this.startPoint) {
      if (this.mode === 'lasso') {
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        // Skip near-duplicate points (e.g. a stationary pointer still firing
        // move events) so the path doesn't accumulate degenerate segments.
        if (!last || Math.hypot(x - last.x, y - last.y) >= 1 / zoom) {
          this.lassoPoints.push({ x, y });
        }
        this.draw(zoom);
        return;
      }
      this.currentRect = {
        x: this.startPoint.x,
        y: this.startPoint.y,
        w: x - this.startPoint.x,
        h: y - this.startPoint.y
      };
      this.draw(zoom);
    }
  }

  /** Returns true if pixels were just cut out of the layer into a new floating selection (so callers can record an undo step). */
  public endSelection(activeCtx: CanvasRenderingContext2D | null): boolean {
    if (this.isMoving || this.activeHandle) {
      this.isMoving = false;
      this.activeHandle = null;

      // Zabráníme "přetočení" šířky a výšky do mínusu, aby to nerozbilo další kroky
      if (this.currentRect) {
        const nx = Math.min(this.currentRect.x, this.currentRect.x + this.currentRect.w);
        const ny = Math.min(this.currentRect.y, this.currentRect.y + this.currentRect.h);
        this.currentRect = { x: nx, y: ny, w: Math.abs(this.currentRect.w), h: Math.abs(this.currentRect.h) };
      }
      return false;
    }

    if (this.isSelecting) {
      this.isSelecting = false;

      if (this.mode === 'lasso') {
        if (this.lassoPoints.length < 3) {
          this.graphics.clear();
          this.currentRect = null;
          this.lassoPoints = [];
          return false;
        }
        if (activeCtx && !this.hasSelection) {
          const extracted = this.extractLassoPixels(activeCtx);
          this.lassoPoints = [];
          return extracted;
        }
        this.lassoPoints = [];
        return false;
      }

      if (!this.currentRect) return false;

      const w = Math.abs(this.currentRect.w);
      const h = Math.abs(this.currentRect.h);

      if (w < 2 || h < 2) {
        this.graphics.clear();
        this.currentRect = null;
        return false;
      }

      if (activeCtx && !this.hasSelection) {
        this.extractPixels(activeCtx);
        return true;
      }
    }
    return false;
  }

  /**
   * Cuts `rect` (in the layer's own pixel coordinates) out of `ctx` into a
   * new floating selection with move/resize/rotate handles already active —
   * the same underlying cut/float/paste-back pipeline a rectangular marquee
   * drag produces, without requiring the user to actually drag one. Used
   * right after importing an image so it immediately gets transform handles
   * (matching Procreate/ibis Paint's "insert photo") instead of landing as
   * flat, already-baked pixels the user would otherwise have to marquee-
   * select by hand just to move or resize.
   *
   * Any selection already floating is committed back into `ctx` first — the
   * caller is responsible for `ctx` actually being wherever that pending
   * float belongs (e.g. bake in any float on the OLD active layer via
   * commitSelection/commitActiveSelection before switching layers, rather
   * than relying on this call to do it against the wrong layer's context).
   */
  public selectRegion(ctx: CanvasRenderingContext2D, rect: { x: number, y: number, w: number, h: number }, zoom: number): void {
    if (this.hasSelection) {
      this.commitSelection(ctx);
    }
    this.mode = 'rect';
    this.isSelecting = false;
    this.isMoving = false;
    this.activeHandle = null;
    this.rotation = 0;
    this.currentRect = { ...rect };
    this.extractPixels(ctx);
    this.draw(zoom);
  }

  private extractPixels(ctx: CanvasRenderingContext2D) {
    // Normalizace před extrakcí — rounded to integers so tempCanvas pixel
    // dimensions exactly match the drawImage source rect (avoids subpixel
    // resample blur on commit).
    const nx = Math.round(Math.min(this.currentRect!.x, this.currentRect!.x + this.currentRect!.w));
    const ny = Math.round(Math.min(this.currentRect!.y, this.currentRect!.y + this.currentRect!.h));
    const nw = Math.round(Math.abs(this.currentRect!.w));
    const nh = Math.round(Math.abs(this.currentRect!.h));
    
    // Přepíšeme currentRect čistými kladnými hodnotami
    this.currentRect = { x: nx, y: ny, w: nw, h: nh };

    this.tempCanvas = document.createElement("canvas");
    this.tempCanvas.width = nw;
    this.tempCanvas.height = nh;
    const tempCtx = this.tempCanvas.getContext("2d");
    if (!tempCtx) return;

    tempCtx.drawImage(ctx.canvas, nx, ny, nw, nh, 0, 0, nw, nh);
    ctx.clearRect(nx, ny, nw, nh);

    this.installFloatingTexture();
  }

  /**
   * Freehand-lasso counterpart to extractPixels(): same rect-shaped
   * `tempCanvas`/floating-sprite pipeline underneath (move/resize/rotate/
   * commit are all shape-agnostic — see `mode`'s doc comment), but the
   * extracted bbox region is punched down to the lasso's actual outline via
   * `destination-in` clipping before installing it as the floating texture,
   * and the source layer is cleared with the same path as a clip rather than
   * clearing the whole bounding box.
   */
  private extractLassoPixels(ctx: CanvasRenderingContext2D): boolean {
    const xs = this.lassoPoints.map((p) => p.x);
    const ys = this.lassoPoints.map((p) => p.y);
    const nx = Math.round(Math.min(...xs));
    const ny = Math.round(Math.min(...ys));
    const nw = Math.round(Math.max(...xs) - Math.min(...xs));
    const nh = Math.round(Math.max(...ys) - Math.min(...ys));

    if (nw < 2 || nh < 2) {
      this.graphics.clear();
      this.currentRect = null;
      return false;
    }

    this.currentRect = { x: nx, y: ny, w: nw, h: nh };

    // Path in the layer's own (absolute) coordinate space — used to clip the
    // source layer's clear so only the lasso'd pixels are removed, not the
    // whole bounding box.
    const absPath = new Path2D();
    absPath.moveTo(this.lassoPoints[0]!.x, this.lassoPoints[0]!.y);
    for (let i = 1; i < this.lassoPoints.length; i++) absPath.lineTo(this.lassoPoints[i]!.x, this.lassoPoints[i]!.y);
    absPath.closePath();

    // Same path translated into the bbox-local space `tempCanvas` uses.
    const localPath = new Path2D();
    localPath.moveTo(this.lassoPoints[0]!.x - nx, this.lassoPoints[0]!.y - ny);
    for (let i = 1; i < this.lassoPoints.length; i++) localPath.lineTo(this.lassoPoints[i]!.x - nx, this.lassoPoints[i]!.y - ny);
    localPath.closePath();

    this.tempCanvas = document.createElement("canvas");
    this.tempCanvas.width = nw;
    this.tempCanvas.height = nh;
    const tempCtx = this.tempCanvas.getContext("2d");
    if (!tempCtx) return false;

    tempCtx.drawImage(ctx.canvas, nx, ny, nw, nh, 0, 0, nw, nh);
    // Punch the bbox-shaped copy down to just the lasso'd outline.
    tempCtx.save();
    tempCtx.globalCompositeOperation = "destination-in";
    tempCtx.fill(localPath);
    tempCtx.restore();

    ctx.save();
    ctx.clip(absPath);
    ctx.clearRect(nx, ny, nw, nh);
    ctx.restore();

    this.installFloatingTexture();
    return true;
  }

  /** Shared tail of extractPixels()/extractLassoPixels(): installs `tempCanvas` as the floating sprite's texture and marks a selection active. */
  private installFloatingTexture(): void {
    // Destroy the previous floating texture (and its backing canvas) before
    // replacing it, otherwise every new selection leaks the old one.
    const oldTexture = this.floatingSprite.texture;
    if (oldTexture && oldTexture !== Texture.EMPTY) {
      try { oldTexture.destroy(true); } catch {}
    }

    const texture = Texture.from(this.tempCanvas!);
    this.floatingSprite.texture = texture;

    if (this.floatingSprite.texture.source) {
      this.floatingSprite.texture.source.update();
    }

    this.rotation = 0;
    this.updateFloatingTransform();
    this.floatingSprite.visible = true;

    this.hasSelection = true;
  }

  /**
   * Hands ownership of the currently-floating selection to a caller (the
   * Transform tool) instead of pasting it back into the layer — the
   * selection's own UI (handles, "Done" button) disappears immediately,
   * exactly as if it had been committed, but the caller receives the
   * extracted content (already alpha-masked to the lasso outline, if that's
   * how it was cut) and is responsible for it from here on. Returns null if
   * there's no floating selection to take.
   */
  public takeFloatingContent(): { canvas: HTMLCanvasElement; rect: { x: number, y: number, w: number, h: number }; rotation: number } | null {
    if (!this.hasSelection || !this.tempCanvas || !this.currentRect) return null;
    const result = { canvas: this.tempCanvas, rect: { ...this.currentRect }, rotation: this.rotation };

    const oldTexture = this.floatingSprite.texture;
    if (oldTexture && oldTexture !== Texture.EMPTY) {
      try { oldTexture.destroy(true); } catch {}
    }
    this.floatingSprite.texture = Texture.EMPTY;
    this.floatingSprite.rotation = 0;
    this.floatingSprite.visible = false;
    this.graphics.clear();

    this.hasSelection = false;
    this.rotation = 0;
    this.currentRect = null;
    this.tempCanvas = null;
    return result;
  }

  /** Pastes the floating selection back into `ctx` at its current position/size/rotation. Returns true if it actually committed anything. */
  public commitSelection(ctx: CanvasRenderingContext2D): boolean {
    if (!this.hasSelection || !this.tempCanvas || !this.currentRect) return false;

    const r = this.currentRect;
    if (Math.abs(this.rotation) > 1e-6) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.rotation);
      ctx.drawImage(this.tempCanvas, -r.w / 2, -r.h / 2, r.w, r.h);
      ctx.restore();
    } else {
      // Při ukládání zpět musíme respektovat naši novou zvětšenou/zmenšenou velikost
      ctx.drawImage(this.tempCanvas, r.x, r.y, r.w, r.h);
    }

    this.hasSelection = false;
    this.rotation = 0;
    this.floatingSprite.rotation = 0;
    this.floatingSprite.visible = false;
    this.graphics.clear();
    this.currentRect = null;
    this.tempCanvas = null;
    return true;
  }

  /** Drops a floating selection without pasting it back — used before restoring
   * a history snapshot, since the floating pixels don't belong to any past state. */
  public discardFloatingSelection(): void {
    this.hasSelection = false;
    this.isMoving = false;
    this.isSelecting = false;
    this.activeHandle = null;
    this.rotation = 0;
    const tex = this.floatingSprite.texture;
    if (tex && tex !== Texture.EMPTY) {
      try { tex.destroy(true); } catch {}
    }
    this.floatingSprite.texture = Texture.EMPTY;
    this.floatingSprite.rotation = 0;
    this.floatingSprite.visible = false;
    this.graphics.clear();
    this.currentRect = null;
    this.tempCanvas = null;
    this.lassoPoints = [];
  }

  /** Redraws the rotated selection outline, corner handles, and rotate handle at the current `currentRect`/`rotation`. During an in-progress lasso drag, draws the raw traced path instead (no handles yet — those only apply to a committed floating selection). `zoom` keeps stroke/handle sizes constant in screen space. */
  public draw(zoom: number) {
    this.graphics.clear();

    if (this.isSelecting && this.mode === 'lasso') {
      if (this.lassoPoints.length < 2) return;
      const strokeWidth = 2 / zoom;
      this.graphics.moveTo(this.lassoPoints[0]!.x, this.lassoPoints[0]!.y);
      for (let i = 1; i < this.lassoPoints.length; i++) {
        this.graphics.lineTo(this.lassoPoints[i]!.x, this.lassoPoints[i]!.y);
      }
      this.graphics.stroke({ color: 0x0088ff, width: strokeWidth });
      return;
    }

    if (!this.currentRect) return;

    const x = Math.min(this.currentRect.x, this.currentRect.x + this.currentRect.w);
    const y = Math.min(this.currentRect.y, this.currentRect.y + this.currentRect.h);
    const w = Math.abs(this.currentRect.w);
    const h = Math.abs(this.currentRect.h);

    if (w < 1 || h < 1) return;

    const cx = x + w / 2;
    const cy = y + h / 2;
    const rotatePoint = (hx: number, hy: number) => {
      if (!this.rotation) return { x: hx, y: hy };
      const cos = Math.cos(this.rotation);
      const sin = Math.sin(this.rotation);
      const dx = hx - cx;
      const dy = hy - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    };

    const strokeWidth = 2 / zoom;
    const corners = [
      rotatePoint(x, y),
      rotatePoint(x + w, y),
      rotatePoint(x + w, y + h),
      rotatePoint(x, y + h),
    ];

    this.graphics.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) this.graphics.lineTo(corners[i].x, corners[i].y);
    this.graphics.closePath();
    this.graphics.stroke({ color: 0x0088ff, width: strokeWidth });

    const handleSize = 12 / zoom;
    const drawHandle = (hx: number, hy: number, round = false) => {
      if (round) {
        this.graphics.circle(hx, hy, handleSize / 2);
      } else {
        this.graphics.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      }
      this.graphics.fill({ color: 0xffffff });
      this.graphics.stroke({ color: 0x0088ff, width: strokeWidth / 2 });
    };

    for (const c of corners) drawHandle(c.x, c.y);

    // Rotate handle: a small circle a fixed screen-distance above top-center,
    // connected by a stem line — standard Photoshop/Affinity placement.
    const rotDist = SelectionManager.ROTATE_HANDLE_DIST / zoom;
    const topMid = rotatePoint(x + w / 2, y);
    const handlePos = rotatePoint(x + w / 2, y - rotDist);
    this.graphics.moveTo(topMid.x, topMid.y);
    this.graphics.lineTo(handlePos.x, handlePos.y);
    this.graphics.stroke({ color: 0x0088ff, width: strokeWidth });
    drawHandle(handlePos.x, handlePos.y, true);
  }
}