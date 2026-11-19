import assert from 'node:assert/strict';
import test from 'node:test';
import { trackGPUResources } from '../../benchmarks/lib/gpuResourceTracking.utils.js';

function fixture() {
  const bindings = new WeakMap();
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => ({ destroy() {} }),
    createComputePipeline() {},
    createComputePipelineAsync: async () => ({}),
    createRenderPipeline() {},
    createRenderPipelineAsync: async () => ({}),
    queue: { onSubmittedWorkDone: async () => {} },
  };
  return {
    device,
    bindings,
    tracker: trackGPUResources(device, () => ({}), {
      backend: { has: target => bindings.has(target), get: target => bindings.get(target) },
    }),
  };
}

test('deferred semantic attribution resolves aliases without counting physical storage twice', () => {
  const { device, bindings, tracker } = fixture();
  const attribute = {},
    alias = {};
  const info = { owner: 'smoke', category: 'gas state', purpose: 'transport', state: 'prepared', generation: 2 };
  tracker.annotate(attribute, info);
  const buffer = device.createBuffer({ size: 128 });
  bindings.set(attribute, { buffer });
  bindings.set(alias, { buffer });
  tracker.refresh();
  tracker.annotate(alias, info);
  const snapshot = tracker.semanticSnapshot();
  assert.equal(snapshot.liveBytes, 128);
  assert.equal(snapshot.liveAllocations, 1);
  assert.equal(snapshot.byCategory['gas state'], 128);
  assert.equal(snapshot.byState.prepared, 128);
  assert.equal(snapshot.attributedFraction, 1);
  assert.equal(snapshot.largest[0].owner, 'smoke');
  tracker.restore();
});

test('global peak preserves its exact resource set and lifecycle instead of adding category peaks', async () => {
  const { device, tracker } = fixture();
  const first = device.createBuffer({ size: 128 });
  tracker.annotate(first, { owner: 'liquid', category: 'velocity', state: 'current' });
  const next = device.createBuffer({ size: 256 });
  tracker.annotate(next, { owner: 'liquid', category: 'pressure', state: 'prepared' });
  // Distinguish adoption from the allocation instant even on coarse timer clocks.
  await new Promise(resolve => setTimeout(resolve, 2));
  tracker.annotate(first, { owner: 'liquid', category: 'velocity', state: 'retired' });
  tracker.annotate(next, { owner: 'liquid', category: 'pressure', state: 'current' });
  first.destroy();
  next.destroy();
  const later = device.createBuffer({ size: 300 });
  tracker.annotate(later, { owner: 'lighting', category: 'radiance' });
  const peak = tracker.peakSnapshot();
  assert.equal(peak.bytes, 384);
  assert.deepEqual(peak.byState, { current: 128, prepared: 256 });
  assert.equal(peak.allocations.length, 2);
  assert(peak.allocations.every(item => item.owner === 'liquid'));
  assert.deepEqual(tracker.categoryPeaks(), { velocity: 128, pressure: 256, radiance: 300 });
  assert.equal(tracker.semanticSnapshot().liveBytes, 300);
  later.destroy();
  assert.equal(tracker.semanticSnapshot().liveBytes, 0);
  assert.equal(tracker.records().filter(item => item.destroyedAt !== null).length, 3);
  tracker.restore();
});

test('packed allocation segments divide physical bytes and annotation metadata cannot retain resource objects', () => {
  const { device, tracker } = fixture();
  const buffer = device.createBuffer({ size: 48 });
  tracker.annotate(buffer, {
    owner: 'surface',
    category: 'packed',
    resource: buffer,
    segments: [
      { category: 'scalar', bytes: 4 },
      { category: 'color', bytes: 28 },
      { category: 'curl', bytes: 16 },
    ],
  });
  const snapshot = tracker.semanticSnapshot();
  assert.equal(
    Object.values(snapshot.byCategory).reduce((sum, value) => sum + value, 0),
    48,
  );
  assert.equal(snapshot.largest[0].resource, undefined);
  assert.throws(() => tracker.annotate(buffer, { owner: buffer }), /primitive/);
  assert.throws(() => tracker.annotate(buffer, { segments: [{ category: 'bad', bytes: NaN }] }), /segment/);
  tracker.restore();
});

test('category peaks retain earlier ownership when shared storage is reclassified later', async () => {
  const { device, tracker } = fixture();
  const buffer = device.createBuffer({ size: 128 });
  tracker.annotate(buffer, { owner: 'active', category: 'pressure', state: 'current' });
  await new Promise(resolve => setTimeout(resolve, 2));
  tracker.annotate(buffer, { owner: 'prepared', category: 'workspace', state: 'prepared' });
  assert.deepEqual(tracker.categoryPeaks(), { pressure: 128, workspace: 128 });
  assert.equal(tracker.peakSnapshot().byCategory.pressure, 128);
  buffer.destroy();
  tracker.restore();
});
