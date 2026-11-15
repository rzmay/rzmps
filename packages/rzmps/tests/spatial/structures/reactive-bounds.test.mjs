import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ParticleSpatialGrid, ParticleSystem, GasSimulation } from '../../../build/index.mjs';

const vector = (...values) => new THREE.Vector3(...values);
const box = (size, center = vector()) => new THREE.Box3().setFromCenterAndSize(center, size);
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const apply = (grid, occupied, time) => grid.setBounds(grid.resolveOccupiedBounds(occupied, time));
const options = { brickSubdivisions: 2, cellSubdivisions: 2, shrinkDelay: 60,
  minVolumeQuality: 4, maxVolumeQuality: 4 };
const grid = new ParticleSpatialGrid(options);
const support = box(vector(2, 16, 2));
apply(grid, support, 100);
assert.deepEqual(grid.bounds.getSize(vector()).toArray(), [4, 18, 4]);
assert.deepEqual(grid.gridDimensions.toArray(), [16, 72, 16]);
near(grid.cellSize, 0.25);
assert(grid.bounds.containsBox(support.clone().expandByScalar(grid.brickSize)));

// No growth feedback from guard snapping, even when synchronizing or editing unrelated options.
const initial = grid.bounds.clone();
for (let i = 0; i < 5; i++) apply(grid, support, 200 + i);
assert(grid.bounds.equals(initial));
grid.setOptions({ autoShrink: true }); near(grid.volumeQualityTier, 4);

// A horizontal jump grows the required faces directly; opposite faces wait for shrinkDelay.
const moved = support.clone().translate(vector(20, 0, 0));
apply(grid, moved, 300);
assert(grid.bounds.containsBox(moved.clone().expandByScalar(grid.brickSize)));
near(grid.bounds.min.x, initial.min.x);
near(grid.bounds.min.y, initial.min.y); near(grid.bounds.max.y, initial.max.y);
apply(grid, moved, 1400);
assert(grid.bounds.min.x > initial.min.x);
for (const axis of ['x', 'y', 'z']) near(grid.bounds.min[axis] / grid.brickSize,
  Math.round(grid.bounds.min[axis] / grid.brickSize));
assert(grid.domainDiagnostics.growth[1] > 0 && grid.domainDiagnostics.shrink[0] > 0);

// Independent physical and quality constraints, including anisotropic caps.
const constrained = new ParticleSpatialGrid({ ...options,
  minBounds: vector(2, 2, 2), maxBounds: vector(4, 16, 4) });
apply(constrained, box(vector(3, 20, 5)), 100);
const size = constrained.bounds.getSize(vector());
assert(size.x >= 2 && size.x <= 4 && size.y <= 16 && size.z <= 4);
assert(constrained.domainDiagnostics.hardCapBreaches > 0);
const count = constrained.domainDiagnostics.hardCapBreaches;
constrained.resolveOccupiedBounds(box(vector(3, 20, 5)), 200);
assert(constrained.domainDiagnostics.hardCapBreaches > count);
near(constrained.cellSize, 0.25);

// Explicit coverage remains fixed. Gas can extend source occupancy without forecasting motion.
const fixed = new ParticleSpatialGrid({ ...options, bounds: support, autoExpand: true });
const fixedBounds = fixed.bounds.clone();
assert.equal(fixed.autoExpand, false);
assert(fixed.resolveOccupiedBounds(moved).equals(fixedBounds));
const gasFixed = new GasSimulation({ bounds: box(vector(2, 4, 2)), automaticPadding: true });
assert.equal(gasFixed.automaticPadding, false);
const source = box(vector(1, 1, 1)), gas = box(vector(1, 2, 1), vector(0, 5, 0));
const gasGrid = new ParticleSpatialGrid(options);
apply(gasGrid, source.clone().union(gas), 100);
assert(gasGrid.bounds.containsBox(gas));

// Guards at very low brick depth must not cause recursive quality-tier inflation.
const lowDepth = new ParticleSpatialGrid({ brickSubdivisions: 1, cellSubdivisions: 2 });
const compact = box(vector(2, 2, 2));
apply(lowDepth, compact, 100);
const tier = lowDepth.volumeQualityTier;
for (let i = 0; i < 10; i++) apply(lowDepth, compact, 200 + i);
near(lowDepth.volumeQualityTier, tier);

// Equivalent physical limit shortcuts still reuse the same managed index.
const system = new ParticleSystem({ emitters: [], modules: [], renderers: [] });
assert.equal(system.acquireParticleSpatialGrid({ maxBounds: 16 }),
  system.acquireParticleSpatialGrid({ maxBounds: vector(16, 16, 16) }));
assert.equal(typeof system.predictBounds, 'undefined');
console.log('Guard domains: vertical/jet occupancy, jumps, independent shrink, caps, quality and explicit bounds passed.');

// Velocity guards expand only the requested face and retain ordinary shrink hysteresis.
const adaptive = new ParticleSpatialGrid(options);
adaptive.setBounds(adaptive.resolveOccupiedBounds(source, 100, [1, 1, 1, 4, 1, 1]));
const guarded = adaptive.bounds.clone(), width = adaptive.cellSize;
assert(guarded.max.y >= source.max.y + adaptive.brickSize * 4);
const relaxed = adaptive.resolveOccupiedBounds(source, 200, [1, 1, 1, 1, 1, 1]);
assert.equal(relaxed.max.y, guarded.max.y, 'slower motion must not immediately remove spare layers');
adaptive.setBounds(relaxed);
adaptive.setBounds(adaptive.resolveOccupiedBounds(source, 2000, [1, 1, 1, 1, 1, 1]));
assert(adaptive.bounds.max.y < guarded.max.y);
near(adaptive.cellSize, width, 'guard depth must not feed back into the quality metric');

// Coverage is immediate and fixed-width. A separate stable request may subsequently change quality.
const fastGuard = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 4, maxBounds: 32 });
fastGuard.setBounds(fastGuard.resolveOccupiedBounds(source, 100, { travel: [0, 0, 0, 15, 0, 0] }));
assert(fastGuard.bounds.max.y >= source.max.y + 15);
near(fastGuard.volumeQualityTier, 2);
assert.equal(fastGuard.resolveDeferredQuality(500), undefined);
const quality = fastGuard.resolveDeferredQuality(1200);
assert(quality);
fastGuard.setBounds(quality);
assert(fastGuard.volumeQualityTier > 2);

const staticQuality = new ParticleSpatialGrid({ volumeQuality: 4, brickSubdivisions: 2, cellSubdivisions: 2 });
assert.equal(staticQuality.autoVolumeQuality, false);
apply(staticQuality, box(vector(20, 2, 2)), 100);
near(staticQuality.cellSize, 0.25);
assert.equal(staticQuality.resolveDeferredQuality(100000), undefined);
assert(staticQuality.bounds.containsBox(box(vector(20, 2, 2)).expandByScalar(staticQuality.brickSize)));
staticQuality.setOptions({ autoVolumeQuality: true });
apply(staticQuality, box(vector(40, 2, 2)), 200);
assert(staticQuality.resolveDeferredQuality(1400));
staticQuality.setOptions({ autoVolumeQuality: false });
near(staticQuality.volumeQuality, staticQuality.volumeQualityTier);
assert.equal(staticQuality.resolveDeferredQuality(100000), undefined);

// Fluid initial fields and its managed index must start on the same explicitly fixed lattice.
const staticGas = new GasSimulation({ spatialGridOptions: { volumeQuality: 8,
  brickSubdivisions: 2, cellSubdivisions: 2 } });
near(staticGas.cellSize, 0.5);
const qualityOwner = new ParticleSystem({ emitters: [], modules: [], renderers: [] });
assert.notEqual(qualityOwner.acquireParticleSpatialGrid({ volumeQuality: 4 }),
  qualityOwner.acquireParticleSpatialGrid({ volumeQuality: 8 }));
qualityOwner.destroy();

// Immediate coverage can apply while a histogram is pending without invalidating its travel result.
const reactiveGas = new GasSimulation({ automaticPadding: true,
  spatialGridOptions: { volumeQuality: 2, brickSubdivisions: 2, cellSubdivisions: 2 } });
const reactiveGrid = new ParticleSpatialGrid({ volumeQuality: 2, brickSubdivisions: 2, cellSubdivisions: 2 });
reactiveGas.spatialGrid = reactiveGrid;
reactiveGrid.readParticleBounds = async () => source.clone();
reactiveGas.readOccupiedFieldBounds = async () => source.clone().translate(vector(0, 2, 0));
reactiveGas.guardSources = () => [{}];
let finishHistogram;
reactiveGas.guardPrediction = { read: () => new Promise(resolve => { finishHistogram = resolve; }) };
reactiveGas.refreshBounds(reactiveGrid, {});
for (let i = 0; i < 4 && !finishHistogram; i++) await Promise.resolve();
assert(finishHistogram);
assert(reactiveGas.pendingBounds, 'coverage must be queued before histogram completion');
reactiveGrid.setBounds(reactiveGas.pendingBounds.bounds);
reactiveGas.bounds.copy(reactiveGrid.bounds);
reactiveGas.boundsGeneration++;
finishHistogram(Array.from({ length: 6 }, () => ({ predictedTravel: 2 })));
for (let i = 0; i < 4; i++) await Promise.resolve();
assert.equal(reactiveGas.guardDiagnostics.faces[3].predictedTravel, 2,
  'a compatible logical extension must retain the in-flight histogram');
assert(reactiveGas.pendingBounds.bounds.max.y >= source.max.y + 4);
