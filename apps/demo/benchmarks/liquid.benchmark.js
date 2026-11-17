import * as THREE from 'three';
import { pairBenchmarkCases } from './benchmark.utils.js';
import { passTimer } from '../../../benchmarks/lib/passTimer.js';
import { createLiquidWorkload, seedLiquidLattice } from './fluids/liquidWorkload.utils.js';
import { liquidCheckpoint, compareMarkers } from './fluids/liquidQuality.utils.js';
import { profileLiquidStages, liquidStageNames } from './fluids/liquidStages.utils.js';
import { summarizeFluidTimings, trackSimulationTime } from './fluids/fluidProfiling.utils.js';
import { benchmarkFoam } from './fluids/foamProfiling.utils.js';
import { runLiquidQualityTransition } from './fluids/liquidTransition.utils.js';

/** GPU-only, fixed population fixtures. Expensive checkpoints and lifecycle setup precede timed measurement. */
export function liquidBenchmarkCases() {
  return [
    ['low', 'Liquid steady state 2k', 2000], ['medium', 'Liquid steady state 8k', 8000],
    ['high', 'Liquid steady state 16k', 16000], ['pressure', 'Liquid high-resolution pressure', 8000],
    ['collider', 'Liquid collider-heavy', 8000], ['surface', 'Liquid surface and spray', 8000],
    ['foam', 'Liquid surface foam', 8000],
    ['startup', 'Liquid lifecycle startup', 2000], ['quality', 'Liquid lifecycle quality transition', 2000],
    ['capacity', 'Liquid lifecycle resident/domain growth', 8000], ['sustained', 'Liquid sustained 24k', 24000],
  ].map(([kind, name, count]) => {
    let system, renderer, state, timer, restore, clock, device, create, createAsync, initial;
    let pending, frame = 0, pipelines = 0, constructWallMs = 0;
    const advance = async () => {
      const cpuStart = performance.now();
      system.advanceFrames(1, 1 / 60);
      const cpuSubmissionMs = performance.now() - cpuStart, renderStart = performance.now();
      await renderer.renderAsync(system._scene, system._camera);
      const queueStart = performance.now();
      await device.queue.onSubmittedWorkDone();
      return { cpuSubmissionMs, renderSubmissionMs: queueStart - renderStart,
        queueCompletionWaitMs: performance.now() - queueStart };
    };
    const fencedFrame = async () => {
      const start = performance.now(), before = pipelines;
      timer?.start();
      const cpu = await advance(), fencedWallMs = performance.now() - start;
      const timestampStart = performance.now();
      const gpu = timer ? await timer.finish() : null;
      return { ...cpu, fencedWallMs, timestampReadbackMs: performance.now() - timestampStart,
        computePipelines: pipelines - before,
        gpu: gpu ? (({ passes: _passes, ...timings }) => timings)(gpu) : null };
    };
    return {
      id: `liquid-${kind}`, name, feature: 'simulation/liquid', gpuOnly: true, particleCount: count,
      reportKey: 'liquid', minimumDurationMs: kind === 'sustained' ? 60000 : 0,
      async createSystem() {
        const start = performance.now();
        system = createLiquidWorkload({ count, kind, translation: kind === 'quality' });
        constructWallMs = performance.now() - start;
        return system;
      },
      configureScene(scene) {
        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(3, 5, 2);
        const objects = [ambient, sun, ...system.__liquidFixture.colliders];
        scene.add(...objects);
        return objects;
      },
      async prepare(owner, gpuRenderer, scene, camera) {
        system = owner; renderer = gpuRenderer;
        system._renderer = renderer; system._scene = scene; system._camera = camera;
        device = renderer.backend.device;
        create = device.createComputePipeline; createAsync = device.createComputePipelineAsync;
        device.createComputePipeline = function (...args) { pipelines++; return create.apply(this, args); };
        device.createComputePipelineAsync = function (...args) { pipelines++; return createAsync.apply(this, args); };
        state = { category: ['startup', 'quality', 'capacity'].includes(kind) ? 'lifecycle' : 'steady',
          gpuSamples: [], cpuSubmissionMs: [], stage: 'liquid/other', lifecycle: { constructWallMs }, quality: {} };
        clock = trackSimulationTime(system);
        system.benchmarks.start();
        const started = performance.now();
        await system.prepare(renderer);
        await device.queue.onSubmittedWorkDone();
        state.lifecycle.prepareWallMs = performance.now() - started;
        state.lifecycle.preparedComputePipelines = pipelines;
        const preparation = system.benchmarks.stop();
        state.lifecycle.preparationCPUSpans = Object.fromEntries(Object.entries(preparation.metrics)
          .filter(([, metric]) => metric.type === 'span').map(([name, metric]) => [name, metric.value]));
        timer = device.features.has('timestamp-query') ? passTimer(device, renderer.backend,
          type => type === 'render' ? state.renderStage ?? 'liquid/surface rendering' : state.stage) : null;
        restore = profileLiquidStages(system, renderer, state);
        state.lifecycle.firstFrame = await fencedFrame();
        seedLiquidLattice(system, renderer);
        state.lifecycle.firstPopulatedRender = await fencedFrame();
        state.lifecycle.firstPopulatedRenderMs = performance.now() - started;
        for (let frame = 0; frame < 12; frame++) await advance();
        initial = await liquidCheckpoint(system, renderer);
        state.workload = initial.workload; state.quality.initial = initial.quality;
        state.checkpointTime = { ...clock.time };

        if (kind === 'quality') {
          const before = pipelines;
          state.lifecycle.qualityTransition = await runLiquidQualityTransition(
            system, renderer, advance, clock.time, fencedFrame, () => pipelines,
          );
          state.lifecycle.qualityTransition.computePipelines = pipelines - before;
        }
        if (kind === 'capacity') {
          const flip = system.__liquidFixture.flip, from = flip.workGrid.capacity;
          const before = pipelines;
          const fromBounds = [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()];
          // Keep the domain change distinct from resident backing growth. Both use real production paths.
          const bounds = flip.bounds.clone().expandByScalar(flip.cellSize * flip.workGrid.brickSide);
          flip.bounds.copy(bounds); flip.autoBounds = false;
          flip.getParticleSpatialGrid(system).setBounds(bounds);
          state.lifecycle.domainGrowth = await fencedFrame();
          state.lifecycle.domainGrowth.fromBounds = fromBounds;
          state.lifecycle.domainGrowth.toBounds = [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()];
          const beforeGrowth = await liquidCheckpoint(system, renderer);
          const oldPressure = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
          const pool = flip.workPool, start = performance.now();
          pool.request(Math.min(pool.maximumCapacity, from * 2));
          await pool.whenPrepared();
          const prepared = performance.now();
          pool.commit();
          const swapped = performance.now();
          await device.queue.onSubmittedWorkDone();
          const queueCompletionWaitMs = performance.now() - swapped, fencedWallMs = performance.now() - start;
          const nextPressure = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
          const retainedPressure = oldPressure.subarray(0, oldPressure.length - 1)
            .every((value, index) => value === nextPressure[index]);
          const checkpoint = await liquidCheckpoint(system, renderer);
          state.lifecycle.capacity = { from, to: flip.workGrid.capacity, preparationWallMs: prepared - start,
            bindSwapCPUMs: swapped - prepared, queueCompletionWaitMs, retainedPressure,
            fencedWallMs, computePipelines: pipelines - before,
            phases: { ...pool.metrics }, ...compareMarkers(beforeGrowth.markers, checkpoint.markers) };
          if (!retainedPressure) throw new Error('Liquid capacity migration changed retained pressure');
        }
      },
      beforeUpdate(_system, _elapsed, phase) {
        state.phase = phase; state.cpuStart = performance.now();
        if (phase === 'measure' && timer && !pending && frame++ % 20 === 0) {
          timer.start(); state.measuring = true;
        }
      },
      afterUpdate() {
        if (state.phase === 'measure') state.cpuSubmissionMs.push(performance.now() - state.cpuStart);
      },
      afterRender() {
        if (!state.measuring) return;
        state.measuring = false;
        pending = timer.finish().then(sample => {
          if (state.gpuSamples.length < 64) state.gpuSamples.push(sample);
        }).catch(error => { state.error = error.message; }).finally(() => { pending = null; });
      },
      async validate() {
        if (pending) await pending;
        if (state.error) throw new Error(state.error);
        const final = await liquidCheckpoint(system, renderer);
        state.workload = final.workload;
        state.quality.final = final.quality;
        state.quality.conservation = { ...compareMarkers(initial.markers, final.markers),
          momentumConservationApplicable: system.__liquidFixture.translation,
          externalForces: system.__liquidFixture.translation ? 'none' : 'gravity and collider impulses' };
        const beforeSurface = initial.quality.surface, afterSurface = final.quality.surface;
        state.quality.stability = {
          centerOfMassHeightChange: final.quality.centroid[1] - initial.quality.centroid[1],
          rmsSpeedChange: final.quality.rmsSpeed - initial.quality.rmsSpeed,
          surfaceTriangleRatio: beforeSurface?.triangles > 0
            ? afterSurface.triangles / beforeSurface.triangles : null,
          surfaceBoundsCoverageChange: beforeSurface?.boundsCoverage != null && afterSurface?.boundsCoverage != null
            ? afterSurface.boundsCoverage - beforeSurface.boundsCoverage : null,
        };
        state.simulationTime = { ...clock.time };
        if (kind === 'foam') state.foam = await benchmarkFoam(
          system, renderer, system._scene, system._camera, timer, state,
        );
        if (final.quality.surface?.invalidSurfaceIndices || final.quality.surface?.nonFiniteSurfaceVertices)
          throw new Error('Liquid surface has invalid indices or non-finite vertices');
        if (final.quality.nonFiniteSamples || final.quality.pressure.nonFiniteSamples)
          throw new Error('Liquid fixture produced non-finite particles or pressure');
        if (state.quality.conservation.particleRetention < 0.99 || state.quality.conservation.massRetention < 0.99)
          throw new Error('Source-free liquid lost particles or mass');
      },
      report() {
        return { category: state.category, workload: state.workload, lifecycle: state.lifecycle,
          quality: state.quality, foam: state.foam, simulationTime: state.simulationTime, computePipelines: pipelines,
          stageNames: liquidStageNames, timestampQuerySupported: !!timer,
          stageNotes: { 'particle collision': 'Includes integration where the production particle kernel is fused.',
            'surface rendering': 'Scene render-pass union, including secondary sprites and background draws.',
            'secondary-particle/spray work': 'Secondary compute only; draw calls can share the surface render pass.' },
          ...summarizeFluidTimings(state) };
      },
      async cleanup() {
        if (pending) await pending;
        restore?.(); clock?.restore(); timer?.dispose();
        if (device) { device.createComputePipeline = create; device.createComputePipelineAsync = createAsync; }
      },
    };
  });
}

export default {
  id: 'liquid', name: 'Liquid FLIP workloads', feature: 'simulation/liquid', runtime: 'browser', backends: ['gpu'],
  createCases() { return pairBenchmarkCases(liquidBenchmarkCases()); },
};
