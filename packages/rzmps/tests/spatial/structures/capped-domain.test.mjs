import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, Vector3 } from 'three';
import { FLIPSimulation, ParticleSpatialGrid } from '../../../build/index.mjs';

const box = (low, high) => new Box3(new Vector3(...low), new Vector3(...high));

test('FLIP directory deferral preserves the current lattice instead of adopting an unprepared quality', () => {
  const grid = new ParticleSpatialGrid({ bounds: box([-1, -1, -1], [1, 1, 1]),
    brickSubdivisions: 3, cellSubdivisions: 4 });
  const cellSize = grid.cellSize;
  const oldBounds = box([-1, -7, -1], [1, 1, 1]);
  grid.setBounds(grid.resolveBounds(oldBounds));
  const oldDimensions = grid.gridDimensions.clone();
  grid.setBounds(grid.resolveBounds(box([-1, -8, -1], [1, 1, 1])));
  const fluid = new FLIPSimulation();
  fluid.bounds.copy(grid.bounds);
  fluid.workGrid = { bounds: oldBounds, cellSize, gridDimensions: oldDimensions,
    maxDepth: grid.maxDepth, brickSubdivisions: grid.brickSubdivisions, updateLayout: () => false };
  fluid.ensureGridResolution({}, grid);
  assert.equal(grid.cellSize, cellSize, 'coverage rollback must never select a different quality');
  assert(grid.bounds.equals(oldBounds));
  assert(fluid.pendingBounds, 'deferred coverage is retried');
  fluid.workGrid = undefined; fluid.cleanup();
});

test('capped adaptive growth rejects outlier bricks instead of evicting existing coverage', () => {
  const grid = new ParticleSpatialGrid({ bounds: box([-8, -8, -8], [8, 8, 8]), maxBounds: 16,
    brickSubdivisions: 3, cellSubdivisions: 3, autoVolumeQuality: false, volumeQuality: 16,
    autoShrink: true, shrinkDelay: 0 });
  grid.automaticBounds = true;
  const original = grid.bounds.clone();
  for (const position of [-100, 100, -200, 200]) {
    const occupied = box([-1, Math.min(-1, position), -1], [1, Math.max(1, position), 1]);
    const next = grid.resolveOccupiedBounds(occupied, 10000);
    assert.equal(next.min.y, original.min.y);
    assert.equal(next.max.y, original.max.y);
    grid.setBounds(next);
  }
});

test('a capped domain can be off-origin without following disconnected rogue particles', () => {
  const grid = new ParticleSpatialGrid({ bounds: box([20, 20, 20], [36, 36, 36]), maxBounds: 16,
    volumeQuality: 16, autoVolumeQuality: false, brickSubdivisions: 3, cellSubdivisions: 3,
    autoShrink: false });
  grid.automaticBounds = true;
  const original = grid.bounds.clone();
  const next = grid.resolveOccupiedBounds(box([100, 100, 100], [101, 101, 101]), 10000);
  assert(next.equals(original));
});

test('partial remaining capacity admits whole layers without deleting old coverage', () => {
  const grid = new ParticleSpatialGrid({ bounds: box([-6, -6, -6], [6, 6, 6]), maxBounds: 16,
    brickSubdivisions: 3, cellSubdivisions: 3, volumeQuality: 16, autoVolumeQuality: false,
    autoShrink: false });
  grid.automaticBounds = true;
  const previous = grid.bounds.clone();
  const next = grid.resolveOccupiedBounds(box([-100, -100, -100], [100, 100, 100]), 10000);
  assert(next.containsBox(previous));
  assert(next.getSize(new Vector3()).equals(new Vector3(16, 16, 16)));
});

test('deferred quality changes keep an off-origin cap instead of chasing outliers', () => {
  const grid = new ParticleSpatialGrid({ bounds: box([20, 20, 20], [36, 36, 36]), maxBounds: 16,
    brickSubdivisions: 3, cellSubdivisions: 3, autoShrink: false });
  grid.automaticBounds = true;
  grid.volumeQualityTier = 8;
  grid.resolveOccupiedBounds(box([21, -100, 21], [35, 35, 35]), 100);
  const next = grid.resolveDeferredQuality(2000, () => true);
  assert(next);
  assert(next.equals(box([20, 20, 20], [36, 36, 36])));
});
