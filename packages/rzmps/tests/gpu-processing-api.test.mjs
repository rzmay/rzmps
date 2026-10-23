import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  Module,
  Particle,
  ParticleSystem,
  Renderer,
  SpatialEffect,
  AudioRenderer,
  LightRenderer,
  MeshRenderer,
  OrientToDirection,
  SpriteRenderer,
  TrailRenderer,
  ColorOverLifetime,
  Collision,
  Emitter,
  EmissionShape,
  EmissionSource,
  ParticleForceField,
  ScaleOverLifetime,
  ThreeCollisionBackend,
  GPUAllocationBufferState,
  GPUEmitterInstanceBufferState,
  GPUEmissionRunBufferState,
  GPUEventBufferState,
  GPU_EVENT_FLOAT_SLOT_COUNT,
  GPUEventType,
  GPUSpatialEffectRegistry,
  GPUSelectiveReadbackState,
  KillZone,
  MaxCulling,
  TagSelectionMethod,
  buildGPUSystemSchedule,
  createEmptyGPUParticleBufferState,
  createGPUParticleBufferState,
} from '../build/index.mjs';

class CPUOnlyRenderer extends Renderer {
  setup() {}
  _update() {}
  destroy() {}
  clear() {}
}

class GPUCapableRenderer extends Renderer {
  setup() {}
  _update() {}
  updateGPU() {}
  destroy() {}
  clear() {}
}

const cpuOnlyModule = new Module(() => {});
const gpuModule = new Module(Module.CPU_UNSUPPORTED, {
  modifyGPU() {},
});
const explicitUnsupportedGPU = new Module(() => {}, {
  modifyGPU: null,
});
const cpuConditionOnlyModule = new Module(() => {}, {
  condition: () => true,
  modifyGPU() {},
});
const pairedConditionModule = new Module(() => {}, {
  condition: () => true,
  conditionGPU: (particle) => particle.alive.notEqual(0),
  modifyGPU() {},
});

assert.equal(cpuOnlyModule.supportsGPU, false);
assert.equal(gpuModule.supportsGPU, true);
assert.equal(explicitUnsupportedGPU.supportsGPU, false);
assert.equal(cpuConditionOnlyModule.supportsGPU, false);
assert.equal(pairedConditionModule.supportsGPU, true);
assert.throws(() => Module.CPU_UNSUPPORTED(new Particle(), 0), /does not support CPU processing/);
assert.throws(() => Module.GPU_UNSUPPORTED(gpuModule, 0, {}), /does not support GPU processing/);

assert.equal(new CPUOnlyRenderer().supportsGPUInput, false);
assert.equal(new GPUCapableRenderer().supportsGPUInput, true);
assert.equal(new AudioRenderer().supportsGPUInput, true);
assert.equal(new LightRenderer().supportsGPUInput, true);
assert.equal(new MeshRenderer().supportsGPUInput, true);
assert.equal(new SpriteRenderer(new THREE.Texture()).supportsGPUInput, true);
assert.equal(new TrailRenderer({ texture: new THREE.Texture() }).supportsGPUInput, true);

const shadowMaskRenderer = new MeshRenderer({ castShadow: true, maxParticles: 1 });
const shadowMaskSystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
shadowMaskRenderer.updateGPU(createEmptyGPUParticleBufferState(1), shadowMaskSystem);
assert.ok(shadowMaskRenderer.instances.material.maskShadowNode);
assert.equal(shadowMaskRenderer.instances.castShadow, true);

assert.equal(new OrientToDirection().supportsGPU, true);
assert.equal(new ColorOverLifetime({ alpha: [1, 0] }).supportsGPU, true);
assert.equal(new ScaleOverLifetime({ scale: () => new THREE.Vector3(1, 1, 1) }).supportsGPU, true);
assert.equal(new ScaleOverLifetime({ scale: new Set([new THREE.Vector3(1, 1, 1)]) }).supportsGPU, true);
assert.equal(new Collision().supportsGPU, true);
assert.equal(new Collision().withDependents().every((module) => module.supportsGPU), true);
assert.equal(new Collision({ backend: new ThreeCollisionBackend() }).supportsGPU, false);
const runtimeCollisionBackend = new ThreeCollisionBackend();
const runtimeCollision = new Collision();
runtimeCollision.backend = runtimeCollisionBackend;
assert.equal(runtimeCollision.supportsGPU, false);
runtimeCollision.setBackend(undefined);
assert.equal(runtimeCollision.backend, undefined);
assert.equal(runtimeCollision.supportsGPU, true);
runtimeCollisionBackend.destroy?.();
assert.equal(new ThreeCollisionBackend().supportsCPU, true);
assert.equal(new ThreeCollisionBackend({ maxLevel: 4, trianglesPerLeaf: 12 }).maxLevel, 4);

const initialCapacitySystem = new ParticleSystem({
  maxParticles: 10000,
  emitters: [],
  renderers: [],
  modules: [],
});
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 256);
initialCapacitySystem.emitters = [new Emitter({
  rate: [10, 20],
  bursts: [
    { time: 0, count: [30, 40] },
    { time: 1, count: 10 },
  ],
  initialValues: { lifetime: (time) => 2 + time * 3 },
})];
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 256);
initialCapacitySystem.emitters.push(new Emitter({
  rate: 100,
  bursts: { time: 0, count: new Set([20, 60]) },
  initialValues: { lifetime: 5 },
}));
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 1024);
initialCapacitySystem.emitters = [];
initialCapacitySystem.particles.push(...Array.from({ length: 300 }, () => new Particle()));
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 512);
initialCapacitySystem.maxParticles = 400;
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 400);
initialCapacitySystem.maxParticles = 10000;
initialCapacitySystem.particles.length = 0;
initialCapacitySystem.emitters = [new Emitter({
  rate: 0,
  bursts: { time: 0, count: 10000 },
})];
assert.equal(initialCapacitySystem._getInitialGPUBufferCapacity(), 10000);

const modeSwitchSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  modules: [],
});
modeSwitchSystem.particles.push(new Particle({ lifetime: 10 }));
modeSwitchSystem.gpuProcessing = true;
assert.equal(modeSwitchSystem.particles.length, 1);
modeSwitchSystem.gpuProcessing = false;
assert.equal(modeSwitchSystem.particles.length, 0);
assert.equal(modeSwitchSystem.playing, true);

const resetSubSystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const resetChildSystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
modeSwitchSystem.addSubSystem(resetSubSystem, { emitContinuous: true });
modeSwitchSystem.add(resetChildSystem);
[modeSwitchSystem, resetSubSystem, resetChildSystem].forEach((system, index) => {
  system.particles.push(new Particle({ lifetime: 10 }));
  system._elapsedTime = index + 1;
  system._processingMode = 'gpu';
});
const lifecycleGenerations = [modeSwitchSystem, resetSubSystem, resetChildSystem]
  .map((system) => system._gpuLifecycleGeneration);
modeSwitchSystem.reset();
[modeSwitchSystem, resetSubSystem, resetChildSystem].forEach((system, index) => {
  assert.equal(system.particles.length, 0);
  assert.equal(system._elapsedTime, 0);
  assert.equal(system._processingMode, undefined);
  assert.equal(system._gpuLifecycleGeneration, lifecycleGenerations[index] + 1);
  assert.equal(system.playing, true);
  assert.equal(system.paused, false);
});

modeSwitchSystem.particles.push(new Particle({ lifetime: 10 }));
modeSwitchSystem._processingMode = 'gpu';
modeSwitchSystem._processParticles();
assert.equal(modeSwitchSystem.particles.length, 0);
assert.equal(modeSwitchSystem._processingMode, 'cpu');

const particle = new Particle({
  lifetime: 100,
  position: new THREE.Vector3(1, 2, 3),
  velocity: new THREE.Vector3(1, 0, 0),
});
const buffers = createGPUParticleBufferState([particle], 4);

assert.equal(buffers.count, 1);
assert.equal(buffers.capacity, 4);
assert.equal(buffers.attributes.floatData.count, 44);
assert.equal(buffers.attributes.floatData.array[0], 1);
assert.equal(buffers.attributes.floatData.array[1], 2);
assert.equal(buffers.attributes.floatData.array[2], 3);
assert.equal(buffers.attributes.uintData.array[0], 1);
assert.equal(buffers.attributes.uintData.array[4], 0);

particle.tags = ['spark', 'hot'];
buffers.upload([particle], (p) => (
  (p.tags?.includes('spark') ? 1 : 0)
  + (p.tags?.includes('hot') ? 2 : 0)
));

assert.equal(buffers.attributes.uintData.array[1], 3);
assert.equal(buffers.attributes.uintData.array[5], 0);

const growBuffers = createEmptyGPUParticleBufferState(4);
const gpuBuffers = new Map();
const copies = [];
const destroyed = [];
const growRenderer = {
  backend: {
    device: {
      createCommandEncoder() {
        return {
          copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
            copies.push({ source, sourceOffset, destination, destinationOffset, size });
          },
          finish() { return {}; },
        };
      },
      queue: { submit() {} },
    },
    get(attribute) { return { buffer: gpuBuffers.get(attribute) }; },
    createStorageAttribute(attribute) { gpuBuffers.set(attribute, {}); },
    destroyAttribute(attribute) { destroyed.push(attribute); },
  },
};
growBuffers.initialize(growRenderer);
assert.equal(growBuffers.grow(growRenderer, 8), true);
assert.equal(growBuffers.capacity, 8);
assert.equal(copies.length, 2);
assert.equal(destroyed.length, 2);

const emptyGPUPool = createEmptyGPUParticleBufferState(8);
assert.equal(emptyGPUPool.count, 0);
assert.equal(emptyGPUPool.capacity, 8);
assert.equal(emptyGPUPool.attributes.uintData.array[0], 0);
assert.equal(emptyGPUPool.attributes.uintData.array[28], 0);

const sphereShapeSupport = EmissionShape.Sphere().getGPUEmissionSupport();
assert.equal(sphereShapeSupport.supported, true);
assert.equal(sphereShapeSupport.level, 'native');

for (const createShape of [
  (source) => EmissionShape.Box({ source }, 1, 1, 1),
  (source) => EmissionShape.Sphere({ source }, 1, 8, 4),
  (source) => EmissionShape.Cone({ source }, 1, 1, 8),
  (source) => EmissionShape.Torus({ source }, 1, 0.25, 8, 4),
]) {
  for (const source of [EmissionSource.Volume, EmissionSource.Surface, EmissionSource.Vertices]) {
    const shape = createShape(source);
    assert.equal(shape.getGPUEmissionSupport().supported, true);
    assert.equal(new Emitter({ source: shape }).supportsGPUEmission, true);
  }
}

const customGeometryShape = new EmissionShape({
  geometry: new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0, 0.5, 0,
    ], 3),
  ),
  source: EmissionSource.Surface,
});
assert.equal(customGeometryShape.getGPUEmissionSupport().supported, true);
assert.ok(customGeometryShape.getGPUEmissionSupport().features.includes('sampling:geometry-buffer'));
assert.doesNotThrow(() => new Emitter({ source: customGeometryShape }).createBuiltInGPUUpdate());
const surfaceGetPoint = customGeometryShape.getPoint;
customGeometryShape.getPoint = () => { throw new Error('surface GPU emission must use geometry buffers'); };
assert.doesNotThrow(() => new Emitter({ source: customGeometryShape }).createBuiltInGPUUpdate());
customGeometryShape.getPoint = surfaceGetPoint;

const unequalSurfaceShape = new EmissionShape({
  geometry: new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      10, 0, 0, 12, 0, 0, 10, 2, 0,
    ], 3),
  ),
  source: EmissionSource.Surface,
});
const unequalSurfaceEmitter = new Emitter({ source: unequalSurfaceShape });
unequalSurfaceEmitter.createBuiltInGPUUpdate();
const surfaceTriangles = unequalSurfaceEmitter._gpuGeometrySampling.triangles.array;
assert.equal(surfaceTriangles[3], 1);
assert.ok(Math.abs(surfaceTriangles[4] / 0xffffffff - 0.4) < 1e-6);
assert.equal(surfaceTriangles[11], 1);
assert.equal(surfaceTriangles[12], 0xffffffff);

const sampledVolumeShape = EmissionShape.Torus({ source: EmissionSource.Volume }, 1, 0.25, 4, 8);
sampledVolumeShape.volumeSamples = 4;
const sampledVolumeEmitter = new Emitter({ source: sampledVolumeShape });
sampledVolumeEmitter.createBuiltInGPUUpdate();
assert.equal(sampledVolumeEmitter._gpuVolumeSampling.count, 4);
assert.ok(
  Math.abs(
    sampledVolumeEmitter._gpuVolumeSampling.vectors.array[3]
      - sampledVolumeShape.getVolumeSamples()[0].radius,
  ) < 1e-6,
  'GPU storage should use the radius from the shared CPU volume table',
);
const sampledVolumeVectors = sampledVolumeEmitter._gpuVolumeSampling.vectors;
sampledVolumeEmitter.createBuiltInGPUUpdate();
assert.equal(
  sampledVolumeEmitter._gpuVolumeSampling.vectors,
  sampledVolumeVectors,
  'unchanged shared volume tables should reuse their GPU storage',
);
sampledVolumeShape.volumeSamples = 6;
sampledVolumeEmitter.createBuiltInGPUUpdate();
assert.equal(sampledVolumeEmitter._gpuVolumeSampling.count, 6);
assert.notEqual(sampledVolumeEmitter._gpuVolumeSampling.vectors, sampledVolumeVectors);

const gpuNativeEmitter = new Emitter({
  source: EmissionShape.Box({ source: EmissionSource.Volume }, 1, 2, 3),
  rate: [5, 10],
  rateOverDistance: 2,
  bursts: [
    { time: 0, count: 3 },
    { time: 0.5, count: [1, 2] },
  ],
  radialSpeed: new Set([1, 2]),
  alignment: (time) => time,
  initialValues: {
    lifetime: [1, 2],
    velocity: new THREE.Vector3(0, 1, 0),
    color: new Set([new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0)]),
  },
  tags: ['gpu-a', 'gpu-b'],
  tagSelection: TagSelectionMethod.Random,
});
assert.equal(gpuNativeEmitter.supportsGPUEmission, true);
assert.ok(gpuNativeEmitter.getGPUEmissionSupport().features.includes('bursts'));
assert.ok(gpuNativeEmitter.getGPUEmissionSupport().features.includes('rateOverDistance'));

const builtInGPUEmitter = new Emitter({
  source: EmissionShape.Box({ source: EmissionSource.Volume }, 2, 4, 6),
  rate: 10,
  bursts: [{ time: 0.1, count: 2 }],
  radialSpeed: 0,
  initialValues: {
    lifetime: 2,
    speed: 1,
    position: new THREE.Vector3(1, 2, 3),
    velocity: new THREE.Vector3(0, 1, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(1, 1, 1),
  },
});
assert.equal(builtInGPUEmitter.supportsGPUEmission, true);
assert.ok(builtInGPUEmitter.getGPUEmissionSupport().features.includes('builtIn:BoxGeometry:volume'));
const builtInSphereGPUEmitter = new Emitter({
  source: EmissionShape.Sphere({ source: EmissionSource.Volume }, 3, 16, 8),
  rate: 10,
  radialSpeed: 1,
  initialValues: {
    lifetime: 2,
    speed: 1,
  },
});
assert.equal(builtInSphereGPUEmitter.supportsGPUEmission, true);
const builtInBurstGPUEmitter = new Emitter({
  source: EmissionShape.Sphere({ source: EmissionSource.Volume }, 0.1, 16, 8),
  rate: 0,
  bursts: [{ time: 0, count: [100, 300] }],
  radialSpeed: [4.5, 12],
  initialValues: {
    lifetime: [0.75, 1.35],
    scale: [
      new THREE.Vector3(0.06, 0.06, 0.06),
      new THREE.Vector3(0.14, 0.14, 0.14),
    ],
    color: new Set([new THREE.Color(1, 1, 1), new THREE.Color(1, 0.8, 0.4)]),
  },
});
assert.equal(builtInBurstGPUEmitter.supportsGPUEmission, true);

const manyBurstGPUEmitter = new Emitter({
  bursts: Array.from({ length: 65 }, (_, index) => ({ time: index / 64, count: 1 })),
});
assert.equal(manyBurstGPUEmitter.supportsGPUEmission, true);
assert.equal(manyBurstGPUEmitter.bursts.length, 65);
const boundedBurstTimesEmitter = new Emitter({
  bursts: [
    { time: Number.NEGATIVE_INFINITY, count: 1 },
    { time: Number.NaN, count: 1 },
    { time: Number.POSITIVE_INFINITY, count: 1 },
  ],
});
assert.deepEqual(boundedBurstTimesEmitter.bursts.map((burst) => burst.time), [0, 0, 1]);

const lodGPUEmitter = new Emitter({
  rate: 20,
  rateOverDistance: 2,
  bursts: [{ time: 0.5, count: 4 }],
  updateLOD: { distance: 5, quality: 0.5 },
  countLOD: { distance: 5, quality: 0.5 },
});
assert.ok(lodGPUEmitter.getGPUEmissionSupport().features.includes('updateLOD'));
assert.ok(lodGPUEmitter.getGPUEmissionSupport().features.includes('countLOD'));

const distributeTagsEmitter = new Emitter({
  tags: ['a', 'b'],
  tagSelection: TagSelectionMethod.Distribute,
});
assert.equal(distributeTagsEmitter.supportsGPUEmission, true);
assert.ok(distributeTagsEmitter.getGPUEmissionSupport().features.includes('tags:distribute'));

const customShapeEmitter = new Emitter({
  source: customGeometryShape,
});
assert.equal(customShapeEmitter.supportsGPUEmission, true);
assert.ok(customShapeEmitter.getGPUEmissionSupport().features.includes('sampling:geometry-buffer'));

let gpuEmitterDispatches = 0;
const previousEmitterReadbackRate = ParticleSystem.GPU_READBACK_RATE;
ParticleSystem.GPU_READBACK_RATE = 0;
const gpuEmitterRenderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  compute() {
    gpuEmitterDispatches += 1;
  },
});
const gpuEmitterSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [new Emitter({ rate: 1 }), new Emitter({ rate: 2 })],
  renderers: [],
  modules: [],
  maxParticles: 32,
});
gpuEmitterSystem._renderer = gpuEmitterRenderer;
gpuEmitterSystem.deltaTime = 1 / 60;
assert.equal(gpuEmitterSystem._shouldExecuteEmittersOnGPU(), true);
gpuEmitterSystem._processParticles();
assert.equal(gpuEmitterDispatches, 8);
assert.equal(gpuEmitterSystem._gpuEmissionComputeCache.nodes.length, 2);
assert.equal(gpuEmitterSystem._gpuBuffers.count, gpuEmitterSystem._gpuBuffers.capacity);
assert.equal(gpuEmitterSystem.particles.length, 0);
ParticleSystem.GPU_READBACK_RATE = previousEmitterReadbackRate;

let builtInEmitterDispatches = 0;
const previousBuiltInReadbackRate = ParticleSystem.GPU_READBACK_RATE;
ParticleSystem.GPU_READBACK_RATE = 0;
const builtInEmitterRenderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  compute() {
    builtInEmitterDispatches += 1;
  },
});
const builtInEmitterSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [builtInGPUEmitter],
  renderers: [],
  modules: [],
  maxParticles: 32,
});
builtInEmitterSystem._renderer = builtInEmitterRenderer;
builtInEmitterSystem.deltaTime = 1 / 60;
assert.equal(builtInEmitterSystem._shouldExecuteEmittersOnGPU(), true);
builtInEmitterSystem._processParticles();
assert.equal(builtInEmitterDispatches, 5);
assert.ok(builtInEmitterSystem._gpuEmissionComputeCache.nodes[0]);
assert.ok(builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0]);
assert.equal(builtInEmitterSystem._gpuBuffers.count, builtInEmitterSystem._gpuBuffers.capacity);
assert.equal(builtInEmitterSystem.particles.length, 0);
const initialEmissionNode = builtInEmitterSystem._gpuEmissionComputeCache.nodes[0];
const initialPrepareNode = builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0];
const initialEmitterVersion = builtInGPUEmitter.version;
const initialConfigurationStats = builtInEmitterSystem.gpuConfigurationStats;
builtInGPUEmitter.rate = 40;
builtInGPUEmitter.rateOverDistance = 3;
builtInGPUEmitter.bursts[0].time = 0.25;
builtInGPUEmitter.initialValues.position.set(4, 5, 6);
builtInEmitterSystem.duration = 24;
builtInEmitterSystem.gravity.set(1, 2, 3);
builtInEmitterSystem._processParticles();
assert.equal(builtInGPUEmitter.version, initialEmitterVersion);
assert.equal(builtInEmitterSystem._gpuEmissionComputeCache.nodes[0], initialEmissionNode);
assert.equal(builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0], initialPrepareNode);
assert.equal(
  builtInEmitterSystem.gpuConfigurationStats.pipelineBuilds,
  initialConfigurationStats.pipelineBuilds,
);
assert.equal(typeof builtInEmitterSystem.gpuConfigurationStats.parameterUploads, 'number');

builtInGPUEmitter.rate = (time) => 20 + time * 10;
builtInEmitterSystem._processParticles();
assert.ok(builtInGPUEmitter.version > initialEmitterVersion);
assert.notEqual(builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0], initialPrepareNode);
assert.ok(
  builtInEmitterSystem.gpuConfigurationStats.pipelineBuilds
    > initialConfigurationStats.pipelineBuilds,
);
const curvePrepareNode = builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0];
builtInGPUEmitter.rate = 20;
builtInEmitterSystem._processParticles();
assert.notEqual(builtInEmitterSystem._gpuEmissionPrepareComputeCache.nodes[0], curvePrepareNode);
ParticleSystem.GPU_READBACK_RATE = previousBuiltInReadbackRate;

const mutableRenderer = new SpriteRenderer(new THREE.Texture(), {
  gridSize: new THREE.Vector2(2, 2),
  countLOD: { distance: 10, quality: 0.5 },
  materialOptions: { depthWrite: false },
});
mutableRenderer.syncGPUConfiguration();
const initialRendererVersion = mutableRenderer.version;
mutableRenderer.countLOD.quality = 0.25;
mutableRenderer.syncGPUConfiguration();
assert.equal(mutableRenderer.version, initialRendererVersion);
assert.equal(mutableRenderer._countLODHelper.quality, 0.25);
mutableRenderer.gridSize.set(4, 2);
mutableRenderer.syncGPUConfiguration();
assert.ok(mutableRenderer.version > initialRendererVersion);
const gridRendererVersion = mutableRenderer.version;
mutableRenderer.materialOptions.depthWrite = true;
mutableRenderer.syncGPUConfiguration();
assert.ok(mutableRenderer.version > gridRendererVersion);

const mutableEmitterLOD = new Emitter({
  updateLOD: { distance: 10, quality: 0.5 },
  countLOD: { distance: 20, quality: 0.25 },
});
mutableEmitterLOD.updateLOD.distance = 30;
mutableEmitterLOD.countLOD.quality = 0.75;
mutableEmitterLOD.syncGPUConfiguration();
assert.equal(mutableEmitterLOD._lodHelper.distance, 30);
assert.equal(mutableEmitterLOD._countLODHelper.quality, 0.75);

const mutableSystemLOD = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
  useUpdateLOD: false,
  updateLOD: { distance: 10, quality: 0.5 },
});
mutableSystemLOD.updateLOD.distance = 40;
mutableSystemLOD.update();
assert.equal(mutableSystemLOD._lodHelper.distance, 40);

const explicitVersionModule = new Module(Module.CPU_UNSUPPORTED, { modifyGPU() {} });
const moduleSignatureSystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const firstModuleSignature = moduleSignatureSystem._getGPUModifierSignature(explicitVersionModule);
explicitVersionModule.needsUpdate = true;
assert.notEqual(moduleSignatureSystem._getGPUModifierSignature(explicitVersionModule), firstModuleSignature);

const explicitVersionEffect = new SpatialEffect(null, { modifyGPU() {} });
const firstEffectSignature = moduleSignatureSystem._getGPUModifierSignature(explicitVersionEffect);
explicitVersionEffect.needsUpdate = true;
assert.notEqual(moduleSignatureSystem._getGPUModifierSignature(explicitVersionEffect), firstEffectSignature);

const gpuEmissionSupportSystem = new ParticleSystem({
  emitters: [gpuNativeEmitter],
  renderers: [],
  modules: [],
});
assert.equal(gpuEmissionSupportSystem.getGPUEmissionSupport().supported, true);

const customEmissionSupportSystem = new ParticleSystem({
  emitters: [customShapeEmitter],
  renderers: [],
  modules: [],
});
assert.equal(customEmissionSupportSystem.getGPUEmissionSupport().supported, true);

const parentEmissionSupportSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});
const childEmissionSupportSystem = new ParticleSystem({
  emitters: [gpuNativeEmitter],
  renderers: [],
  modules: [],
});
parentEmissionSupportSystem.addSubSystem(childEmissionSupportSystem, {
  emitContinuous: true,
  shouldEmit: () => true,
});
assert.equal(parentEmissionSupportSystem.getGPUEmissionSupport().supported, false);
assert.match(parentEmissionSupportSystem.getGPUEmissionSupport().reasons.join('\n'), /shouldEmit function/);

const scheduleRoot = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const scheduleChildA = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const scheduleChildB = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const scheduleGrandchild = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
scheduleRoot.addSubSystem(scheduleChildA, { emitContinuous: true });
scheduleRoot.addSubSystem(scheduleChildB, { emitOnDeath: true });
scheduleChildA.addSubSystem(scheduleGrandchild, { emitOnSpawn: true });
const schedule = scheduleRoot.getGPUExecutionSchedule();
assert.deepEqual(schedule.nodes.map((node) => node.system), [
  scheduleRoot,
  scheduleChildA,
  scheduleGrandchild,
  scheduleChildB,
]);
assert.deepEqual(schedule.nodes.map((node) => node.depth), [0, 1, 2, 1]);
assert.equal(buildGPUSystemSchedule(scheduleRoot).nodes.length, 4);

const mixedParent = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const mixedChild = new ParticleSystem({ emitters: [gpuNativeEmitter], renderers: [], modules: [] });
mixedParent.addSubSystem(mixedChild, { emitContinuous: true, emitOnDeath: true });
assert.equal(mixedParent.getGPUEmissionSupport().supported, true);

const emissionRuns = new GPUEmissionRunBufferState(4);
assert.equal(emissionRuns.capacity, 4);
assert.equal(emissionRuns.snapshots.capacity, 4);
emissionRuns.reset();
assert.equal(emissionRuns.snapshots.count, 4);

const cycleRoot = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const cycleChild = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
cycleRoot.subSystems.set(cycleChild, {
  shouldEmit: true,
  ratio: 1,
  emitContinuous: true,
  emitOnCollision: false,
  emitOnSpawn: false,
  emitOnDeath: false,
  inheritScale: 1,
  inheritLifetime: 1,
  inheritColor: 1,
  inheritAlpha: 1,
  inheritMass: 1,
  inheritVelocity: 0,
  impulseAffectsScale: 0,
  impulseAffectsSpeed: 0,
  impulseAffectsLifetime: 0,
  impulseAffectsMass: 0,
  impulseAffectsAlignment: false,
  impulseThreshold: 0,
});
cycleChild.subSystems.set(cycleRoot, cycleRoot.subSystems.get(cycleChild));
assert.throws(() => cycleRoot.getGPUExecutionSchedule(), /dependency cycle/);

const survivor = new Particle({
  lifetime: 100,
  position: new THREE.Vector3(9, 8, 7),
});
survivor.tags = ['survivor'];
buffers.sync([survivor], (p) => (p.tags?.includes('survivor') ? 4 : 0));

assert.equal(buffers.count, 1);
assert.equal(buffers.attributes.floatData.array[0], 9);
assert.equal(buffers.attributes.floatData.array[1], 8);
assert.equal(buffers.attributes.floatData.array[2], 7);
assert.equal(buffers.attributes.uintData.array[1], 4);
assert.equal(buffers.attributes.uintData.array[4], 0);

let cpuFallbackRan = false;
const system = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  modules: [
    new Module((p) => {
      cpuFallbackRan = true;
      p.position.x += 1;
    }),
  ],
  gravityModifier: 0,
});

system.particles.push(particle);
system.deltaTime = 0;
system._processParticles();

assert.equal(cpuFallbackRan, true);
assert.equal(particle.position.x, 2);

const gpuEligibilitySystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [new CPUOnlyRenderer()],
  modules: [],
  gravityModifier: 0,
});

gpuEligibilitySystem._renderer = Object.create(WebGPURenderer.prototype);
gpuEligibilitySystem._gpuTagOverflow = false;

assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule], []), true);
assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule, cpuOnlyModule], []), false);
const renderTimeGPUModule = new Module(Module.CPU_UNSUPPORTED, {
  priority: 1,
  modifyGPU() {},
});
assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([renderTimeGPUModule], []), false);
gpuEligibilitySystem.renderers = [new GPUCapableRenderer()];
assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([renderTimeGPUModule], []), true);

const subsystemLimitSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [new GPUCapableRenderer()],
  modules: [],
});
subsystemLimitSystem.addSubSystem(new ParticleSystem({ renderers: [] }), {
  emitContinuous: true,
});
subsystemLimitSystem._renderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  backend: {
    device: { limits: { maxStorageBuffersPerShaderStage: 8 } },
  },
});
assert.equal(subsystemLimitSystem._canProcessParticlesOnGPU([gpuModule], []), true);

gpuEligibilitySystem.renderers = [new CPUOnlyRenderer()];
assert.equal(
  gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule], [new ParticleForceField()]),
  true,
);
assert.equal(
  gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule], [
    new SpatialEffect((p) => {
      p.alpha = 0;
    }),
  ]),
  true,
);
assert.equal(new CPUOnlyRenderer().supportsGPUInput, false);
assert.equal(new GPUCapableRenderer().supportsGPUInput, true);

gpuEligibilitySystem.particles = [
  new Particle({ tags: Array.from({ length: 64 }, (_unused, index) => `particle-${index}`) }),
];
gpuEligibilitySystem._prepareGPUTagRegistry([
  new Module(() => {}, {
    tags: Array.from({ length: 32 }, (_unused, index) => `gpu-${index}`),
  }),
]);

assert.equal(gpuEligibilitySystem._gpuTagOverflow, false);

gpuEligibilitySystem._prepareGPUTagRegistry([
  new Module(Module.CPU_UNSUPPORTED, {
    modifyGPU() {},
    tags: Array.from({ length: 33 }, (_unused, index) => `gpu-${index}`),
  }),
]);

assert.equal(gpuEligibilitySystem._gpuTagOverflow, true);

const previousReadbackRate = ParticleSystem.GPU_READBACK_RATE;
ParticleSystem.GPU_READBACK_RATE = 0;

let fusedDispatches = 0;
const fusedRenderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  compute() {
    fusedDispatches += 1;
  },
});
const fusedSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  gravityModifier: 0,
  modules: [
    new Module(Module.CPU_UNSUPPORTED, {
      priority: -2,
      modifyGPU(p) {
        p.velocity.assign(p.velocity);
      },
    }),
    new Module(Module.CPU_UNSUPPORTED, {
      priority: -1,
      modifyGPU(p) {
        p.velocity.assign(p.velocity);
      },
    }),
    new Module(Module.CPU_UNSUPPORTED, {
      priority: 0,
      modifyGPU(p) {
        p.velocity.assign(p.velocity);
      },
    }),
    new Module(Module.CPU_UNSUPPORTED, {
      priority: 0.5,
      modifyGPU(p) {
        p.velocity.assign(p.velocity);
      },
    }),
  ],
});

fusedSystem._renderer = fusedRenderer;
fusedSystem.particles.push(new Particle({ lifetime: 100 }));
fusedSystem.deltaTime = 1 / 60;
fusedSystem._processParticles();

assert.equal(fusedDispatches, 1);
assert.equal(fusedSystem.gpuAllocationStats.sequence, 1);
assert.equal(fusedSystem.gpuAllocationStats.startingActiveCount, 1);
assert.equal(fusedSystem.gpuAllocationStats.capacity, 256);
assert.equal(fusedSystem.gpuAllocationStats.cullingMode, 0);

ParticleSystem.GPU_READBACK_RATE = previousReadbackRate;

ParticleSystem.GPU_READBACK_RATE = 0;

let renderDispatches = 0;
let receivedRenderBuffer;
const compactRenderRenderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  compute() {
    renderDispatches += 1;
  },
});
const compactGPUInputRenderer = new GPUCapableRenderer();
compactGPUInputRenderer.updateGPU = (buffers) => {
  receivedRenderBuffer = buffers;
};
const compactRenderSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [compactGPUInputRenderer],
  gravityModifier: 0,
  modules: [
    new Module(Module.CPU_UNSUPPORTED, {
      priority: 1,
      modifyGPU(p) {
        p.alpha.assign(p.alpha);
      },
    }),
  ],
});

compactRenderSystem._renderer = compactRenderRenderer;
compactRenderSystem.particles.push(new Particle({ lifetime: 100 }));
compactRenderSystem.deltaTime = 1 / 60;
compactRenderSystem._processParticles();

assert.equal(renderDispatches, 2);
assert.equal(receivedRenderBuffer.attributes.floatData.count, receivedRenderBuffer.capacity * 4);

ParticleSystem.GPU_READBACK_RATE = previousReadbackRate;

ParticleSystem.GPU_READBACK_RATE = 0;

const cachedComputeNodes = [];
let cachedDeltaTimeArgument;
const cachingRenderer = Object.assign(Object.create(WebGPURenderer.prototype), {
  compute(node) {
    cachedComputeNodes.push(node);
  },
});
const cachingSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  gravityModifier: 0,
  modules: [
    new Module(Module.CPU_UNSUPPORTED, {
      priority: 0,
      modifyGPU(p, deltaTime) {
        cachedDeltaTimeArgument = deltaTime;
        p.velocity.assign(p.velocity.add(p.acceleration.mul(deltaTime)));
      },
    }),
  ],
});

cachingSystem._renderer = cachingRenderer;
cachingSystem.particles.push(new Particle({ lifetime: 100 }));
cachingSystem.deltaTime = 1 / 60;
cachingSystem._processParticles();
cachingSystem.deltaTime = 1 / 30;
cachingSystem._processParticles();

assert.equal(cachedComputeNodes.length, 2);
assert.equal(cachedComputeNodes[0], cachedComputeNodes[1]);
assert.notEqual(typeof cachedDeltaTimeArgument, 'number');
assert.equal(cachingSystem._gpuSimulationComputeCache.node, cachedComputeNodes[0]);

ParticleSystem.GPU_READBACK_RATE = previousReadbackRate;

const eventIdentity = new Particle({
  lifetime: 1,
  position: new THREE.Vector3(1, 2, 3),
});
eventIdentity.id = 'gpu-event-particle';
const eventBuffer = new GPUEventBufferState(1);
eventBuffer.reset(7);
eventBuffer.counterAttribute.array[0] = 2;
eventBuffer.counterAttribute.array[1] = 1;
eventBuffer.floatAttribute.array.set([
  9, 8, 7, 1.5,
  6, 5, 4, 0.25,
  3, 2, 1, 2,
  4, 5, 6, 0.75,
  7, 8, 9, 1,
  1, 2, 3, 0.5,
  4, 5, 6, 1000,
  0, 1, 0, 0,
  1, 0, 0, 0,
  0, 0, 1, 0,
  0.25, 0.5, 0.75, 0,
], 0);
new Uint32Array(eventBuffer.floatAttribute.array.buffer).set(
  [GPUEventType.Death, 0, 3, 7],
  14 * 4,
);
const eventBatch = await eventBuffer.readback({
  getArrayBufferAsync(attribute) {
    return Promise.resolve(attribute.array.buffer);
  },
}, (slot, generation) => (slot === 0 && generation === 3 ? eventIdentity : undefined));

assert.equal(eventBatch.sequence, 7);
assert.equal(eventBatch.rawEventCount, 2);
assert.equal(eventBatch.overflowCount, 1);
assert.equal(eventBatch.events.length, 1);
assert.equal(eventBatch.events[0].type, GPUEventType.Death);
assert.equal(eventBatch.events[0].tagMask, 7);
assert.equal(eventBatch.events[0].particle.id, 'gpu-event-particle');
assert.equal(eventBatch.events[0].particle.alive, false);
assert.equal(eventBatch.events[0].particle.position.x, 9);
assert.equal(eventBatch.events[0].particle.realtime, 1000);

const boundedEventSystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
boundedEventSystem.maxParticles = 8;
const eventRendererStub = {
  backend: {
    get() { return { buffer: {} }; },
  },
};
const firstReadbackBuffer = boundedEventSystem._acquireGPUEventBuffer(eventRendererStub);
const secondReadbackBuffer = boundedEventSystem._acquireGPUEventBuffer(eventRendererStub);
assert.equal(boundedEventSystem.gpuEventStats.buffers, 1);
assert.equal(firstReadbackBuffer.capacity, 32);
assert.equal(secondReadbackBuffer, firstReadbackBuffer);

const spawnCollisionBuffer = new GPUEventBufferState(2);
spawnCollisionBuffer.reset(8);
spawnCollisionBuffer.counterAttribute.array[0] = 2;
spawnCollisionBuffer.floatAttribute.array.set([
  1, 0, 0, 1,
  0, 0, 0, 1,
  0, 0, 0, 1,
  1, 1, 1, 1,
  0, 1, 0, 1,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  1, 1, 1, 0,
  2, 0, 0, 1,
  0, 0, 0, 1,
  0, 0, 0, 1,
  1, 1, 1, 1,
  0, 1, 0, 1,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  1, 1, 1, 0,
], 0);
const spawnCollisionBits = new Uint32Array(spawnCollisionBuffer.floatAttribute.array.buffer);
spawnCollisionBits.set([GPUEventType.Spawn, 0, 1, 8], 14 * 4);
spawnCollisionBits.set(
  [GPUEventType.Collision, 1, 2, 8],
  (GPU_EVENT_FLOAT_SLOT_COUNT + 14) * 4,
);
const spawnCollisionBatch = await spawnCollisionBuffer.readback({
  getArrayBufferAsync(attribute) {
    return Promise.resolve(attribute.array.buffer);
  },
}, (slot, generation) => new Particle({
  lifetime: 1,
  position: new THREE.Vector3(slot, generation, 0),
}));
assert.deepEqual(spawnCollisionBatch.events.map((event) => event.type), [
  GPUEventType.Spawn,
  GPUEventType.Collision,
]);
assert.equal(spawnCollisionBatch.events[0].particle.alive, true);
assert.equal(spawnCollisionBatch.events[1].particle.alive, true);

const gpuDeathSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  modules: [],
  gravityModifier: 0,
});
const gpuDeathParticle = new Particle({ lifetime: 1 });
gpuDeathParticle.id = 'gpu-death-dispatch';
gpuDeathSystem.particles.push(gpuDeathParticle);
const gpuDeathGeneration = gpuDeathSystem._getGPUParticleSlotGeneration(gpuDeathParticle, 0);
let gpuDeathCallbackCount = 0;
let gpuDeathCallbackParticle;
gpuDeathSystem.onDeath((particleValue) => {
  gpuDeathCallbackCount += 1;
  gpuDeathCallbackParticle = particleValue;
});

const gpuDeathSnapshot = gpuDeathParticle.clone();
gpuDeathSnapshot.realtime = 1001;
gpuDeathSnapshot.time = 1.001;
gpuDeathSnapshot.alive = false;
gpuDeathSystem._gpuCompletedEventBatches.set(1, {
  sequence: 1,
  rawEventCount: 1,
  overflowCount: 0,
  capacity: 1,
  events: [{
    type: 1,
    slot: 0,
    generation: gpuDeathGeneration,
    sequence: 1,
    particle: gpuDeathSnapshot,
  }],
});
gpuDeathSystem._flushGPUEventBatches();
gpuDeathSystem._applyGPUReadbackDeaths([gpuDeathParticle], [true]);

assert.equal(gpuDeathCallbackCount, 1);
assert.equal(gpuDeathCallbackParticle.id, 'gpu-death-dispatch');
assert.equal(gpuDeathSystem.particles[0].alive, false);

const allocationState = new GPUAllocationBufferState(16);
const initializedAllocationAttributes = [];
allocationState.initialize({
  backend: {
    get: () => undefined,
    createStorageAttribute: (attribute) => initializedAllocationAttributes.push(attribute),
  },
});
assert.deepEqual(initializedAllocationAttributes, [allocationState.attribute]);
allocationState.reset(4, 3, 1);
allocationState.attribute.array[0] = 5;
allocationState.attribute.array[1] = 2;
allocationState.attribute.array[2] = 3;
allocationState.attribute.array[3] = 1;
const orderedFloatBits = (value) => {
  const float = new Float32Array([value]);
  const bits = new Uint32Array(float.buffer)[0];
  return (bits & 0x80000000) !== 0
    ? (bits ^ 0xffffffff) >>> 0
    : (bits ^ 0x80000000) >>> 0;
};
[-2, -3, -4, 5, 6, 7, 8].forEach((value, index) => {
  allocationState.attribute.array[10 + index] = orderedFloatBits(value);
});
allocationState.attribute.array[17] = 1;
const allocationSnapshot = allocationState.snapshot();
assert.equal(allocationSnapshot.sequence, 4);
assert.equal(allocationSnapshot.capacity, 16);
assert.equal(allocationSnapshot.cullingMode, 1);
assert.equal(allocationSnapshot.allocationAttempts, 5);
assert.equal(allocationSnapshot.allocationSuccesses, 2);
assert.equal(allocationSnapshot.allocationFailures, 3);
assert.equal(allocationSnapshot.recycledDeaths, 1);
assert.equal(allocationSnapshot.startingActiveCount, 3);
assert.equal(allocationSnapshot.estimatedActiveCount, 4);
assert.deepEqual(allocationSnapshot.bounds.min.toArray(), [-2, -3, -4]);
assert.deepEqual(allocationSnapshot.bounds.max.toArray(), [5, 6, 7]);
assert.equal(allocationSnapshot.maxVelocity, 8);
const allocationReadback = await allocationState.readback({
  getArrayBufferAsync(attribute) {
    return Promise.resolve(attribute.array.buffer);
  },
});
assert.equal(allocationReadback.estimatedActiveCount, 4);

const emitterInstanceState = new GPUEmitterInstanceBufferState(2, 96);
emitterInstanceState.upload([{
  active: true,
  parentSlot: 7,
  parentGeneration: 3,
  emitterIndex: 1,
  runId: 42,
  flags: 5,
  firedBurstsMask: 0b101,
  firedBurstWords: [0b101, 0x80000000, 7],
  startTime: 10,
  lastSpawn: 11,
  distanceCredit: 0.5,
  elapsedTime: 1.25,
  lastDistancePosition: new THREE.Vector3(1, 2, 3),
  duration: 4,
}]);
assert.equal(emitterInstanceState.uintAttribute.array[0], 1);
assert.equal(emitterInstanceState.uintAttribute.array[1], 7);
assert.equal(emitterInstanceState.uintAttribute.array[2], 3);
assert.equal(emitterInstanceState.uintAttribute.array[3], 1);
assert.equal(emitterInstanceState.uintAttribute.array[4], 42);
assert.equal(emitterInstanceState.burstWordCount, 3);
assert.equal(emitterInstanceState.uintAttribute.array[6], 0b101);
assert.equal(emitterInstanceState.uintAttribute.array[8], 0x80000000);
assert.equal(emitterInstanceState.uintAttribute.array[9], 7);
const emitterInstanceReadback = await emitterInstanceState.readback({
  getArrayBufferAsync(attribute) {
    return Promise.resolve(attribute.array.buffer);
  },
});
assert.equal(emitterInstanceReadback.length, 1);
assert.equal(emitterInstanceReadback[0].parentSlot, 7);
assert.equal(emitterInstanceReadback[0].parentGeneration, 3);
assert.equal(emitterInstanceReadback[0].lastSpawn, 11);
assert.equal(emitterInstanceReadback[0].lastDistancePosition.z, 3);
assert.deepEqual(emitterInstanceReadback[0].firedBurstWords, [0b101, 0x80000000, 7]);
assert.throws(() => emitterInstanceState.upload([
  emitterInstanceReadback[0],
  emitterInstanceReadback[0],
  emitterInstanceReadback[0],
]), /capacity 2 exceeded/);

const cullingNewSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
  maxParticles: 1,
  maxCullingMode: MaxCulling.New,
});
cullingNewSystem._renderer = Object.create(WebGPURenderer.prototype);
assert.equal(cullingNewSystem.addParticle(new Particle({ lifetime: 10 })), true);
assert.equal(cullingNewSystem.addParticle(new Particle({ lifetime: 10 })), false);
assert.equal(cullingNewSystem.particles.length, 1);

const cullingOldSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
  maxParticles: 1,
  maxCullingMode: MaxCulling.Old,
});
cullingOldSystem._renderer = Object.create(WebGPURenderer.prototype);
const oldParticle = new Particle({ lifetime: 10 });
oldParticle.id = 'old-culling-original';
let oldCullingDeaths = 0;
cullingOldSystem.onDeath((value) => {
  if (value.id === 'old-culling-original') oldCullingDeaths += 1;
});
assert.equal(cullingOldSystem.addParticle(oldParticle), true);
assert.equal(cullingOldSystem.addParticle(new Particle({ lifetime: 10 })), true);
assert.equal(cullingOldSystem.particles.length, 1);
assert.equal(oldCullingDeaths, 1);

const multiDeathSystem = new ParticleSystem({
  gpuProcessing: true,
  emitters: [],
  renderers: [],
  modules: [],
  gravityModifier: 0,
});
const multiDeathParticles = Array.from({ length: 3 }, (_unused, index) => {
  const value = new Particle({ lifetime: 1 });
  value.id = `gpu-multi-death-${index}`;
  multiDeathSystem.particles.push(value);
  return value;
});
const multiDeathGenerations = multiDeathParticles.map((value, index) => (
  multiDeathSystem._getGPUParticleSlotGeneration(value, index)
));
const multiDeathIds = [];
multiDeathSystem.onDeath((particleValue) => {
  multiDeathIds.push(particleValue.id);
});
multiDeathSystem._gpuCompletedEventBatches.set(1, {
  sequence: 1,
  rawEventCount: 3,
  overflowCount: 0,
  capacity: 3,
  events: multiDeathParticles.map((value, index) => {
    const snapshot = value.clone();
    snapshot.alive = false;
    snapshot.realtime = 1001;
    snapshot.time = 1.001;
    return {
      type: 1,
      slot: index,
      generation: multiDeathGenerations[index],
      sequence: 1,
      particle: snapshot,
    };
  }),
});
multiDeathSystem._flushGPUEventBatches();

assert.deepEqual(multiDeathIds, [
  'gpu-multi-death-0',
  'gpu-multi-death-1',
  'gpu-multi-death-2',
]);

const batchableType = {
  key: 'test-batchable-force',
  parameterLayout: {
    id: 'test-force-v1',
    fields: [
      { name: 'strength', type: 'float' },
      { name: 'direction', type: 'vec3' },
    ],
  },
  testGPU() {},
  modifyGPU() {},
};
const makeBatchableEffect = (strength, x) => {
  const effect = new SpatialEffect(null, {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    position: new THREE.Vector3(x, 0, 0),
    priority: -1,
    modifyGPU() {},
  });
  effect.gpuSpatialType = batchableType;
  effect.writeGPUParameters = (target, offset) => {
    target[offset] = strength;
    target[offset + 1] = 1;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    target[offset + 4] = 0;
  };
  return effect;
};
const spatialRegistrySystem = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const spatialRegistry = GPUSpatialEffectRegistry.build(
  [makeBatchableEffect(2, -1), makeBatchableEffect(4, 1)],
  spatialRegistrySystem,
  () => 0,
);

assert.equal(spatialRegistry.records.length, 2);
assert.equal(spatialRegistry.types.length, 1);
assert.equal(spatialRegistry.records[0].parameterOffset, 0);
assert.equal(spatialRegistry.records[1].parameterOffset, 8);
assert.equal(spatialRegistry.parameterAttribute.array[0], 2);
assert.equal(spatialRegistry.parameterAttribute.array[8], 4);
assert.ok(spatialRegistry.bvhNodes.length >= 1);
assert.equal(spatialRegistry.leafEffectIds.length, 2);

const traverseSpatialRegistry = (registry, position) => {
  const candidates = [];
  let nodeIndex = 0;
  while (nodeIndex < registry.bvhNodes.length) {
    const node = registry.bvhNodes[nodeIndex];
    if (!node.bounds.containsPoint(position)) {
      nodeIndex = node.escape;
    } else {
      if (node.count > 0) {
        candidates.push(...registry.leafEffectIds.slice(node.start, node.start + node.count));
      }
      nodeIndex += 1;
    }
  }
  return candidates;
};
for (const position of [
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(100, 100, 100),
]) {
  const acceleratedCandidates = traverseSpatialRegistry(spatialRegistry, position).sort((a, b) => a - b);
  const accelerated = acceleratedCandidates.filter((id) => (
    spatialRegistry.records[id].bounds.containsPoint(position)
  ));
  const bruteForce = spatialRegistry.records
    .filter((record) => record.bounds.containsPoint(position))
    .map((record) => record.id);
  assert.deepEqual(accelerated, bruteForce);
}

const thousandSpatialRegistry = GPUSpatialEffectRegistry.build(
  Array.from({ length: 1000 }, (_unused, index) => makeBatchableEffect(index, index * 2)),
  spatialRegistrySystem,
  () => 0,
);
assert.equal(thousandSpatialRegistry.records.length, 1000);
assert.equal(thousandSpatialRegistry.types.length, 1);

const builtInSpatialRegistry = GPUSpatialEffectRegistry.build(
  [
    KillZone.Sphere({ position: new THREE.Vector3(-1, 0, 0) }, 1, 16, 8),
    KillZone.Sphere({ position: new THREE.Vector3(1, 0, 0) }, 1, 16, 8),
    ParticleForceField.Sphere({ direction: new THREE.Vector3(1, 0, 0), multiplier: 2 }, 1, 16, 8),
    ParticleForceField.Sphere({ direction: new THREE.Vector3(0, 1, 0), multiplier: 4 }, 1, 16, 8),
  ],
  spatialRegistrySystem,
  () => 0,
);

assert.equal(builtInSpatialRegistry.records.length, 4);
assert.equal(builtInSpatialRegistry.types.length, 2);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[3], 1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[12], 2);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[20], 0);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[27], -1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[76], 1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[81], 1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[88], 2);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[121], 1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[125], 1);
assert.equal(builtInSpatialRegistry.parameterAttribute.array[132], 4);

const builtInSpatialVersion = builtInSpatialRegistry.version;
const builtInSpatialParameterAttribute = builtInSpatialRegistry.parameterAttribute;
const builtInSpatialMetadataAttribute = builtInSpatialRegistry.metadataAttribute;
const builtInSpatialBoundsAttribute = builtInSpatialRegistry.bvhBoundsAttribute;
const builtInSpatialLeafAttribute = builtInSpatialRegistry.leafAttribute;
assert.equal(builtInSpatialRegistry.update(
  builtInSpatialRegistry.records.map((record) => record.effect),
  spatialRegistrySystem,
  () => 0,
), true);
assert.equal(builtInSpatialRegistry.version, builtInSpatialVersion);
assert.equal(builtInSpatialRegistry.parameterAttribute, builtInSpatialParameterAttribute);

const movingForceField = builtInSpatialRegistry.records[2].effect;
const oldMovingBounds = movingForceField.position.clone();
movingForceField.position.x += 12;
assert.equal(builtInSpatialRegistry.update(
  builtInSpatialRegistry.records.map((record) => record.effect),
  spatialRegistrySystem,
  () => 0,
), true);
assert.equal(builtInSpatialRegistry.version, builtInSpatialVersion);
assert.equal(builtInSpatialRegistry.bvhBoundsAttribute, builtInSpatialBoundsAttribute);
assert.equal(builtInSpatialRegistry.leafAttribute, builtInSpatialLeafAttribute);
assert.equal(builtInSpatialRegistry.stats.structuralBuilds, 1);
assert.equal(builtInSpatialRegistry.stats.parameterUploads, 1);
assert.equal(builtInSpatialRegistry.stats.leafUpdates, 1);
assert.equal(builtInSpatialRegistry.stats.bvhRefits, 1);
assert.ok(!builtInSpatialRegistry.records[2].bounds.containsPoint(oldMovingBounds));
assert.ok(builtInSpatialRegistry.records[2].bounds.containsPoint(movingForceField.position));

const unchangedSpatialStats = { ...builtInSpatialRegistry.stats };
assert.equal(builtInSpatialRegistry.update(
  builtInSpatialRegistry.records.map((record) => record.effect),
  spatialRegistrySystem,
  () => 0,
), true);
assert.deepEqual(builtInSpatialRegistry.stats, unchangedSpatialStats);

const localSpatialSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
  simulationSpace: 'local',
});
localSpatialSystem.position.x = 2;
const movingParent = new THREE.Group();
movingParent.position.x = 5;
const parentedForceField = ParticleForceField.Sphere({
  direction: new THREE.Vector3(1, 0, 0),
}, 1, 16, 8);
parentedForceField.position.x = 1;
movingParent.add(parentedForceField);
const parentedRegistry = GPUSpatialEffectRegistry.build(
  [parentedForceField],
  localSpatialSystem,
  () => 0,
);
const localBoundsCenter = parentedRegistry.records[0].bounds.getCenter(new THREE.Vector3());
assert.equal(localBoundsCenter.x, 4);
movingParent.position.x += 3;
assert.equal(parentedRegistry.update(
  [parentedForceField],
  localSpatialSystem,
  () => 0,
), true);
assert.equal(
  parentedRegistry.records[0].bounds.getCenter(new THREE.Vector3()).x,
  7,
  'parent movement must update local-simulation bounds without rebuilding the registry',
);
assert.equal(parentedRegistry.stats.structuralBuilds, 1);
assert.equal(parentedRegistry.stats.bvhRefits, 1);

const addedForceField = ParticleForceField.Sphere({
  direction: new THREE.Vector3(0, 0, 1),
  multiplier: 8,
}, 1, 16, 8);
assert.equal(builtInSpatialRegistry.update(
  [...builtInSpatialRegistry.records.map((record) => record.effect), addedForceField],
  spatialRegistrySystem,
  () => 0,
), false);
assert.equal(builtInSpatialRegistry.records.length, 4);
assert.equal(builtInSpatialRegistry.version, builtInSpatialVersion);
assert.equal(builtInSpatialRegistry.parameterAttribute, builtInSpatialParameterAttribute);
assert.equal(builtInSpatialRegistry.metadataAttribute, builtInSpatialMetadataAttribute);

const incompatibleType = {
  ...batchableType,
  modifyGPU() {},
};
const incompatibleEffect = makeBatchableEffect(1, 0);
incompatibleEffect.gpuSpatialType = incompatibleType;
const incompatibleRegistry = GPUSpatialEffectRegistry.build(
  [makeBatchableEffect(1, -1), incompatibleEffect],
  spatialRegistrySystem,
  () => 0,
);
assert.equal(incompatibleRegistry.types.length, 2);

const selectiveSourceParticle = new Particle({
  lifetime: 5,
  position: new THREE.Vector3(3, 4, 5),
});
selectiveSourceParticle.id = 'selective-source';
selectiveSourceParticle.alive = true;
const selectiveState = new GPUSelectiveReadbackState(2);
selectiveState.setRequests([{
  slot: 3,
  generation: 9,
  fields: ['position'],
  identity: selectiveSourceParticle,
}]);
selectiveState.outputFloatAttribute.array.set([3, 4, 5, 0]);
selectiveState.outputStateAttribute.array.set([1, 5, 9, 0]);
const selectiveResults = await selectiveState.readback({
  getArrayBufferAsync(attribute, _target, offset = 0, count = -1) {
    const end = count < 0 ? attribute.array.byteLength : offset + count;
    return Promise.resolve(attribute.array.buffer.slice(offset, end));
  },
});

assert.equal(selectiveResults.length, 1);
assert.equal(selectiveResults[0].slot, 3);
assert.equal(selectiveResults[0].generation, 9);
assert.equal(selectiveResults[0].valid, true);
assert.equal(selectiveResults[0].tagMask, 5);
assert.equal(selectiveResults[0].particle.id, 'selective-source');
assert.equal(selectiveResults[0].particle.position.x, 3);
assert.equal(selectiveState.readbackByteLength, 32);
assert.throws(() => selectiveState.setRequests([
  { slot: 0, generation: 1 },
  { slot: 1, generation: 1 },
  { slot: 2, generation: 1 },
]), /capacity 2 exceeded/);
