import assert from 'node:assert/strict';
import test from 'node:test';
import { frameDistribution, spikeWindows } from '../../apps/demo/benchmarks/fluids/liquidReliability.utils.js';
import { textureBytes, trackGPUResources } from '../../benchmarks/lib/gpuResourceTracking.utils.js';

test('frame percentiles preserve tail latency and GPU spike windows do not infer causes', () => {
  const values = Array(95).fill(16).concat([17, 20, 21, 34, 80]);
  const stats = frameDistribution(values);
  assert.equal(stats.p95, 16); assert.equal(stats.p99, 34); assert.equal(stats.max, 80);
  assert.equal(stats.over16_67, 5); assert.equal(stats.over20, 3); assert.equal(stats.over33_33, 2);
  const frames = Array.from({ length: 7 }, (_, frame) => ({ frame, qualityPending: frame === 2,
    gpu: { totalGPUms: frame === 3 ? 22 : 10,
      allStageGPUms: { pressure: 2, reconstruction: frame === 3 ? 19 : 1 } } }));
  const [window] = spikeWindows(frames);
  assert.equal(window.frame, 3); assert.deepEqual(window.largestStage, ['reconstruction', 19]);
  assert.equal(window.before.length, 3); assert.equal(window.after.length, 3);
  assert.equal(window.cause, undefined);
});

test('native resource accounting includes mips, overlap and idempotent explicit destruction', async () => {
  assert.equal(textureBytes({ size: [4, 4, 2], format: 'rgba16float', mipLevelCount: 3 }), 336);
  assert.equal(textureBytes({ size: [4, 4, 4], dimension: '3d', format: 'r32float', mipLevelCount: 3 }), 292);
  const device = { createBuffer: () => ({ destroy() {} }), createTexture: () => ({ destroy() {} }),
    createComputePipeline() {}, createComputePipelineAsync: async () => ({}),
    createRenderPipeline() {}, createRenderPipelineAsync: async () => ({}),
    queue: { onSubmittedWorkDone: async () => {} } };
  const original = device.createBuffer, tracking = trackGPUResources(device, () => ({ frame: 12 }));
  const first = device.createBuffer({ size: 1024 }), next = device.createBuffer({ size: 2048 });
  first.destroy(); first.destroy();
  assert.equal(tracking.snapshot().liveBytes, 2048); assert.equal(tracking.snapshot().peakBytes, 3072);
  next.destroy(); await device.queue.onSubmittedWorkDone();
  assert.equal(tracking.snapshot().liveBytes, 0); assert.equal(tracking.snapshot().pendingFences, 0);
  assert.equal(tracking.events.filter(event => event.type === 'destroy').length, 2);
  assert(tracking.events.every(event => event.frame === 12));
  tracking.restore(); assert.equal(device.createBuffer, original);
});
