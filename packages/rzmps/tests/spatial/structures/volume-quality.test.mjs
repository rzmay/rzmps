/* eslint-env node */
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { GasSimulation, ParticleSpatialGrid } from '../../../build/index.mjs';

const resolution = 128, cellsPerBrick = 16;
const box = (size, center = new Vector3()) => new Box3().setFromCenterAndSize(center, size);
const resolve = (size, options = {}) => new ParticleSpatialGrid({ bounds: box(size),
  brickSubdivisions: 3, cellSubdivisions: 4, ...options });

// Increasing aspect ratio must save empty coverage, rather than silently refining the long axis.
for (const longest of [8, 16, 64, 256]) {
  for (const axis of ['x', 'y', 'z']) {
    const size = new Vector3(2, 2, 2); size[axis] = longest;
    const grid = resolve(size);
    assert.equal(grid.volumeQualityTier, longest);
    assert.equal(grid.cellSize, longest / resolution);
    assert(grid.gridDimensions[axis] <= resolution + 2 * cellsPerBrick);
    const dimensions = grid.bounds.getSize(new Vector3());
    assert(dimensions[axis] > Math.min(...dimensions.toArray()));
    assert(grid.bounds.containsBox(box(size)));
  }
}

// Initial cubes preserve reference resolution; subsequent crossings have symmetric hysteresis.
assert.equal(resolve(new Vector3(8, 8, 8)).cellSize, 8 / resolution);
const held = resolve(new Vector3(4, 4, 4));
held.setBounds(box(new Vector3(4.2, 2, 2)));
assert.equal(held.volumeQualityTier, 4, 'small growth retains the finer tier within the bounded band');
held.setBounds(box(new Vector3(4.5, 2, 2)));
assert.equal(held.volumeQualityTier, 8, 'growth beyond the band requests the coarser tier');
held.setBounds(box(new Vector3(3.7, 2, 2)));
assert.equal(held.volumeQualityTier, 8, 'small shrink retains the coarse tier');
held.setBounds(box(new Vector3(3.5, 2, 2)));
assert.equal(held.volumeQualityTier, 4);

// Explicit quality overrides may intentionally refine further; physical caps are applied first.
assert.equal(resolve(new Vector3(2, 64, 2), { volumeQuality: 4 }).cellSize, 4 / resolution);
const capped = resolve(new Vector3(2, 64, 2), { maxBounds: new Vector3(2, 8, 2) });
assert.equal(capped.volumeQualityTier, 8);
assert(capped.bounds.getSize(new Vector3()).y <= 8);
const continuous = resolve(new Vector3(2, 15.5, 2), { powerOfTwoBounds: false });
assert.equal(continuous.cellSize, 15.5 / resolution);

// Coverage still uses the current lattice immediately; only the separate deferred request changes quality.
const automatic = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 4 });
const support = box(new Vector3(2, 8, 2));
automatic.setBounds(automatic.resolveOccupiedBounds(support, 100));
assert.equal(automatic.cellSize, 2 / resolution);
const deferred = automatic.resolveDeferredQuality(1200);
assert(deferred);
automatic.setBounds(deferred);
assert.equal(automatic.volumeQualityTier, 16);
assert(automatic.bounds.containsBox(support.clone().expandByScalar(automatic.brickSize)));
const shape = automatic.bounds.getSize(new Vector3());
assert(shape.y > shape.x && shape.y > shape.z);

// A delayed directory allocation restores coverage without re-evaluating its quality.
const rollback = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 3 });
rollback.setBounds(rollback.resolveOccupiedBounds(support, 100));
const retainedWidth = rollback.cellSize;
rollback.setBounds(rollback.resolveBounds(rollback.bounds.clone()));
assert.equal(rollback.cellSize, retainedWidth, 'directory rollback must not bypass deferred quality preparation');

// Keep the debounce deadline when an expanding plume crosses another tier in the same direction.
const evolving = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 3 });
evolving.resolveOccupiedBounds(box(new Vector3(2, 4, 2)), 100);
let preparationCalls = 0;
assert.equal(evolving.resolveDeferredQuality(200, () => { preparationCalls++; return false; }), undefined);
assert.equal(preparationCalls, 1, 'prepare programs while the hysteresis deadline is still pending');
evolving.resolveOccupiedBounds(box(new Vector3(2, 10, 2)), 600);
assert(evolving.resolveDeferredQuality(1200), 'continued coarsening must not reset the hysteresis deadline');

console.log('Volume quality: bounded anisotropy, rectangular coverage, hysteresis and explicit overrides passed.');

// Quality changes do not depend on whether empty physical faces may shrink.
const cappedFire = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 3,
  maxVolumeQuality: 8, autoShrink: false });
cappedFire.setBounds(cappedFire.resolveOccupiedBounds(box(new Vector3(12, 2, 2)), 100));
const coarseFire = cappedFire.resolveDeferredQuality(1200);
assert(coarseFire); cappedFire.setBounds(coarseFire);
assert.equal(cappedFire.cellSize, 0.125);
cappedFire.resolveOccupiedBounds(box(new Vector3(2, 2, 2)), 1300);
assert.equal(cappedFire.resolveDeferredQuality(2200), undefined);
const fineFire = cappedFire.resolveDeferredQuality(2400);
assert(fineFire, 'refinement has the same debounce even when physical autoShrink is disabled');

// The physical rectangle may stay identical while its sampling tier changes.
const fluid = new GasSimulation({ automaticPadding: false });
let adopted = false;
const unchanged = fluid.bounds.clone();
fluid.synchronizeGridBounds({ autoExpand: false, cubicBounds: false, centeredAtOrigin: false,
  powerOfTwoBounds: true, bounds: unchanged,
  resolveDeferredQuality: () => unchanged, resolveBounds: () => unchanged,
  setBounds: () => { adopted = true; },
}, {});
assert(adopted, 'a deferred quality tier must be applied even when rectangular bounds are unchanged');
