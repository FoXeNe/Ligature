import type { Bbox } from './api';

export type Vec = [number, number];

export function inBbox(b: Bbox, x: number, y: number, pad = 0): boolean {
  return x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
}

export function inflate(b: Bbox, d: number): Bbox {
  return [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
}

export const bboxCenter = (b: Bbox): Vec => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export function polyBbox(poly: Vec[]): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}

/** Even-odd ray casting. */
export function pointInPoly(x: number, y: number, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Share of a stroke's points (x y p triples) inside a polygon. Sampling at most
 * `samples` points keeps long strokes cheap without changing the answer much.
 */
export function fractionInside(pts: ArrayLike<number>, poly: Vec[], samples = 24): number {
  const n = pts.length / 3;
  if (n === 0) return 0;
  const step = Math.max(1, Math.floor(n / samples));
  let total = 0;
  let inside = 0;
  for (let i = 0; i < n; i += step) {
    total++;
    if (pointInPoly(pts[i * 3], pts[i * 3 + 1], poly)) inside++;
  }
  return inside / total;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a polyline (x y p triples) passes within `r` of a point, segments included. */
export function polylineNear(pts: ArrayLike<number>, x: number, y: number, r: number): boolean {
  const n = pts.length / 3;
  if (n === 1) return Math.hypot(pts[0] - x, pts[1] - y) <= r;
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 3;
    const b = a + 3;
    if (distToSegment(x, y, pts[a], pts[a + 1], pts[b], pts[b + 1]) <= r) return true;
  }
  return false;
}

/**
 * Parameter t >= 0 at which a ray from (cx, cy) along (dx, dy) leaves the box.
 * Used to clip a link line to the frames of its two ends.
 */
export function exitT(cx: number, cy: number, dx: number, dy: number, b: Bbox): number {
  const tx = dx > 0 ? (b[2] - cx) / dx : dx < 0 ? (b[0] - cx) / dx : Infinity;
  const ty = dy > 0 ? (b[3] - cy) / dy : dy < 0 ? (b[1] - cy) / dy : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

/** Start and end of a link line, clipped to the boxes of both ends. */
export function linkEndpoints(a: Bbox, b: Bbox): [Vec, Vec] {
  const [ax, ay] = bboxCenter(a);
  const [bx, by] = bboxCenter(b);
  const dx = bx - ax;
  const dy = by - ay;
  const ta = exitT(ax, ay, dx, dy, a);
  const tb = exitT(bx, by, -dx, -dy, b);
  return [
    [ax + dx * ta, ay + dy * ta],
    [bx - dx * tb, by - dy * tb],
  ];
}
