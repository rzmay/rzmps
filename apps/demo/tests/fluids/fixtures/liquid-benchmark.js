import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { createLiquidWorkload, seedLiquidLattice } from '../../../benchmarks/fluids/liquidWorkload.utils.js';
import { liquidCheckpoint, compareMarkers } from '../../../benchmarks/fluids/liquidQuality.utils.js';
import { trackSimulationTime } from '../../../benchmarks/fluids/fluidProfiling.utils.js';
import { runLiquidQualityTransition } from '../../../benchmarks/fluids/liquidTransition.utils.js';
import liquid, { liquidScalingCases } from '../../../benchmarks/liquid.benchmark.js';

const renderer = new WebGPURenderer();
renderer.setSize(320, 240);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
camera.position.set(3, 2, 4); camera.lookAt(0, 0, 0);

async function fixture(count, callback) {
  const system = createLiquidWorkload({ count, translation: true, cellSubdivisions: 2 });
  scene.add(system); system._renderer = renderer; system._scene = scene; system._camera = camera;
  const clock = trackSimulationTime(system);
  const advance = async () => {
    system.advanceFrames(1, 1 / 60);
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  };
  try {
    await system.prepare(renderer);
    await advance(); seedLiquidLattice(system, renderer);
    // Establish a uniform input velocity field without aging the source during compilation.
    await advance();
    return await callback(system, clock, advance);
  } finally {
    await renderer.backend.device.queue.onSubmittedWorkDone();
    clock.restore(); system.destroy(); system.removeFromParent();
  }
}

window.runLiquidInvariant = async (count = 216) => {
  const baseline = await fixture(count, async (system, clock, advance) => {
    const before = await liquidCheckpoint(system, renderer), time = { ...clock.time };
    for (let frame = 0; frame < 8; frame++) await advance();
    const after = await liquidCheckpoint(system, renderer);
    const delta = Object.fromEntries(Object.keys(time).map(key => [key, clock.time[key] - time[key]]));
    return { ...delta, ...compareMarkers(before.markers, after.markers, delta.executedSeconds),
      initial: before.quality, final: after.quality };
  });
  const transition = await fixture(count, (system, clock, advance) =>
    runLiquidQualityTransition(system, renderer, advance, clock.time));
  return { baseline, transition };
};

/** Run the same descriptor as the demo/CLI. Trace checkpoints stay out of ordinary case reports. */
window.runLiquidStudy = async ({ kind = 'low', frames = 12, traceEvery = 0, detailedSurface = false,
  anisotropy = 0, kernelOptimization } = {}) => {
  const cases = kind.startsWith('scaling-')
    ? liquidScalingCases({ detailedSurface, anisotropy, kernelOptimization }) : liquid.createCases();
  const entry = cases.find(entry => entry.id === `liquid-${kind}:gpu`);
  if (!entry) throw new Error(`Unknown liquid case ${kind}`);
  const system = await entry.createSystem(), objects = entry.configureScene(scene);
  scene.add(system);
  const trace = [];
  try {
    await entry.prepare(system, renderer, scene, camera);
    for (let frame = 0; frame < frames; frame++) {
      entry.beforeUpdate(system, frame * 1000 / 60, 'measure');
      system.advanceFrames(1, 1 / 60); entry.afterUpdate();
      await renderer.renderAsync(scene, camera); entry.afterRender();
      if (traceEvery > 0 && frame % traceEvery === 0) {
        const { markers: _markers, ...checkpoint } = await liquidCheckpoint(system, renderer);
        trace.push({ frame, ...checkpoint });
      }
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();
    await entry.validate();
    return { report: entry.report(), trace };
  } finally {
    await entry.cleanup();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    system.destroy(); system.removeFromParent(); objects.forEach(object => object.removeFromParent());
  }
};
window.ready = true;

window.profileFrozenAnisotropy = async (count = 25000) => {
  const { default: profileFrozenAnisotropicSurface } = await import(
    '../../../benchmarks/fluids/profileFrozenAnisotropicSurface.js');
  const entry = liquidScalingCases({ anisotropy: 0.35 }).find(entry => entry.id === `liquid-scaling-${count}:gpu`);
  const system = await entry.createSystem(), objects = entry.configureScene(scene);
  scene.add(system);
  try {
    await entry.prepare(system, renderer, scene, camera);
    for (let frame = 0; frame < 180; frame++) {
      system.advanceFrames(1, 1 / 60); await renderer.renderAsync(scene, camera);
      if (frame % 30 === 0) await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    const result = await profileFrozenAnisotropicSurface(system, renderer, scene, camera);
    return { result, checkpoint: (await liquidCheckpoint(system, renderer)).workload };
  } finally {
    await entry.cleanup(); await renderer.backend.device.queue.onSubmittedWorkDone();
    system.destroy(); system.removeFromParent(); objects.forEach(object => object.removeFromParent());
  }
};
