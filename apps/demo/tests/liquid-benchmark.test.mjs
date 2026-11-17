import test from 'node:test';
import assert from 'node:assert/strict';
import { markerMetrics, compareMarkers } from '../benchmarks/fluids/liquidQuality.utils.js';
import { trackSimulationTime, summarizeFluidTimings } from '../benchmarks/fluids/fluidProfiling.utils.js';
import { liquidStage, liquidStageNames } from '../benchmarks/fluids/liquidStages.utils.js';
import { readProfilerStats } from '../src/profiling/readProfilerStats.js';

const marker = (id, position, velocity = [1, 0, 0], mass = 2) => ({ id, position, velocity, mass, radius: 0.1 });

test('liquid checkpoints distinguish cell-relative speed changes, lost identities, mass and collider interiors', () => {
  const before = [marker('0:1', [0, 0, 0]), marker('1:1', [0, 1, 0])];
  const after = before.map(particle => ({ ...particle, position: [0.5, ...particle.position.slice(1)] }));
  const comparison = compareMarkers(before, after, 0.5);
  assert.equal(comparison.particleRetention, 1);
  assert.equal(comparison.massRetention, 1);
  assert.equal(comparison.rmsTranslationError, 0);
  assert.equal(comparison.momentumDrift, 0);
  const doubled = after.map(particle => ({ ...particle, velocity: [2, 0, 0], position: [1, 0, 0] }));
  assert(compareMarkers(before, doubled, 0.5).rmsTranslationError > 0.4);
  assert(compareMarkers(before, doubled, 0.5).momentumDrift > 0);
  assert.equal(compareMarkers(before, [marker('0:2', [0, 0, 0])]).particleRetention, 0);
  const quality = markerMetrics(before, [{ center: [0, 0, 0], halfSize: [0.5, 0.5, 0.5] }]);
  assert.equal(quality.colliderInteriorParticles, 1);
  assert.equal(quality.maxPenetration, 0.5);
  assert.equal(quality.mass, 4);
});

test('simulation clock observes executed substeps and skipped history independently', () => {
  const system = { deltaTime: 1, _advanceSimulationInterval() {
    this._skipSimulationTime(0.75);
    for (let i = 0; i < 2; i++) { this.deltaTime = 0.125; this._advanceSimulationStep(); }
  }, _advanceSimulationStep() {}, _skipSimulationTime() {} };
  const original = system._advanceSimulationStep, clock = trackSimulationTime(system);
  system._advanceSimulationInterval();
  assert.deepEqual(clock.time, { requestedSeconds: 1, executedSeconds: 0.25, skippedSeconds: 0.75, substeps: 2 });
  clock.restore();
  assert.equal(system._advanceSimulationStep, original);
});

test('fluid reports retain interval-union totals instead of adding stage medians', () => {
  const report = summarizeFluidTimings({ cpuSubmissionMs: [2, 4], gpuSamples: [
    { totalGPUms: 10, stageGPUms: { pressure: 9, surface: 1 } },
    { totalGPUms: 10, stageGPUms: { pressure: 1, surface: 9 } },
  ] });
  assert.equal(report.gpuExecutionMedianMs.totalGPUms, 10);
  assert.equal(report.gpuStageMedianMs.pressure + report.gpuStageMedianMs.surface, 18);
  assert.match(report.timingConvention, /not additive/);
  assert.equal(liquidStage('pressureTopology'), 'pressure topology');
  assert.equal(liquidStage('meshUpdate', true), 'surface attribute reconstruction');
  assert(liquidStageNames.includes('foam attachment'));
});

test('the fluid profiler formats public submission metrics without requiring solver or renderer internals', () => {
  const prefix = 'systems/ParticleSystem-1/modules/FLIPSimulation-2/';
  const stats = readProfilerStats({ snapshot: () => ({
    [`${prefix}grid/cellSize`]: 0.125,
    [`${prefix}grid/width`]: 32, [`${prefix}grid/height`]: 32, [`${prefix}grid/depth`]: 32,
    [`${prefix}pressureSolve`]: 1.5, [`${prefix}residentPages`]: 24,
    'systems/ParticleSystem-1/renderers/SurfaceRenderer-3/surfaceExtraction': 0.75,
  }) });
  assert.equal(stats.fluids[0].pressureSubmissionMs, 1.5);
  assert.equal(stats.fluids[0].surfaceSubmissionMs, 0.75);
  assert.equal(stats.fluids[0].residentPages, 24);
});
