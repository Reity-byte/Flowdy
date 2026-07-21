import { Container, Graphics } from "pixi.js";

export type RulerType = "straight" | "circular";

type Point = { x: number; y: number };
type Handle = "start" | "end" | "move" | "center" | "radius" | null;

/**
 * Procreate/ibis-Paint-style drawing guide: a ruler you place and adjust on
 * the canvas (straight edge, or a circle), which then constrains every dab
 * of a brush/eraser/blur/smudge stroke to lie exactly on it — snapping the
 * raw pointer position onto the guide's geometry before it ever reaches
 * `HighPerformanceBrushStroke`. The ruler itself never touches layer pixels;
 * it's pure input-shaping, driven the same way `SelectionManager` drives its
 * own press-drag-release lifecycle (startEdit → updateEdit → endEdit), with
 * `type`/`enabled` synced in from the editor store by the caller.
 */
export class RulerManager {
  public container = new Container();
  private graphics = new Graphics();

  public type: RulerType = "straight";
  /** Whether a placed ruler actually constrains drawing right now. */
  public enabled = true;
  /** Whether the geometry below has ever been set (nothing to snap to until it has). */
  public placed = false;

  // Straight ruler: a line segment; strokes snap onto its infinite extension.
  public lineStart: Point | null = null;
  public lineEnd: Point | null = null;

  // Circular ruler: strokes snap onto the circle's circumference.
  public center: Point | null = null;
  public radius = 0;

  private activeHandle: Handle = null;
  private dragStart: Point | null = null;
  private initialLineStart: Point | null = null;
  private initialLineEnd: Point | null = null;
  private initialCenter: Point | null = null;

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Switches the guide shape. Clears any existing geometry — a straight edge and a circle aren't interchangeable placements. */
  public setType(type: RulerType, zoom: number): void {
    if (this.type === type) return;
    this.type = type;
    this.clear(zoom);
  }

  public setEnabled(enabled: boolean, zoom: number): void {
    this.enabled = enabled;
    this.draw(zoom);
  }

  /** Removes the placed guide entirely (snapping becomes a no-op until re-placed). */
  public clear(zoom: number): void {
    this.placed = false;
    this.lineStart = null;
    this.lineEnd = null;
    this.center = null;
    this.radius = 0;
    this.activeHandle = null;
    this.draw(zoom);
  }

  private static readonly HANDLE_HIT_RADIUS = 16;

  private distToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    return Math.hypot(p.x - px, p.y - py);
  }

  /** Begins placing a new guide or grabbing an existing handle/body. Always "handled" — there's no pass-through interaction for the ruler tool. */
  public startEdit(x: number, y: number, zoom: number): void {
    const tol = RulerManager.HANDLE_HIT_RADIUS / zoom;

    if (this.placed && this.type === "straight" && this.lineStart && this.lineEnd) {
      if (Math.hypot(x - this.lineStart.x, y - this.lineStart.y) <= tol) {
        this.activeHandle = "start";
        this.dragStart = { x, y };
        this.initialLineStart = { ...this.lineStart };
        this.initialLineEnd = { ...this.lineEnd };
        return;
      }
      if (Math.hypot(x - this.lineEnd.x, y - this.lineEnd.y) <= tol) {
        this.activeHandle = "end";
        this.dragStart = { x, y };
        this.initialLineStart = { ...this.lineStart };
        this.initialLineEnd = { ...this.lineEnd };
        return;
      }
      if (this.distToSegment({ x, y }, this.lineStart, this.lineEnd) <= tol) {
        this.activeHandle = "move";
        this.dragStart = { x, y };
        this.initialLineStart = { ...this.lineStart };
        this.initialLineEnd = { ...this.lineEnd };
        return;
      }
    }

    if (this.placed && this.type === "circular" && this.center) {
      const distToCenter = Math.hypot(x - this.center.x, y - this.center.y);
      const distToEdge = Math.abs(distToCenter - this.radius);
      if (distToEdge <= tol) {
        this.activeHandle = "radius";
        this.dragStart = { x, y };
        this.initialCenter = { ...this.center };
        return;
      }
      if (distToCenter <= tol) {
        this.activeHandle = "center";
        this.dragStart = { x, y };
        this.initialCenter = { ...this.center };
        return;
      }
      if (distToCenter < this.radius) {
        this.activeHandle = "move";
        this.dragStart = { x, y };
        this.initialCenter = { ...this.center };
        return;
      }
    }

    // Nothing hit — start placing a fresh guide from scratch, discarding any old one.
    this.placed = true;
    if (this.type === "straight") {
      this.lineStart = { x, y };
      this.lineEnd = { x, y };
      this.activeHandle = "end";
    } else {
      this.center = { x, y };
      this.radius = 0;
      this.activeHandle = "radius";
    }
    this.draw(zoom);
  }

  public updateEdit(x: number, y: number, zoom: number): void {
    if (!this.activeHandle) return;

    if (this.type === "straight") {
      if (this.activeHandle === "start") {
        this.lineStart = { x, y };
      } else if (this.activeHandle === "end") {
        this.lineEnd = { x, y };
      } else if (this.activeHandle === "move" && this.dragStart && this.initialLineStart && this.initialLineEnd) {
        const dx = x - this.dragStart.x;
        const dy = y - this.dragStart.y;
        this.lineStart = { x: this.initialLineStart.x + dx, y: this.initialLineStart.y + dy };
        this.lineEnd = { x: this.initialLineEnd.x + dx, y: this.initialLineEnd.y + dy };
      }
    } else {
      if (this.activeHandle === "radius" && this.center) {
        this.radius = Math.hypot(x - this.center.x, y - this.center.y);
      } else if (this.activeHandle === "center" && this.dragStart && this.initialCenter) {
        const dx = x - this.dragStart.x;
        const dy = y - this.dragStart.y;
        this.center = { x: this.initialCenter.x + dx, y: this.initialCenter.y + dy };
      } else if (this.activeHandle === "move" && this.dragStart && this.initialCenter) {
        const dx = x - this.dragStart.x;
        const dy = y - this.dragStart.y;
        this.center = { x: this.initialCenter.x + dx, y: this.initialCenter.y + dy };
      }
    }

    this.draw(zoom);
  }

  public endEdit(): void {
    this.activeHandle = null;
    this.dragStart = null;
  }

  public get isEditing(): boolean {
    return this.activeHandle !== null;
  }

  /** Projects (x, y) onto the guide's geometry. Passes the point through unchanged if disabled or not yet placed (or degenerate — a zero-length line/radius). */
  public snapPoint(x: number, y: number): Point {
    if (!this.enabled || !this.placed) return { x, y };

    if (this.type === "straight" && this.lineStart && this.lineEnd) {
      const dx = this.lineEnd.x - this.lineStart.x;
      const dy = this.lineEnd.y - this.lineStart.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) return { x, y };
      const t = ((x - this.lineStart.x) * dx + (y - this.lineStart.y) * dy) / len2;
      return { x: this.lineStart.x + t * dx, y: this.lineStart.y + t * dy };
    }

    if (this.type === "circular" && this.center && this.radius > 0.5) {
      const dx = x - this.center.x;
      const dy = y - this.center.y;
      const d = Math.hypot(dx, dy) || 1;
      return { x: this.center.x + (dx / d) * this.radius, y: this.center.y + (dy / d) * this.radius };
    }

    return { x, y };
  }

  public draw(zoom: number): void {
    this.graphics.clear();
    if (!this.placed) return;

    const strokeWidth = 2 / zoom;
    const dashColor = this.enabled ? 0xffaa00 : 0x888888;
    const handleSize = 10 / zoom;

    const drawHandle = (hx: number, hy: number) => {
      this.graphics.circle(hx, hy, handleSize / 2);
      this.graphics.fill({ color: 0xffffff });
      this.graphics.stroke({ color: dashColor, width: strokeWidth / 1.5 });
    };

    if (this.type === "straight" && this.lineStart && this.lineEnd) {
      // Extend the drawn line well past the two handles so it visually reads
      // as an infinite straight-edge, matching what snapPoint actually does.
      const dx = this.lineEnd.x - this.lineStart.x;
      const dy = this.lineEnd.y - this.lineStart.y;
      const len = Math.hypot(dx, dy) || 1;
      const ext = 4000 / zoom;
      const ux = dx / len;
      const uy = dy / len;
      this.graphics.moveTo(this.lineStart.x - ux * ext, this.lineStart.y - uy * ext);
      this.graphics.lineTo(this.lineEnd.x + ux * ext, this.lineEnd.y + uy * ext);
      this.graphics.stroke({ color: dashColor, width: strokeWidth, alpha: 0.85 });
      drawHandle(this.lineStart.x, this.lineStart.y);
      drawHandle(this.lineEnd.x, this.lineEnd.y);
    } else if (this.type === "circular" && this.center) {
      this.graphics.circle(this.center.x, this.center.y, this.radius);
      this.graphics.stroke({ color: dashColor, width: strokeWidth, alpha: 0.85 });
      drawHandle(this.center.x, this.center.y);
      if (this.radius > 0.5) drawHandle(this.center.x + this.radius, this.center.y);
    }
  }
}
