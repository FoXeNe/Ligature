import { getStroke } from 'perfect-freehand';
import type { Bbox } from './api';
import type { Camera } from './camera';
import { inflate, linkEndpoints, type Vec } from './geometry';
import { STROKE_SIZE, type Model, type ObjRec, type StrokeRec } from './model';
import { intersects } from './spatial';

/** Colors resolved from the CSS tokens in app.css; refreshed on theme change. */
export const theme = {
  ink: '#1d1d1f',
  muted: '#8a8a8e',
  panel: '#ffffff',
  line: '#e3e1db',
  accent: '#7c6cf0',
  danger: '#ff3b30',
};

export function syncTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const key of Object.keys(theme) as (keyof typeof theme)[]) {
    const v = cs.getPropertyValue(`--${key}`).trim();
    if (v) theme[key] = v;
  }
}

export const STROKE_OPTS = {
  size: STROKE_SIZE,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
};

/** Screen-space padding between an object's ink and its frame. */
export const FRAME_PAD_PX = 8;
const LABEL_H_PX = 22;
const ARROW_PX = 9;

// ---- stroke geometry -------------------------------------------------------------

const pathCache = new WeakMap<StrokeRec, Path2D>();
const lineCache = new WeakMap<StrokeRec, Path2D>();

function polyToPath(poly: number[][]): Path2D {
  const p = new Path2D();
  if (poly.length === 0) return p;
  p.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) p.lineTo(poly[i][0], poly[i][1]);
  p.closePath();
  return p;
}

function toInput(pts: ArrayLike<number>): number[][] {
  const out: number[][] = new Array(pts.length / 3);
  for (let i = 0, j = 0; i < pts.length; i += 3, j++) out[j] = [pts[i], pts[i + 1], pts[i + 2]];
  return out;
}

/** Outline of a stroke, built once per stroke record and cached. */
export function strokePath(s: StrokeRec): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = polyToPath(getStroke(toInput(s.pts), STROKE_OPTS));
    pathCache.set(s, p);
  }
  return p;
}

/** Center line of a stroke: cheap to build, used when the stroke is small on screen. */
function strokeLine(s: StrokeRec): Path2D {
  let p = lineCache.get(s);
  if (!p) {
    p = new Path2D();
    const pts = s.pts;
    p.moveTo(pts[0], pts[1]);
    for (let i = 3; i < pts.length; i += 3) p.lineTo(pts[i], pts[i + 1]);
    if (pts.length === 3) p.lineTo(pts[0] + 0.01, pts[1]);
    lineCache.set(s, p);
  }
  return p;
}

export function draftPath(pts: number[]): Path2D {
  return polyToPath(getStroke(toInput(pts), { ...STROKE_OPTS, last: false }));
}

/** World-space area an object occupies on screen: frame plus the label above it. */
export function objectRegion(o: ObjRec, z: number): Bbox {
  const pad = FRAME_PAD_PX / z;
  const labelW = o.label ? (o.label.length * 7.5 + 24) / z : 0;
  return [
    o.bbox[0] - pad - 2 / z,
    o.bbox[1] - pad - (o.label ? LABEL_H_PX + 6 : 2) / z,
    Math.max(o.bbox[2] + pad, o.bbox[0] - pad + labelW) + 2 / z,
    o.bbox[3] + pad + 2 / z,
  ];
}

export function frameOf(o: ObjRec, z: number): Bbox {
  return inflate(o.bbox, FRAME_PAD_PX / z);
}

export function linkGeometry(a: ObjRec, b: ObjRec, z: number): [Vec, Vec] {
  return linkEndpoints(frameOf(a, z), frameOf(b, z));
}

function roundRect(ctx: CanvasRenderingContext2D, b: Bbox, r: number) {
  ctx.beginPath();
  ctx.roundRect(b[0], b[1], b[2] - b[0], b[3] - b[1], r);
}

function arrowHead(ctx: CanvasRenderingContext2D, tip: Vec, from: Vec, size: number) {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(tip[0] - size * Math.cos(ang - spread), tip[1] - size * Math.sin(ang - spread));
  ctx.lineTo(tip[0] - size * Math.cos(ang + spread), tip[1] - size * Math.sin(ang + spread));
  ctx.closePath();
  ctx.fill();
}

function drawLink(ctx: CanvasRenderingContext2D, p1: Vec, p2: Vec, z: number) {
  ctx.beginPath();
  ctx.moveTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.stroke();
  arrowHead(ctx, p2, p1, ARROW_PX / z);
}

// ---- static layer ------------------------------------------------------------------

/**
 * Committed content: object frames, strokes, links, labels.
 *
 * The bitmap is a cache. Panning shifts it and draws only the uncovered strips;
 * zooming scales it as a preview and re-renders sharply once input settles;
 * edits re-render only the world rectangles they touched. A full redraw of
 * 100k strokes therefore never happens per frame.
 */
export class StaticLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Camera the current bitmap corresponds to; null means "nothing valid". */
  private rendered: Camera | null = null;
  private dpr = 1;
  /** Bitmap was scaled from another zoom level and needs a sharp re-render. */
  blurry = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true })!;
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.rendered = null;
  }

  invalidateAll() {
    this.rendered = null;
  }

  /** Brings the bitmap in line with `cam`, then re-renders the dirty world rects. */
  sync(m: Model, cam: Camera, dirty: Bbox[]) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const r = this.rendered;

    if (!r) {
      this.rendered = cam.clone();
      this.blurry = false;
      this.renderDevice(m, [0, 0, W, H]);
      return;
    }

    if (r.z !== cam.z) {
      // Scale the old bitmap as a preview, then fill the uncovered border sharply.
      const s = cam.z / r.z;
      const ox = this.dpr * cam.z * (r.x - cam.x);
      const oy = this.dpr * cam.z * (r.y - cam.y);
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(this.canvas, ox, oy, W * s, H * s);
      ctx.restore();
      this.rendered = cam.clone();
      this.blurry = true;
      for (const strip of uncovered(W, H, ox, oy, W * s, H * s)) this.renderDevice(m, strip);
    } else if (r.x !== cam.x || r.y !== cam.y) {
      // Shift by whole device pixels so the bitmap never gets resampled.
      const k = this.dpr * cam.z;
      const dx = Math.round((r.x - cam.x) * k);
      const dy = Math.round((r.y - cam.y) * k);
      if (Math.abs(dx) >= W || Math.abs(dy) >= H) {
        this.rendered = cam.clone();
        this.renderDevice(m, [0, 0, W, H]);
      } else if (dx !== 0 || dy !== 0) {
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(this.canvas, dx, dy);
        ctx.restore();
        // The bitmap now matches a camera moved by exactly (dx, dy) pixels;
        // the sub-pixel remainder (< 0.5 px) is ignored until the next full render.
        const next = r.clone();
        next.x -= dx / k;
        next.y -= dy / k;
        this.rendered = next;
        for (const strip of uncovered(W, H, dx, dy, W, H)) this.renderDevice(m, strip);
      }
    }

    for (const b of dirty) this.renderWorld(m, b);
  }

  /** Full sharp re-render, used once zooming has settled. */
  sharpen(m: Model, cam: Camera) {
    this.rendered = cam.clone();
    this.blurry = false;
    this.renderDevice(m, [0, 0, this.canvas.width, this.canvas.height]);
  }

  private renderWorld(m: Model, b: Bbox) {
    const r = this.rendered!;
    const k = this.dpr * r.z;
    const x0 = Math.floor((b[0] - r.x) * k) - 1;
    const y0 = Math.floor((b[1] - r.y) * k) - 1;
    const x1 = Math.ceil((b[2] - r.x) * k) + 1;
    const y1 = Math.ceil((b[3] - r.y) * k) + 1;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rect: Bbox = [Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1)];
    if (rect[2] > rect[0] && rect[3] > rect[1]) this.renderDevice(m, rect);
  }

  /** Clears and redraws everything inside a device-pixel rectangle. */
  private renderDevice(m: Model, rect: Bbox) {
    const r = this.rendered!;
    const ctx = this.ctx;
    const dpr = this.dpr;
    const z = r.z;
    const k = dpr * z;
    const [x0, y0, x1, y1] = rect;
    const world: Bbox = [x0 / k + r.x, y0 / k + r.y, x1 / k + r.x, y1 / k + r.y];

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);

    ctx.setTransform(k, 0, 0, k, -k * r.x, -k * r.y);

    // Object frames under the ink.
    const visibleObjects: ObjRec[] = [];
    for (const o of m.objects.values()) {
      if (intersects(objectRegion(o, z), world)) visibleObjects.push(o);
    }
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1 / z;
    for (const o of visibleObjects) {
      roundRect(ctx, frameOf(o, z), 8 / z);
      ctx.stroke();
    }

    // Strokes, with level of detail by on-screen size: under ~2px a dot, under
    // ~12px a plain center line (pressure is invisible there), otherwise the full
    // pressure-sensitive outline. Outlines are the expensive part, so a zoomed-out
    // view of a dense board never builds them for every stroke.
    ctx.fillStyle = theme.ink;
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = STROKE_SIZE * 0.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const tiny = 2 / z;
    const small = 12 / z;
    for (const id of m.grid.query(world)) {
      const s = m.strokes.get(id)!;
      const b = s.bbox;
      const size = Math.max(b[2] - b[0], b[3] - b[1]);
      if (size < tiny) {
        ctx.fillRect(b[0], b[1], Math.max(b[2] - b[0], 1 / z), Math.max(b[3] - b[1], 1 / z));
      } else if (size < small) {
        ctx.stroke(strokeLine(s));
      } else {
        ctx.fill(strokePath(s));
      }
    }

    // Labels in screen space so they stay readable at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const o of visibleObjects) {
      if (!o.label) continue;
      const f = frameOf(o, z);
      const sx = (f[0] - r.x) * z;
      const sy = (f[1] - r.y) * z;
      const w = Math.min(ctx.measureText(o.label).width, 260) + 16;
      ctx.fillStyle = theme.panel;
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(sx, sy - LABEL_H_PX - 4, w, LABEL_H_PX, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.ink;
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy - LABEL_H_PX - 4, w - 8, LABEL_H_PX);
      ctx.clip();
      ctx.fillText(o.label, sx + 8, sy - LABEL_H_PX / 2 - 4);
      ctx.restore();
    }

    // Links last, so arrowheads stay visible even where they meet a label.
    ctx.setTransform(k, 0, 0, k, -k * r.x, -k * r.y);
    ctx.strokeStyle = theme.muted;
    ctx.fillStyle = theme.muted;
    ctx.lineWidth = 1.25 / z;
    for (const l of m.links.values()) {
      const a = m.objects.get(l.from_id);
      const b = m.objects.get(l.to_id);
      if (!a || !b) continue;
      const [p1, p2] = linkGeometry(a, b, z);
      const pad = ARROW_PX / z;
      const lb: Bbox = [
        Math.min(p1[0], p2[0]) - pad,
        Math.min(p1[1], p2[1]) - pad,
        Math.max(p1[0], p2[0]) + pad,
        Math.max(p1[1], p2[1]) + pad,
      ];
      if (intersects(lb, world)) drawLink(ctx, p1, p2, z);
    }

    ctx.restore();
  }
}

/** Parts of a W×H canvas not covered by an image drawn at (x, y) with size (w, h). */
function uncovered(W: number, H: number, x: number, y: number, w: number, h: number): Bbox[] {
  const out: Bbox[] = [];
  const l = Math.max(0, Math.floor(x));
  const t = Math.max(0, Math.floor(y));
  const r = Math.min(W, Math.ceil(x + w));
  const b = Math.min(H, Math.ceil(y + h));
  if (l >= r || t >= b) return [[0, 0, W, H]];
  if (t > 0) out.push([0, 0, W, t]);
  if (b < H) out.push([0, b, W, H]);
  if (l > 0) out.push([0, t, l, b]);
  if (r < W) out.push([r, t, W, b]);
  return out;
}

// ---- active layer ------------------------------------------------------------------

export interface ActiveView {
  /** Pen draft in world space, x y pressure per point. */
  draft?: number[];
  lasso?: Vec[];
  /** Arrow being dragged from an object frame to the pointer. */
  arrow?: { from: ObjRec; to: Vec; target: ObjRec | null } | null;
  hover?: ObjRec | null;
  selected?: ObjRec | null;
  hoverLink?: { a: ObjRec; b: ObjRec } | null;
  /** Strokes picked by the lasso, waiting for a name. */
  picked?: StrokeRec[];
  eraser?: { x: number; y: number; r: number } | null;
  /** Pen position, drawn as the cursor so it always sits exactly on the ink. */
  penDot?: { x: number; y: number; r: number } | null;
}

/** Transient overlays, redrawn on pointer moves. Cheap: never touches committed ink. */
export function drawActive(ctx: CanvasRenderingContext2D, cam: Camera, v: ActiveView, dpr: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const z = cam.z;
  const k = dpr * z;
  ctx.setTransform(k, 0, 0, k, -k * cam.x, -k * cam.y);

  if (v.selected) {
    roundRect(ctx, frameOf(v.selected, z), 8 / z);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2 / z;
    ctx.stroke();
  }

  if (v.hover && v.hover !== v.selected) {
    roundRect(ctx, frameOf(v.hover, z), 8 / z);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5 / z;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (v.hoverLink) {
    const [p1, p2] = linkGeometry(v.hoverLink.a, v.hoverLink.b, z);
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 2.5 / z;
    drawLink(ctx, p1, p2, z);
  }

  if (v.picked) {
    ctx.fillStyle = theme.accent;
    for (const s of v.picked) ctx.fill(strokePath(s));
  }

  if (v.draft && v.draft.length >= 3) {
    ctx.fillStyle = theme.ink;
    ctx.fill(draftPath(v.draft));
  }

  if (v.lasso && v.lasso.length > 1) {
    ctx.beginPath();
    ctx.moveTo(v.lasso[0][0], v.lasso[0][1]);
    for (let i = 1; i < v.lasso.length; i++) ctx.lineTo(v.lasso[i][0], v.lasso[i][1]);
    ctx.closePath();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (v.arrow) {
    const { from, to, target } = v.arrow;
    if (target) {
      roundRect(ctx, frameOf(target, z), 8 / z);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / z;
      ctx.stroke();
    }
    const end: Vec = target ? linkGeometry(from, target, z)[1] : to;
    const start = target ? linkGeometry(from, target, z)[0] : linkEndpoints(frameOf(from, z), [to[0], to[1], to[0], to[1]])[0];
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash(target ? [] : [6 / z, 5 / z]);
    drawLink(ctx, start, end, z);
    ctx.setLineDash([]);
  }

  if (v.penDot) {
    const { x, y, r } = v.penDot;
    // Ring for visibility, dot the size of the nib at its exact position.
    ctx.beginPath();
    ctx.arc(x, y, r + 4 / z, 0, Math.PI * 2);
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1 / z;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.ink;
    ctx.fill();
  }

  if (v.eraser) {
    ctx.beginPath();
    ctx.arc(v.eraser.x, v.eraser.y, v.eraser.r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = theme.danger;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.danger;
    ctx.lineWidth = 1.25 / z;
    ctx.stroke();
  }
}

