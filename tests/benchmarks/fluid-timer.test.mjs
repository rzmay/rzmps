import test from 'node:test';
import assert from 'node:assert/strict';
import { passTimer } from '../../benchmarks/lib/passTimer.js';

test('fluid pass timings union overlapping scopes and separate surface, secondary and scene render work', async () => {
  const previousUsage = globalThis.GPUBufferUsage, previousMap = globalThis.GPUMapMode;
  globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
  globalThis.GPUMapMode = { READ: 1 };
  const ns = ms => BigInt(ms) * 1_000_000n;
  const times = new BigUint64Array([ns(1), ns(6), ns(3), ns(8), ns(7), ns(10), ns(2), ns(11)]);
  const buffer = () => ({ destroy() {}, unmap() {}, async mapAsync() {}, getMappedRange: () => times.buffer });
  const encoder = () => ({ beginComputePass() { return {}; }, beginRenderPass() { return {}; },
    resolveQuerySet() {}, copyBufferToBuffer() {}, finish() { return {}; } });
  const device = { createQuerySet: () => ({ destroy() {} }), createBuffer: buffer,
    createCommandEncoder: encoder, queue: { submit() {} } };
  const backend = { initTimestampQuery() {} }, original = device.createCommandEncoder;
  let stage = 'liquid/pressure solve';
  const timer = passTimer(device, backend, type => type === 'render' ? 'liquid/surface rendering' : stage);
  try {
    timer.start();
    const command = device.createCommandEncoder();
    command.beginComputePass();
    stage = 'liquid/surface extraction'; command.beginComputePass();
    stage = 'liquid/secondary-particle/spray work'; command.beginComputePass();
    command.beginRenderPass();
    const result = await timer.finish();
    assert.equal(result.totalGPUms, 10);
    assert.equal(result.computeGPUms, 9);
    assert.equal(result.renderPassGPUms, 9);
    assert.equal(result.computeRenderOverlapGPUms, 8);
    assert.equal(result.renderGPUms, 1);
    assert.equal(result.simulationGPUms, 5);
    assert.equal(result.surfaceComputeGPUms, 5);
    assert.equal(result.secondaryGPUms, 3);
    assert.equal(result.allStageGPUms['liquid/surface rendering'], 9);
    assert.equal(result.stageGPUms['liquid/pressure solve'], 5);
  } finally {
    timer.dispose();
    assert.equal(device.createCommandEncoder, original);
    if (previousUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = previousUsage;
    if (previousMap === undefined) delete globalThis.GPUMapMode;
    else globalThis.GPUMapMode = previousMap;
  }
});
