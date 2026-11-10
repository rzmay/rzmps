/** Collection is opt-in. Providers expose current values without retaining history. */

export type BenchmarkDomain = 'cpu' | 'gpu' | 'value';

export type BenchmarkAggregation = 'none' | 'sum' | 'max' | 'last';

export interface BenchmarkMetric {
  type: 'span' | 'gauge' | 'counter' | 'derived';
  unit?: string;
  domain?: BenchmarkDomain;
  aggregation?: BenchmarkAggregation;

  /** Renderer-wide measurements include the whole scene, not just a particle system. */
  scope?: 'component' | 'renderer';
  source?: string;

  /** Frame providers are automatic; manual metrics are sampled at an explicit boundary. */
  sampling?: 'frame' | 'manual';

  /** Reset a counter after each frame; otherwise its value is cumulative. */
  perFrame?: boolean;
  get?: () => number | null;
}

export interface BenchmarkCollectionOptions {
  warmupMs?: number;
  maxSamples?: number;

  /** Permit explicit GPU timestamp readbacks. Never substitutes CPU wait time. */
  gpuTiming?: boolean;
}

export interface BenchmarkDistribution extends Omit<BenchmarkMetric, 'get'> {
  value: number | null;
  count: number;
  totalCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  variance: number | null;
  sum: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  slowestOnePercentMean: number | null;
}

export interface BenchmarkReport {
  durationMs: number;
  warmupMs: number;
  metrics: Record<string, BenchmarkDistribution>;
}

export interface BenchmarkAssertion {
  metric: string;
  statistic: 'value' | 'mean' | 'min' | 'max' | 'p50' | 'p95' | 'p99' | 'sum' | 'variance' | 'count';
  min?: number;
  max?: number;
}

type Metric = BenchmarkMetric & { value: number | null; manual?: boolean };

type History = { metric: BenchmarkMetric; values: number[]; next: number; total: number };

type Session = {
  active: boolean;
  started: number;
  ended?: number;
  warmup: number;
  capacity: number;
  gpuTiming: boolean;
  history: Map<string, History>;
  pending: Map<string, { value: number; metric: BenchmarkMetric }>;
};

let identity = 0;

/** Component-owned metrics with one bounded history per attached collection tree. */
export default class Benchmarks {
  readonly id = ++identity;

  private readonly metrics = new Map<string, Metric>();
  private readonly children = new Map<string, Benchmarks>();
  private parent?: { owner: Benchmarks; name: string };
  private session?: Session;
  private readonly reading = new Set<string>();
  private timestampsPending = false;
  private readonly now: () => number;
  private readonly beforeSnapshot?: () => void;

  constructor(options: { now?: () => number; beforeSnapshot?: () => void } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.beforeSnapshot = options.beforeSnapshot;
  }

  get enabled(): boolean {
    return this.parent ? this.parent.owner.enabled : !!this.session?.active;
  }

  get gpuTimingEnabled(): boolean {
    return !!this.root().session?.gpuTiming && this.enabled;
  }

  register(name: string, options: BenchmarkMetric): this {
    if (!name || name.startsWith('/') || name.endsWith('/')) throw new Error('Benchmark metric needs a relative name');

    const previous = this.metrics.get(name);

    this.metrics.set(name, {
      domain: options.type === 'span' ? 'cpu' : 'value',
      aggregation: 'none',
      scope: 'component',
      sampling: 'frame',
      ...options,
      value: previous?.value ?? (options.type === 'counter' ? 0 : null),
    });

    return this;
  }

  has(name: string): boolean {
    return this.metrics.has(name);
  }

  set(name: string, value: number | null): void {
    this.metric(name, 'gauge').value = this.number(value);
  }

  increment(name: string, amount = 1): void {
    if (!Number.isFinite(amount)) throw new RangeError('Benchmark increments must be finite');

    const metric = this.metric(name, 'counter');

    metric.value = (metric.value ?? 0) + amount;
  }

  derive(name: string, dependencies: readonly string[], calculate: (values: Record<string, number>) => number): this {
    return this.register(name, {
      type: 'derived',
      get: () => {
        const values: Record<string, number> = {};

        for (const key of dependencies) {
          const value = this.current(key);

          if (value === null) return null;

          values[key] = value;
        }

        return calculate(values);
      },
    });
  }

  /** Attach once; stable instance IDs can be included in the caller's component path. */
  attach(name: string, child: Benchmarks): void {
    if (child === this || this.ancestors().includes(child)) throw new Error('Cyclic benchmark hierarchy');
    if (this.children.get(name) === child) return;
    if (this.children.has(name)) throw new Error(`Duplicate benchmark component: ${name}`);

    child.detach();
    child.session = undefined;
    this.children.set(name, child);
    child.parent = { owner: this, name };
  }

  detach(): void {
    this.parent?.owner.children.delete(this.parent.name);
    this.parent = undefined;
  }

  /** Reconcile a component category without disturbing other categories or histories. */
  reconcile(category: string, components: readonly { benchmarks: Benchmarks; constructor: { name: string } }[]): void {
    const expected = new Set(components.map(component => component.benchmarks));

    for (const [name, child] of this.children)
      if (name.startsWith(`${category}/`) && !expected.has(child)) child.detach();

    for (const component of components) {
      const child = component.benchmarks;

      // A shared component belongs to its first owner; snapshots must never steal its collector.
      if (!child.parent || child.parent.owner === this)
        this.attach(`${category}/${component.constructor.name}-${child.id}`, child);
    }
  }

  start(options: BenchmarkCollectionOptions = {}): this {
    if (this.parent) {
      this.root().start(options);
      return this;
    }

    const capacity = options.maxSamples ?? 4096;
    const warmup = options.warmupMs ?? 0;

    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(warmup) || warmup < 0)
      throw new RangeError('Benchmark collection needs positive maxSamples and nonnegative warmupMs');

    this.walk(owner => {
      for (const metric of owner.metrics.values()) {
        if (metric.type === 'span') metric.value = null;
        else if (metric.perFrame) metric.value = 0;
      }
    });

    this.session = {
      active: true,
      started: this.now(),
      warmup,
      capacity,
      gpuTiming: options.gpuTiming ?? false,
      history: new Map(),
      pending: new Map(),
    };

    return this;
  }

  stop(): BenchmarkReport {
    const root = this.root();
    root.flush();

    if (root.session?.active) {
      root.session.active = false;
      root.session.ended = root.now();
    }

    return this.report();
  }

  /** No clock reads or sample allocations while disabled. Exceptions still finish a span. */
  begin(name: string): (() => void) | undefined {
    if (!this.enabled) return undefined;

    const root = this.root();
    const session = root.session!;
    const started = root.now();

    if (started - session.started < session.warmup) return undefined;

    let finished = false;

    return () => {
      if (finished) return;

      finished = true;

      if (this.root() === root && root.session === session && session.active)
        this.record(name, root.now() - started, { type: 'span', unit: 'ms', domain: 'cpu', aggregation: 'none' });
    };
  }

  span<T>(name: string, callback: () => T): T {
    if (!this.enabled) return callback();

    const end = this.begin(name);

    try {
      return callback();
    } finally {
      end?.();
    }
  }

  async spanAsync<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const end = this.begin(name);

    try {
      return await callback();
    } finally {
      end?.();
    }
  }

  /** Explicit samples, including genuine GPU timestamps supplied by a backend. */
  record(name: string, value: number, options?: BenchmarkMetric): void {
    if (!this.enabled) return;
    if (!Number.isFinite(value)) throw new RangeError('Benchmark samples must be finite');
    if (!this.metrics.has(name)) this.register(name, options ?? { type: 'span', unit: 'ms', domain: 'cpu' });

    const metric = this.metrics.get(name)!;
    metric.value = value;
    metric.manual = true;

    const root = this.root();
    const session = root.session!;

    if (root.now() - session.started < session.warmup) return;

    const path = this.path(name);

    if (metric.aggregation !== 'none') {
      const pending = session.pending.get(path);
      const next =
        !pending || metric.aggregation === 'last'
          ? value
          : metric.aggregation === 'sum'
            ? pending.value + value
            : Math.max(pending.value, value);

      session.pending.set(path, { value: next, metric });
    } else root.append(path, value, metric);
  }

  /** Sample providers/gauges/counters once at an application's frame boundary. */
  frame(): void {
    if (!this.enabled) return;

    const reset: Metric[] = [];

    this.walk((owner, prefix) => {
      for (const [name, metric] of owner.metrics) {
        if (!metric.manual && metric.sampling !== 'manual' && metric.type !== 'span') {
          const value = owner.current(name);

          if (value !== null && this.root().now() - this.root().session!.started >= this.root().session!.warmup)
            this.root().append(`${prefix}${name}`, value, metric);
        }

        if (metric.perFrame) reset.push(metric);
      }
    }, this.path(''));

    for (const metric of reset) metric.value = 0;

    this.root().flush();
  }

  /** Call after rendering. Timings cover the renderer's timestamp query pools, not individual modules. */
  async resolveGPU(renderer: {
    info?: object;
    backend?: object;
    hasFeature?: (name: string) => boolean;
    resolveTimestampsAsync?: (type: 'compute' | 'render') => Promise<number | void>;
  }): Promise<void> {
    const names = { compute: 'renderer/gpuComputeTime', render: 'renderer/gpuRenderTime' };

    for (const type of ['compute', 'render'] as const)
      if (!this.metrics.has(names[type]))
        this.register(names[type], {
          type: 'span',
          unit: 'ms',
          domain: 'gpu',
          scope: 'renderer',
          source: `renderer.resolveTimestampsAsync(${type})`,
        });

    if (!this.gpuTimingEnabled || this.timestampsPending) return;

    if (
      (renderer.hasFeature && !renderer.hasFeature('timestamp-query')) ||
      !(renderer.backend as { trackTimestamp?: boolean } | undefined)?.trackTimestamp ||
      !renderer.resolveTimestampsAsync
    ) {
      for (const name of Object.values(names)) this.metrics.get(name)!.value = null;

      return;
    }

    if (!this.metrics.has('renderer/timestampReadbackTime'))
      this.register('renderer/timestampReadbackTime', {
        type: 'span',
        unit: 'ms',
        domain: 'cpu',
        scope: 'renderer',
        source: 'performance.now around timestamp resolution (includes synchronization)',
      });

    const session = this.root().session;
    this.timestampsPending = true;
    const end = this.begin('renderer/timestampReadbackTime');

    try {
      for (const type of ['compute', 'render'] as const) {
        const value = await renderer.resolveTimestampsAsync(type);

        if (this.root().session === session && typeof value === 'number' && Number.isFinite(value))
          this.record(names[type], value);
        else if (this.root().session === session) this.metrics.get(names[type])!.value = null;
      }
    } finally {
      end?.();
      this.timestampsPending = false;
    }
  }

  snapshot(names?: readonly string[]): Record<string, number | null> {
    if (names) return Object.fromEntries(names.map(name => [name, this.readPath(name)]));

    const values: Record<string, number | null> = {};

    this.walk((owner, prefix) => {
      for (const name of owner.metrics.keys()) values[`${prefix}${name}`] = owner.current(name);
    });

    return values;
  }

  report(): BenchmarkReport {
    const root = this.root(),
      session = root.session;
    const snapshot = this.snapshot();
    const metrics: Record<string, BenchmarkDistribution> = {};
    const prefix = this.path('');

    for (const [name, value] of Object.entries(snapshot)) {
      const metric = this.definition(name);
      metrics[name] = this.distribution(metric!, value, session?.history.get(`${prefix}${name}`));
    }

    // Detached/disposed components stop contributing live values, but their collected history remains reviewable.
    for (const [name, history] of session?.history ?? []) {
      if (!name.startsWith(prefix)) continue;

      const local = name.slice(prefix.length);
      metrics[local] ??= this.distribution(history.metric, null, history);
    }

    return {
      durationMs: session ? (session.ended ?? root.now()) - session.started : 0,
      warmupMs: session?.warmup ?? 0,
      metrics,
    };
  }

  assert(assertions: readonly BenchmarkAssertion[]): void {
    const report = this.report();

    for (const assertion of assertions) {
      const value = report.metrics[assertion.metric]?.[assertion.statistic];

      if (
        value === null ||
        value === undefined ||
        (assertion.min !== undefined && value < assertion.min) ||
        (assertion.max !== undefined && value > assertion.max)
      )
        throw new Error(`Benchmark assertion failed: ${assertion.metric}/${assertion.statistic} = ${value}`);
    }
  }

  dispose(): void {
    this.detach();
    for (const child of [...this.children.values()]) child.detach();

    this.session = undefined;
    this.metrics.clear();
  }

  private metric(name: string, type: BenchmarkMetric['type']): Metric {
    if (!this.metrics.has(name)) this.register(name, { type });

    return this.metrics.get(name)!;
  }

  private number(value: number | null): number | null {
    return value !== null && Number.isFinite(value) ? value : null;
  }

  private root(): Benchmarks {
    return this.parent?.owner.root() ?? this;
  }

  private ancestors(): Benchmarks[] {
    return [this, ...(this.parent?.owner.ancestors() ?? [])];
  }

  private path(name: string): string {
    return this.parent ? this.parent.owner.path(`${this.parent.name}/${name}`) : name;
  }

  private current(name: string): number | null {
    if (this.reading.has(name)) throw new Error(`Cyclic benchmark metric: ${name}`);

    const metric = this.metrics.get(name);

    if (!metric) return null;

    this.reading.add(name);

    try {
      return this.number(metric.get ? metric.get() : metric.value);
    } finally {
      this.reading.delete(name);
    }
  }

  private walk(visit: (owner: Benchmarks, prefix: string) => void, prefix = ''): void {
    this.beforeSnapshot?.();
    visit(this, prefix);

    for (const [name, child] of this.children) child.walk(visit, `${prefix}${name}/`);
  }

  private readPath(path: string): number | null {
    if (this.metrics.has(path)) return this.current(path);

    for (const [name, child] of this.children)
      if (path.startsWith(`${name}/`)) return child.readPath(path.slice(name.length + 1));

    return null;
  }

  private definition(path: string): Metric | undefined {
    if (this.metrics.has(path)) return this.metrics.get(path);

    for (const [name, child] of this.children)
      if (path.startsWith(`${name}/`)) return child.definition(path.slice(name.length + 1));

    return undefined;
  }

  private append(name: string, value: number, metric: BenchmarkMetric): void {
    const session = this.session!;
    let history = session.history.get(name);

    if (!history) {
      const metadata = {
        type: metric.type,
        unit: metric.unit,
        domain: metric.domain,
        aggregation: metric.aggregation,
        perFrame: metric.perFrame,
        scope: metric.scope,
        source: metric.source,
        sampling: metric.sampling,
      };

      history = { metric: metadata, values: [], next: 0, total: 0 };
      session.history.set(name, history);
    }

    if (history.values.length < session.capacity) history.values.push(value);
    else {
      history.values[history.next] = value;
      history.next = (history.next + 1) % session.capacity;
    }

    history.total++;
  }

  private flush(): void {
    const root = this.root();

    for (const [name, pending] of root.session?.pending ?? []) root.append(name, pending.value, pending.metric);

    root.session?.pending.clear();
  }

  private distribution(metric: BenchmarkMetric, value: number | null, history?: History): BenchmarkDistribution {
    const sorted = [...(history?.values ?? [])].sort((a, b) => a - b);
    const count = sorted.length,
      sum = sorted.reduce((total, sample) => total + sample, 0);
    const mean = count ? sum / count : null;
    const percentile = (p: number) => (count ? sorted[Math.min(count - 1, Math.floor(count * p))] : null);
    const tail = sorted.slice(-Math.max(1, Math.ceil(count * 0.01)));
    const metadata = metric;

    return {
      type: metadata.type,
      unit: metadata.unit,
      domain: metadata.domain,
      aggregation: metadata.aggregation,
      perFrame: metadata.perFrame,
      scope: metadata.scope,
      source: metadata.source,
      sampling: metadata.sampling,
      value,
      count,
      totalCount: history?.total ?? 0,
      min: sorted[0] ?? null,
      max: sorted[count - 1] ?? null,
      sum,
      mean,
      variance: mean === null ? null : sorted.reduce((total, sample) => total + (sample - mean) ** 2, 0) / count,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      slowestOnePercentMean: count ? tail.reduce((total, sample) => total + sample, 0) / tail.length : null,
    };
  }
}
