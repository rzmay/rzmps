import { passTimer } from '../../../../benchmarks/lib/passTimer.js';
import { profileLiquidStages } from './liquidStages.utils.js';
import { profileFluidStages } from './fluidProfiling.utils.js';
import { frameDistribution } from './liquidReliability.utils.js';

/** Both solvers use the same native/semantic audit, RAF clock and asynchronous GPU timing convention. */
export default async function runFluidMemoryDiagnostic({
  seconds = 45,
  transitions = true,
  replay = false,
  controlled = false,
} = {}) {
  const {
    renderer,
    system,
    scene,
    camera,
    flip: fluid,
    sceneLifecycle,
    resourceTracking: tracker,
    memoryAttribution: attribution,
    memoryPhases,
  } = window.debugFluid;
  const surface = system.renderers.find(view => view.readSurfaceDiagnostics);
  const state = { stage: 'fluid/other', detailedSurface: true };
  window.liquidReliabilityState = state;
  if (surface) system.__liquidFixture = { flip: fluid, surface };
  const restore = surface
    ? profileLiquidStages(system, renderer, state)
    : profileFluidStages(renderer, [[fluid, name => `gas/${name}`]], state);
  const device = renderer.backend.device,
    timer = passTimer(device, renderer.backend, type => (type === 'render' ? 'scene/rendering' : state.stage), {
      slots: 8,
    });
  const frames = [],
    samples = [],
    errors = [],
    pending = new Set(),
    lifecycle = [];
  attribution.scan();
  let lastSample = -Infinity;
  const enqueue = promise => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      error => {
        errors.push(error.message);
        pending.delete(promise);
      },
    );
  };
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let deviceLost;
  void device.lost.then(result => {
    deviceLost = { reason: result.reason, message: result.message };
  });
  const snapshot = phase => {
    const result = { phase, ...attribution.scan() };
    samples.push(result);
    return result;
  };
  const start = performance.now();
  let previous = start;
  const draw = (timestamp, measure = true) => {
    const frame = { frame: frames.length, time: timestamp - start, intervalMs: timestamp - previous };
    previous = timestamp;
    window.liquidReliabilityFrame = frame.frame;
    const active = measure && timer.start(),
      begin = performance.now();
    sceneLifecycle?.update?.(replay ? 1 / 60 : frame.intervalMs / 1000);
    if (replay) system.advanceFrames(1, 1 / 60);
    else system.update();
    renderer.render(scene, camera);
    frame.cpuSubmissionMs = performance.now() - begin;
    // Discover new current/prepared identities after submission; annotations themselves do not read the GPU.
    if (timestamp - lastSample > 100) {
      lastSample = timestamp;
      snapshot('live');
    } else tracker.refresh();
    frame.quality = fluid.cellSize;
    frame.particles = system.liveParticleCount;
    frame.capacity = (fluid.workGrid ?? fluid.volumeGrid).capacity;
    frame.memoryBytes = tracker.snapshot().liveBytes;
    if (measure) frames.push(frame);
    if (active)
      enqueue(
        timer.finish().then(result => {
          frame.gpu = { totalGPUms: result.totalGPUms, stageGPUms: result.allStageGPUms };
        }),
      );
  };
  const advanceUntil = async predicate => {
    const began = performance.now();
    while (!predicate()) {
      if (performance.now() - began > 60000) throw new Error('Memory lifecycle transition timed out');
      await new Promise(resolve =>
        requestAnimationFrame(time => {
          draw(time, false);
          resolve();
        }),
      );
    }
  };
  try {
    // Include first populated visibility and current lighting; optional preparation does not advance time.
    if (controlled) {
      const pool = fluid.workPool ?? fluid.poolAllocation;
      if (!pool) throw new Error('Controlled replay requires the populated preparation checkpoint.');
      while (pool.capacity < Math.min(512, pool.maximumCapacity)) {
        pool.request(512);
        await pool.whenPrepared();
        pool.commit();
      }
    }
    snapshot('first visible');
    system.start(false);
    await new Promise((resolve, reject) => {
      const step = timestamp => {
        try {
          draw(timestamp);
          if (replay ? frames.length < seconds * 60 : timestamp - start < seconds * 1000) requestAnimationFrame(step);
          else resolve();
        } catch (error) {
          reject(error);
        }
      };
      requestAnimationFrame(step);
    });
    await Promise.all([...pending]);
    await attribution.observe();
    const steady = snapshot('steady');
    await attribution.whenIdle();
    await device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 0));
    const settled = snapshot('steady after background retirement');
    // Stress transitions separately from ordinary interactive FPS; report each phase and retained field diagnostics.
    if (transitions) {
      const pool = fluid.workPool ?? fluid.poolAllocation;
      if (pool && pool.capacity < pool.maximumCapacity) {
        const old = pool.capacity;
        pool.request(old);
        lifecycle.push(snapshot('capacity preparation'));
        await advanceUntil(
          () =>
            pool.status.state === 'ready' || pool.capacity > old || (fluid.workPool ?? fluid.poolAllocation) !== pool,
        );
        lifecycle.push(snapshot('capacity prepared'));
        await advanceUntil(() => pool.capacity > old || (fluid.workPool ?? fluid.poolAllocation) !== pool);
        lifecycle.push(snapshot('capacity adopted'));
        await device.queue.onSubmittedWorkDone();
        lifecycle.push(snapshot('capacity reclaimed'));
      }
      const original = fluid.spatialGridOptions.volumeQuality ?? fluid.spatialGrid.volumeQualityTier;
      for (const [phase, quality] of [
        ['coarsened', original * 2],
        ['refined', original],
      ]) {
        fluid.setSpatialGridOptions({ autoVolumeQuality: false, volumeQuality: quality });
        draw(performance.now(), false);
        await device.queue.onSubmittedWorkDone();
        lifecycle.push(snapshot(phase));
      }
    }
    const pressure = await fluid.getPressureProjection().readDiagnostics(renderer, fluid.velocityCurrent);
    const surfaceStats = await surface?.readSurfaceDiagnostics();
    const peak = tracker.peakSnapshot(),
      categoryPeaks = tracker.categoryPeaks();
    const beforeDestroy = snapshot('before teardown');
    await Promise.all([
      fluid.workPool?.whenPrepared(),
      fluid.poolAllocation?.whenPrepared(),
      fluid.textureAllocation?.whenPrepared(),
      fluid.qualityPreparation?.completion,
      surface?.allocation?.whenPrepared(),
    ]);
    await attribution.whenIdle();
    system.destroy();
    sceneLifecycle?.cleanup?.();
    await device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 0));
    await device.queue.onSubmittedWorkDone();
    await attribution.whenIdle();
    await device.queue.onSubmittedWorkDone();
    const afterDestroy = tracker.semanticSnapshot();
    return {
      seconds,
      controlled,
      replay: replay
        ? { dt: 1 / 60, frames: seconds * 60, seed: 137, quality: fluid.spatialGridOptions.volumeQuality }
        : null,
      workload: surface ? 'liquid' : 'gas',
      startup: memoryPhases,
      steady,
      settled,
      peak,
      categoryPeaks,
      beforeDestroy,
      afterDestroy,
      overlap: {
        peakMultiplier: steady.liveBytes ? peak.bytes / steady.liveBytes : 0,
        atGlobalPeak: peak.byState,
        preparedPeak: Math.max(0, ...samples.map(sample => sample.byState.prepared ?? 0)),
        retiredPeak: Math.max(0, ...samples.map(sample => sample.byState.retired ?? 0)),
        sampledTemporaryPeak: Math.max(
          0,
          ...samples.map(sample => (sample.byState.prepared ?? 0) + (sample.byState.retired ?? 0)),
        ),
      },
      samples,
      lifecycle,
      frames,
      errors,
      deviceLost,
      pressure,
      surface: surfaceStats,
      timing: {
        raf: frameDistribution(frames.slice(1).map(frame => frame.intervalMs)),
        cpu: frameDistribution(frames.map(frame => frame.cpuSubmissionMs)),
        gpu: frameDistribution(frames.map(frame => frame.gpu?.totalGPUms)),
      },
      allocations: tracker.records(),
      events: tracker.events,
    };
  } finally {
    await Promise.allSettled([...pending]);
    timer.dispose();
    restore();
    attribution.restore();
    tracker.restore();
    delete window.liquidReliabilityState;
  }
}
