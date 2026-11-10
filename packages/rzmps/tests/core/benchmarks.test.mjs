import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Benchmarks,
  profileRenderer,
  Emitter,
  Module,
  Particle,
  ParticleSystem,
  ThreeGPUCollisionBackend,
} from '../../build/index.mjs';

function clock() {
  let time = 0,
    reads = 0;
  return {
    b: new Benchmarks({
      now: () => {
        reads++;
        return time;
      },
    }),
    tick: value => {
      time += value;
    },
    reads: () => reads,
  };
}

test('disabled collection avoids clocks and retains live providers, results and exceptions', () => {
  const { b, reads } = clock();
  let allocated = 10;
  b.register('allocated', { type: 'gauge', unit: 'bytes', get: () => allocated });
  b.set('used', 2);
  b.derive('ratio', ['used', 'allocated'], ({ used, allocated }) => used / allocated);
  assert.equal(
    b.span('work', () => 42),
    42,
  );
  assert.throws(
    () =>
      b.span('error', () => {
        throw Error('original');
      }),
    /original/,
  );
  b.record('ignored', 5);
  b.frame();
  assert.equal(reads(), 0);
  assert.deepEqual(b.snapshot(), { allocated: 10, used: 2, ratio: 0.2 });
  allocated = 20;
  assert.deepEqual(b.snapshot(['ratio', 'missing']), { ratio: 0.1, missing: null });
  assert.equal(b.report().metrics.allocated.count, 0);
});

test('warmup, bounded retention, distributions, idempotent endings and stopped collections', () => {
  const { b, tick } = clock();
  b.start({ warmupMs: 10, maxSamples: 3 });
  b.record('work', 100);
  tick(10);
  for (const value of [1, 2, 3, 4]) b.record('work', value);
  const end = b.begin('timed');
  tick(7);
  end();
  end();
  const report = b.stop(),
    m = report.metrics.work;
  for (const [name, value] of Object.entries({
    count: 3,
    totalCount: 4,
    min: 2,
    max: 4,
    mean: 3,
    sum: 9,
    p50: 3,
    p95: 4,
    p99: 4,
    variance: 2 / 3,
    slowestOnePercentMean: 4,
  }))
    assert.equal(m[name], value, name);
  assert.equal(report.metrics.timed.mean, 7);
  assert.equal(report.metrics.timed.count, 1);
  b.record('work', 999);
  tick(100);
  assert.equal(b.report().durationMs, 17);
  assert.throws(() => b.start({ maxSamples: 0 }), /positive/);
  assert.throws(() => b.start({ warmupMs: -1 }), /nonnegative/);
});

test('frame aggregation is explicit; per-frame and cumulative counters differ', () => {
  const { b } = clock();
  for (const aggregation of ['sum', 'max', 'last', 'none'])
    b.register(aggregation, { type: 'span', unit: 'ms', aggregation });
  b.register('births', { type: 'counter', perFrame: true });
  b.register('total', { type: 'counter' });
  b.derive('twiceBirths', ['births'], ({ births }) => births * 2);
  b.start();
  b.increment('births', 3);
  b.increment('total', 3);
  b.set('population', 9);
  for (const value of [5, 2]) for (const name of ['sum', 'max', 'last', 'none']) b.record(name, value);
  b.frame();
  b.frame();
  const { metrics: m } = b.stop();
  assert.equal(m.sum.mean, 7);
  assert.equal(m.max.mean, 5);
  assert.equal(m.last.mean, 2);
  assert.equal(m.none.count, 2, 'overlapping durations are not automatically added');
  assert.equal(m.twiceBirths.sum, 6, 'derived providers read counters before frame reset');
  assert.equal(m.births.sum, 3);
  assert.equal(m.total.mean, 3);
  assert.equal(m.population.count, 2);
});

test('stable scopes share collection, do not steal shared owners, and detach without losing history', () => {
  const { b, tick } = clock();
  const first = new Module(() => {}),
    second = new Module(() => {});
  b.reconcile('modules', [first, second]);
  b.start();
  const end = first.benchmarks.begin('pressure');
  tick(3);
  end();
  second.benchmarks.record('pressure', 8);
  const a = `modules/Module-${first.benchmarks.id}/pressure`;
  const c = `modules/Module-${second.benchmarks.id}/pressure`;
  assert.equal(b.report().metrics[a].mean, 3);
  assert.equal(b.report().metrics[c].mean, 8);
  assert.equal(first.benchmarks.report().metrics.pressure.count, 1);
  const other = new Benchmarks();
  other.reconcile('modules', [first]);
  assert.deepEqual(other.snapshot(), {});
  b.reconcile('modules', [second]);
  assert.equal(first.benchmarks.enabled, false);
  assert.equal(b.snapshot()[a], undefined);
  assert.equal(b.report().metrics[a].value, null);
  assert.equal(b.report().metrics[a].count, 1);
  first.benchmarks.start();
  first.benchmarks.record('pressure', 20);
  assert.equal(first.benchmarks.stop().metrics.pressure.mean, 20);
  assert.equal(b.report().metrics[a].mean, 3);
  second.dispose();
  assert.equal(b.snapshot()[c], undefined);
  assert.throws(() => b.attach('cycle', b), /Cyclic/);
  b.attach('child', other);
  assert.throws(() => other.attach('cycle', b), /Cyclic/);
});

test('derived metrics and arbitrary correctness assertions handle missing values and cycles', () => {
  const b = new Benchmarks();
  b.derive('unavailable', ['missing'], () => 9);
  assert.equal(b.snapshot().unavailable, null);
  b.start();
  b.record('residual', 0.02, { type: 'gauge' });
  b.assert([{ metric: 'residual', statistic: 'max', max: 0.03 }]);
  assert.throws(() => b.assert([{ metric: 'residual', statistic: 'max', max: 0.01 }]), /assertion/);
  assert.throws(() => b.assert([{ metric: 'missing', statistic: 'mean', max: 1 }]), /assertion/);
  b.derive('a', ['b'], ({ b }) => b);
  b.derive('b', ['a'], ({ a }) => a);
  assert.throws(() => b.snapshot(), /Cyclic/);
});

test('async failures preserve errors; stale spans cannot land in a restarted session', async () => {
  const { b, tick } = clock();
  b.start();
  await assert.rejects(
    b.spanAsync('async', async () => {
      tick(5);
      throw Error('original');
    }),
    /original/,
  );
  assert.equal(b.report().metrics.async.mean, 5);
  const end = b.begin('stale');
  b.start();
  tick(10);
  end();
  assert.equal(b.report().metrics.stale, undefined);
});

test('GPU timings require opt-in and actual supported timestamps', async () => {
  const b = new Benchmarks();
  let reads = 0;
  const renderer = {
    backend: { trackTimestamp: true },
    resolveTimestampsAsync: async type => {
      reads++;
      return type === 'compute' ? 1.5 : 2.5;
    },
  };
  b.start();
  await b.resolveGPU(renderer);
  assert.equal(reads, 0);
  assert.equal(b.snapshot()['renderer/gpuComputeTime'], null);
  b.start({ gpuTiming: true });
  await b.resolveGPU({ backend: { trackTimestamp: false } });
  assert.equal(reads, 0);
  await b.resolveGPU(renderer);
  assert.equal(reads, 2);
  const { metrics: m } = b.stop();
  assert.equal(m['renderer/gpuComputeTime'].mean, 1.5);
  assert.equal(m['renderer/gpuRenderTime'].mean, 2.5);
  assert.equal(m['renderer/gpuComputeTime'].domain, 'gpu');
  assert.equal(m['renderer/gpuComputeTime'].unit, 'ms');
});

test('systems collect component scopes and retain available providers while disabled', () => {
  const module = new Module((_p, dt, { module }) => module.benchmarks.set('residual', dt));
  const emitter = new Emitter({ rate: 0 });
  const system = new ParticleSystem({
    emitters: [emitter],
    modules: [module],
    renderers: [],
    gpuProcessing: false,
    duration: 100,
  });
  system.particles.push(new Particle({ lifetime: 10 }));
  try {
    assert.equal(system.benchmarks.enabled, false);
    assert.equal(system.benchmarks.snapshot()['system/particleCount'], 1);
    assert.equal(system.benchmarks.snapshot()['system/moduleCount'], 1);
    assert.equal(system.benchmarks.snapshot()['renderer/gpuComputeTime'], null);
    system.benchmarks.start();
    system.advanceFrames(1, 1 / 60);
    const prefix = `modules/Module-${module.benchmarks.id}`,
      report = system.benchmarks.report();
    assert.equal(report.metrics['system/update'].count, 1);
    assert.equal(report.metrics[`${prefix}/update`].count, 1);
    assert.equal(report.metrics[`${prefix}/residual`].mean, 1 / 60);
    system.modules = [];
    system.benchmarks.snapshot();
    assert.equal(module.benchmarks.enabled, false);
    assert.equal(system.benchmarks.report().metrics[`${prefix}/update`].value, null);
  } finally {
    system.destroy();
  }
  assert.deepEqual(system.benchmarks.snapshot(), {});
  assert.equal(emitter.benchmarks.enabled, false);
  const backend = new ThreeGPUCollisionBackend();
  assert.equal(backend.benchmarks.snapshot().uploadBytes, 0);
  backend.destroy();
});

test('repeated stop is stable, new sessions clear old timings, and detached spans cannot leak', () => {
  const { b, tick } = clock();
  const child = new Benchmarks();
  b.attach('child', child);
  b.start();
  child.record('work', 7);
  const end = child.begin('late');
  child.detach();
  child.start();
  tick(4);
  end();
  assert.equal(child.report().metrics.late, undefined);
  b.stop();
  tick(10);
  assert.equal(b.stop().durationMs, 4);
  child.record('work', 9);
  child.start();
  assert.equal(child.snapshot().work, null);
});

test('renderer profiling labels scene-wide statistics and samples after rendering without resetting info', () => {
  const { b, tick, reads } = clock();
  const renderer = { info: { autoReset: false, render: { calls: 100 }, memory: { geometries: 3, textures: 7 } } };
  const render = () => {
    renderer.info.render.calls += 4;
    return 'rendered';
  };
  assert.equal(profileRenderer(b, renderer, render, 16), 'rendered');
  assert.equal(reads(), 0, 'disabled render profiling does not read the clock');
  assert.equal(b.snapshot()['renderer/drawCount'], 4);
  assert.equal(b.snapshot()['renderer/geometryCount'], 3);
  assert.equal(b.snapshot()['renderer/allocatedBytes'], null);
  assert.equal(b.snapshot()['renderer/frameTime'], 16);
  b.start();
  b.frame();
  profileRenderer(
    b,
    renderer,
    () => {
      tick(2);
      render();
    },
    17,
  );
  b.frame();
  const { metrics: m } = b.stop();
  assert.equal(m['renderer/cpuRenderTime'].mean, 2);
  assert.equal(m['renderer/cpuRenderTime'].domain, 'cpu');
  assert.equal(m['renderer/drawCount'].count, 1, 'provider frames do not duplicate render-boundary samples');
  assert.equal(m['renderer/drawCount'].mean, 4);
  assert.equal(m['renderer/drawCount'].scope, 'renderer');
  assert.match(m['renderer/drawCount'].source, /renderer.info/);
  assert.equal(m['renderer/geometryCount'].count, 1);
  assert.equal(renderer.info.render.calls, 108, 'the collector never resets shared info');
  assert.equal(renderer.info.autoReset, false);
  assert.equal(m['renderer/frameTime'].mean, 17);
  renderer.info.autoReset = true;
  profileRenderer(b, renderer, () => {
    renderer.info.render.calls = 5;
  });
  assert.equal(b.snapshot()['renderer/drawCount'], 5, 'classic WebGL resets counts inside render');
});

test('common renderer draw calls are distinct from render calls and shared resources are not per-system totals', () => {
  const { b } = clock();
  const renderer = {
    info: {
      autoReset: true,
      render: { calls: 1000, drawCalls: 20 },
      compute: { calls: 80 },
      memory: { geometries: 3, textures: 7, total: 1024 },
    },
  };
  b.start();
  profileRenderer(b, renderer, () => {
    renderer.info.render.calls++;
    renderer.info.render.drawCalls += 6;
  });
  const { metrics: m } = b.stop();
  assert.equal(m['renderer/drawCount'].mean, 6);
  assert.equal(m['renderer/dispatchCount'].value, 80);
  assert.equal(m['renderer/dispatchCount'].scope, 'renderer');
  assert.equal(m['renderer/allocatedBytes'].value, 1024);
  assert.equal(m['renderer/allocatedBytes'].aggregation, 'none');
  assert.equal(m['renderer/frameTime'].count, 0, 'no frame duration is invented when none was supplied');
});

test('GPU execution and timestamp resolution waits remain distinct, including common WebGL fallback', async () => {
  const { b, tick } = clock();
  let reads = 0;
  const renderer = {
    backend: { trackTimestamp: true },
    hasFeature: name => name === 'timestamp-query',
    resolveTimestampsAsync: async type => {
      reads++;
      tick(50);
      return type === 'render' ? 2.5 : undefined;
    },
  };
  b.start({ gpuTiming: true });
  await Promise.all([b.resolveGPU(renderer), b.resolveGPU(renderer)]);
  assert.equal(reads, 2, 'overlapping timestamp resolutions are coalesced');
  const { metrics: m } = b.report();
  assert.equal(m['renderer/gpuComputeTime'].value, null);
  assert.equal(m['renderer/gpuRenderTime'].mean, 2.5);
  assert.equal(m['renderer/gpuRenderTime'].domain, 'gpu');
  assert.equal(m['renderer/timestampReadbackTime'].mean, 100);
  assert.equal(m['renderer/timestampReadbackTime'].domain, 'cpu');
  await b.resolveGPU({ ...renderer, hasFeature: () => false });
  assert.equal(reads, 2);
  assert.equal(b.snapshot()['renderer/gpuRenderTime'], null, 'a backend change cannot leave stale timings');
  assert.equal(b.report().metrics['renderer/gpuRenderTime'].count, 1);
});
