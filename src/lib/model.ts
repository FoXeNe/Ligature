import type { Bbox, BoardMeta, ObjectRow, Patch, StrokeRow } from './api';
import { SpatialGrid } from './spatial';

/** Pen diameter in world units at full pressure. */
export const STROKE_SIZE = 3;

/** Object: a named group of strokes. Its bbox is always derived from its strokes. */
export interface ObjRec {
  readonly id: number;
  readonly label: string;
  readonly tags: string;
  readonly bbox: Bbox;
  readonly x: number;
  readonly y: number;
}

/**
 * Stroke: world-space points packed as x, y, pressure.
 * Records are immutable: a change replaces the record, which also keeps
 * undo snapshots and render caches (keyed by record) correct for free.
 */
export interface StrokeRec {
  readonly id: number;
  readonly object_id: number | null;
  readonly pts: Float32Array;
  /** Bounds of the drawn ink, i.e. points padded by the pen radius. */
  readonly bbox: Bbox;
}

/** Link: a row in the database. The line on the canvas is only its drawing. */
export interface LinkRec {
  readonly from_id: number;
  readonly to_id: number;
  readonly kind: string;
}

export type Kind = 'o' | 's' | 'l';
type Rec = ObjRec | StrokeRec | LinkRec;

/** One touched entity. Holding both states lets the same change be applied or undone. */
export interface Entry {
  readonly kind: Kind;
  readonly key: string;
  before: Rec | null;
  after: Rec | null;
}

export const linkKey = (from: number, to: number, kind: string) => `${from}>${to}>${kind}`;

/** Random 48-bit id: unique without asking the database, exact in both JS and SQLite. */
export function newId(taken: (id: number) => boolean): number {
  const buf = new Uint32Array(2);
  for (;;) {
    crypto.getRandomValues(buf);
    const id = (buf[0] & 0xffffff) * 0x1000000 + (buf[1] & 0xffffff);
    if (id > 0 && !taken(id)) return id;
  }
}

export function pointsBbox(pts: Float32Array, pad = STROKE_SIZE / 2): Bbox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function unionBbox(list: Iterable<Bbox>): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of list) {
    if (r[0] < b[0]) b[0] = r[0];
    if (r[1] < b[1]) b[1] = r[1];
    if (r[2] > b[2]) b[2] = r[2];
    if (r[3] > b[3]) b[3] = r[3];
  }
  return b;
}

export const bboxArea = (b: Bbox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export function makeStroke(id: number, objectId: number | null, pts: Float32Array): StrokeRec {
  return { id, object_id: objectId, pts, bbox: pointsBbox(pts) };
}

/** An object record whose bbox and center are recomputed from its strokes. */
export function objectFromStrokes(base: Omit<ObjRec, 'bbox' | 'x' | 'y'>, strokes: StrokeRec[]): ObjRec {
  const bbox = unionBbox(strokes.map((s) => s.bbox));
  return { ...base, bbox, x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 };
}

// ---- encoding ------------------------------------------------------------------

function bytesToB64(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function encodePts(pts: Float32Array): string {
  return bytesToB64(new Uint8Array(pts.buffer, pts.byteOffset, pts.byteLength));
}

export function decodePts(b64: string): Float32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

/**
 * Parses the binary dump from `load_strokes` (see `pack_stroke` in store.rs):
 * `u32 count`, then per stroke `f64 id | f64 object_id (-1 = none) | u32 n | f32 * n`.
 * Point arrays are views into the buffer, so loading copies nothing.
 */
export function decodeStrokes(buf: ArrayBuffer): StrokeRec[] {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const out: StrokeRec[] = new Array(count);
  let off = 4;
  for (let i = 0; i < count; i++) {
    const id = dv.getFloat64(off, true);
    const obj = dv.getFloat64(off + 8, true);
    const n = dv.getUint32(off + 16, true);
    off += 20;
    const pts = new Float32Array(buf, off, n);
    off += n * 4;
    out[i] = makeStroke(id, obj < 0 ? null : obj, pts);
  }
  return out;
}

// ---- in-memory board ------------------------------------------------------------

/**
 * One board in memory. All mutations go through the methods below so the
 * indexes (strokes per object, links per object, spatial grid) never drift.
 */
export class Model {
  readonly noteId: number;
  readonly objects = new Map<number, ObjRec>();
  readonly strokes = new Map<number, StrokeRec>();
  readonly links = new Map<string, LinkRec>();
  readonly grid = new SpatialGrid();
  private byObject = new Map<number, Set<number>>();
  private linksByObject = new Map<number, Set<string>>();

  constructor(noteId: number) {
    this.noteId = noteId;
  }

  static load(noteId: number, meta: BoardMeta, strokes: StrokeRec[]): Model {
    const m = new Model(noteId);
    for (const o of meta.objects) {
      m.setObject({ id: o.id, label: o.label, tags: o.tags, bbox: o.bbox, x: o.x, y: o.y });
    }
    for (const s of strokes) m.setStroke(s);
    for (const l of meta.links) m.setLink({ from_id: l.from_id, to_id: l.to_id, kind: l.kind });
    return m;
  }

  setStroke(s: StrokeRec) {
    const old = this.strokes.get(s.id);
    if (old && old.object_id !== null && old.object_id !== s.object_id) {
      this.byObject.get(old.object_id)?.delete(s.id);
    }
    this.strokes.set(s.id, s);
    this.grid.insert(s.id, s.bbox);
    if (s.object_id !== null) {
      let set = this.byObject.get(s.object_id);
      if (!set) this.byObject.set(s.object_id, (set = new Set()));
      set.add(s.id);
    }
  }

  removeStroke(id: number) {
    const s = this.strokes.get(id);
    if (!s) return;
    this.strokes.delete(id);
    this.grid.remove(id);
    if (s.object_id !== null) this.byObject.get(s.object_id)?.delete(id);
  }

  setObject(o: ObjRec) {
    this.objects.set(o.id, o);
  }

  removeObject(id: number) {
    this.objects.delete(id);
  }

  setLink(l: LinkRec) {
    const k = linkKey(l.from_id, l.to_id, l.kind);
    this.links.set(k, l);
    for (const id of [l.from_id, l.to_id]) {
      let set = this.linksByObject.get(id);
      if (!set) this.linksByObject.set(id, (set = new Set()));
      set.add(k);
    }
  }

  removeLink(k: string) {
    const l = this.links.get(k);
    if (!l) return;
    this.links.delete(k);
    this.linksByObject.get(l.from_id)?.delete(k);
    this.linksByObject.get(l.to_id)?.delete(k);
  }

  strokesOf(objectId: number): StrokeRec[] {
    const ids = this.byObject.get(objectId);
    if (!ids) return [];
    const out: StrokeRec[] = [];
    for (const id of ids) {
      const s = this.strokes.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  linksOf(objectId: number): LinkRec[] {
    const keys = this.linksByObject.get(objectId);
    if (!keys) return [];
    const out: LinkRec[] = [];
    for (const k of keys) {
      const l = this.links.get(k);
      if (l) out.push(l);
    }
    return out;
  }

  strokesIn(b: Bbox): StrokeRec[] {
    const out: StrokeRec[] = [];
    for (const id of this.grid.query(b)) out.push(this.strokes.get(id)!);
    return out;
  }

  /** Bounds of all ink on the board, or null when the board is empty. */
  contentBbox(): Bbox | null {
    if (this.strokes.size === 0) return null;
    return unionBbox(Array.from(this.strokes.values(), (s) => s.bbox));
  }

  taken(id: number): boolean {
    return this.objects.has(id) || this.strokes.has(id);
  }
}

// ---- transactions ---------------------------------------------------------------

/** Collects the mutations of one user action, remembering each entity's state before it. */
export class Tx {
  private seen = new Map<string, Entry>();
  private m: Model;

  constructor(m: Model) {
    this.m = m;
  }

  private entry(kind: Kind, key: string, current: Rec | null): Entry {
    let e = this.seen.get(kind + key);
    if (!e) {
      e = { kind, key, before: current, after: current };
      this.seen.set(kind + key, e);
    }
    return e;
  }

  putObject(o: ObjRec) {
    const e = this.entry('o', String(o.id), this.m.objects.get(o.id) ?? null);
    this.m.setObject(o);
    e.after = o;
  }

  deleteObject(id: number) {
    const e = this.entry('o', String(id), this.m.objects.get(id) ?? null);
    this.m.removeObject(id);
    e.after = null;
  }

  putStroke(s: StrokeRec) {
    const e = this.entry('s', String(s.id), this.m.strokes.get(s.id) ?? null);
    this.m.setStroke(s);
    e.after = s;
  }

  deleteStroke(id: number) {
    const e = this.entry('s', String(id), this.m.strokes.get(id) ?? null);
    this.m.removeStroke(id);
    e.after = null;
  }

  putLink(l: LinkRec) {
    const k = linkKey(l.from_id, l.to_id, l.kind);
    const e = this.entry('l', k, this.m.links.get(k) ?? null);
    this.m.setLink(l);
    e.after = l;
  }

  deleteLink(l: LinkRec) {
    const k = linkKey(l.from_id, l.to_id, l.kind);
    const e = this.entry('l', k, this.m.links.get(k) ?? null);
    this.m.removeLink(k);
    e.after = null;
  }

  /** Deletes an object with its strokes and links, mirroring the database cascade. */
  deleteObjectCascade(id: number) {
    for (const s of this.m.strokesOf(id)) this.deleteStroke(s.id);
    for (const l of this.m.linksOf(id)) this.deleteLink(l);
    this.deleteObject(id);
  }

  /** Entries whose state actually changed. */
  changes(): Entry[] {
    return [...this.seen.values()].filter((e) => e.before !== e.after);
  }
}

export function invert(entries: Entry[]): Entry[] {
  return entries.map((e) => ({ kind: e.kind, key: e.key, before: e.after, after: e.before }));
}

/**
 * Applies entries to the model (undo/redo). Objects go first and links last,
 * matching the order the database applies a patch in.
 */
export function applyEntries(m: Model, entries: Entry[]) {
  const order: Kind[] = ['o', 's', 'l'];
  for (const kind of order) {
    for (const e of entries) {
      if (e.kind !== kind) continue;
      if (kind === 'o') {
        if (e.after) m.setObject(e.after as ObjRec);
        else m.removeObject(Number(e.key));
      } else if (kind === 's') {
        if (e.after) m.setStroke(e.after as StrokeRec);
        else m.removeStroke(Number(e.key));
      } else {
        if (e.after) m.setLink(e.after as LinkRec);
        else m.removeLink(e.key);
      }
    }
  }
}

/** Converts entries to the Rust patch format. A delete always has a `before`. */
export function toPatch(noteId: number, entries: Entry[]): Patch {
  const patch: Patch = {
    strokes: { upsert: [], delete: [] },
    objects: { upsert: [], delete: [] },
    links: { upsert: [], delete: [] },
  };
  for (const e of entries) {
    if (e.kind === 'o') {
      if (e.after) {
        const o = e.after as ObjRec;
        const row: ObjectRow = { id: o.id, note_id: noteId, label: o.label, tags: o.tags, bbox: o.bbox, x: o.x, y: o.y };
        patch.objects.upsert.push(row);
      } else {
        patch.objects.delete.push((e.before as ObjRec).id);
      }
    } else if (e.kind === 's') {
      if (e.after) {
        const s = e.after as StrokeRec;
        const row: StrokeRow = { id: s.id, note_id: noteId, object_id: s.object_id, data: encodePts(s.pts) };
        patch.strokes.upsert.push(row);
      } else {
        patch.strokes.delete.push((e.before as StrokeRec).id);
      }
    } else {
      const l = (e.after ?? e.before) as LinkRec;
      const row = { from_id: l.from_id, to_id: l.to_id, kind: l.kind };
      if (e.after) patch.links.upsert.push(row);
      else patch.links.delete.push(row);
    }
  }
  return patch;
}

/** Tags are stored as a comma-separated list without empty or duplicate entries. */
export function normalizeTags(raw: string): string {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim().replace(/^#/, '');
    if (t) seen.add(t);
  }
  return [...seen].join(', ');
}

export function splitTags(tags: string): string[] {
  return tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
}
