import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FLIPSimulation,
  AdvectionMethod,
  FluidCollider,
  GasSimulation,
  ParticleOctree,
  ParticleSpatialGrid,
  ParticleSystem,
  VolumeRenderer,
} from '../build/index.mjs';

const gas = new GasSimulation({
  spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 3 },
});
const flip = new FLIPSimulation({
  spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 4 },
});
const boundedFlip = new FLIPSimulation({
  maxBounds: 20,
  bounds: new THREE.Box3(new THREE.Vector3(-32, -32, -32), new THREE.Vector3(32, 32, 32)),
  spatialGridOptions: { autoExpand: true },
});
assert.deepEqual(boundedFlip.bounds.min.toArray(), [-8, -8, -8]);
assert.deepEqual(boundedFlip.bounds.max.toArray(), [8, 8, 8]);
assert.equal(boundedFlip.spatialGridOptions.autoExpand, false);
assert.equal(flip.maxBounds, Infinity);
assert.equal(gas.turbulenceStrength, 0);
assert.throws(() => new FLIPSimulation({ maxBounds: 0 }), /maxBounds/);
boundedFlip.cleanup();
const shrinkingGas = new GasSimulation({
  spatialGridOptions: { shrinkDelay: 180 },
});
assert.equal(gas.supportsGPU, true);
assert.equal(flip.supportsGPU, true);
assert.equal(gas.resolution, 32);
assert.equal(flip.resolution, 64);
assert.equal(gas.autoBounds, true);
assert.equal(gas.automaticPadding, true);
assert.equal(flip.automaticPadding, true);
assert.equal(flip.velocityPaddingLookahead, 0.5);
assert.equal(flip.collisionIterations, 2);
assert.equal(flip.particleSeparation, 0.05);
assert.equal(flip.particleSpacing, 1);
flip.particleSeparation = 2;
flip.particleSpacing = -1;
assert.equal(flip.particleSeparation, 1);
assert.equal(flip.particleSpacing, 0);
assert.equal(gas.showGridHelper, false);
assert.ok(gas.bounds.getSize(new THREE.Vector3()).x > 2);
assert.ok(gas.density.texture.isStorageTexture);
assert.ok(gas.colorField.texture.isStorageTexture);
assert.equal(gas.density.data, undefined);
assert.equal(gas.scalarDiffusion, 0);
assert.equal(gas.advectionMethod, 'SemiLagrangian');
assert.equal(AdvectionMethod.SemiLagrangian, 'SemiLagrangian');
assert.equal(AdvectionMethod.MacCormack, 'MacCormack');
const higherOrderGas = new GasSimulation({ advectionMethod: AdvectionMethod.MacCormack });
assert.equal(higherOrderGas.advectionMethod, 'MacCormack');
higherOrderGas.cleanup();
assert.equal(gas.densityDissipation, 0.6);
assert.equal(gas.densityCutoff, 0.01);
assert.deepEqual(gas.temperatureRange, [0, 1]);
assert.equal(gas.temperatureOverLifetime, 1);
assert.equal('maxSplatRadius' in gas, false);
assert.deepEqual(gas.requireSpatialEffects, [FluidCollider]);
assert.deepEqual(flip.requireSpatialEffects, [FluidCollider]);
const fluidCollider = FluidCollider.Box({}, 2, 3, 4);
assert.ok(fluidCollider.geometry instanceof THREE.BoxGeometry);
assert.equal(fluidCollider.feather, 0);
assert.equal(fluidCollider.automaticFeather, false);
assert.equal(fluidCollider.gridOccupancy, true);
assert.equal(fluidCollider.particleCollision, true);
assert.equal(fluidCollider.surfaceThickness, 0);
assert.ok(fluidCollider.getCollisionObject() instanceof THREE.Mesh);
const occupancyOnlyCollider = FluidCollider.Box({ particleCollision: false }, 1, 1, 1);
assert.equal(occupancyOnlyCollider.gridOccupancy, true);
assert.equal(occupancyOnlyCollider.particleCollision, false);
occupancyOnlyCollider.surfaceThickness = 0.125;
assert.equal(occupancyOnlyCollider.surfaceThickness, 0.125);
const clampedGas = new GasSimulation({
  densityDissipation: -1,
  temperatureDissipation: -1,
  colorDissipation: -1,
  velocityDissipation: -1,
  scalarDiffusion: -1,
});
assert.equal(clampedGas.densityDissipation, 0);
assert.equal(clampedGas.temperatureDissipation, 0);
assert.equal(clampedGas.colorDissipation, 0);
assert.equal(clampedGas.velocityDissipation, 0);
assert.equal(clampedGas.scalarDiffusion, 0);

const system = new ParticleSystem({ modules: [gas], renderers: [] });
assert.throws(() => gas.prepare(system, 0), /require GPU particle processing/);
const grid = gas.getParticleSpatialGrid(system);
assert.equal(grid.cellsPerAxis, gas.resolution);
assert.equal(grid.powerOfTwoBounds, true);
assert.equal(grid.cubicBounds, true);
assert.equal(grid.autoExpand, false);
assert.equal(shrinkingGas.getParticleSpatialGrid(system).shrinkDelay, 180);
assert.ok(grid.bounds.equals(gas.bounds));

const volumeRenderer = new VolumeRenderer();
volumeRenderer.setup(system);
assert.equal(volumeRenderer.webglMaterial.side, THREE.FrontSide);
assert.equal(volumeRenderer.webgpuMaterial.side, THREE.FrontSide);
assert.equal(volumeRenderer.renderOrder, 100);
assert.equal(volumeRenderer.webglMaterial.depthTest, true);
assert.equal(volumeRenderer.webgpuMaterial.depthTest, true);
assert.ok(volumeRenderer.webgpuMaterial.depthNode, 'volume depth must use ray entry rather than the back face');
assert.ok(volumeRenderer.webgpuMaterial.fragmentNode, 'volume color and alpha come directly from the ray march');
assert.equal(volumeRenderer.mesh.material, volumeRenderer.webgpuMaterial, 'GPU fields select a compatible first-frame material');
volumeRenderer.destroy();
fluidCollider.geometry.dispose();
occupancyOnlyCollider.geometry.dispose();

assert.equal(typeof ParticleOctree.prototype.getGridCell, 'undefined');
const cubic = ParticleSpatialGrid.normalizeBounds(new THREE.Box3(
  new THREE.Vector3(-1, -2, -3), new THREE.Vector3(1, 2, 3),
), true, true);
const size = cubic.getSize(new THREE.Vector3());
assert.equal(size.x, size.y);
assert.equal(size.y, size.z);

gas.cleanup();
clampedGas.cleanup();
shrinkingGas.cleanup();
flip.cleanup();

// A readback from a previous lifecycle cannot queue a domain change after cleanup.
const staleFlip = new FLIPSimulation();
const staleSystem = new ParticleSystem({ modules: [staleFlip], emitters: [], renderers: [] });
const staleGrid = staleFlip.getParticleSpatialGrid(staleSystem);
let resolveMetrics;
staleGrid.readParticleMetrics = () => new Promise((resolve) => { resolveMetrics = resolve; });
staleFlip.lastBoundsRead = -Infinity;
const originalBounds = staleFlip.bounds.clone();
staleFlip.refreshBounds(staleGrid, {});
staleFlip.cleanup();
resolveMetrics({ bounds: new THREE.Box3(new THREE.Vector3(-32, -32, -32), new THREE.Vector3(32, 32, 32)), maxParticleSpeed: 10 });
await new Promise(setImmediate);
assert.ok(staleFlip.bounds.equals(originalBounds));
assert.equal(staleFlip.pendingBounds, undefined);
staleSystem.destroy();
console.log('fluid-gpu tests passed');
