import { pairBenchmarkCases } from './benchmark.utils.js';
import * as THREE from 'three';
import { GasSimulation } from '@rzmps/rzmps';
import smokePreset from 'examples/presets/volumetricSmoke.js';
import firePreset from 'examples/presets/volumetricFire.js';
import { passTimer } from '../../../benchmarks/lib/passTimer.js';
import { profileGasStages } from './fluids/gasStages.utils.js';

import { summarizeFluidTimings } from './fluids/fluidProfiling.utils.js';
const hash = buffer => {
  let value = 2166136261;
  for (const byte of new Uint8Array(buffer)) value = Math.imul(value ^ byte, 16777619);
  return value >>> 0;
};

function workload(system, renderer) {
  const gas = system.modules.find(module => module instanceof GasSimulation);
  const volume = system.renderers.find(view => view.constructor.name === 'VolumeRenderer');
  return { cellWidth: gas.cellSize, subdivisions: [gas.spatialGrid.brickSubdivisions, gas.spatialGrid.cellSubdivisions],
    bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()],
    residentPages: gas.brickDiagnostics.resident, activePages: gas.brickDiagnostics.activeDispatch,
    activeCells: gas.brickDiagnostics.activeDispatch * gas.volumeGrid.cellsPerBrick,
    particleCount: system.liveParticleCount, pressureSolver: gas.pressureSelection(),
    requestedPressureSolver: gas.pressureSolver,
    pressure: { ...gas.pressureStats }, lighting: { ...volume.lightingGrid?.statistics },
    lightingLevels: volume.lightingGrid?.levels ?? 0, renderScale: volume.dynamicTarget.resolutionScale,
    viewport: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() };
}

/** Compact, GPU-only full-suite workloads; the short PR selection intentionally remains unchanged. */
export function gasBenchmarkCases() {
  return [
    ['smoke', 'Volumetric Smoke steady state', smokePreset],
    ['fire', 'Volumetric Fire steady state', firePreset],
    ['pressure', 'Gas high-quality pressure', smokePreset],
    ['lighting', 'Gas lighting-heavy plume', smokePreset],
    ['startup', 'Gas lifecycle startup', smokePreset],
    ['quality', 'Gas lifecycle quality transition', smokePreset],
    ['capacity', 'Gas lifecycle resident capacity', smokePreset],
    ['sustained', 'Gas sustained smoke', smokePreset],
  ].map(([kind, name, factory]) => {
    let state, timer, restore, device, create, createAsync, pipelineCount = 0, pending = false, frame = 0;
    return {
      id: `gas-${kind}`, name, gpuOnly: true, particleCount: 300,
      minimumDurationMs: kind === 'sustained' ? 10000 : 0,
      async createSystem() {
        const system = await factory();
        if (kind === 'capacity' || kind === 'pressure') {
          system.modules = system.modules.map(module => module instanceof GasSimulation
            ? new GasSimulation({ initialBrickCapacity: 128, maxActiveBricks: kind === 'capacity' ? 256 : 1024,
              ...(kind === 'pressure' ? { bounds: new THREE.Box3(new THREE.Vector3(-4, -4, -4),
                new THREE.Vector3(4, 4, 4)), automaticPadding: false, pressureIterations: 32,
                pressureDiagnostics: true } : {}),
              spatialGridOptions: { brickSubdivisions: 3,
                cellSubdivisions: kind === 'pressure' ? 4 : 3, minVolumeQuality: 8 } }) : module);
        }
        system.gpuProcessing = true;
        return system;
      },
      configureScene(scene) {
        const ambient = new THREE.AmbientLight(0xffffff, 0.4);
        const light = new THREE.PointLight('#ffeecc', 35, 0);
        light.position.set(2, 3, 2);
        scene.add(ambient, light);
        return [ambient, light];
      },
      async prepare(system, renderer, scene, camera) {
        const gas = system.modules.find(module => module instanceof GasSimulation);
        const volume = system.renderers.find(view => view.constructor.name === 'VolumeRenderer');
        gas.setSpatialGridOptions({ autoVolumeQuality: false, volumeQuality: 8,
          minVolumeQuality: 8, maxVolumeQuality: 8 });
        volume.dynamicResolution = false;
        // Lighting-heavy case increases actual coverage, not requested probe quality.
        if (kind === 'lighting') volume.lightingGridOptions = { ...volume.lightingGridOptions, margin: 3 };
        system._renderer = renderer; system._scene = scene; system._camera = camera;
        device = renderer.backend.device;
        create = device.createComputePipeline;
        createAsync = device.createComputePipelineAsync;
        device.createComputePipeline = function (...args) { pipelineCount++; return create.apply(this, args); };
        device.createComputePipelineAsync = function (...args) {
          pipelineCount++; return createAsync.apply(this, args);
        };
        state = { category: kind === 'startup' || kind === 'quality' || kind === 'capacity' ? 'lifecycle' : 'steady',
          gpuSamples: [], cpuSubmissionMs: [], lifecycle: {}, stage: 'other' };
        system.__gasBenchmark = state;
        const fence = () => device.queue.onSubmittedWorkDone();
        const start = performance.now(), prepareStart = start;
        await system.prepare(renderer);
        state.lifecycle.prepareWallMs = performance.now() - start;
        state.lifecycle.preparedComputePipelines = pipelineCount;
        const advance = async () => {
          const start = performance.now();
          system.advanceFrames(1, 1 / 60);
          const cpu = performance.now() - start;
          const renderStart = performance.now();
          await renderer.renderAsync(scene, camera);
          const queueStart = performance.now();
          await fence();
          state.lastFrameTimings = { renderSubmissionMs: queueStart - renderStart,
            queueCompletionWaitMs: performance.now() - queueStart };
          if (state.lifecycle.firstPopulatedRenderMs === undefined) {
            const values = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
            if (values.some((value, i) => i % 4 === 0 && value > 0))
              state.lifecycle.firstPopulatedRenderMs = performance.now() - prepareStart;
          }
          return cpu;
        };
        timer = device.features.has('timestamp-query') ? passTimer(device, renderer.backend, () => state.stage) : null;
        restore = profileGasStages(renderer, gas, volume, state);
        const before = pipelineCount, firstStart = performance.now();
        timer?.start();
        state.lifecycle.firstUpdateCPUMs = await advance();
        if (timer) {
          const { passes: _passes, ...timing } = await timer.finish();
          state.lifecycle.firstUpdateGPU = timing;
        }
        state.lifecycle.firstUpdateRenderFenceMs = performance.now() - firstStart;
        state.lifecycle.firstRender = { ...state.lastFrameTimings };
        for (let i = 0; i < 12; i++) await advance();
        state.lifecycle.firstUseComputePipelines = pipelineCount - before;

        if (kind === 'quality') {
          const cell = gas.cellSize * 2;
          const dimensions = gas.bounds.getSize(new THREE.Vector3()).divideScalar(cell).ceil();
          const domain = { bounds: gas.bounds.clone(), gridDimensions: dimensions, cellSize: cell };
          const start = performance.now();
          while (!gas.prepareQualityChange(domain, renderer)) {
            if (gas.qualityPreparation?.error) throw gas.qualityPreparation.error;
            if (performance.now() - start > 20000) throw new Error('Gas quality benchmark preparation timeout');
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          state.lifecycle.qualityPreparationMs = performance.now() - start;
          const density = async () => new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
          const old = await density();
          gas.spatialGrid.setOptions({ autoVolumeQuality: false, minVolumeQuality: 16, maxVolumeQuality: 16,
            volumeQuality: 16 });
          const count = pipelineCount, swap = performance.now();
          state.cpuStages = {};
          timer?.start();
          state.lifecycle.adoptionCPUMs = await advance();
          if (timer) {
            const { passes: _passes, ...timing } = await timer.finish();
            state.lifecycle.adoptionGPU = timing;
          }
          state.lifecycle.adoptionCPUStages = { ...state.cpuStages };
          state.lifecycle.firstPostTransitionRender = { ...state.lastFrameTimings };
          state.lifecycle.adoptionFenceMs = performance.now() - swap;
          state.lifecycle.adoptionComputePipelines = pipelineCount - count;
          const next = await density();
          state.lifecycle.fieldsFinite = next.every(Number.isFinite);
          state.lifecycle.retainedNonzeroDensity = old.some(value => value > 0) && next.some(value => value > 0);
          if (!state.lifecycle.fieldsFinite || !state.lifecycle.retainedNonzeroDensity)
            throw new Error('Gas quality transition lost populated fields');
        }
        if (kind === 'capacity') {
          const attributes = () => [...gas.fieldAttributes, ...gas.getPressureProjection().capacityAttributes()];
          const packed = new Set([gas.fieldAttributes.indexOf(gas.boundaryAttribute),
            gas.fieldAttributes.indexOf(gas.visualAttribute)]);
          const oldCells = gas.cellCount;
          const old = await Promise.all(attributes().map(attribute => renderer.getArrayBufferAsync(attribute)));
          const from = gas.volumeGrid.capacity, count = pipelineCount, start = performance.now();
          gas.poolAllocation.request(from * 2);
          await gas.poolAllocation.whenPrepared();
          const preparedAt = performance.now();
          gas.poolAllocation.commit();
          const queueStart = performance.now();
          await fence();
          const queueWaitMs = performance.now() - queueStart;
          const next = await Promise.all(attributes().map(attribute => renderer.getArrayBufferAsync(attribute)));
          state.lifecycle.capacity = { from, to: gas.volumeGrid.capacity,
            fencedWallMs: performance.now() - start, preparationWallMs: preparedAt - start, queueWaitMs,
            pipelines: pipelineCount - count,
            phases: { ...gas.capacityMetrics, ...gas.poolAllocation.metrics },
            retained: old.every((buffer, i) => {
              if (!packed.has(i)) return hash(buffer) === hash(next[i].slice(0, buffer.byteLength));
              const planeBytes = oldCells * 16;
              return hash(buffer.slice(0, planeBytes)) === hash(next[i].slice(0, planeBytes))
                && hash(buffer.slice(planeBytes)) === hash(next[i].slice(gas.cellCount * 16,
                  gas.cellCount * 16 + buffer.byteLength - planeBytes));
            }) };
          if (!state.lifecycle.capacity.retained) throw new Error('Capacity growth changed retained gas storage');
        }
      },
      beforeUpdate(_system, _elapsed, phase) {
        state.phase = phase;
        state.cpuStart = performance.now();
        if (phase === 'measure' && timer && !pending && frame++ % 20 === 0) { timer.start(); state.measuring = true; }
      },
      afterUpdate() {
        if (state.phase === 'measure') state.cpuSubmissionMs.push(performance.now() - state.cpuStart);
      },
      afterRender(system, renderer) {
        if (state.measuring) {
          state.measuring = false; pending = true;
          timer.finish().then(sample => {
            if (state.gpuSamples.length < 64) state.gpuSamples.push(sample);
          }).catch(error => { state.error = error.message; }).finally(() => { pending = false; });
        }
        state.workload = workload(system, renderer);
      },
      validate() { if (state.error) throw new Error(state.error); },
      report() {
        return { category: state.category, workload: state.workload, lifecycle: state.lifecycle,
          ...summarizeFluidTimings(state) };
      },
      async cleanup() {
        restore?.();
        while (pending) await new Promise(resolve => setTimeout(resolve, 1));
        timer?.dispose();
        if (device) { device.createComputePipeline = create; device.createComputePipelineAsync = createAsync; }
      },
    };
  });
}

export default {
  id: 'gas',
  name: 'Gas simulation workloads',
  feature: 'simulation/gas',
  runtime: 'browser',
  backends: ['gpu'],
  createCases() { return pairBenchmarkCases(gasBenchmarkCases()); },
};
