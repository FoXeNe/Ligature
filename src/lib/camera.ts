import type { Bbox } from './api';

/** Maps world space to screen space: screen = (world - origin) * zoom. */
export class Camera {
  /** World coordinate shown at the top-left corner of the canvas. */
  x = 0;
  y = 0;
  z = 1;

  static readonly MIN_Z = 0.02;
  static readonly MAX_Z = 32;

  clone(): Camera {
    const c = new Camera();
    c.x = this.x;
    c.y = this.y;
    c.z = this.z;
    return c;
  }

  equals(o: Camera): boolean {
    return this.x === o.x && this.y === o.y && this.z === o.z;
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [sx / this.z + this.x, sy / this.z + this.y];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.z, (wy - this.y) * this.z];
  }

  panBy(sdx: number, sdy: number) {
    this.x -= sdx / this.z;
    this.y -= sdy / this.z;
  }

  /** Zooms while keeping the world point under the cursor fixed. */
  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.z = clampZoom(this.z * factor);
    this.x = wx - sx / this.z;
    this.y = wy - sy / this.z;
  }

  centerOn(wx: number, wy: number, viewW: number, viewH: number, z = this.z) {
    this.z = clampZoom(z);
    this.x = wx - viewW / (2 * this.z);
    this.y = wy - viewH / (2 * this.z);
  }

  /** Zoom at which `b` fits the view with a margin, never closer than `maxZ`. */
  static fitZoom(b: Bbox, viewW: number, viewH: number, maxZ: number, margin = 0.8): number {
    const w = Math.max(b[2] - b[0], 1);
    const h = Math.max(b[3] - b[1], 1);
    return clampZoom(Math.min((viewW * margin) / w, (viewH * margin) / h, maxZ));
  }
}

export function clampZoom(z: number): number {
  return Math.min(Camera.MAX_Z, Math.max(Camera.MIN_Z, z));
}
