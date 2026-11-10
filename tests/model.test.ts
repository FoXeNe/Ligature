import { describe, expect, test } from 'vitest';
import type { BoardMeta } from '../src/lib/api';
import {
  applyEntries,
  decodePts,
  decodeStrokes,
  encodePts,
  invert,
  linkKey,
  makeStroke,
  Model,
  normalizeTags,
  objectFromStrokes,
  toPatch,
  Tx,
} from '../src/lib/model';

const pts = (...v: number[]) => new Float32Array(v);
const emptyMeta: BoardMeta = { objects: [], links: [] };

/** Builds the same binary layout as `pack_stroke` in store.rs. */
function packStrokes(rows: { id: number; obj: number | null; data: number[] }[]): ArrayBuffer {
  const size = 4 + rows.reduce((n, r) => n + 20 + r.data.length * 4, 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, rows.length, true);
  let off = 4;
  for (const r of rows) {
    dv.setFloat64(off, r.id, true);
    dv.setFloat64(off + 8, r.obj ?? -1, true);
    dv.setUint32(off + 16, r.data.length, true);
    off += 20;
    for (const f of r.data) {
      dv.setFloat32(off, f, true);
      off += 4;
    }
  }
  return buf;
}

/** A board with objects 1 and 2, one stroke each, and a link 1 → 2. */
function twoObjects(): Model {
  const m = new Model(7);
  const s5 = makeStroke(5, 1, pts(0, 0, 0.5, 10, 10, 0.5));
  const s6 = makeStroke(6, 2, pts(100, 0, 0.5, 110, 10, 0.5));
  m.setStroke(s5);
  m.setStroke(s6);
  m.setObject(objectFromStrokes({ id: 1, label: 'A', tags: '' }, [s5]));
  m.setObject(objectFromStrokes({ id: 2, label: 'B', tags: '' }, [s6]));
  m.setLink({ from_id: 1, to_id: 2, kind: 'ref' });
  return m;
}

describe('encoding', () => {
  test('stroke points survive base64 packing', () => {
    const p = pts(1, 2, 0.5, 3.25, -4, 1);
    expect(Array.from(decodePts(encodePts(p)))).toEqual(Array.from(p));
  });

  test('encodes a view into a larger buffer correctly', () => {
    const big = pts(9, 9, 9, 1, 2, 0.5);
    const view = big.subarray(3);
    expect(Array.from(decodePts(encodePts(view)))).toEqual([1, 2, 0.5]);
  });

  test('decodes the binary stroke dump from the backend', () => {
    const buf = packStrokes([
      { id: 2 ** 40 + 3, obj: 77, data: [1, 2, 0.5, 3, 4, 0.75] },
      { id: 9, obj: null, data: [5, 6, 1] },
    ]);
    const [a, b] = decodeStrokes(buf);
    expect(a.id).toBe(2 ** 40 + 3);
    expect(a.object_id).toBe(77);
    expect(Array.from(a.pts)).toEqual([1, 2, 0.5, 3, 4, 0.75]);
    expect(b.object_id).toBeNull();
    // bbox is padded by the pen radius
    expect(a.bbox[0]).toBeLessThan(1);
    expect(a.bbox[2]).toBeGreaterThan(3);
  });
});

describe('model indexes', () => {
  test('load builds per-object and spatial indexes', () => {
    const strokes = decodeStrokes(packStrokes([{ id: 5, obj: 1, data: [0, 0, 0.5] }]));
    const m = Model.load(
      1,
      { objects: [{ id: 1, note_id: 1, label: 'A', tags: '', bbox: [0, 0, 1, 1], x: 0, y: 0 }], links: [] },
      strokes,
    );
    expect(m.strokesOf(1).map((s) => s.id)).toEqual([5]);
    expect(m.strokesIn([-5, -5, 5, 5]).map((s) => s.id)).toEqual([5]);
    expect(m.strokesIn([50, 50, 60, 60])).toEqual([]);
  });

  test('moving a stroke to another object updates the per-object index', () => {
    const m = twoObjects();
    m.setStroke({ ...m.strokes.get(5)!, object_id: 2 });
    expect(m.strokesOf(1)).toEqual([]);
    expect(m.strokesOf(2).map((s) => s.id).sort()).toEqual([5, 6]);
  });

  test('spatial index follows a moved stroke', () => {
    const m = new Model(1);
    m.setStroke(makeStroke(1, null, pts(0, 0, 0.5)));
    m.setStroke(makeStroke(1, null, pts(1000, 1000, 0.5)));
    expect(m.strokesIn([-5, -5, 5, 5])).toEqual([]);
    expect(m.strokesIn([995, 995, 1005, 1005]).map((s) => s.id)).toEqual([1]);
  });

  test('a far-out query (more cells than occupied) still finds everything', () => {
    const m = new Model(1);
    for (let i = 0; i < 50; i++) m.setStroke(makeStroke(i + 1, null, pts(i * 300, i * 7, 0.5)));
    expect(m.strokesIn([-1e6, -1e6, 1e6, 1e6]).length).toBe(50);
  });
});

describe('transactions', () => {
  test('a new stroke becomes an upsert; its undo becomes a delete', () => {
    const m = Model.load(7, emptyMeta, []);
    const tx = new Tx(m);
    tx.putStroke(makeStroke(11, null, pts(0, 0, 0.5, 4, 4, 0.5)));
    const entries = tx.changes();
    expect(entries).toHaveLength(1);

    const forward = toPatch(7, entries);
    expect(forward.strokes.upsert).toHaveLength(1);
    expect(forward.strokes.upsert[0].note_id).toBe(7);

    const inv = invert(entries);
    applyEntries(m, inv);
    expect(m.strokes.has(11)).toBe(false);
    expect(m.strokesIn([-10, -10, 10, 10])).toEqual([]);
    expect(toPatch(7, inv).strokes.delete).toEqual([11]);
  });

  test('touching an entity without changing it records nothing', () => {
    const m = twoObjects();
    const tx = new Tx(m);
    tx.putStroke(m.strokes.get(5)!);
    expect(tx.changes()).toHaveLength(0);
  });

  test('deleting an object cascades to its strokes and links, all undoable', () => {
    const m = twoObjects();
    const tx = new Tx(m);
    tx.deleteObjectCascade(1);
    const entries = tx.changes();
    expect(m.objects.has(1)).toBe(false);
    expect(m.strokes.has(5)).toBe(false);
    expect(m.links.size).toBe(0);
    expect(m.linksOf(2)).toEqual([]);
    expect(m.strokes.has(6)).toBe(true);

    const patch = toPatch(7, entries);
    expect(patch.objects.delete).toEqual([1]);
    expect(patch.strokes.delete).toEqual([5]);
    expect(patch.links.delete).toEqual([{ from_id: 1, to_id: 2, kind: 'ref' }]);

    applyEntries(m, invert(entries));
    expect(m.objects.has(1)).toBe(true);
    expect(m.strokesOf(1).map((s) => s.id)).toEqual([5]);
    expect(m.links.has(linkKey(1, 2, 'ref'))).toBe(true);
    expect(m.linksOf(2)).toHaveLength(1);
  });

  test('a multi-step gesture keeps the original state for undo', () => {
    const m = twoObjects();
    const orig = m.strokes.get(5)!;
    const tx = new Tx(m);
    tx.putStroke(makeStroke(5, 1, pts(1, 1, 0.5)));
    tx.putStroke(makeStroke(5, 1, pts(2, 2, 0.5)));
    const entries = tx.changes();
    expect(entries).toHaveLength(1);
    applyEntries(m, invert(entries));
    expect(m.strokes.get(5)).toBe(orig);
  });

  test('redo after undo restores the same records', () => {
    const m = twoObjects();
    const tx = new Tx(m);
    tx.deleteObjectCascade(2);
    const entries = tx.changes();
    applyEntries(m, invert(entries));
    applyEntries(m, entries);
    expect(m.objects.has(2)).toBe(false);
    expect(m.links.size).toBe(0);
  });
});

test('object bbox is recomputed from its strokes', () => {
  const a = makeStroke(1, 9, pts(0, 0, 0.5));
  const b = makeStroke(2, 9, pts(20, 10, 0.5));
  const o = objectFromStrokes({ id: 9, label: '', tags: '' }, [a, b]);
  expect(o.bbox[0]).toBeLessThan(0);
  expect(o.bbox[2]).toBeGreaterThan(20);
  expect(o.x).toBeCloseTo(10);
  expect(o.y).toBeCloseTo(5);
});

test('tags are trimmed, de-duplicated and lose a leading #', () => {
  expect(normalizeTags(' #idea, draft,, idea ,draft')).toBe('idea, draft');
  expect(normalizeTags('')).toBe('');
});
