import { createPressureProbe } from './createPressureProbe.js';
import {
  pressureAutoPolicy, pressureHierarchy,
} from '../../../../../packages/rzmps/src/simulation/gpu/pressureSolver.utils.ts';
import { passTimer } from './volume-quality.js';

// Frozen real-plume RHS, measured separately with/without persistent fine pressure.
window.comparePlumePressure = async () => {
  const { renderer, system, flip: gas, scene, camera } = window.debugFluid;
  const device = renderer.backend.device, backend = renderer.backend;
  const fence = () => device.queue.onSubmittedWorkDone();
  // Isolate pressure from the separately tracked live quality-transition binding fault.
  gas.spatialGrid.autoVolumeQuality = false;
  gas.spatialGrid.volumeQuality = gas.spatialGrid.volumeQualityTier;
  for (let i = 1; i < (window.pressureCaptureUpdates ?? 20); i++) {
    system.advanceFrames(1, 1 / 60); await renderer.renderAsync(scene, camera); await fence();
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  system.pause(false);
  const projection = gas.getPressureProjection(), originalControls = projection.controls;
  const controls = { ...originalControls(), autoMultigrid: false,
    diagnostics: false, measureVelocity: false, report() {} };
  projection.controls = () => controls;
  const attributes = [gas.velocityNext.value, gas.pressureCurrent.value];
  const copies = attributes.map(attribute => {
    const live = backend.get(attribute).buffer;
    const saved = device.createBuffer({ size: live.size,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(live, 0, saved, 0, live.size);
    device.queue.submit([encoder.finish()]); return { live, saved };
  });
  const restore = () => {
    const encoder = device.createCommandEncoder();
    copies.forEach(({ live, saved }) => encoder.copyBufferToBuffer(saved, 0, live, 0, live.size));
    device.queue.submit([encoder.finish()]);
  };
  const timer = passTimer(device, backend, () => 'projection');
  const results = [];
  const liveDiagnostics = await gas.readGridDiagnostics(renderer);
  try {
    for (const warmStart of [false, true]) {
      let target;
      const referenceIterations = window.pressureReferenceIterations ?? gas.pressureIterations;
      let configs = [{ name: 'Iterative', multigrid: false, preSmooth: 2, postSmooth: 4,
        budget: referenceIterations },
      ...[[2, 4, 12], [2, 6, 12], [1, 3, 12], [2, 4, 24]]
        .flatMap(([preSmooth, postSmooth, coarseIterations]) => [16, 32, 64].map(budget => ({
          name: `MG-${preSmooth}-${postSmooth}-${coarseIterations}-${budget}`, multigrid: true,
          preSmooth, postSmooth, coarseIterations, budget,
        })))];
      if (window.pressureCrossoverOnly) configs = [configs[0], { name: 'MG-global', multigrid: true,
        budget: referenceIterations, preSmooth: 2, postSmooth: 4, coarseIterations: 12 },
        { name: 'Auto', auto: true, multigrid: referenceIterations >= pressureAutoPolicy.minimumWork
          && liveDiagnostics.activeBricks * gas.volumeGrid.cellsPerBrick >= pressureAutoPolicy.entryCells
          && pressureHierarchy(gas.gridDimensions.toArray()).usefulLevels >= pressureAutoPolicy.minimumLevels,
        budget: referenceIterations, preSmooth: 2, postSmooth: 4, coarseIterations: 12 }];
      for (const config of configs) {
        Object.assign(controls, { warmStart, autoMultigrid: Boolean(config.auto), multigrid: config.multigrid,
          tolerance: target?.pressureResidual ?? 0, minIterations: 0, maxIterations: config.budget,
          multigridOptions: config });
        const solve = () => projection.solve(renderer, gas.velocityNext, gas.velocityCurrent, config.budget);
        for (let i = 0; i < (config.auto ? 10 : 2); i++) { restore(); solve(); await fence(); }
        const samples = [];
        for (let i = 0; i < 3; i++) {
          restore(); await fence(); timer.start(); solve(); await fence();
          samples.push((await timer.finish()).computeGPUms);
        }
        const stats = await projection.readDiagnostics(renderer, gas.velocityCurrent);
        target ??= stats;
        results.push({ warmStart, ...config, selectedMG: new Float32Array(await renderer.getArrayBufferAsync(
          projection.convergenceAttribute))[3], samples, stats, target,
          equalQuality: stats.pressureResidual <= target.pressureResidual * 1.05 + 1e-5
            && stats.maxDivergenceAfterProjection <= target.maxDivergenceAfterProjection * 1.05 + 1e-5
            && stats.meanDivergenceAfterProjection <= target.meanDivergenceAfterProjection * 1.05 + 1e-5 });
      }
    }
    return { results, captureUpdates: window.pressureCaptureUpdates ?? 20,
      bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()],
      quality: gas.spatialGrid.volumeQualityTier, h: gas.cellSize, subdivisions:
        [gas.spatialGrid.brickSubdivisions, gas.spatialGrid.cellSubdivisions],
      diagnostics: await gas.readGridDiagnostics(renderer) };
  } finally { await fence(); timer.dispose(); copies.forEach(({ saved }) => saved.destroy());
    projection.controls = originalControls; }
};

window.evolveMultigrid = async ({ frames = 360 } = {}) => {
  const { renderer, system, flip: gas, scene, THREE } = window.debugFluid;
  const device = renderer.backend.device;
  gas.pressureSolver = 'Multigrid';
  gas.pressureIterations = 16;
  gas.pressureWarmStart = true;
  // Fix linear resolution while allowing normal rectangular guards, page churn and pool growth.
  gas.spatialGrid.autoVolumeQuality = false;
  gas.spatialGrid.volumeQuality = gas.spatialGrid.volumeQualityTier;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.15, 1.1), new THREE.MeshBasicMaterial());
  scene.add(wall);
  gas.collisionOptions = { ...gas.collisionOptions, dynamicObjects: [wall] };
  const observations = [], pending = [], localized = [];
  let frame = 0;
  const hooked = new Set();
  const hook = () => {
    const projection = gas.getPressureProjection();
    if (hooked.has(projection)) return;
    hooked.add(projection);
    const original = projection.solve;
    projection.solve = function (renderer, input, output, iterations) {
      if (this.preparing || frame % 30 !== 0) return original.call(this, renderer, input, output, iterations);
      const live = renderer.backend.get(gas.pressureCurrent.value).buffer;
      const saved = device.createBuffer({ size: live.size,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      let encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(live, 0, saved, 0, live.size);
      device.queue.submit([encoder.finish()]);
      gas.pressureSolver = 'Iterative'; gas.pressureMaxIterations = 16;
      original.call(this, renderer, input, output, 16);
      const reference = this.readDiagnostics(renderer, output);
      encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(saved, 0, live, 0, live.size);
      device.queue.submit([encoder.finish()]);
      gas.pressureSolver = 'Multigrid'; gas.pressureMaxIterations = undefined;
      const probe = (window.pressureProbeFrames ?? [150, 450, 630]).includes(frame)
        ? createPressureProbe(gas, this, renderer) : undefined;
      const controls = this.controls;
      if (probe) this.controls = () => ({ ...controls(), trace: probe.trace });
      original.call(this, renderer, input, output, iterations);
      this.controls = controls;
      if (probe) {
        const update = frame;
        pending.push(probe.finish().then(result => localized.push({ update, ...result }))
          .finally(() => probe.dispose()));
      }
      const stamp = frame;
      pending.push(Promise.all([reference, this.readDiagnostics(renderer, output)])
        .then(([iterative, multigrid]) => {
        observations.push({ frame: stamp, iterative, multigrid, equalQuality:
          multigrid.pressureResidual <= iterative.pressureResidual * 1.05 + 1e-5
            && multigrid.maxDivergenceAfterProjection <= iterative.maxDivergenceAfterProjection * 1.05 + 1e-5
            && multigrid.meanDivergenceAfterProjection <= iterative.meanDivergenceAfterProjection * 1.05 + 1e-5 });
        saved.destroy();
      }));
    };
  };
  const pages = [];
  for (frame = 1; frame <= frames; frame++) {
    hook();
    wall.position.set(Math.sin(frame / 50) * 0.3, 1.4, 0);
    wall.rotation.z = Math.sin(frame / 70) * 0.45;
    scene.updateMatrixWorld(true);
    system.emitters[0].rate = frame % 120 < 70 ? 100 : 0;
    system.advanceFrames(1, 1 / 60);
    await device.queue.onSubmittedWorkDone();
    if (frame % 30 === 0) pages.push({ ...await gas.readGridDiagnostics(renderer), update: frame,
      bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()] });
    // Let asynchronous diagnostics and backing retirement run between updates.
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await Promise.all(pending);
  return { frames, observations, pages, localized, quality: gas.spatialGrid.volumeQualityTier, h: gas.cellSize };
};


window.measureFluidFPS = async () => {
  const { renderer, system, scene, camera, sceneLifecycle } = window.debugFluid;
  const step = async () => {
    sceneLifecycle?.update?.(1 / 60); scene.updateMatrixWorld(true);
    system.advanceFrames(1, 1 / 60);
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  };
  for (let i = 0; i < (window.fluidFPSWarmup
    ?? (system.modules[0].constructor.name === 'FLIPSimulation' ? 240 : 120)); i++) await step();
  const samples = [];
  for (let i = 0; i < 16; i++) {
    const start = performance.now(); await step(); samples.push(performance.now() - start);
  }
  const sorted = samples.toSorted((a, b) => a - b);
  return { medianFrameMs: sorted[8], p90FrameMs: sorted[14], fps: 1000 / sorted[8], samples,
    liveParticles: system.liveParticleCount, gpuActive: system.isGPUProcessingActive, elapsed: system._elapsedTime,
    drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
    cellSubdivisions: system.modules[0].spatialGridOptions.cellSubdivisions };
};
