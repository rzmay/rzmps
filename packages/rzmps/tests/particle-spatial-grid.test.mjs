import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Module,
  Particle,
  ParticleOctree,
  ParticleSpatialGrid,
  ParticleSystem,
} from '../build/index.mjs';

const configuredBounds = new THREE.Box3(
  new THREE.Vector3(-3, -5, -1),
  new THREE.Vector3(4, 2, 8),
);
const normalized = ParticleSpatialGrid.normalizeBounds(configuredBounds, true);
assert.deepEqual(normalized.getSize(new THREE.Vector3()).toArray(), [8, 8, 16]);
assert.deepEqual(
  ParticleSpatialGrid.normalizeBounds(configuredBounds, false).min.toArray(),
  configuredBounds.min.toArray(),
);

const grid = new ParticleSpatialGrid({
  bounds: configuredBounds,
  brickSubdivisions: 2,
  cellSubdivisions: 3,
  powerOfTwoBounds: false,
  autoExpand: false,
});
assert.equal(grid.cellsPerAxis, 32);
assert.equal(grid.maxDepth, 5);
assert.deepEqual(grid.locate(configuredBounds.min), new THREE.Vector3(0, 0, 0));
assert.deepEqual(grid.locate(configuredBounds.max), new THREE.Vector3(31, 31, 31));

// Equivalent CPU/GPU operations use the same min-inclusive, max-inclusive bounds convention.
const octree = new ParticleOctree({ bounds: configuredBounds, maxDepth: 5 }, {
  new: () => 0,
  combine: (a, b) => a + b,
});
const sample = new THREE.Vector3(0.5, -1, 2);
assert.ok(octree.locate(sample));
assert.deepEqual(grid.locate(sample), ParticleSpatialGrid.locate(sample, configuredBounds, 32));

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
const managedOctreeModule = new Module((_particle, _deltaTime, _system, octreeValue) => {
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
managedOctreeModule.prepare(system, 1 / 60);
managedOctreeModule.modify(system.particles, 1 / 60, system);
assert.equal(callbackOctree, managedOctreeModule.getParticleOctree());
assert.equal(callbackOctree.root.aggregate.count, 1);

// Function-defined GPU modules receive a compatible system-managed grid.
let callbackGrid;
const gridOptions = { brickSubdivisions: 1, cellSubdivisions: 2 };
const managedGridModule = new Module(Module.CPU_UNSUPPORTED, {
  spatialGrid: gridOptions,
  modifyGPU(_particle, _deltaTime, _context, gridValue) {
    callbackGrid = gridValue;
  },
});
const managedGrid = managedGridModule.getParticleSpatialGrid(system);
assert.equal(managedGrid, system.acquireParticleSpatialGrid(gridOptions));
managedGridModule.modifyGPU({}, {}, { system }, managedGrid);
assert.equal(callbackGrid, managedGrid);

// Explicit grids remain caller-owned and survive module cleanup.
const explicitGridModule = new Module(Module.CPU_UNSUPPORTED, {
  spatialGrid: explicit,
  modifyGPU() {},
});
assert.equal(explicitGridModule.getParticleSpatialGrid(system), explicit);
explicitGridModule.cleanup();
assert.equal(explicitGridModule.getParticleSpatialGrid(system), explicit);

system.destroy();

console.log('particle-spatial-grid tests passed');
