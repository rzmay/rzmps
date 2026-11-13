import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import * as THREE from 'three';
import {
  createGPUParticleBufferState,
  LightRenderer,
  SpriteRenderer,
  MeshRenderer,
  Particle,
  ParticleSystem,
  TrailMode,
  TrailRenderer,
} from '../../build/index.mjs';

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
const rendererSystem = {
  cameraDistanceSq: 0,
  beginGPUEventExecution: () => ({ forEach() {} }),
  sceneCamera: camera,
  useLiveCubemap: false,
  scene: undefined,
  getGPURendererTagMask: () => undefined,
};

const meshMaterial = new THREE.MeshStandardMaterial();
const meshRenderer = new MeshRenderer({
  mesh: new THREE.Mesh(new THREE.ConeGeometry(), meshMaterial),
  maxParticles: 4,
});
const meshParticle = new Particle({
  position: new THREE.Vector3(3, 4, 5),
  color: new THREE.Color(0.25, 0.5, 0.75),
});
const meshBuffers = createGPUParticleBufferState([meshParticle], 4);
meshRenderer.updateGPU(meshBuffers, rendererSystem);
assert.ok(meshMaterial.positionNode);
assert.ok(meshMaterial.colorNode);

meshRenderer.reset();
assert.equal(meshMaterial.positionNode, null);
assert.equal(meshMaterial.colorNode, null);
assert.equal(meshMaterial.maskShadowNode, null);
assert.ok(meshMaterial.opacityNode);
meshRenderer.update([meshParticle], rendererSystem);
assert.equal(meshMaterial.positionNode, null);
assert.equal(meshMaterial.colorNode, null);
assert.equal(meshMaterial.maskShadowNode, null);
assert.ok(meshMaterial.opacityNode);
const cpuInstanceMatrix = new THREE.Matrix4();
const instanceColor = new THREE.Color();
meshRenderer.instances.getMatrixAt(0, cpuInstanceMatrix);
assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(cpuInstanceMatrix).toArray(), [3, 4, 5]);
meshRenderer.instances.getColorAt(0, instanceColor);
assert.deepEqual(instanceColor.toArray(), meshParticle.color.toArray());

meshRenderer.updateGPU(meshBuffers, rendererSystem);
assert.ok(meshMaterial.positionNode);
meshRenderer.instances.getColorAt(0, instanceColor);
assert.deepEqual(instanceColor.toArray(), [1, 1, 1]);
meshParticle.position.set(6, 7, 8);
meshRenderer.reset();
meshRenderer.update([meshParticle], rendererSystem);
meshRenderer.instances.getMatrixAt(0, cpuInstanceMatrix);
assert.equal(meshMaterial.positionNode, null);
assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(cpuInstanceMatrix).toArray(), [6, 7, 8]);

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

const lightRenderer = new LightRenderer({ count: 1 });
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
  getGPURendererTagMask() { return undefined; },
  cameraDistanceSq: 0,
  selectiveReadback(limit) {
    requestedLimit = limit;
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

// Paused configuration refresh preserves the published selection and rejects in-flight readbacks.
const pausedSystem = new ParticleSystem({ emitters: [], modules: [], renderers: [] });
const pausedLights = new LightRenderer({ count: 1, brightness: 1 });
pausedSystem.addRenderer(pausedLights);
pausedLights.update([firstLightParticle], pausedSystem);
let finishPausedReadback, pauseReadbacks = 0;
pausedSystem.selectiveReadback = () => {
  pauseReadbacks++;
  return new Promise(resolve => { finishPausedReadback = resolve; });
};
pausedLights.updateGPU({ count: 8 }, pausedSystem);
pausedSystem.start(); pausedSystem.pause();
pausedSystem.gpuSimulation._gpuBuffers = { count: 8 };
pausedSystem.gpuSimulation.refreshRenderers();
finishPausedReadback([{ valid: true, particle: reusedLightParticle }]);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(pausedLights.lights[0].position.toArray(), [1, 2, 3]);
assert.equal(pauseReadbacks, 1, 'paused refresh must not request fresh selections');
firstLightParticle.position.x = 99;
pausedLights.brightness = 2;
pausedSystem.gpuSimulation.refreshRenderers();
assert.deepEqual(pausedLights.lights[0].position.toArray(), [1, 2, 3], 'published views own their vector snapshots');
assert.equal(pausedLights.lights[0].intensity, 2, 'CPU light configuration remains editable while paused');
pausedLights.clear(); pausedLights.refresh(pausedSystem);
assert.equal(pausedLights.lights[0].intensity, 0, 'clear must not resurrect cached light samples');
pausedSystem.gpuSimulation._gpuBuffers = undefined;
pausedSystem.destroy();

particleTrail.destroy();
ribbonTrail.destroy();
lightRenderer.destroy();
meshRenderer.destroy();

// Soft-particle depth excludes transparent volume proxies but retains opaque scene geometry.
{
  const view = new SpriteRenderer(new THREE.Texture());
  const owner = new ParticleSystem({ emitters: [], modules: [], renderers: [] });
  const scene = new THREE.Scene(); scene.add(owner);
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
  const opaque = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  owner.addRendererObject(proxy); scene.add(opaque);
  const hidden = view.hideParticleRenderers(scene);
  assert.equal(proxy.visible, false, 'volume proxy boxes do not contribute opaque depth');
  assert.equal(opaque.visible, true);
  view.restoreParticleRenderers(hidden);
  assert.equal(proxy.visible, true);
  view.destroy(); owner.destroy();
  for (const mesh of [proxy, opaque]) { mesh.geometry.dispose(); mesh.material.dispose(); }
}
