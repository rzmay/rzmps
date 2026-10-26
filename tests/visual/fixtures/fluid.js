import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, float, instanceIndex, storage, uint, vec3, vec4 } from 'three/tsl';
import { experimentalExamples } from '../../../examples/experimental/index.js';
import createScene from '../../../apps/demo/src/presets/scenes/fluidTeapot.js';
import createCheckerboard from '../../../apps/demo/src/presets/scenes/checkerboard.js';
import createGasFlow from '../../../apps/demo/src/presets/scenes/gasFlow.js';
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
const gasScene = new URLSearchParams(location.search).get('scene') === 'gasFlow';
await (example === 'flipFluid' ? createScene : gasScene ? createGasFlow : createCheckerboard)(scene);
const fixedGas = new URLSearchParams(location.search).get('fixedGas') === 'true';
const reviewAdvection = new URLSearchParams(location.search).get('reviewAdvection');
const system = await experimentalExamples.find(({ id }) => id === example).create({
  ...(reviewAdvection ? { advectionMethod: reviewAdvection } : {}),
  ...(fixedGas ? {
  bounds: new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8)),
  boundsPadding: 0,
  maxBounds: 16,
  automaticPadding: false,
  } : {}),
});
scene.userData.__rzmps_particleRoot.add(system);
scene.updateMatrixWorld(true);
if (new URLSearchParams(location.search).has('sourceWall')) addGasWall();
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
window.moveParticle = (position, velocity = [0, 0, 0], slot = 0, speed) => {
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(instanceIndex.equal(uint(slot)), () => {
      particle.position.assign(vec3(...position));
      particle.velocity.assign(vec3(...velocity));
      if (speed !== undefined) particle.speed.assign(speed);
      buffers.storage.storeParticle(particle);
    });
  })().compute(buffers.count));
};
window.seedGas = (kind = 'rotating') => {
  flip.pressureProjection?.invalidate();
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
function addGasWall() {
  const wall = FluidCollider.Box({}, 0.5, 20, 20);
  wall.position.x = 0.75;
  system.updateWorldMatrix(true, false);
  wall.applyMatrix4(system.matrixWorld);
  scene.add(wall);
  wall.updateWorldMatrix(true, true);
}
window.addGasWall = addGasWall;
window.seedGasSource = (remaining = 1, alpha = 1) => {
  system.emitters.forEach(emitter => { emitter.rate = 0; emitter.rateOverDistance = 0; });
  flip.externalForce.set(0, 0, 0);
  flip.buoyancy = flip.weight = flip.turbulenceStrength = flip.vorticityStrength = 0;
  flip.velocityDissipation = flip.densityDissipation = flip.colorDissipation = 0;
  flip.temperatureDissipation = flip.scalarDiffusion = flip.velocitySourceStrength = 0;
  flip.automaticPadding = false;
  flip.temperatureColor = undefined;
  flip.sourceStrength = 1;
  flip.sourceTemperature = 1;
  flip.temperatureOverLifetime = 1;
  system.gravity.set(0, 0, 0);
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    particle.alive.assign(instanceIndex.equal(0).select(uint(1), uint(0)));
    particle.position.assign(vec3(0));
    particle.velocity.assign(vec3(0));
    particle.scale.assign(vec3(0.2));
    particle.color.assign(vec3(0.2, 0.4, 0.8));
    particle.mass.assign(1);
    particle.alpha.assign(alpha);
    particle.speed.assign(0);
    particle.lifetime.assign(1);
    particle.realtime.assign((1 - remaining) * 1000);
    particle.time.assign(1 - remaining);
    buffers.storage.storeParticle(particle);
  })().compute(buffers.count));
  renderer.compute(Fn(() => {
    flip.densityCurrent.element(instanceIndex).assign(vec4(0));
    flip.colorCurrent.element(instanceIndex).assign(vec4(0));
    flip.velocityCurrent.element(instanceIndex).assign(vec4(0));
  })().compute(flip.cellCount));
  flip.pressureProjection?.invalidate();
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
      : center.x.mul(mode === 'waves' ? Math.PI : Math.PI / 8).sin();
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
  if (flip.pressureProjection) {
    const faces = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureProjection.attribute));
    const pressure = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
    const rhs = new Float32Array(await renderer.getArrayBufferAsync(flip.divergenceAttribute));
    const solids = new Float32Array(await renderer.getArrayBufferAsync(flip.solidAttribute));
    const n = flip.resolution, h = flip.cellSize, side = n + 1;
    const cell = (x, y, z) => x + n * (y + n * z);
    const face = (x, y, z, axis) => faces[4 * (x + side * (y + side * z)) + axis];
    let before = 0, after = 0, residualError = 0, blockedFlux = 0, count = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = cell(x, y, z);
      if (solids[i] >= 0.5) continue;
      const projected = (face(x + 1, y, z, 0) - face(x, y, z, 0)
        + face(x, y + 1, z, 1) - face(x, y, z, 1)
        + face(x, y, z + 1, 2) - face(x, y, z, 2)) / h;
      let laplacian = 0;
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const c = [x, y, z];
        c[axis] += sign;
        if (c[axis] < 0 || c[axis] >= n) laplacian -= 2 * pressure[i];
        else if (solids[cell(...c)] < 0.5) laplacian += pressure[cell(...c)] - pressure[i];
        else {
          const f = [x, y, z];
          if (sign > 0) f[axis]++;
          blockedFlux = Math.max(blockedFlux, Math.abs(face(...f, axis)));
        }
      }
      before += rhs[i] ** 2;
      after += projected ** 2;
      residualError = Math.max(residualError, Math.abs(projected - (rhs[i] - laplacian / h ** 2)));
      count++;
    }
    window.lastProjectionMetrics.faces = {
      before: Math.sqrt(before / count), after: Math.sqrt(after / count), residualError, blockedFlux,
    };
  }
  return output.reduce((error, value, index) => index % 4 === 0
    ? Math.max(error, Math.abs(value - input[index])) : error, 0);
};
window.fluidPacking = async () => {
  const samples = await system.selectiveReadback(16000, ['position', 'velocity', 'scale']);
  const points = samples.filter(({ particle }) => particle.alive).map(({ particle }) => ({
    position: particle.position.toArray(),
    diameter: Math.max(...particle.scale.toArray().map(Math.abs)) * flip.particleSpacing,
  }));
  const width = Math.max(...points.map(p => p.diameter), 1e-4);
  const buckets = new Map();
  const key = c => c.join(',');
  for (const [i, p] of points.entries()) {
    p.cell = p.position.map(v => Math.floor(v / width));
    const k = key(p.cell);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  const ratios = points.map((p, i) => {
    let closest = Infinity;
    for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const indices = buckets.get(key([p.cell[0] + x, p.cell[1] + y, p.cell[2] + z])) ?? [];
      for (const j of indices) if (i !== j) {
        const q = points[j];
        const distance = Math.hypot(...p.position.map((v, axis) => v - q.position[axis]));
        closest = Math.min(closest, distance / ((p.diameter + q.diameter) * 0.5));
      }
    }
    return closest;
  }).sort((a, b) => a - b);
  const pressure = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
  return { count: points.length, nearCoincident: ratios.filter(r => r < 0.1).length / points.length,
    compressed: ratios.filter(r => r < 0.5).length / points.length,
    medianSpacing: ratios[Math.floor(ratios.length / 2)],
    pressureMin: pressure.reduce((a, b) => Math.min(a, b), 0),
    pressureMax: pressure.reduce((a, b) => Math.max(a, b), 0) };
};
window.seedFLIPPair = (distance = 0, sizes = [0.1, 0.1], wallContact = false) => {
  system.emitters.forEach(emitter => { emitter.rate = 0; emitter.rateOverDistance = 0; });
  system.gravity.set(0, 0, 0);
  flip.externalForce.set(0, 0, 0);
  flip.pressureIterations = 0;
  flip.picRatio = 0;
  flip.particleSpacing = 1;
  flip.particleSeparation = 0.5;
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    particle.alive.assign(instanceIndex.lessThan(2).select(uint(1), uint(0)));
    const x = wallContact ? 0.5 - sizes[0] * 0.5 + 1e-4 : 0;
    particle.position.assign(instanceIndex.equal(0).select(vec3(x, 3, 0), vec3(x + distance, 3, 0)));
    particle.velocity.assign(vec3(0));
    particle.scale.assign(vec3(instanceIndex.equal(0).select(sizes[0], sizes[1])));
    particle.mass.assign(1);
    particle.speed.assign(1);
    particle.lifetime.assign(60);
    particle.realtime.assign(0);
    particle.time.assign(0);
    buffers.storage.storeParticle(particle);
  })().compute(buffers.count));
};
window.readLivePositions = async () => (await system.selectiveReadback(16000, ['position']))
  .filter(({ particle }) => particle.alive).map(({ particle }) => particle.position.toArray());
window.ready = true;
window.seedUniformGas = () => {
  window.seedGasSource(0, 0);
  renderer.compute(Fn(() => {
    flip.densityCurrent.element(instanceIndex).assign(vec4(0.5, 0.25, 0, 0));
    flip.colorCurrent.element(instanceIndex).assign(vec4(0.1, 0.2, 0.4, 0));
    flip.velocityCurrent.element(instanceIndex).assign(vec4(0.3, 0, 0, 0));
  })().compute(flip.cellCount));
  flip.pressureProjection?.invalidate();
};
window.gasCapFlux = async () => {
  const values = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureProjection.attribute));
  const n = flip.resolution, side = n + 1;
  let flux = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (const edge of [0, n]) {
    for (const [axis, c] of [[0, [edge, a, b]], [1, [a, edge, b]], [2, [a, b, edge]]]) {
      flux = Math.max(flux, Math.abs(values[4 * (c[0] + side * (c[1] + side * c[2])) + axis]));
    }
  }
  return flux;
};
