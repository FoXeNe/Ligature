import type { Bbox } from './api';

/**
 * Uniform grid over world space. Each id is registered in every cell its bbox
 * touches, so a rectangle query only looks at nearby items instead of all of them.
 * With 100k strokes this is what keeps erasing, lassoing and redraws fast.
 */
export class SpatialGrid {
  private cells = new Map<number, Set<number>>();
  private boxes = new Map<number, Bbox>();
  private readonly size: number;

  constructor(cellSize = 256) {
    this.size = cellSize;
  }

  // Cell coordinates are packed into one number; ±2^20 cells is ±268M world units.
  private key(cx: number, cy: number): number {
    return (cx + 0x100000) * 0x200000 + (cy + 0x100000);
  }

  private range(b: Bbox): [number, number, number, number] {
    const s = this.size;
    return [Math.floor(b[0] / s), Math.floor(b[1] / s), Math.floor(b[2] / s), Math.floor(b[3] / s)];
  }

  insert(id: number, b: Bbox) {
    this.remove(id);
    this.boxes.set(id, b);
    const [x0, y0, x1, y1] = this.range(b);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = new Set()));
        cell.add(id);
      }
    }
  }

  remove(id: number) {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    const [x0, y0, x1, y1] = this.range(b);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const cell = this.cells.get(k);
        if (!cell) continue;
        cell.delete(id);
        if (cell.size === 0) this.cells.delete(k);
      }
    }
  }

  /** Ids whose bbox intersects `q`. */
  query(q: Bbox, out: Set<number> = new Set()): Set<number> {
    const [x0, y0, x1, y1] = this.range(q);
    const visit = (cell: Set<number>) => {
      for (const id of cell) {
        if (!out.has(id) && intersects(this.boxes.get(id)!, q)) out.add(id);
      }
    };
    // A huge query (zoomed far out) would probe millions of empty cells;
    // walk the occupied cells instead.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const [k, cell] of this.cells) {
        const cx = Math.floor(k / 0x200000) - 0x100000;
        const cy = (k % 0x200000) - 0x100000;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) visit(cell);
      }
      return out;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) visit(cell);
      }
    }
    return out;
  }

  get count(): number {
    return this.boxes.size;
  }
}

export function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
