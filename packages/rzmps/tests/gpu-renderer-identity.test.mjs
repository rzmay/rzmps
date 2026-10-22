import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  LightRenderer,
  Particle,
  TrailMode,
  TrailRenderer,
} from '../build/index.mjs';

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
const rendererSystem = {
  cameraDistanceSq: 0,
  sceneCamera: camera,
  useLiveCubemap: false,
  scene: undefined,
};

const particleTrail = new TrailRenderer({
  texture: new THREE.Texture(),
  mode: TrailMode.Particle,
  minimumVertexDistance: 0,
});
const firstGeneration = new Particle({ lifetime: 10 });
firstGeneration.id = 'gpu:0:1';
particleTrail._update([firstGeneration], rendererSystem, 0.1);
firstGeneration.position.x = 1;
particleTrail._update([firstGeneration], rendererSystem, 0.1);
assert.equal(particleTrail.trails.has('gpu:0:1'), true);
assert.ok(particleTrail.geometry.getAttribute('position').count > 4);

const reusedSlot = new Particle({ lifetime: 10 });
reusedSlot.id = 'gpu:0:2';
reusedSlot.position.x = 5;
particleTrail._update([reusedSlot], rendererSystem, 0.1);
assert.equal(particleTrail.trails.has('gpu:0:1'), false);
assert.equal(particleTrail.trails.has('gpu:0:2'), true);

const ribbonTrail = new TrailRenderer({
  texture: new THREE.Texture(),
  mode: TrailMode.Ribbon,
  ribbonCount: 1,
});
const ribbonParticles = [0, 1, 2].map((index) => {
  const particle = new Particle({
    lifetime: 10,
    position: new THREE.Vector3(index, index * 0.25, 0),
  });
  particle.id = `gpu:${index}:1`;
  particle.startTime = index;
  return particle;
});
ribbonTrail._update(ribbonParticles, rendererSystem, 0.1);
assert.ok(ribbonTrail.geometry.getAttribute('position').count > 4);

const lightRenderer = new LightRenderer({ count: 1, randomDistribution: false });
const firstLightParticle = new Particle({ position: new THREE.Vector3(1, 2, 3) });
firstLightParticle.id = 'gpu:0:1';
lightRenderer._update([firstLightParticle]);
assert.deepEqual(lightRenderer.lights[0].position.toArray(), [1, 2, 3]);
const reusedLightParticle = new Particle({ position: new THREE.Vector3(4, 5, 6) });
reusedLightParticle.id = 'gpu:0:2';
lightRenderer._update([reusedLightParticle]);
assert.deepEqual(lightRenderer.lights[0].position.toArray(), [4, 5, 6]);

let resolveReadback;
let readbackCalls = 0;
let requestedLimit = 0;
const selectiveSystem = {
  cameraDistanceSq: 0,
  requestReadback(limit) {
    requestedLimit = limit;
    return [{ slot: 0, generation: 0 }];
  },
  readbackGPUParticlesSelective() {
    readbackCalls += 1;
    return new Promise((resolve) => { resolveReadback = resolve; });
  },
};
lightRenderer.updateGPU({ count: 1000 }, selectiveSystem, 1 / 60);
lightRenderer.updateGPU({ count: 1000 }, selectiveSystem, 1 / 60);
assert.equal(readbackCalls, 1);
assert.ok(requestedLimit < 1000);
resolveReadback([]);
await new Promise((resolve) => setTimeout(resolve, 0));

particleTrail.destroy();
ribbonTrail.destroy();
lightRenderer.destroy();
