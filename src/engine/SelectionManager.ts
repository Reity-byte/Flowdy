import { Container, Graphics, Sprite, Texture } from "pixi.js";

export class SelectionManager {
  public container = new Container();
  private graphics = new Graphics();
  public floatingSprite = new Sprite(); 

  public isSelecting = false;
  public isMoving = false;
  public activeHandle: 'tl' | 'tr' | 'bl' | 'br' | null = null; // Který roh držíme?
  public hasSelection = false; 

  public startPoint: { x: number, y: number } | null = null;
  public currentRect: { x: number, y: number, w: number, h: number } | null = null;

  private moveStartPoint: { x: number, y: number } | null = null;
  private initialRectPos: { x: number, y: number, w: number, h: number } | null = null;
  private tempCanvas: HTMLCanvasElement | null = null;

  constructor() {
    this.container.addChild(this.floatingSprite);
    this.container.addChild(this.graphics);
  }

  // Zjistí, zda jsme klikli přesně na nějaký roh (úchytku)
  private getHitHandle(x: number, y: number, zoom: number): 'tl' | 'tr' | 'bl' | 'br' | null {
    if (!this.currentRect || !this.hasSelection) return null;
    const handleSize = 12 / zoom;
    const tolerance = (handleSize / 2) + (5 / zoom); // Mírná tolerance pro dotyk prstem

    const rx = this.currentRect.x;
    const ry = this.currentRect.y;
    const rw = this.currentRect.w;
    const rh = this.currentRect.h;

    const check = (hx: number, hy: number) => Math.abs(x - hx) <= tolerance && Math.abs(y - hy) <= tolerance;

    if (check(rx, ry)) return 'tl';           // Top-Left
    if (check(rx + rw, ry)) return 'tr';      // Top-Right
    if (check(rx, ry + rh)) return 'bl';      // Bottom-Left
    if (check(rx + rw, ry + rh)) return 'br'; // Bottom-Right

    return null;
  }

  public isPointInside(x: number, y: number): boolean {
    if (!this.currentRect || !this.hasSelection) return false;
    const rx = this.currentRect.x;
    const ry = this.currentRect.y;
    const rw = this.currentRect.w;
    const rh = this.currentRect.h;
    return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
  }

  public startSelection(x: number, y: number, zoom: number, activeCtx: CanvasRenderingContext2D | null) {
    // 1. Zkontrolujeme, jestli se netrefil do rohu pro změnu velikosti
    const hitHandle = this.getHitHandle(x, y, zoom);
    if (hitHandle) {
      this.activeHandle = hitHandle;
      this.moveStartPoint = { x, y };
      this.initialRectPos = { ...this.currentRect! };
      return;
    }

    // 2. Kliknutí dovnitř -> Přesouvání celého výběru
    if (this.isPointInside(x, y)) {
      this.isMoving = true;
      this.moveStartPoint = { x, y };
      this.initialRectPos = { ...this.currentRect! };
      return;
    }

    // 3. Kliknutí mimo -> Přilepení
    if (this.hasSelection && activeCtx) {
      this.commitSelection(activeCtx);
    }

    // 4. Začátek nového výběru
    this.isSelecting = true;
    this.hasSelection = false;
    this.floatingSprite.visible = false;
    this.startPoint = { x, y };
    this.currentRect = { x, y, w: 0, h: 0 };
    this.draw(zoom);
  }

  public updateSelection(x: number, y: number, zoom: number) {
    // LOGIKA PRO ZMĚNU VELIKOSTI (TRANSFORMACE)
    if (this.activeHandle && this.moveStartPoint && this.initialRectPos && this.currentRect) {
      const dx = x - this.moveStartPoint.x;
      const dy = y - this.moveStartPoint.y;

      let nx = this.initialRectPos.x;
      let ny = this.initialRectPos.y;
      let nw = this.initialRectPos.w;
      let nh = this.initialRectPos.h;

      if (this.activeHandle === 'tl') { nx += dx; ny += dy; nw -= dx; nh -= dy; }
      else if (this.activeHandle === 'tr') { ny += dy; nw += dx; nh -= dy; }
      else if (this.activeHandle === 'bl') { nx += dx; nw -= dx; nh += dy; }
      else if (this.activeHandle === 'br') { nw += dx; nh += dy; }

      this.currentRect = { x: nx, y: ny, w: nw, h: nh };

      // Aktualizace plovoucí textury v reálném čase
      this.floatingSprite.position.set(Math.min(nx, nx + nw), Math.min(ny, ny + nh));
      this.floatingSprite.width = Math.abs(nw);
      this.floatingSprite.height = Math.abs(nh);

      this.draw(zoom);
      return;
    }

    // LOGIKA PRO POSOUVÁNÍ
    if (this.isMoving && this.moveStartPoint && this.initialRectPos && this.currentRect) {
      const dx = x - this.moveStartPoint.x;
      const dy = y - this.moveStartPoint.y;

      this.currentRect.x = this.initialRectPos.x + dx;
      this.currentRect.y = this.initialRectPos.y + dy;

      this.floatingSprite.position.set(this.currentRect.x, this.currentRect.y);
      this.draw(zoom);
      return;
    }

    // LOGIKA PRO VYTVÁŘENÍ RÁMEČKU
    if (this.isSelecting && this.startPoint) {
      this.currentRect = {
        x: this.startPoint.x,
        y: this.startPoint.y,
        w: x - this.startPoint.x,
        h: y - this.startPoint.y
      };
      this.draw(zoom);
    }
  }

  public endSelection(activeCtx: CanvasRenderingContext2D | null) {
    if (this.isMoving || this.activeHandle) {
      this.isMoving = false;
      this.activeHandle = null;
      
      // Zabráníme "přetočení" šířky a výšky do mínusu, aby to nerozbilo další kroky
      if (this.currentRect) {
        const nx = Math.min(this.currentRect.x, this.currentRect.x + this.currentRect.w);
        const ny = Math.min(this.currentRect.y, this.currentRect.y + this.currentRect.h);
        this.currentRect = { x: nx, y: ny, w: Math.abs(this.currentRect.w), h: Math.abs(this.currentRect.h) };
      }
      return;
    }

    if (this.isSelecting) {
      this.isSelecting = false;
      if (!this.currentRect) return;

      const w = Math.abs(this.currentRect.w);
      const h = Math.abs(this.currentRect.h);

      if (w < 2 || h < 2) {
        this.graphics.clear();
        this.currentRect = null;
        return;
      }

      if (activeCtx && !this.hasSelection) {
        this.extractPixels(activeCtx);
      }
    }
  }

  private extractPixels(ctx: CanvasRenderingContext2D) {
    // Normalizace před extrakcí
    const nx = Math.min(this.currentRect!.x, this.currentRect!.x + this.currentRect!.w);
    const ny = Math.min(this.currentRect!.y, this.currentRect!.y + this.currentRect!.h);
    const nw = Math.abs(this.currentRect!.w);
    const nh = Math.abs(this.currentRect!.h);
    
    // Přepíšeme currentRect čistými kladnými hodnotami
    this.currentRect = { x: nx, y: ny, w: nw, h: nh };

    this.tempCanvas = document.createElement("canvas");
    this.tempCanvas.width = nw;
    this.tempCanvas.height = nh;
    const tempCtx = this.tempCanvas.getContext("2d");
    if (!tempCtx) return;

    tempCtx.drawImage(ctx.canvas, nx, ny, nw, nh, 0, 0, nw, nh);
    ctx.clearRect(nx, ny, nw, nh);

    const texture = Texture.from(this.tempCanvas);
    this.floatingSprite.texture = texture;
    
    if (this.floatingSprite.texture.source) {
      this.floatingSprite.texture.source.update(); 
    }
    
    this.floatingSprite.position.set(nx, ny);
    this.floatingSprite.width = nw;
    this.floatingSprite.height = nh;
    this.floatingSprite.visible = true;

    this.hasSelection = true;
  }

  public commitSelection(ctx: CanvasRenderingContext2D) {
    if (!this.hasSelection || !this.tempCanvas) return;
    
    // Při ukládání zpět musíme respektovat naši novou zvětšenou/zmenšenou velikost
    ctx.drawImage(
      this.tempCanvas, 
      this.currentRect!.x, 
      this.currentRect!.y, 
      this.currentRect!.w, 
      this.currentRect!.h
    );
    
    this.hasSelection = false;
    this.floatingSprite.visible = false;
    this.graphics.clear();
    this.currentRect = null;
    this.tempCanvas = null;
  }

  public draw(zoom: number) {
    this.graphics.clear();
    if (!this.currentRect) return;

    const x = Math.min(this.currentRect.x, this.currentRect.x + this.currentRect.w);
    const y = Math.min(this.currentRect.y, this.currentRect.y + this.currentRect.h);
    const w = Math.abs(this.currentRect.w);
    const h = Math.abs(this.currentRect.h);

    if (w < 1 || h < 1) return;

    const strokeWidth = 2 / zoom;
    
    this.graphics.rect(x, y, w, h);
    this.graphics.stroke({ color: 0x0088ff, width: strokeWidth });

    const handleSize = 12 / zoom;
    const drawHandle = (hx: number, hy: number) => {
      this.graphics.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      this.graphics.fill({ color: 0xffffff });
      this.graphics.stroke({ color: 0x0088ff, width: strokeWidth / 2 });
    };

    drawHandle(x, y);
    drawHandle(x + w, y);
    drawHandle(x, y + h);
    drawHandle(x + w, y + h);
  }
}