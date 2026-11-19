import assert from 'node:assert/strict';
import test from 'node:test';
import { initialFluidQuality } from '../../packages/rzmps/src/simulation/gpu/fluidStartup.utils.ts';
import { ParticleSpatialGrid } from '../../packages/rzmps/build/index.mjs';

test('startup chooses one tier finer than bounded coverage and respects configured quality limits', () => {
  assert.equal(initialFluidQuality(10, 2, Infinity), 8);
  assert.equal(initialFluidQuality(16, 2, Infinity), 8);
  assert.equal(initialFluidQuality(3, 2, Infinity), 2);
  assert.equal(initialFluidQuality(10, 16, 32), 16);
  assert.equal(initialFluidQuality(100, 2, 8), 8);
  assert.equal(initialFluidQuality(Infinity, 4, 32), 4);
  assert.equal(initialFluidQuality(0, 2, 32), 2);
});

test('seeding an empty grid leaves its adaptive quality policy unchanged', () => {
  const grid = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 4,
    minVolumeQuality: 2, maxVolumeQuality: 16, autoVolumeQuality: true });
  grid.initializeVolumeQuality(8);
  assert.equal(grid.volumeQualityTier, 8);
  assert.equal(grid.cellSize, 8 / 128);
  assert.equal(grid.minVolumeQuality, 2);
  assert.equal(grid.maxVolumeQuality, 16);
  assert.equal(grid.autoVolumeQuality, true);
  grid.initializeVolumeQuality(4);
  assert.equal(grid.volumeQualityTier, 4, 'a later selection is not pinned to the startup tier');
  grid.setOptions({ autoVolumeQuality: false, volumeQuality: 16 });
  grid.initializeVolumeQuality(2);
  assert.equal(grid.volumeQualityTier, 16, 'fixed quality must not be overridden');
  grid.dispose();
});
