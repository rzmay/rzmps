import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, float, instanceIndex, storage, uint, vec3, vec4 } from 'three/tsl';
import { experimentalExamples } from '../../../examples/experimental/index.js';
import createScene from '../../../apps/demo/src/presets/scenes/fluidTeapot.js';
import createCheckerboard from '../../../apps/demo/src/presets/scenes/checkerboard.js';

const renderer = new WebGPURenderer();
renderer.setSize(800, 600);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.01, 200);
camera.position.set(5, 4, 6);
camera.lookAt(0, 0.6, 0);
const example = new URLSearchParams(location.search).get('example') ?? 'flipFluid';
await (example === 'flipFluid' ? createScene : createCheckerboard)(scene);
const system = await experimentalExamples.find(({ id }) => id === example).create();
scene.userData.__rzmps_particleRoot.add(system);
scene.updateMatrixWorld(true);
await renderer.renderAsync(scene, camera);
system.advanceFrames(1, 1 / 60);
const flip = system.modules[0];
window.debugFluid = { renderer, scene, system, flip, camera };
window.probe = async (start, end, radius = 0.06) => {
  const output = new StorageBufferAttribute(new Float32Array(12), 4);
  const target = storage(output, 'vec4', 3);
  const node = Fn(() => {
    const hit = flip.particleCollisionBackend.queryCapsule(vec3(...start), vec3(...end), float(radius));
    target.element(0).assign(vec4(hit.get('point'), hit.get('found').select(1, 0)));
    target.element(1).assign(vec4(hit.get('normal'), hit.get('distanceSq')));
    target.element(2).assign(vec4(hit.get('capsulePoint'), 0));
  })().compute(1);
  renderer.compute(node);
  return [...new Float32Array(await renderer.getArrayBufferAsync(output))];
};
window.runFrames = async (frames, dt = 1 / 60) => {
  for (let i = 0; i < frames; i++) {
    system.advanceFrames(1, dt);
    if (i % 60 === 0) await renderer.backend.device.queue.onSubmittedWorkDone();
  }
  await renderer.renderAsync(scene, camera);
  const particles = await system.selectiveReadback(16000, ['position', 'velocity', 'time']);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let speed = 0, inContainer = 0, newbornSpeed = 0;
  for (const { particle: p } of particles) {
    if (!p.alive) continue;
    p.position.toArray().forEach((v, i) => { min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v); });
    speed = Math.max(speed, p.velocity.length());
    if (p.time < 0.001) newbornSpeed = Math.max(newbornSpeed, p.velocity.length());
    if (p.position.y > -2.9 && p.position.y < -1.1
      && p.position.x > -1.7 && p.position.x < 2.7 && Math.abs(p.position.z) < 1.7) {
      inContainer += 1;
    }
  }
  let field;
  if (flip.densityCurrent) {
    const values = new Float32Array(await renderer.getArrayBufferAsync(flip.densityCurrent.value));
    let sum = 0, peak = 0, heat = 0;
    for (let i = 0; i < values.length; i += 4) {
      sum += values[i];
      peak = Math.max(peak, values[i]);
      heat += values[i + 1];
    }
    const velocities = new Float32Array(await renderer.getArrayBufferAsync(flip.velocityCurrentAttribute));
    let energy = 0, coolEnergy = 0, coolDensity = 0;
    for (let i = 0; i < values.length; i += 4) {
      const speedSq = velocities[i] ** 2 + velocities[i + 1] ** 2 + velocities[i + 2] ** 2;
      energy += speedSq * values[i];
      if (values[i + 1] / Math.max(values[i], 1e-6) < 0.25) {
        coolEnergy += speedSq * values[i];
        coolDensity += values[i];
      }
    }
    field = { sum, peak, heat, rmsSpeed: Math.sqrt(energy / Math.max(sum, 1e-6)),
      coolSpeed: Math.sqrt(coolEnergy / Math.max(coolDensity, 1e-6)), coolDensity };
  }
  return { count: particles.filter((p) => p.valid).length, min, max, speed, newbornSpeed, inContainer, field };
};
window.moveParticle = (position, velocity = [0, 0, 0]) => {
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(instanceIndex.equal(uint(0)), () => {
      particle.position.assign(vec3(...position));
      particle.velocity.assign(vec3(...velocity));
      buffers.storage.storeParticle(particle);
    });
  })().compute(buffers.count));
};
window.seedGas = (kind = 'rotating') => {
  flip.automaticPadding = false;
  flip.externalForce.set(0, 0, 0);
  flip.buoyancy = 0;
  flip.weight = 0;
  flip.turbulenceStrength = 0;
  flip.velocityDissipation = 0;
  renderer.compute(Fn(() => {
    const center = flip.cellCenter(flip.cellCoordinate(instanceIndex));
    const radius = center.length();
    const density = radius.lessThan(1.25).select(1, 0);
    const spin = float(1).sub(radius.div(2)).max(0);
    const velocity = kind === 'uniform' ? vec3(0.3, 0, 0)
      : vec3(center.y.negate(), center.x, 0).mul(spin);
    flip.densityCurrent.element(instanceIndex).assign(vec4(density, 0, 0, 0));
    flip.colorCurrent.element(instanceIndex).assign(vec4(density, density, density, 0));
    flip.velocityCurrent.element(instanceIndex).assign(vec4(velocity, 0));
  })().compute(flip.cellCount));
};
window.ready = true;
