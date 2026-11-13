/* eslint-env node */
import assert from 'node:assert/strict';
import { StagedGPUAllocation } from '../../build/index.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let prepared, fence;
const released = [], operations = [];
const initial = { capacity: 4, value: 7 };
const allocation = new StagedGPUAllocation(initial, 4, {
  maximumCapacity: 16,
  create: capacity => ({ capacity, value: 0 }),
  prepare: () => new Promise(resolve => { prepared = resolve; }),
  migrate: (current, next) => { operations.push('migrate'); next.value = current.value; },
  swap: () => operations.push('swap'),
  dispose: value => released.push(value),
  fence: () => new Promise(resolve => { fence = resolve; }),
});
allocation.request(3);
await tick();
initial.value = 19;
assert.equal(allocation.current, initial);
assert.equal(allocation.commit(), false, 'preparation may not mutate live bindings');
prepared(); await tick();
assert(allocation.commit());
assert.deepEqual(operations, ['migrate', 'swap']);
assert.equal(allocation.current.value, 19, 'migration must capture state at swap time, not request time');
assert.equal(allocation.capacity, 8);
assert.deepEqual(released, [], 'old resources must survive until queued uses finish');
fence(); await tick();
assert.deepEqual(released, [initial]);
allocation.request(7); await tick();
const current = allocation.current;
allocation.dispose();
fence(); prepared(); await tick(); fence(); await tick();
assert.equal(allocation.current, current, 'cancelled staging cannot swap after teardown');
assert.equal(released.length, 3);
console.log('Staged allocation lifecycle passed');
