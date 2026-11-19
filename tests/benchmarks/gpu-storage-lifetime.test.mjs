import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageBufferAttribute } from 'three/webgpu';
import { initializeStorageAttribute } from '../../packages/rzmps/src/utils/gpu/storage.utils.ts';

test('compute-only attribute disposal releases native storage once and can reinitialize safely', () => {
  const allocations = new Map(), metadata = new Map();
  let destroyed = 0;
  const backend = { has: attribute => allocations.has(attribute),
    get: attribute => {
      if (!allocations.has(attribute)) allocations.set(attribute, {});
      return allocations.get(attribute);
    },
    createStorageAttribute: attribute => { allocations.set(attribute, { buffer: {} }); },
    destroyAttribute: attribute => { destroyed++; allocations.delete(attribute); } };
  const renderer = { backend, _attributes: { has: attribute => metadata.has(attribute),
    delete: attribute => { metadata.delete(attribute); backend.destroyAttribute(attribute); } } };
  const attribute = new StorageBufferAttribute(new Float32Array(16), 4);
  initializeStorageAttribute(renderer, attribute); initializeStorageAttribute(renderer, attribute);
  metadata.set(attribute, { version: 0 });
  attribute.dispose(); attribute.dispose();
  assert.equal(metadata.size, 0, 'Three version metadata must not outlive its native buffer');
  assert.equal(destroyed, 1); assert.equal(allocations.size, 0);
  initializeStorageAttribute(renderer, attribute); attribute.dispose();
  assert.equal(destroyed, 2); assert.equal(allocations.size, 0);
});

test('background preparation bounds parallel driver waits and settles cancellation', async () => {
  const { default: prepare } = await import('../../packages/rzmps/src/utils/gpu/prepareComputePrograms.ts');
  let active = 0, peak = 0, prepared = 0;
  const compiler = { async compileComputeAsync() {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 8));
    active--; prepared++;
  } };
  await prepare(compiler, Array.from({ length: 12 }, () => ({})));
  assert.equal(prepared, 12); assert(peak > 1 && peak <= 4); assert.equal(active, 0);
  prepared = 0;
  await prepare(compiler, Array.from({ length: 12 }, () => ({})), () => prepared === 0);
  assert(prepared < 12); assert.equal(active, 0, 'cancelled preparation must settle before resource disposal');
});
