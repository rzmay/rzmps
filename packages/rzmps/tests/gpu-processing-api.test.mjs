import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  Module,
  Particle,
  ParticleSystem,
  Renderer,
  AudioRenderer,
  ColorOverLifetime,
  Collision,
  ExternalForces,
  ScaleOverLifetime,
  ThreeCollisionBackend,
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

assert.equal(cpuOnlyModule.supportsGPU, false);
assert.equal(gpuModule.supportsGPU, true);
assert.equal(explicitUnsupportedGPU.supportsGPU, false);
assert.throws(() => Module.CPU_UNSUPPORTED(new Particle(), 0), /does not support CPU processing/);
assert.throws(() => Module.GPU_UNSUPPORTED(gpuModule, 0, {}), /does not support GPU processing/);

assert.equal(new CPUOnlyRenderer().supportsGPUInput, false);
assert.equal(new GPUCapableRenderer().supportsGPUInput, true);
assert.equal(new AudioRenderer().supportsGPUInput, false);
assert.equal(new ColorOverLifetime({ alpha: [1, 0] }).supportsGPU, true);
assert.equal(new ScaleOverLifetime({ scale: () => new THREE.Vector3(1, 1, 1) }).supportsGPU, true);
assert.equal(new ScaleOverLifetime({ scale: new Set([new THREE.Vector3(1, 1, 1)]) }).supportsGPU, true);
assert.equal(new ExternalForces().supportsGPU, true);
assert.equal(new Collision().supportsGPU, true);
assert.equal(new Collision().withDependents().every((module) => module.supportsGPU), true);
assert.equal(new ThreeCollisionBackend().gpuCollision, true);
assert.equal(new ThreeCollisionBackend({ maxLevel: 4, trianglesPerLeaf: 12, gpuCollision: false }).maxLevel, 4);

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

assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule]), true);
assert.equal(gpuEligibilitySystem._canProcessParticlesOnGPU([gpuModule, cpuOnlyModule]), false);
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
