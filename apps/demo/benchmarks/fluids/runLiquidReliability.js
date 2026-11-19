import { StorageBufferAttribute } from 'three/webgpu';
import { storage } from 'three/tsl';
import { passTimer } from '../../../../benchmarks/lib/passTimer.js';
import { profileLiquidStages } from './liquidStages.utils.js';
import { benchmarkFoam } from './foamProfiling.utils.js';
import { trackSimulationTime } from './fluidProfiling.utils.js';
import { frameDistribution, spikeWindows } from './liquidReliability.utils.js';

/** Diagnostic-only, full reference preset. RAF mode never awaits a fence or timestamp in its frame callback. */
export default async function runLiquidReliability({ seconds = 45, mode = 'raf', threshold = 16.67,
  foam = true, neighborCounts = true, warmupSeconds = 0 } = {}) {
  const { system, renderer, scene, camera, flip, sceneLifecycle, resourceTracking: resources } = window.debugFluid;
  const surface = system.renderers.find(view => view.readSurfaceDiagnostics), device = renderer.backend.device;
  const state = { stage: 'liquid/other', detailedSurface: true };
  system.__liquidFixture = { flip, surface };
  window.liquidReliabilityState = state;
  const foamSystem = [...system.subSystems.keys()].find(child => child.name === 'Liquid Foam');
  if (!foam && foamSystem) { system.removeSubSystem(foamSystem); foamSystem.destroy(); }
  const visitsAttribute = new StorageBufferAttribute(new Float32Array(system.maxParticles), 1);
  const visits = storage(visitsAttribute, 'float', system.maxParticles);
  if (neighborCounts) {
    surface.kernelOptimization = { neighborVisits: (index, count) => visits.element(index).assign(count) };
    surface.surface.kernelKey = '';
  }
  let currentRecord;
  const ensure = flip.ensureGridResolution;
  flip.ensureGridResolution = function (...args) {
    const from = this.workGrid?.cellSize;
    const prepared = this.qualityPreparation;
    const candidate = { ready: prepared?.ready, cellWidth: prepared?.pool?.grid.cellSize,
      key: prepared?.key, target: args[1]?.cellSize };
    try { return ensure.apply(this, args); } finally {
      if (from !== this.workGrid?.cellSize && currentRecord) {
        currentRecord.qualityAdoption = { from, to: this.workGrid?.cellSize, candidate };
      }
    }
  };
  const restore = profileLiquidStages(system, renderer, state);
  const timer = passTimer(device, renderer.backend,
    type => type === 'render' ? state.renderStage ?? 'scene/rendering' : state.stage, { slots: 8 });
  const model = scene.getObjectByName('Lidless Utah Teapot');
  const simulationTime = trackSimulationTime(system);
  const frames = [], pending = new Set(), errors = [], longTasks = [];
  device.addEventListener('uncapturederror', event => {
    errors.push({ time: performance.now(), error: event.error.message });
  });
  let lost;
  void device.lost.then(info => { lost = { reason: info.reason, message: info.message }; });
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: 'longtask', buffered: false });
  const addPending = promise => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), error => {
      pending.delete(promise); errors.push({ error: error.message });
    });
  };
  const countSnapshot = () => [system, ...system.subSystems.keys()].map(owner => ({ name: owner.name,
    particles: owner.liveParticleCount, children: owner.renderers.reduce((n, view) => n + view.renderedChildCount, 0),
    sequence: owner.gpuAllocationStats?.sequence }));
  const workload = () => {
    const mesh = surface.surface, grid = flip.workGrid, stats = surface.benchmarks.snapshot();
    return { systems: countSnapshot(), bounds: [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()],
      cellWidth: flip.cellSize, flipCapacity: grid?.capacity,
      flipResidentPages: flip.benchmarks.snapshot().residentPages,
      flipDeniedPages: flip.benchmarks.snapshot().deniedPages,
      flipRequestedPages: flip.benchmarks.snapshot().requestedPages,
      flipCellsPerPage: grid?.brickSide ** 3, flipPool: flip.workPool?.status,
      quality: flip.qualityPreparation ? { cellWidth: flip.qualityPreparation.pool?.grid.cellSize,
        ready: flip.qualityPreparation.ready, key: flip.qualityPreparation.key,
        phase: flip.qualityPreparation.phase } : null,
      qualityPreparationError: flip.qualityPreparationError,
      preparation: Object.fromEntries(Object.entries(flip.benchmarks.snapshot())
        .filter(([name, value]) => (name.startsWith('preparation/active/') && value > 0)
          || name.startsWith('preparationLast') || name === 'preparationActiveCompilers' || name.startsWith('capacity')
          || name.startsWith('qualityPreparation'))),
      surfaceCapacity: mesh?.grid.capacity, surfacePages: stats.activeBricks,
      surfaceQuery: { cellWidth: mesh?.queryGrid.cellSize, bounds: mesh?.queryGrid.bounds.toArray?.()
        ?? [...mesh.queryGrid.bounds.min.toArray(), ...mesh.queryGrid.bounds.max.toArray()] },
      surfaceCellsProcessed: stats.activeBricks * (mesh?.grid.brickSide ** 3),
      triangles: stats.triangleCount, vertices: stats.vertexCount,
      surfacePool: surface.allocation?.status,
      collider: { position: model.position.toArray(), rotation: model.rotation.toArray().slice(0, 3) },
      resources: resources.snapshot() };
  };
  let resourceCursor = 0;
  let dropped = 0, fencePending = false, lastRender = performance.now(), lastUpdate = lastRender;
  // Compile the optional statistics write and populate current material/child buffers before timing.
  sceneLifecycle.update?.(1 / 60); system.advanceFrames(1, 1 / 60);
  await renderer.renderAsync(scene, camera);
  await device.queue.onSubmittedWorkDone();
  system.start(false);
  const started = performance.now();
  let previous = started;
  const frame = timestamp => {
    const index = frames.length;
    window.liquidReliabilityFrame = index;
    const interval = timestamp - previous;
    previous = timestamp;
    const record = { frame: index, time: timestamp - started, rafIntervalMs: interval,
      updateAgeMs: performance.now() - lastUpdate, renderAgeMs: performance.now() - lastRender };
    frames.push(record); currentRecord = record;
    state.cpuStages = {};
    const timing = timer.start(), start = performance.now();
    const beforeTime = { ...simulationTime.time };
    sceneLifecycle.update?.(mode === 'raf' ? interval / 1000 : 1 / 60);
    if (mode === 'raf') system.update(); else system.advanceFrames(1, 1 / 60);
    lastUpdate = performance.now();
    renderer.render(scene, camera);
    lastRender = performance.now();
    currentRecord = undefined;
    record.cpuSubmissionMs = lastRender - start;
    record.simulationTime = Object.fromEntries(Object.entries(simulationTime.time)
      .map(([key, value]) => [key, value - beforeTime[key]]));
    record.cpuStages = state.cpuStages;
    Object.assign(record, workload());
    // Queue snapshots without waiting. The next RAF can submit while these copies/maps complete.
    if (timing) {
      const pendingTiming = timer.finish().then(gpu => {
        const { passes, ...summary } = gpu;
        record.gpu = summary;
        const steps = record.simulationTime.substeps;
        const pressure = summary.allStageGPUms['liquid/pressure solve'] ?? 0;
        record.perSubstepGPUms = steps ? summary.simulationGPUms / steps : 0;
        record.pressurePerSubstepGPUms = steps ? pressure / steps : 0;
        if (gpu.totalGPUms > threshold) record.passes = passes;
        if (index % 120 === 0 && window.recordReliabilityCheckpoint) {
          const events = resources.events.slice(resourceCursor); resourceCursor = resources.events.length;
          void window.recordReliabilityCheckpoint({ ...record, passes: undefined, resourceEvents: events });
        }
      })
        .catch(error => errors.push({ frame: index, error: error.message }));
      addPending(pendingTiming);
      if (neighborCounts) addPending(renderer.getArrayBufferAsync(visitsAttribute).then(buffer => {
        const counts = new Float32Array(buffer);
        const capacity = surface.inputBuffers?.count ?? system.maxParticles;
        record.anisotropicNeighborVisits = counts.subarray(0, capacity).reduce((sum, value) => sum + value, 0);
      }));
    } else dropped++;
    if (index % 120 === 0 && !fencePending) {
      fencePending = true;
      const start = performance.now();
      addPending(device.queue.onSubmittedWorkDone().then(() => {
        record.queueCompletionMs = performance.now() - start;
      }).finally(() => { fencePending = false; }));
    }
    return record;
  };
  try {
    window.liquidReliabilityPhase = 'stepping';
    if (mode === 'raf') {
      await new Promise((resolve, reject) => {
        const next = timestamp => {
          try {
            frame(timestamp);
            if (timestamp - started < (seconds + warmupSeconds) * 1000) requestAnimationFrame(next); else resolve();
          } catch (error) { reject(error); }
        };
        requestAnimationFrame(next);
      });
    } else {
      for (let index = 0; index < Math.round(seconds * 60); index++) {
        const start = performance.now();
        const record = frame(start);
        await device.queue.onSubmittedWorkDone();
        record.fencedWallMs = performance.now() - start;
      }
    }
    const ended = performance.now();
    window.liquidReliabilityPhase = 'final-readback';
    await Promise.all([...pending]);
    const initialQuality = { ...flip.benchmarks.snapshot() };
    const finalSurface = await surface.readSurfaceDiagnostics();
    const finalPressure = await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent);
    timer.dispose(); restore();
    const frozenState = { stage: 'foam/other' };
    const foamTimer = passTimer(device, renderer.backend,
      type => type === 'render' ? frozenState.renderStage ?? 'scene/rendering' : frozenState.stage);
    let foamCost;
    window.liquidReliabilityPhase = 'foam-checkpoint';
    try { foamCost = await benchmarkFoam(system, renderer, scene, camera, foamTimer, frozenState); }
    finally { foamTimer.dispose(); }
    const afterRun = resources.snapshot();
    window.liquidReliabilityPhase = 'retirement';
    // Stop only after recording the reference interval; then prove retirement and full workload cleanup.
    await Promise.all([flip.workPool?.whenPrepared(), flip.qualityPreparation?.completion,
      surface.allocation?.whenPrepared()]);
    system.destroy(); sceneLifecycle.cleanup?.();
    await device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 0));
    await device.queue.onSubmittedWorkDone();
    const afterDestroy = resources.snapshot();
    simulationTime.restore();
    const idleIntervals = [];
    window.liquidReliabilityPhase = 'idle-raf';
    if (mode === 'raf') {
      let previous;
      await new Promise(resolve => {
        const idle = timestamp => {
          if (previous !== undefined) idleIntervals.push(timestamp - previous);
          previous = timestamp;
          if (idleIntervals.length < 120) requestAnimationFrame(idle); else resolve();
        };
        requestAnimationFrame(idle);
      });
    }
    const measured = frames.filter(frame => frame.time >= warmupSeconds * 1000);
    window.liquidReliabilityPhase = 'complete';
    return { mode, seconds, warmupSeconds, idleRAF: frameDistribution(idleIntervals),
      foamEnabled: foam, neighborCounts, resolution: renderer.getDrawingBufferSize(
      new window.debugFluid.THREE.Vector2()).toArray(), measuredWallMs: ended - started,
    initialQuality: Object.fromEntries(Object.entries(initialQuality)
      .filter(([key]) => key.startsWith('initialQuality'))),
    frames, gpuTimingDropped: dropped, summary: {
      raf: frameDistribution(measured.slice(1).map(frame => frame.rafIntervalMs)),
      cpu: frameDistribution(measured.map(frame => frame.cpuSubmissionMs)),
      gpu: frameDistribution(measured.map(frame => frame.gpu?.totalGPUms)),
      queue: frameDistribution(measured.map(frame => frame.queueCompletionMs)) },
    spikes: spikeWindows(frames, threshold), foamCost, finalSurface, finalPressure,
    resources: { afterRun, afterDestroy, events: resources.events, remaining: resources.live() },
    measuredInterval: { start: started, end: ended }, graphBuilds: window.fluidBuildTrace?.records,
    longTasks: longTasks.filter(task => task.start >= started && task.start < ended), errors, deviceLost: lost };
  } finally {
    observer.disconnect(); simulationTime.restore(); flip.ensureGridResolution = ensure;
    await Promise.allSettled([...pending]);
    timer.dispose(); restore();
    if (renderer.backend.has(visitsAttribute) && renderer.backend.get(visitsAttribute).buffer)
      renderer.backend.destroyAttribute(visitsAttribute);
    visitsAttribute.dispose();
    resources.restore();
    window.fluidBuildTrace?.restore();
    delete window.liquidReliabilityState;
  }
}
