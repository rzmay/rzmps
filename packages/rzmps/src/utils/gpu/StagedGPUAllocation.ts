/** Resource-specific operations. Migration/swap run only at the consumer's safe frame boundary. */
export interface StagedGPUAllocationOptions<T> {
  create(capacity: number): T | Promise<T>;
  prepare(resources: T): Promise<void>;
  migrate(current: T, replacement: T): void;
  swap(replacement: T): void;
  dispose(resources: T): void;
  /** Resolve when all previously submitted uses of resources have completed. */
  fence(): Promise<unknown>;
  maximumCapacity: number;
}

/** Prepare a separate geometric-capacity replacement while the current resource identity remains usable. */
export default class StagedGPUAllocation<T> {
  private generation = 0;
  private disposed = false;
  private pending?: { resources: T; capacity: number; ready: boolean };
  private preparing = false;
  private preparation: Promise<void> = Promise.resolve();
  private failure?: Error;
  readonly metrics = { requests: 0, preparationMs: 0, allocationMs: 0, migrationSubmissionMs: 0, swapMs: 0 };

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
    if (this.disposed || this.preparing || this.pending || demand < this.capacity * 0.75) return;
    if (this.capacity >= this.options.maximumCapacity) {
      if (demand > this.capacity)
        this.failure = new Error('GPU resource demand exceeds the device/configured ceiling.');
      return;
    }
    const capacity = Math.min(
      this.options.maximumCapacity,
      Math.max(this.capacity * 2, 2 ** Math.ceil(Math.log2(Math.max(1, demand)))),
    );
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
    this.generation++;
    if (this.pending) void this.release(this.pending.resources);
    this.pending = undefined;
  }

  /** Call only between simulation/render updates. GPU copies precede the swap in queue order. */
  commit(): boolean {
    if (this.failure) throw this.failure;
    const next = this.pending;
    if (!next?.ready || this.disposed) return false;
    const previous = this.current;
    const start = performance.now();
    this.options.migrate(previous, next.resources);
    this.metrics.migrationSubmissionMs = performance.now() - start;
    const swapStart = performance.now();
    this.options.swap(next.resources);
    this.current = next.resources;
    this.capacity = next.capacity;
    this.pending = undefined;
    this.metrics.swapMs = performance.now() - swapStart;
    void this.release(previous);
    return true;
  }

  private async release(resources: T): Promise<void> {
    try {
      await this.options.fence();
    } catch {
      /* Device loss still requires CPU/resource cleanup. */
    } finally {
      this.options.dispose(resources);
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
