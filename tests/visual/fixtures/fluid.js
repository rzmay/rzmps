import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, float, instanceIndex, storage, uint, vec3, vec4 } from 'three/tsl';
import { experimentalExamples } from '../../../examples/experimental/index.js';
import createScene from '../../../apps/demo/src/presets/scenes/fluidTeapot.js';
import createCheckerboard from '../../../apps/demo/src/presets/scenes/checkerboard.js';
import { FluidCollider } from '@rzmps/rzmps';

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
    const colors = new Float32Array(await renderer.getArrayBufferAsync(flip.colorCurrent.value));
    let energy = 0, coolEnergy = 0, coolDensity = 0;
    let negative = 0, nonfinite = 0, maxColorError = 0, maxTemperatureError = 0;
    let minTemperature = Infinity, maxTemperature = -Infinity, maxColor = 0;
    let gaussianError = 0, expectedSum = 0;
    const cellSize = flip.cellSize;
    for (let i = 0; i < values.length; i += 4) {
      const speedSq = velocities[i] ** 2 + velocities[i + 1] ** 2 + velocities[i + 2] ** 2;
      energy += speedSq * values[i];
      if (values[i + 1] / Math.max(values[i], 1e-6) < 0.25) {
        coolEnergy += speedSq * values[i];
        coolDensity += values[i];
      }
      if (values[i] < -1e-7) negative += 1;
      if (values[i] > 1e-6) {
        const temperature = values[i + 1] / values[i];
        minTemperature = Math.min(minTemperature, temperature);
        maxTemperature = Math.max(maxTemperature, temperature);
        maxColor = Math.max(maxColor, colors[i] / values[i], colors[i + 1] / values[i], colors[i + 2] / values[i]);
      }
      if (![values[i], values[i + 1], ...velocities.subarray(i, i + 3)].every(Number.isFinite)) nonfinite += 1;
      if (window.gaussianTime !== undefined) {
        maxTemperatureError = Math.max(maxTemperatureError, Math.abs(values[i + 1] - values[i] * 0.8));
        [0.2, 0.4, 0.8].forEach((ratio, channel) => {
          maxColorError = Math.max(maxColorError, Math.abs(colors[i + channel] - values[i] * ratio));
        });
        const index = i / 4, n = flip.resolution;
        const x = flip.bounds.min.x + (index % n + 0.5) * cellSize - 0.3 * window.gaussianTime;
        const y = flip.bounds.min.y + (Math.floor(index / n) % n + 0.5) * cellSize;
        const z = flip.bounds.min.z + (Math.floor(index / (n * n)) + 0.5) * cellSize;
        const expected = Math.exp(-(x * x + y * y + z * z) / (2 * 0.35 ** 2));
        gaussianError += Math.abs(values[i] - expected);
        expectedSum += expected;
      }
    }
    field = { sum, peak, heat, rmsSpeed: Math.sqrt(energy / Math.max(sum, 1e-6)),
      coolSpeed: Math.sqrt(coolEnergy / Math.max(coolDensity, 1e-6)), coolDensity,
      negative, nonfinite, minTemperature, maxTemperature, maxColor,
      maxColorError, maxTemperatureError, gaussianError: gaussianError / Math.max(expectedSum, 1e-6) };
  }
  return { count: particles.filter((p) => p.valid).length, min, max, speed, newbornSpeed, inContainer, field };
};
window.moveParticle = (position, velocity = [0, 0, 0], slot = 0) => {
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(instanceIndex.equal(uint(slot)), () => {
      particle.position.assign(vec3(...position));
      particle.velocity.assign(vec3(...velocity));
      buffers.storage.storeParticle(particle);
    });
  })().compute(buffers.count));
};
window.seedGas = (kind = 'rotating') => {
  const gaussian = ['gaussian', 'wall', 'mixed'].includes(kind);
  window.gaussianTime = kind === 'gaussian' ? 0 : undefined;
  flip.automaticPadding = false;
  flip.externalForce.set(0, 0, 0);
  flip.buoyancy = 0;
  flip.weight = 0;
  flip.turbulenceStrength = 0;
  flip.velocityDissipation = 0;
  if (gaussian) {
    flip.densityDissipation = 0;
    flip.colorDissipation = 0;
    flip.temperatureDissipation = 0;
    flip.densityCutoff = 0;
  }
  renderer.compute(Fn(() => {
    const center = flip.cellCenter(flip.cellCoordinate(instanceIndex));
    const radius = center.length();
    const density = gaussian ? radius.mul(radius).div(-2 * 0.35 ** 2).exp()
      .mul(kind === 'wall' ? center.x.lessThan(0.5).select(1, 0) : float(1))
      : radius.lessThan(1.25).select(1, 0);
    const spin = float(1).sub(radius.div(2)).max(0);
    const velocity = kind === 'uniform' || gaussian ? vec3(0.3, 0, 0)
      : vec3(center.y.negate(), center.x, 0).mul(spin);
    const heat = kind === 'mixed' ? center.x.lessThan(0).select(1, 0) : float(0.8);
    flip.densityCurrent.element(instanceIndex).assign(vec4(density, gaussian ? density.mul(heat) : float(0), 0, 0));
    flip.colorCurrent.element(instanceIndex).assign(kind === 'mixed'
      ? vec4(density.mul(heat), 0, density.mul(float(1).sub(heat)), 0) : gaussian
      ? vec4(density.mul(0.2), density.mul(0.4), density.mul(0.8), 0)
      : vec4(density, density, density, 0));
    flip.velocityCurrent.element(instanceIndex).assign(vec4(velocity, 0));
  })().compute(flip.cellCount));
};
window.addGasWall = () => {
  const wall = FluidCollider.Box({}, 0.5, 20, 20);
  wall.position.x = 0.75;
  system.add(wall);
  wall.updateWorldMatrix(true, true);
};
window.gasWallMetrics = async () => {
  const values = new Float32Array(await renderer.getArrayBufferAsync(flip.densityCurrent.value));
  const solid = new Float32Array(await renderer.getArrayBufferAsync(flip.solidAttribute));
  let leaked = 0, occupiedDensity = 0, solidCells = 0;
  for (let index = 0; index < flip.cellCount; index++) {
    const x = flip.bounds.min.x + (index % flip.resolution + 0.5) * flip.cellSize;
    if (x > 1) leaked += values[index * 4];
    if (solid[index] > 0.5) {
      occupiedDensity += values[index * 4];
      solidCells += 1;
    }
  }
  return { leaked, occupiedDensity, solidCells };
};
window.projectGas = async (iterations, mode = 'smooth') => {
  flip.pressureIterations = iterations;
  const seed = Fn(() => {
    const center = flip.cellCenter(flip.cellCoordinate(instanceIndex));
    const speed = mode === 'checkerboard'
      ? flip.cellCoordinate(instanceIndex).x.mod(2).equal(0).select(1, -1)
      : center.x.mul(Math.PI / 8).sin();
    flip.velocityNext.element(instanceIndex).assign(vec4(speed, 0, 0, 0));
  })().compute(flip.cellCount);
  renderer.compute(seed);
  flip.solveProjection(renderer, flip.velocityNext, flip.velocityCurrent, false, flip.solid);
  const input = new Float32Array(await renderer.getArrayBufferAsync(flip.velocityNextAttribute));
  const output = new Float32Array(await renderer.getArrayBufferAsync(flip.velocityCurrentAttribute));
  const divergence = values => {
    let central = 0, forward = 0, count = 0;
    const n = flip.resolution, h = flip.cellSize;
    for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = x + n * (y + n * z);
      const center = (values[(i + 1) * 4] - values[(i - 1) * 4]
        + values[(i + n) * 4 + 1] - values[(i - n) * 4 + 1]
        + values[(i + n * n) * 4 + 2] - values[(i - n * n) * 4 + 2]) / (2 * h);
      const face = (values[(i + 1) * 4] - values[i * 4]
        + values[(i + n) * 4 + 1] - values[i * 4 + 1]
        + values[(i + n * n) * 4 + 2] - values[i * 4 + 2]) / h;
      central += center * center;
      forward += face * face;
      count++;
    }
    return { central: Math.sqrt(central / count), forward: Math.sqrt(forward / count) };
  };
  window.lastProjectionMetrics = { before: divergence(input), after: divergence(output) };
  return output.reduce((error, value, index) => index % 4 === 0
    ? Math.max(error, Math.abs(value - input[index])) : error, 0);
};
window.ready = true;
