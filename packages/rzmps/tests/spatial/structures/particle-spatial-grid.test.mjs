import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Boids,
  Module,
  Particle,
  ParticleOctree,
  ParticleSpatialGrid,
  SpatialGrid,
  ParticleSystem,
} from '../../../build/index.mjs';

const configuredBounds = new THREE.Box3(
  new THREE.Vector3(-3, -5, -1),
  new THREE.Vector3(4, 2, 8),
);
const normalized = ParticleSpatialGrid.normalizeBounds(configuredBounds, true);
assert.deepEqual(normalized.getSize(new THREE.Vector3()).toArray(), [8, 8, 16]);
const nearlyQuantized = ParticleSpatialGrid.normalizeBounds(new THREE.Box3(
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(8.000001, 8.000001, 8.000001),
), true, true);
assert.ok(nearlyQuantized.getSize(new THREE.Vector3()).distanceTo(
  new THREE.Vector3(8, 8, 8),
) < 1e-12);
assert.deepEqual(
  ParticleSpatialGrid.normalizeBounds(configuredBounds, false).min.toArray(),
  configuredBounds.min.toArray(),
);

const grid = new ParticleSpatialGrid({
  bounds: configuredBounds,
  brickSubdivisions: 2,
  cellSubdivisions: 3,
  powerOfTwoBounds: false,
  centeredAtOrigin: false,
  autoExpand: false,
});
assert.equal(grid.cellsPerAxis, 32);
assert.equal(grid.maxDepth, 5);
assert(grid instanceof SpatialGrid);
assert.deepEqual(grid.locate(grid.bounds.min), new THREE.Vector3(0, 0, 0));
assert.deepEqual(grid.locate(grid.bounds.max), grid.gridDimensions.clone().addScalar(-1));
const structuralVersion = grid.resourceVersion;
grid.cellSubdivisions = 4;
assert.equal(grid.cellSubdivisions, 4);
assert.equal(grid.maxDepth, 6);
assert.equal(grid.cellsPerAxis, 64);
assert.ok(grid.resourceVersion > structuralVersion);
grid.setOptions({ brickSubdivisions: 1, cellSubdivisions: 3 });
assert.equal(grid.maxDepth, 4);
assert.equal(grid.cellsPerAxis, 16);
grid.setOptions({ brickSubdivisions: 2, cellSubdivisions: 3 });

const graphGrid = new ParticleSpatialGrid({ autoExpand: false });
const submissions = [];
const fakeRenderer = { compute: node => submissions.push(...(Array.isArray(node) ? node : [node])) };
const fakeBuffers = { capacity: 4, count: 2, version: 1, storage: {} };
graphGrid.rebuild(fakeRenderer, fakeBuffers, {});
const firstGraphs = submissions.splice(0);
fakeBuffers.count = 3;
graphGrid.rebuild(fakeRenderer, fakeBuffers, {});
assert.deepEqual(submissions.splice(0), firstGraphs, 'particle-count edits should reuse build graphs');
assert.equal(firstGraphs[1].count, 3);
graphGrid.setOptions({ timeQuality: 0.5 });
graphGrid.rebuild(fakeRenderer, fakeBuffers, {});
assert.equal(submissions.splice(0)[0], firstGraphs[0], 'CPU update cadence does not specialize build graphs');
graphGrid.setOptions({ autoVolumeQuality: false, volumeQuality: 8 });
graphGrid.rebuild(fakeRenderer, fakeBuffers, {});
assert.equal(submissions.splice(0)[0], firstGraphs[0], 'runtime quality reuses indexing programs');
graphGrid.cellSubdivisions = 2;
graphGrid.rebuild(fakeRenderer, fakeBuffers, {});
assert.notEqual(submissions.splice(0)[0], firstGraphs[0], 'structural edits invalidate build graphs');
graphGrid.dispose();

const centeredGrid = new ParticleSpatialGrid({ bounds: configuredBounds });
assert(centeredGrid.bounds.containsBox(configuredBounds));
assert.equal(centeredGrid.autoShrink, true);
const centeredVersion = centeredGrid.resourceVersion;
centeredGrid.setOptions({ autoShrink: false, shrinkDelay: 42, timeQuality: 0.5 });
assert.equal(centeredGrid.autoShrink, false);
assert.equal(centeredGrid.shrinkDelay, 42);
assert.equal(centeredGrid.timeQuality, 0.5);
assert.ok(centeredGrid.resourceVersion > centeredVersion);

// Equivalent CPU/GPU operations use the same min-inclusive, max-inclusive bounds convention.
const octree = new ParticleOctree({ bounds: configuredBounds, maxDepth: 5 }, {
  new: () => 0,
  combine: (a, b) => a + b,
});
const sample = new THREE.Vector3(0.5, -1, 2);
assert.ok(octree.locate(sample));
assert.deepEqual(grid.locate(sample), ParticleSpatialGrid.locate(sample, grid.bounds, grid.gridDimensions));

// Signed coordinates must not turn a hash collision into coordinate equality.
const hashCapacity = 32;
const seen = new Map();
let collision;
for (let x = -20; x <= 20 && !collision; x += 1) {
  const coordinate = new THREE.Vector3(x, x * 2, -x);
  const hash = ParticleSpatialGrid.hashCoordinate(coordinate, hashCapacity);
  if (seen.has(hash) && !seen.get(hash).equals(coordinate)) collision = [seen.get(hash), coordinate];
  else seen.set(hash, coordinate);
}
assert.ok(collision, 'reference coordinates should exercise a hash collision');
assert.notDeepEqual(collision[0].toArray(), collision[1].toArray());

const system = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const sharedA = system.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 2 });
const sharedB = system.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 2 });
assert.equal(sharedA, sharedB);
const explicit = new ParticleSpatialGrid();
assert.equal(system.acquireParticleSpatialGrid(explicit), explicit);

// Function-defined CPU modules receive a lifecycle-managed, tag-filtered octree.
let callbackOctree;
const managedOctreeModule = new Module((_particle, _deltaTime, { octree: octreeValue }) => {
  callbackOctree = octreeValue;
}, {
  tags: 'included',
  useOctree: true,
  octreeOptions: {
    bounds: configuredBounds,
    maxDepth: 3,
  },
});
const included = new Particle({
  position: new THREE.Vector3(0, 0, 0),
  tags: ['included'],
});
const excluded = new Particle({
  position: new THREE.Vector3(1, 1, 1),
  tags: ['excluded'],
});
system.particles.push(included, excluded);
managedOctreeModule.prepare(managedOctreeModule.beginExecution(system, 1 / 60));
managedOctreeModule.modify(system.particles, 1 / 60, managedOctreeModule.executionContext);
assert.equal(callbackOctree, managedOctreeModule.getParticleOctree());
assert.deepEqual(callbackOctree.root.aggregate, {});
assert.deepEqual(callbackOctree.particlesInRadius(new THREE.Vector3(), 10), [included]);

// Octree config can override the module's processing tags without changing particle filtering.
const sourceFilteredModule = new Module(() => {}, {
  tags: 'included',
  octreeOptions: { bounds: configuredBounds, tags: 'excluded' },
});
sourceFilteredModule.prepare(sourceFilteredModule.beginExecution(system, 0));
assert.deepEqual(sourceFilteredModule.getParticleOctree().root.aggregate, {});
assert.deepEqual(sourceFilteredModule.getParticleOctree().particlesInRadius(new THREE.Vector3(), 10), [excluded]);
sourceFilteredModule.octreeOptions.tags = [];
sourceFilteredModule.prepare(sourceFilteredModule.beginExecution(system, 0));
assert.deepEqual(sourceFilteredModule.getParticleOctree().root.aggregate, {});
assert.equal(sourceFilteredModule.getParticleOctree().particlesInRadius(new THREE.Vector3(), 10).length, 2);

// Function-defined GPU modules receive a compatible system-managed grid.
let callbackGrid;
const gridOptions = { brickSubdivisions: 1, cellSubdivisions: 2 };
const managedGridModule = new Module(Module.CPU_UNSUPPORTED, {
  spatialGridOptions: gridOptions,
  modifyGPU(_particle, _deltaTime, { spatialGrid: gridValue }) {
    callbackGrid = gridValue;
  },
});
const managedGrid = managedGridModule.getParticleSpatialGrid(system);
assert.equal(managedGrid, system.acquireParticleSpatialGrid(gridOptions));
managedGridModule.modifyGPU({}, {}, { system, spatialGrid: managedGrid });
assert.equal(callbackGrid, managedGrid);

assert.equal(managedGridModule.useSpatialGrid, true);
assert.equal(managedGridModule.spatialGridOptions, gridOptions);
managedGridModule.cleanup();
assert.equal(managedGridModule.spatialGrid, undefined);
assert.equal(managedGridModule.getParticleSpatialGrid(system), managedGrid);
const disabledGridModule = new Module(Module.CPU_UNSUPPORTED, {
  useSpatialGrid: false,
  spatialGridOptions: gridOptions,
});
assert.equal(disabledGridModule.getParticleSpatialGrid(system), undefined);

// Boids uses the same managed acquisition and cleanup as function-defined modules.
const boids = new Boids({ spatialGridOptions: gridOptions });
assert.equal(boids.useOctree, true);
assert.equal(boids.useSpatialGrid, true);
assert.equal(boids.getParticleSpatialGrid(system), managedGrid);
assert.equal(boids.spatialGrid, managedGrid);
boids.prepare(boids.beginExecution(system, 0));
assert.equal(boids.getParticleOctree(), boids.octree);
assert.ok(boids.octree.root.aggregate.particleAffectors instanceof Map);
boids.cleanup();
assert.equal(boids.octree, undefined);
assert.equal(boids.spatialGrid, undefined);
assert.equal(boids.getParticleSpatialGrid(system), managedGrid);

// No target tag filter means all boids participate, even when affector sources have tags.
const unfilteredBoids = new Boids({ particleAffectors: { sourceTags: 'excluded' } });
unfilteredBoids.prepare(unfilteredBoids.beginExecution(system, 0));
assert.equal(unfilteredBoids.octree.root.aggregate.count, system.particles.length);
assert.equal(unfilteredBoids.octree.root.aggregate.particleAffectors.get(0).count, 1);

system.destroy();
console.log('particle-spatial-grid tests passed');

// The grid owns the cap for externally supplied bounds as well as automatic growth.
const cappedGrid = new ParticleSpatialGrid({ bounds: configuredBounds, cubicBounds: true, maxBounds: 10 });
assert.deepEqual(cappedGrid.bounds.getSize(new THREE.Vector3()).toArray(), [10, 10, 10]);
cappedGrid.setBounds(new THREE.Box3(new THREE.Vector3(-32, -32, -32), new THREE.Vector3(32, 32, 32)));
assert.deepEqual(cappedGrid.bounds.getSize(new THREE.Vector3()).toArray(), [10, 10, 10]);
cappedGrid.maxBounds = 4;
assert.deepEqual(cappedGrid.bounds.getSize(new THREE.Vector3()).toArray(), [4, 4, 4]);
cappedGrid.setOptions({ powerOfTwoBounds: false, maxBounds: 3 });
assert.deepEqual(cappedGrid.bounds.getSize(new THREE.Vector3()).toArray(), [3, 3, 3]);
assert.throws(() => new ParticleSpatialGrid({ maxBounds: 0 }), /maxBounds/);
assert.throws(() => { cappedGrid.maxBounds = NaN; }, /Physical bounds/);
const capOwner = new ParticleSystem({ emitters: [], renderers: [] });
assert.notEqual(capOwner.acquireParticleSpatialGrid({ maxBounds: 8 }),
  capOwner.acquireParticleSpatialGrid({ maxBounds: 16 }), 'different caps cannot share a managed grid');
capOwner.destroy();
