import { expect, test } from 'vitest';
import { Camera } from '../src/lib/camera';
import { distToSegment, fractionInside, linkEndpoints, pointInPoly, polylineNear, type Vec } from '../src/lib/geometry';
import { SpatialGrid } from '../src/lib/spatial';

const square: Vec[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test('point in polygon', () => {
  expect(pointInPoly(5, 5, square)).toBe(true);
  expect(pointInPoly(15, 5, square)).toBe(false);
});

test('lasso coverage counts the share of points inside', () => {
  const inside = [1, 1, 0.5, 2, 2, 0.5, 3, 3, 0.5, 4, 4, 0.5];
  const half = [1, 1, 0.5, 2, 2, 0.5, 20, 20, 0.5, 30, 30, 0.5];
  expect(fractionInside(inside, square)).toBe(1);
  expect(fractionInside(half, square)).toBe(0.5);
});

test('eraser hits a segment between two distant points', () => {
  const line = [0, 0, 0.5, 100, 0, 0.5];
  expect(polylineNear(line, 50, 3, 4)).toBe(true);
  expect(polylineNear(line, 50, 10, 4)).toBe(false);
});

test('distance from a point to a segment', () => {
  expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
  expect(distToSegment(-4, 0, 0, 0, 10, 0)).toBe(4);
});

test('link line is clipped to both boxes', () => {
  const [p1, p2] = linkEndpoints([0, 0, 10, 10], [100, 0, 110, 10]);
  expect(p1[0]).toBeCloseTo(10);
  expect(p1[1]).toBeCloseTo(5);
  expect(p2[0]).toBeCloseTo(100);
  expect(p2[1]).toBeCloseTo(5);
});

test('zooming keeps the point under the cursor fixed', () => {
  const c = new Camera();
  c.x = 40;
  c.y = -20;
  const before = c.toWorld(300, 200);
  c.zoomAt(300, 200, 2.5);
  const after = c.toWorld(300, 200);
  expect(after[0]).toBeCloseTo(before[0]);
  expect(after[1]).toBeCloseTo(before[1]);
});

test('spatial grid: insert, query, remove, items spanning cells', () => {
  const g = new SpatialGrid(100);
  g.insert(1, [10, 10, 20, 20]);
  g.insert(2, [50, 50, 450, 60]); // spans several cells
  g.insert(3, [-500, -500, -490, -490]);
  expect([...g.query([0, 0, 30, 30])]).toEqual([1]);
  expect([...g.query([400, 55, 401, 56])]).toEqual([2]);
  expect([...g.query([-1000, -1000, 1000, 1000])].sort()).toEqual([1, 2, 3]);
  g.remove(2);
  expect([...g.query([400, 55, 401, 56])]).toEqual([]);
  expect(g.count).toBe(2);
});
