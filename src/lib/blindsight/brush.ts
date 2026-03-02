/**
 * BLINDSIGHT — Canvas brush engine.
 *
 * Renders brush strokes from BrushState parameters onto an HTML5 Canvas.
 * Each frame draws a short stroke segment from previous to current position
 * with curvature (bezier), texture (stipple), and variable opacity/width.
 *
 * Also manages the reveal overlay (solid black that fades out on eye-open).
 */

import type { BrushState, SymmetryMode } from './types';

export class BrushEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;

  // Overlay state
  private overlayOpacity = 1;
  private overlayTarget = 1;   // 1 = hidden (painting), 0 = revealed
  private fadeDuration = 2.5;  // seconds
  private fadeStart = 0;
  private isFading = false;

  // Symmetry
  private symmetryMode: SymmetryMode = 'none';

  // Stats
  private strokePoints = 0;

  constructor(
    paintCanvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
  ) {
    this.canvas = paintCanvas;
    this.ctx = paintCanvas.getContext('2d')!;
    this.overlayCanvas = overlay;
    this.overlayCtx = overlay.getContext('2d')!;
  }

  /** Resize canvases to match their CSS size (retina-aware) */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;

    for (const cvs of [this.canvas, this.overlayCanvas]) {
      const rect = cvs.getBoundingClientRect();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      const c = cvs.getContext('2d')!;
      c.scale(dpr, dpr);
    }

    this.drawOverlay();
  }

  getLogicalSize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    // Fall back to canvas pixel dimensions for off-screen canvases (GIF export)
    const w = rect.width || this.canvas.width;
    const h = rect.height || this.canvas.height;
    return { width: w, height: h };
  }

  setFadeDuration(seconds: number): void {
    this.fadeDuration = seconds;
  }

  setSymmetry(mode: SymmetryMode): void {
    this.symmetryMode = mode;
  }

  /** Expose the paint canvas for gallery saving & replay */
  getPaintCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getStrokePoints(): number {
    return this.strokePoints;
  }

  resetStrokePoints(): void {
    this.strokePoints = 0;
  }

  // ─── Painting ──────────────────────────────────────────────────────────

  /** Render one stroke segment from brush state (with symmetry) */
  renderStroke(brush: BrushState): void {
    const dx = brush.x - brush.prevX;
    const dy = brush.y - brush.prevY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.5) return;

    this.strokePoints++;
    this.renderStrokeAt(brush);

    // Symmetry mirrors
    if (this.symmetryMode === 'bilateral' || this.symmetryMode === 'quad') {
      const { width } = this.getLogicalSize();
      this.renderStrokeAt({ ...brush, x: width - brush.x, prevX: width - brush.prevX });
    }
    if (this.symmetryMode === 'quad') {
      const { width, height } = this.getLogicalSize();
      this.renderStrokeAt({ ...brush, y: height - brush.y, prevY: height - brush.prevY });
      this.renderStrokeAt({
        ...brush,
        x: width - brush.x, prevX: width - brush.prevX,
        y: height - brush.y, prevY: height - brush.prevY,
      });
    }
  }

  /** Internal: render a single stroke segment (no symmetry logic) */
  private renderStrokeAt(brush: BrushState): void {
    const ctx = this.ctx;
    const dx = brush.x - brush.prevX;
    const dy = brush.y - brush.prevY;

    ctx.save();
    ctx.globalAlpha = brush.opacity;
    ctx.strokeStyle = `hsl(${brush.hue}, 70%, 60%)`;
    ctx.fillStyle = `hsl(${brush.hue}, 70%, 60%)`;
    ctx.lineWidth = brush.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Bezier control points offset by curvature
    const cpOffset = brush.curvature * 50;
    const cpX = (brush.prevX + brush.x) / 2 + (Math.random() - 0.5) * cpOffset;
    const cpY = (brush.prevY + brush.y) / 2 + (Math.random() - 0.5) * cpOffset;

    ctx.beginPath();
    ctx.moveTo(brush.prevX, brush.prevY);
    ctx.quadraticCurveTo(cpX, cpY, brush.x, brush.y);
    ctx.stroke();

    // Texture: stipple dots along the stroke path
    if (brush.texture > 0.3) {
      const dots = Math.floor(brush.texture * 8);
      for (let i = 0; i < dots; i++) {
        const t = Math.random();
        const dotX = brush.prevX + dx * t + (Math.random() - 0.5) * brush.width;
        const dotY = brush.prevY + dy * t + (Math.random() - 0.5) * brush.width;
        ctx.globalAlpha = brush.opacity * 0.3;
        ctx.beginPath();
        ctx.arc(dotX, dotY, brush.width * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /** Render a stamp burst at the current brush position — triggered by jaw clench (with symmetry) */
  renderStamp(brush: BrushState): void {
    this.renderStampAt(brush);

    if (this.symmetryMode === 'bilateral' || this.symmetryMode === 'quad') {
      const { width } = this.getLogicalSize();
      this.renderStampAt({ ...brush, x: width - brush.x, prevX: width - brush.prevX });
    }
    if (this.symmetryMode === 'quad') {
      const { width, height } = this.getLogicalSize();
      this.renderStampAt({ ...brush, y: height - brush.y, prevY: height - brush.prevY });
      this.renderStampAt({
        ...brush,
        x: width - brush.x, prevX: width - brush.prevX,
        y: height - brush.y, prevY: height - brush.prevY,
      });
    }
  }

  /** Internal: render a single stamp burst at the given position */
  private renderStampAt(brush: BrushState): void {
    const ctx = this.ctx;
    const cx = brush.x;
    const cy = brush.y;
    const radius = brush.width * 2.5;

    ctx.save();

    // Central splat
    ctx.globalAlpha = Math.min(1, brush.opacity * 1.5);
    ctx.fillStyle = `hsl(${brush.hue}, 85%, 55%)`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2);
    ctx.fill();

    // Radial burst splatters
    const count = 12 + Math.floor(Math.random() * 8);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const dist = radius * (0.4 + Math.random() * 0.8);
      const dotR = radius * (0.08 + Math.random() * 0.18);
      const dx = cx + Math.cos(angle) * dist;
      const dy = cy + Math.sin(angle) * dist;

      ctx.globalAlpha = brush.opacity * (0.3 + Math.random() * 0.6);
      ctx.fillStyle = `hsl(${brush.hue + (Math.random() - 0.5) * 30}, 75%, ${50 + Math.random() * 20}%)`;
      ctx.beginPath();
      ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Connecting streaks from center to some splatters
    ctx.strokeStyle = `hsl(${brush.hue}, 70%, 60%)`;
    ctx.lineWidth = brush.width * 0.3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * Math.PI * 2;
      const len = radius * (0.5 + Math.random() * 0.6);
      ctx.globalAlpha = brush.opacity * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      ctx.stroke();
    }

    ctx.restore();
    this.strokePoints += count;
  }

  // ─── Overlay / Reveal ───────────────────────────────────────────────────

  /** Start painting: hide canvas with overlay */
  hideCanvas(): void {
    this.overlayOpacity = 1;
    this.overlayTarget = 1;
    this.isFading = false;
    this.drawOverlay();
  }

  /** Start reveal: fade overlay out over fadeDuration seconds */
  startReveal(): void {
    this.overlayTarget = 0;
    this.fadeStart = performance.now();
    this.isFading = true;
  }

  /** Instant reveal (hard cut) */
  revealInstant(): void {
    this.overlayOpacity = 0;
    this.overlayTarget = 0;
    this.isFading = false;
    this.drawOverlay();
  }

  /** Update overlay fade animation. Returns reveal progress (0–1). */
  updateOverlay(): number {
    if (this.isFading) {
      const elapsed = (performance.now() - this.fadeStart) / 1000;
      const progress = Math.min(1, elapsed / this.fadeDuration);

      // Ease-out cubic for smooth fade
      const eased = 1 - Math.pow(1 - progress, 3);
      this.overlayOpacity = 1 - eased;

      if (progress >= 1) {
        this.overlayOpacity = 0;
        this.isFading = false;
      }

      this.drawOverlay();
      return eased;
    }
    return this.overlayOpacity === 0 ? 1 : 0;
  }

  /** Returns true if overlay is fully transparent */
  isRevealed(): boolean {
    return this.overlayOpacity <= 0 && !this.isFading;
  }

  isFadingOut(): boolean {
    return this.isFading;
  }

  getOverlayOpacity(): number {
    return this.overlayOpacity;
  }

  /** Clear the painting canvas */
  clearPainting(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.strokePoints = 0;
  }

  /** Export painting as PNG data URL */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    if (this.overlayOpacity <= 0) return;

    if (this.isFading) {
      // ─── Dramatic radial dissolve ───────────────────────────────
      // A transparent hole expands from the center outward
      const cx = w / 2;
      const cy = h / 2;
      const maxRadius = Math.sqrt(cx * cx + cy * cy) * 1.15;
      const progress = 1 - this.overlayOpacity;          // 0 → 1
      const radius = progress * maxRadius;
      const feather = maxRadius * 0.22;

      // Solid overlay base
      ctx.fillStyle = 'rgba(10, 10, 15, 1)';
      ctx.fillRect(0, 0, w, h);

      // Punch a radial hole using destination-out compositing
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const grad = ctx.createRadialGradient(
        cx, cy, Math.max(0, radius - feather),
        cx, cy, radius + feather * 0.3,
      );
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.6, 'rgba(0,0,0,0.8)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // Subtle glow ring at the dissolve edge
      if (radius > 10 && progress < 0.9) {
        ctx.save();
        ctx.globalAlpha = 0.15 * (1 - progress);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // Standard solid overlay (painting mode)
      ctx.fillStyle = `rgba(10, 10, 15, ${this.overlayOpacity})`;
      ctx.fillRect(0, 0, w, h);

      // Subtle text when eyes are closed and overlay is mostly opaque
      if (this.overlayOpacity > 0.7) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.08 * this.overlayOpacity})`;
        ctx.font = '14px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('painting…', w / 2, h / 2);
      }
    }
  }
}
