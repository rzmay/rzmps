import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { float, uniform } from 'three/tsl';
import * as THREE from 'three';
import {
  FLIPSimulation,
  AdvectionMethod,
  FluidBoundsPolicy,
  FluidCollider,
  GasSimulation,
  Module,
  ParticleOctree,
  ParticleSpatialGrid,
  ParticleSystem,
  VolumeRenderer,
  VolumeInterpolation,
  VolumeDensityMapping,
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
assert.equal(gas.maxActiveBricks, 512);
assert.equal(gas.volumeGrid.capacity, 64, 'reservation is capped by logical brick count');
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
assert.equal(gas.boundsPolicy, FluidBoundsPolicy.Ballistic);
assert.equal(flip.boundsPolicy, FluidBoundsPolicy.Ballistic);
assert.deepEqual(Object.values(FluidBoundsPolicy), ['Ballistic', 'Kill', 'Contain']);
const containedGas = new GasSimulation({ boundsPolicy: 'Contain', maxBounds: 16 });
assert.deepEqual(containedGas.closedMaxNode.value.toArray(), [0, 0, 0], 'adaptive grid edges below the cap remain open');
containedGas.cleanup();
assert.throws(() => new GasSimulation({ boundsPolicy: 'Open' }), /boundsPolicy/);
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
assert.equal(volumeRenderer.supportsGPUInput, true, 'volume fields must use the renderer GPU-input hook');
assert.equal(volumeRenderer.webglMaterial.vertexShader,
  readFileSync(new URL('../src/shaders/Volume.vert', import.meta.url), 'utf8'));
assert.ok(!volumeRenderer.webglMaterial.fragmentShader.includes('/* VOLUME_FIELDS */'));
assert.equal(volumeRenderer.generateChildren, true);
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

assert.throws(() => new VolumeRenderer({ stepSizeMultiplier: 0 }), /stepSizeMultiplier/);
assert.throws(() => new VolumeRenderer({ densityRange: [1, 0] }), /densityRange/);
assert.throws(() => new VolumeRenderer({ interpolation: 'invalid' }), /interpolation/);
assert.equal(volumeRenderer.adaptiveStepping, false);
assert.equal(volumeRenderer.noiseContrast, 1);
assert.equal(volumeRenderer.sceneDepthClipping, true);
assert.equal(volumeRenderer.adaptiveStepFactor, 4);
assert.equal(volumeRenderer.transmittanceThreshold, 0.01);
for (const options of [
  { adaptiveStepThreshold: 1 }, { adaptiveStepThreshold: -0.1 },
  { adaptiveStepFactor: 0.5 }, { adaptiveStepFactor: Infinity },
  { transmittanceThreshold: 1 }, { transmittanceThreshold: NaN }, { sceneDepthBias: -1 },
]) assert.throws(() => new VolumeRenderer(options), /adaptive thresholds/);
for (const options of [
  { noiseStrength: -1 }, { noiseStrength: Infinity }, { noiseContrast: -1 }, { noiseContrast: NaN },
]) assert.throws(() => new VolumeRenderer(options), /Volume noise/);
const strongMask = new VolumeRenderer({ noiseStrength: 2, noiseContrast: 1.5 });
assert.equal(strongMask.noiseStrength, 2);
assert.equal(strongMask.noiseContrast, 1.5);
strongMask.destroy();
const copies = new VolumeRenderer({ children: { count: 2, radius: 0.2, scale: 0.8, alpha: 0.5 } });
copies.setup(system);
assert.equal(copies.layers.length, 3);
assert.equal(copies.renderedChildCount, 2);
assert.equal(copies.layers[1].alpha.value, 0.5);
assert.equal(copies.layers[1].scale.value, 0.8);
assert.equal(copies.layers[0].density, copies.layers[1].density, 'copies reuse source texture bindings');
const offsets = copies.layers.map(layer => layer.offset.value.toArray());
copies.update([], system);
assert.deepEqual(copies.layers.map(layer => layer.offset.value.toArray()), offsets);
copies._gpuChildren.prepare = () => { throw new Error('Field children must not generate particle buffers'); };
copies.updateGPU({}, system);
copies.generateChildren = false;
copies.update([], system);
assert.equal(copies.layers.length, 1);
assert.equal(copies.renderedChildCount, 0);
copies.interpolation = VolumeInterpolation.Cubic;
copies.densityMapping = VolumeDensityMapping.Curve;
copies.densityCurve = t => t * t;
copies.update([], system);
assert.ok(copies.curveTexture.version > 0);
copies.destroy();
const uniformCount = uniform(1);
const constantChildren = new VolumeRenderer({ children: { count: uniformCount, radius: 0,
  scale: float(0.8), alpha: float(0.5) } });
constantChildren.setup(system);
assert.equal(constantChildren.layers.length, 2);
assert.ok(Math.abs(constantChildren.layers[1].scale.value - 0.8) < 1e-6);
assert.equal(constantChildren.layers[1].alpha.value, 0.5);
uniformCount.value = 2;
constantChildren.update([], system);
assert.equal(constantChildren.layers.length, 3);
constantChildren.destroy();

// Discovery includes dependents, deduplicates shared instances, and does not rely on GasSimulation.
class CustomVolume extends Module {
  constructor(field, color) {
    super(() => {});
    this.field = field;
    this.color = color;
  }
  getVolumeField() { return this.field; }
  getVolumeColorField() { return this.color; }
}
class DerivedVolume extends CustomVolume {}
const custom = new CustomVolume(gas.density, gas.colorField);
const dependent = new DerivedVolume(gas.density);
custom.dependents.push(dependent);
const lookup = new ParticleSystem({ emitters: [], renderers: [], modules: [custom, dependent] });
assert.deepEqual(lookup.getModules(CustomVolume), [dependent, custom]);
assert.deepEqual(lookup.getModules(DerivedVolume), [dependent]);
assert.deepEqual(lookup.getModules(['getVolumeField']), [dependent, custom]);
assert.deepEqual(lookup.getModules(['getVolumeField', 'missing']), []);
assert.deepEqual(lookup.getModules([]), [dependent, custom]);
const capability = Symbol('capability');
custom[capability] = true;
assert.deepEqual(lookup.getModules([capability]), [custom]);
assert.deepEqual(lookup.getModules(GasSimulation), []);
assert.deepEqual(system.getModules(['getVolumeField']), [gas]);
const customRenderer = new VolumeRenderer();
assert.deepEqual(customRenderer.resolveFields(lookup), [
  { field: gas.density, colorField: undefined },
  { field: gas.density, colorField: gas.colorField },
]);
custom.tags = ['smoke'];
dependent.tags = ['fire'];
assert.deepEqual(lookup.getModules(CustomVolume, ['smoke']), [custom]);
assert.deepEqual(lookup.getModules(['getVolumeField'], ['fire']), [dependent]);
assert.deepEqual(lookup.getModules(['getVolumeField'], null), [dependent, custom]);
assert.deepEqual(lookup.getModules(['getVolumeField'], []), []);
dependent.tags = null;
assert.deepEqual(lookup.getModules(CustomVolume, ['smoke']), [dependent, custom]);
dependent.tags = undefined;
assert.deepEqual(lookup.getModules(CustomVolume, ['smoke']), [dependent, custom]);
customRenderer.tags = ['fire'];
assert.deepEqual(customRenderer.resolveFields(lookup), [{ field: gas.density, colorField: undefined }]);
customRenderer.tags = undefined;
lookup.modules.reverse();
lookup.removeModule(dependent);
custom.dependents.length = 0;
assert.deepEqual(lookup.getModules(['getVolumeField']), [custom], 'queries reflect runtime composition');
assert.equal(customRenderer.resolveFields(lookup)[0].colorField, gas.colorField);
customRenderer.field = () => undefined;
assert.deepEqual(customRenderer.resolveFields(lookup), [], 'explicit callbacks retain control over visibility');
customRenderer.field = gas.colorField;
customRenderer.colorField = gas.density;
assert.deepEqual(customRenderer.resolveFields(lookup), [{ field: gas.colorField, colorField: gas.density }]);
customRenderer.destroy();
lookup.destroy();
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
