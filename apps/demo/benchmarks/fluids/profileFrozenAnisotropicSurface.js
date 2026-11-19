import { passTimer } from '../../../../benchmarks/lib/passTimer.js';
import { profileFluidStages, summarizeFluidTimings, median } from './fluidProfiling.utils.js';
import { liquidStage } from './liquidStages.utils.js';

/** Same immutable render particles, field lattice and camera; compilation is warmed outside timing. */
export default async function profileFrozenAnisotropicSurface(system, renderer, scene, camera, samples = 12) {
  const surface = system.renderers.find(renderer => renderer.constructor.name === 'SurfaceRenderer');
  // Live frames may have left capacity/quality compilers running. Exclude their device-wide
  // work from this render-only A/B, and record any unexpected pipeline creation during samples.
  const flip = system.__liquidFixture?.flip ?? system.modules.find(module => module.workGrid);
  await Promise.all([flip?.workPool?.whenPrepared(), flip?.qualityPreparation?.completion,
    surface.allocation?.whenPrepared()]);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const buffers = surface.surface.copyBuffers, original = surface.kernelOptimization;
  const state = { stage: 'liquid/other', gpuSamples: [], cpuSubmissionMs: [] }, results = [];
  const restore = profileFluidStages(renderer, [[surface, name => `liquid/${liquidStage(name, true)}/${name}`]], state);
  const device = renderer.backend.device;
  let pipelines = 0;
  const factories = ['createComputePipeline', 'createComputePipelineAsync'].map(key => {
    const original = device[key];
    device[key] = function (...args) { pipelines++; return original.apply(this, args); };
    return () => { device[key] = original; };
  });
  const timer = passTimer(device, renderer.backend, type => type === 'render'
    ? 'liquid/surface rendering' : state.stage);
  const modes = {
    reference: { sharedMoments: false, convergedEigen: false },
    early: { sharedMoments: false, convergedEigen: true },
    shared: { sharedMoments: true, convergedEigen: false },
    final: { sharedMoments: true, convergedEigen: true },
  };
  try {
    for (const [mode, settings] of Object.entries(modes)) {
      const initialPipelines = pipelines;
      surface.kernelOptimization = { supportSizedBins: false, ...settings };
      surface.surface.kernelKey = ''; surface.surface.queryVersion = -1;
      for (let warm = 0; warm < 6; warm++) {
        surface.updateGPU(buffers, system); await renderer.renderAsync(scene, camera);
        await device.queue.onSubmittedWorkDone();
      }
      const preparedPipelines = pipelines;
      state.gpuSamples = []; state.cpuSubmissionMs = [];
      const wall = [], queue = [];
      for (let sample = 0; sample < samples; sample++) {
        timer.start(); const start = performance.now();
        surface.updateGPU(buffers, system);
        state.cpuSubmissionMs.push(performance.now() - start);
        await renderer.renderAsync(scene, camera);
        const submitted = performance.now();
        await device.queue.onSubmittedWorkDone();
        wall.push(performance.now() - start); queue.push(performance.now() - submitted);
        state.gpuSamples.push(await timer.finish());
      }
      results.push({ mode, ...summarizeFluidTimings(state),
        pipelineCreationsPreparation: preparedPipelines - initialPipelines,
        pipelineCreationsMeasured: pipelines - preparedPipelines, fencedWallMedianMs: median(wall),
        queueCompletionMedianMs: median(queue), surface: await surface.readSurfaceDiagnostics() });
    }
  } finally {
    timer.dispose(); restore(); factories.forEach(restore => restore());
    if (original) surface.kernelOptimization = original; else delete surface.kernelOptimization;
    surface.surface.kernelKey = ''; surface.surface.queryVersion = -1;
  }
  return results;
}
