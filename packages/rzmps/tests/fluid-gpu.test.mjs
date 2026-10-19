import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FLIPSimulation,
  GasSimulation,
  ParticleOctree,
  ParticleSpatialGrid,
  ParticleSystem,
} from '../build/index.mjs';

const gas = new GasSimulation({
  spatialGrid: { brickSubdivisions: 2, cellSubdivisions: 3 },
});
const flip = new FLIPSimulation({
  spatialGrid: { brickSubdivisions: 2, cellSubdivisions: 4 },
});
assert.equal(gas.supportsGPU, true);
assert.equal(flip.supportsGPU, true);
assert.equal(gas.resolution, 32);
assert.equal(flip.resolution, 64);
assert.equal(gas.autoBounds, true);
assert.ok(gas.bounds.getSize(new THREE.Vector3()).x > 2);
assert.ok(gas.density.texture.isStorageTexture);
assert.ok(gas.colorField.texture.isStorageTexture);
assert.equal(gas.density.data, undefined);

const system = new ParticleSystem({ modules: [gas], renderers: [] });
assert.throws(() => gas.prepare(system, 0), /require GPU particle processing/);
const grid = gas.getParticleSpatialGrid(system);
assert.equal(grid.cellsPerAxis, gas.resolution);
assert.equal(grid.powerOfTwoBounds, true);
assert.equal(grid.cubicBounds, true);
assert.equal(grid.autoExpand, true);
assert.ok(grid.bounds.equals(gas.bounds));

assert.equal(typeof ParticleOctree.prototype.getGridCell, 'undefined');
const cubic = ParticleSpatialGrid.normalizeBounds(new THREE.Box3(
  new THREE.Vector3(-1, -2, -3), new THREE.Vector3(1, 2, 3),
), true, true);
const size = cubic.getSize(new THREE.Vector3());
assert.equal(size.x, size.y);
assert.equal(size.y, size.z);

gas.cleanup();
flip.cleanup();
console.log('fluid-gpu tests passed');
