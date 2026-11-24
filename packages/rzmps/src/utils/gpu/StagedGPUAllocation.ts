/** Resource-specific operations. Migration/swap run only at the consumer's safe frame boundary. */
export interface StagedGPUAllocationOptions<T> {
  create(capacity: number): T | Promise<T>;
  prepare(resources: T): Promise<void>;
  migrate(current: T, replacement: T): void;
  swap(replacement: T): void;
  /** Absorb newer logical layouts without canceling prepared capacity resources. */
  canCommit?(current: T, replacement: T): boolean;
  dispose(resources: T): void;
  /** Resolve when all previously submitted uses of resources have completed. */
  fence(): Promise<unknown>;
  maximumCapacity: number;
  /** Fraction of current capacity that starts preparation; defaults to the existing 75% reserve. */
  growthThreshold?(): number;
}

/** Prepare a separate geometric-capacity replacement while the current resource identity remains usable. */
export default class StagedGPUAllocation<T> {
  private generation = 0;
  private disposed = false;
  private pending?: { resources: T; capacity: number; ready: boolean };
  private preparing = false;
  private preparation: Promise<void> = Promise.resolve();
  private failure?: Error;
  private latestDemand = 0;
  private targetCapacity = 0;
  private supersedingCapacity = 0;
  private retiredResources = 0;
  /** Internal state for frame-level capacity diagnostics. */
  get status() {
    const state = this.preparing ? (this.targetCapacity ? 'preparing' : 'retiring') : this.pending ? 'ready' : 'idle';
    return { state, pendingCapacity: this.targetCapacity, requestedDemand: this.latestDemand,
      retiredResources: this.retiredResources };
  }
  get maximumCapacity(): number { return this.options.maximumCapacity; }
  readonly metrics = { requests: 0, preparationMs: 0, allocationMs: 0,
    migrationSubmissionMs: 0, swapMs: 0, superseded: 0, cancellations: 0 };

  constructor(
    public current: T,
    public capacity: number,
    private readonly options: StagedGPUAllocationOptions<T>,
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(options.maximumCapacity) ||
      options.maximumCapacity < capacity
    )
      throw new RangeError('Invalid staged allocation capacity limits.');
  }

  /** Demand may be predicted. Approaching a full pool begins preparation before visible overflow. */
  request(demand: number): void {
    if (!Number.isFinite(demand) || demand < 0)
      throw new RangeError('Allocation demand must be finite and nonnegative.');
    this.latestDemand = demand;
    const desired = Math.min(this.options.maximumCapacity,
      Math.max(this.capacity * 2, 2 ** Math.ceil(Math.log2(Math.max(1, demand)))));
    if ((this.preparing || this.pending) && desired > Math.max(this.targetCapacity, this.supersedingCapacity)) {
      this.metrics.superseded++;
      this.supersedingCapacity = desired;
    }
    const belowThreshold = this.options.growthThreshold
      ? demand <= this.capacity * this.options.growthThreshold() : demand < this.capacity * 0.75;
    if (this.disposed || this.preparing || this.pending || belowThreshold) return;
    if (this.capacity >= this.options.maximumCapacity) {
      if (demand > this.capacity)
        this.failure = new Error('GPU resource demand exceeds the device/configured ceiling.');
      return;
    }
    const capacity = Math.min(
      this.options.maximumCapacity,
      Math.max(this.capacity * 2, 2 ** Math.ceil(Math.log2(Math.max(1, demand)))),
    );
    this.targetCapacity = capacity;
    this.supersedingCapacity = 0;
    const generation = this.generation;
    this.preparing = true;
    this.metrics.requests++;
    // Yield a frame opportunity before CPU allocation. The callback can stage individual uploads further.
    this.preparation = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
      let resources: T | undefined;
      try {
        const start = performance.now();
        resources = await this.options.create(capacity);
        this.metrics.allocationMs = performance.now() - start;
        const prepareStart = performance.now();
        await this.options.prepare(resources);
        this.metrics.preparationMs = performance.now() - prepareStart;
        if (this.disposed || generation !== this.generation) {
          await this.release(resources);
        } else this.pending = { resources, capacity, ready: true };
      } catch (cause) {
        if (resources !== undefined) await this.release(resources);
        if (!this.disposed && generation === this.generation) {
          this.failure = cause instanceof Error ? cause : new Error(String(cause));
        }
      } finally {
        this.preparing = false;
      }
    });
  }

  /** Diagnostics/preparation may await readiness; the normal update loop never waits. */
  whenPrepared(): Promise<void> { return this.preparation; }

  /** Cancel a stale replacement while leaving current-resource ownership with the consumer. */
  cancelPending(): void {
    if (this.preparing || this.pending) this.metrics.cancellations++;
    this.generation++;
    this.targetCapacity = 0;
    if (this.pending) void this.release(this.pending.resources);
    this.pending = undefined;
  }

  /** Call only between simulation/render updates. GPU copies precede the swap in queue order. */
  commit(): boolean {
    if (this.failure) throw this.failure;
    const next = this.pending;
    if (!next?.ready || this.disposed) return false;
    if (this.options.canCommit && !this.options.canCommit(this.current, next.resources)) return false;
    const previous = this.current;
    const start = performance.now();
    this.options.migrate(previous, next.resources);
    this.metrics.migrationSubmissionMs = performance.now() - start;
    const swapStart = performance.now();
    this.options.swap(next.resources);
    this.current = next.resources;
    this.capacity = next.capacity;
    this.pending = undefined;
    this.targetCapacity = 0;
    this.metrics.swapMs = performance.now() - swapStart;
    void this.release(previous);
    // Finish useful work first; a newer demand starts the next tier without cancel/restart churn.
    const needsNextTier = this.options.growthThreshold
      ? this.latestDemand > this.capacity * this.options.growthThreshold() : this.latestDemand >= this.capacity * 0.75;
    if (needsNextTier) this.request(this.latestDemand);
    return true;
  }

  private async release(resources: T): Promise<void> {
    this.retiredResources++;
    try {
      await this.options.fence();
    } catch {
      /* Device loss still requires CPU/resource cleanup. */
    } finally {
      try { this.options.dispose(resources); } finally { this.retiredResources--; }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    void this.release(this.current);
    if (this.pending) void this.release(this.pending.resources);
    this.pending = undefined;
  }
}
