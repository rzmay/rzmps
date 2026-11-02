import { Particle, ParticleSpatialGrid, SpatialLevels, createGPUParticleBufferState }
  from '../../packages/rzmps/build/index.mjs';
import { Vector3 } from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, Loop, uint, int, float, vec3, vec4, uvec4, storage, instanceIndex } from 'three/tsl';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const aggregator = {
  layout: { count: 'uint', sum: 'vec3', value: 'float', balance: 'int' },
  new: p => ({ count: uint(p ? 1 : 0), sum: p?.position ?? vec3(0),
    value: p ? p.position.x.mul(p.position.x) : float(0),
    balance: p ? p.index.mod(2).equal(0).select(int(-1), int(1)) : int(0) }),
  combine: (a, b) => ({ count: a.count.add(b.count), sum: a.sum.add(b.sum), value: a.value.add(b.value),
    balance: a.balance.add(b.balance) }),
  finalize: a => ({ ...a, sum: a.sum.div(float(a.count.max(1))), value: a.value.div(float(a.count.max(1))) }),
};

async function largeDirectory(renderer) {
  const count = 65537;
  const input = createGPUParticleBufferState([], 131072);
  input.count = count;
  const populate = Fn(() => {
    input.storage.createParticle().position.assign(vec3(float(instanceIndex.mod(256)).add(0.5),
      float(instanceIndex.div(256).mod(256)).add(0.5), float(instanceIndex.div(65536)).add(0.5)).div(256).sub(0.5));
    input.storage.createStateNode().assign(uvec4(1, 0, 1, 0));
  })().compute(count);
  renderer.compute(populate);
  const grid = new ParticleSpatialGrid({ brickSubdivisions: 4, cellSubdivisions: 4, levels: [8], autoExpand: false }, {
    layout: { count: 'uint' }, new: p => ({ count: uint(p ? 1 : 0) }),
    combine: (a, b) => ({ count: a.count.add(b.count) }),
  });
  grid.rebuild(renderer, input);
  const attribute = new StorageBufferAttribute(new Uint32Array(count + 1), 1);
  const out = storage(attribute, 'uint', count + 1);
  const header = Fn(() => { out.element(count).assign(grid.getRegions(8).count); })().compute(1);
  const read = grid.computeRegions(8, region => {
    out.element(instanceIndex).assign(grid.getAggregate(region).count);
  });
  renderer.compute([header, read]);
  const data = new Uint32Array(await renderer.getArrayBufferAsync(attribute));
  check(data[count] === count && data.subarray(0, count).every(value => value === 1),
    'More than 65535 occupied regions use portable tiled workgroup dispatch without losing cells');
  populate.dispose(); header.dispose(); read.dispose();
  grid.dispose(renderer); input.dispose(renderer); renderer.backend.destroyAttribute(attribute);
  return count;
}

async function run() {
  const renderer = await createWebGPURenderer({});
  let building = false;
  const readback = renderer.getArrayBufferAsync.bind(renderer);
  renderer.getArrayBufferAsync = (...args) => {
    if (building) throw new Error('Spatial construction must not read back GPU data');
    return readback(...args);
  };
  const errors = [];
  renderer.backend.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const particles = Array.from({ length: 513 }, (_, i) => new Particle({ position: new Vector3(
    ((i * 7) % 47) / 60 - 0.4, ((i * 13) % 31) / 40 - 0.4, ((i * 19) % 23) / 30 - 0.4,
  ) }));
  const input = createGPUParticleBufferState(particles, 1024);
  const grid = new ParticleSpatialGrid({ brickSubdivisions: 1, cellSubdivisions: 2,
    autoExpand: false, levels: [0, 2, 2] }, aggregator);
  const results = [];
  try {
    for (const count of [513, 17, 0, 513]) {
      input.count = count;
      building = true;
      grid.rebuild(renderer, input);
      building = false;
      for (const depth of [...grid.levels].reverse()) {
        const regions = grid.getRegions(depth);
        const attribute = new StorageBufferAttribute(new Float32Array(regions.capacity * 12 + 4), 4);
        const out = storage(attribute, 'vec4', attribute.count);
        const header = Fn(() => { out.element(regions.capacity * 3).assign(vec4(float(regions.count), 0, 0, 0)); })()
          .compute(1);
        const read = grid.computeRegions(depth, region => {
          const aggregate = grid.getAggregate(region);
          const bounds = grid.getBounds(region);
          const children = grid.getChildren(region);
          const childTotal = uint(0).toVar();
          Loop({ start: uint(0), end: children.count, type: 'uint', condition: '<' }, ({ i }) => {
            childTotal.addAssign(grid.getAggregate(children.region(i)).count);
          });
          out.element(instanceIndex.mul(3)).assign(vec4(bounds.min, float(aggregate.count)));
          out.element(instanceIndex.mul(3).add(1)).assign(vec4(aggregate.sum, aggregate.value));
          out.element(instanceIndex.mul(3).add(2)).assign(vec4(float(aggregate.balance),
            float(children.count), depth === 3 ? float(grid.getParticleIndices(region).count) : 0, float(childTotal)));
        });
        renderer.compute([header, read]);
        const values = new Float32Array(await renderer.getArrayBufferAsync(attribute));
        const actualCount = values[regions.capacity * 12];
        const expected = new Map();
        particles.slice(0, count).forEach((p, i) => {
          const coordinate = grid.locate(p.position, depth);
          const key = coordinate.toArray().join(',');
          const a = expected.get(key) ?? { count: 0, sum: new Vector3(), value: 0, balance: 0 };
          a.count++; a.sum.add(p.position); a.value += p.position.x ** 2; a.balance += i % 2 ? 1 : -1;
          expected.set(key, a);
        });
        check(actualCount === expected.size, `Occupied count at ${depth}: ${actualCount}/${expected.size}`);
        for (let i = 0; i < actualCount; i++) {
          const key = [0, 1, 2].map(axis => Math.round((values[i * 12 + axis] + 0.5) * 2 ** depth)).join(',');
          const a = expected.get(key);
          check(a && values[i * 12 + 3] === a.count,
            `Cell count at ${depth}/${key}: ${values[i * 12 + 3]}/${a?.count}; members=${values[i * 12 + 10]}`);
          const mean = a.sum.divideScalar(a.count);
          check(mean.distanceTo(new Vector3().fromArray(values, i * 12 + 4)) < 1e-5, 'Raw sums survive finalization');
          check(Math.abs(values[i * 12 + 7] - a.value / a.count) < 1e-5, 'Arbitrary float channel');
          check(values[i * 12 + 8] === a.balance, 'Signed integer channel');
          if (depth === 3) check(values[i * 12 + 9] === 0, 'Finest regions have no children');
          else check(values[i * 12 + 11] === a.count, 'Next maintained children cover their parent exactly');
        }
        results.push({ count, depth, cells: actualCount });
        header.dispose(); read.dispose(); renderer.backend.destroyAttribute(attribute);
      }
    }
    for (const preset of [SpatialLevels.None, SpatialLevels.Bricks, SpatialLevels.Cells, SpatialLevels.All]) {
      input.count = 17;
      const smoke = new ParticleSpatialGrid({ brickSubdivisions: 1, cellSubdivisions: 2,
        levels: preset, autoExpand: false }, aggregator);
      smoke.rebuild(renderer, input);
      const attribute = new StorageBufferAttribute(new Uint32Array(1), 1);
      const out = storage(attribute, 'uint', 1);
      const read = Fn(() => {
        const regions = smoke.getRegions(smoke.levels[0]);
        const total = uint(0).toVar();
        Loop({ start: uint(0), end: regions.count, type: 'uint', condition: '<' }, ({ i }) => {
          total.addAssign(smoke.getAggregate(regions.region(i)).count);
        });
        out.element(0).assign(total);
      })().compute(1);
      renderer.compute(read);
      check(new Uint32Array(await renderer.getArrayBufferAsync(attribute))[0] === 17, `Preset ${preset} coverage`);
      read.dispose(); smoke.dispose(renderer); renderer.backend.destroyAttribute(attribute);
    }
    const plain = new ParticleSpatialGrid();
    plain.rebuild(renderer, input);
    check(plain.regions === undefined, 'Default grid users allocate no region directories or aggregate buffers');
    plain.dispose(renderer);
    const explicit = new ParticleSpatialGrid({ levels: [], autoExpand: false });
    explicit.rebuild(renderer, input);
    check(explicit.getRegions(explicit.maxDepth).capacity > 0, 'Explicit finest-only levels expose occupied regions');
    explicit.dispose(renderer);
    let skipped = false;
    try { grid.getRegions(1); } catch (error) { skipped = error instanceof RangeError; }
    check(skipped, 'A skipped level is not reported as an empty level');
    const large = await largeDirectory(renderer);
    check(errors.length === 0, errors.join('\n'));
    return { results, large };
  } finally { grid.dispose(renderer); input.dispose(renderer); renderer.dispose(); }
}
run().then(result => { window.spatialResult = result; }, error => {
  window.spatialResult = { error: error.stack ?? String(error) };
});
