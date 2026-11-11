import type Benchmarks from '../core/Benchmarks';

/** Shared public renderer.info fields, supported by Three.js's classic and common renderers. */
export interface BenchmarkRenderer {
  info: {
    autoReset: boolean;
    render: { calls: number; drawCalls?: number };
    compute?: { calls: number };
    memory: { geometries: number; textures: number; total?: number };
  };
}

const providers = {
  geometryCount: {
    unit: 'count',
    source: 'renderer.info.memory.geometries',
    get: (renderer: BenchmarkRenderer) => renderer.info.memory.geometries,
  },
  textureCount: {
    unit: 'count',
    source: 'renderer.info.memory.textures',
    get: (renderer: BenchmarkRenderer) => renderer.info.memory.textures,
  },
  allocatedBytes: {
    unit: 'bytes',
    source: 'renderer.info.memory.total',
    get: (renderer: BenchmarkRenderer) => renderer.info.memory.total ?? null,
  },
  dispatchCount: {
    unit: 'count',
    source: 'renderer.info.compute.calls (renderer lifetime)',
    get: (renderer: BenchmarkRenderer) => renderer.info.compute?.calls ?? null,
  },
};

/** @internal Register once, with a getter so renderer replacements do not leave stale providers. */
export function registerRendererBenchmarks(
  benchmarks: Benchmarks,
  getRenderer: () => BenchmarkRenderer | undefined,
): void {
  for (const [name, provider] of Object.entries(providers))
    benchmarks.register(`renderer/${name}`, {
      type: name === 'dispatchCount' ? 'counter' : 'gauge',
      unit: provider.unit,
      scope: 'renderer',
      sampling: 'manual',
      source: provider.source,
      get: () => {
        const renderer = getRenderer();
        return renderer ? provider.get(renderer) : null;
      },
    });
  benchmarks.register('renderer/drawCount', {
    type: 'gauge',
    unit: 'count',
    scope: 'renderer',
    sampling: 'manual',
    source: 'renderer.info render draw-call delta across the profiled render callback',
  });
  for (const name of ['cpuRenderTime', 'frameTime', 'timestampReadbackTime'])
    benchmarks.register(`renderer/${name}`, {
      type: 'span',
      unit: 'ms',
      domain: 'cpu',
      scope: 'renderer',
      source:
        name === 'frameTime'
          ? 'application frame interval'
          : name === 'timestampReadbackTime'
            ? 'CPU wait for renderer.resolveTimestampsAsync'
            : 'performance.now around render callback',
    });
  for (const type of ['Compute', 'Render'])
    benchmarks.register(`renderer/gpu${type}Time`, {
      type: 'span',
      unit: 'ms',
      domain: 'gpu',
      scope: 'renderer',
      source: `renderer.resolveTimestampsAsync(${type.toLowerCase()})`,
    });
}

/**
 * Wrap one normal scene render. Counts describe the whole callback, including unrelated scene objects.
 * Does not reset renderer.info, change autoReset, wait for the GPU, or initiate timestamp readbacks.
 * Pass the application's wall-clock frame interval separately from its simulation timestep.
 */
export function profileRenderer<T>(
  benchmarks: Benchmarks | undefined,
  renderer: BenchmarkRenderer,
  render: () => T,
  frameTimeMs?: number,
): T {
  if (!benchmarks) return render();
  if (!benchmarks.has('renderer/cpuRenderTime')) registerRendererBenchmarks(benchmarks, () => renderer);
  const common = renderer.info.render.drawCalls !== undefined;
  const before = common ? renderer.info.render.drawCalls! : renderer.info.render.calls;
  const end = benchmarks.begin('renderer/cpuRenderTime');
  let result: T;
  try {
    result = render();
  } finally {
    end?.();
  }
  const after = common ? renderer.info.render.drawCalls! : renderer.info.render.calls;
  const draws = !common && renderer.info.autoReset ? after : Math.max(0, after - before);
  benchmarks.set('renderer/drawCount', draws);
  if (frameTimeMs !== undefined && Number.isFinite(frameTimeMs) && frameTimeMs >= 0)
    benchmarks.set('renderer/frameTime', frameTimeMs);
  if (!benchmarks.enabled) return result;
  benchmarks.record('renderer/drawCount', draws);
  for (const [name, provider] of Object.entries(providers)) {
    const value = provider.get(renderer);
    if (value !== null) benchmarks.record(`renderer/${name}`, value);
  }
  if (frameTimeMs !== undefined && Number.isFinite(frameTimeMs) && frameTimeMs >= 0)
    benchmarks.record('renderer/frameTime', frameTimeMs);
  return result;
}
