import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { atomicAdd, atomicLoad, atomicStore, If, storage, uint } from 'three/tsl';
import type { GPUParticleLike, GPUReadbackRenderer, GPUStorageBufferRenderer } from './Particle';

type PackedAtomicUintStorage = { element(index: Node | number): Node<'uint'> };

const GPU_ALLOCATION_COUNTER_COUNT = 10;

enum AllocationCounter {
  AllocationAttempts,
  AllocationSuccesses,
  AllocationFailures,
  RecycledDeaths,
  StartingActiveCount,
  Capacity,
  CullingMode,
  Sequence,
  EmissionRunClaims,
  ActiveCount,
}

export interface GPUAllocationDiagnostics {
  sequence: number;
  capacity: number;
  cullingMode: number;
  allocationAttempts: number;
  allocationSuccesses: number;
  allocationFailures: number;
  recycledDeaths: number;
  startingActiveCount: number;
  estimatedActiveCount: number;
  activeCount: number;
}

export class GPUAllocationWriter {
  private readonly counterStorage: PackedAtomicUintStorage;
  private readonly occupancyStorage: PackedAtomicUintStorage;

  constructor(private readonly state: GPUAllocationBufferState) {
    this.counterStorage = storage(
      state.counterAttribute,
      'uint',
      GPU_ALLOCATION_COUNTER_COUNT,
    ).toAtomic() as PackedAtomicUintStorage;
    this.occupancyStorage = storage(
      state.occupancyAttribute,
      'uint',
      state.capacity * 4,
    ).toAtomic() as PackedAtomicUintStorage;
  }

  recordAllocationAttempt(): void {
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.AllocationAttempts)), uint(1));
  }

  recordAllocationSuccess(): void {
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.AllocationSuccesses)), uint(1));
  }

  recordAllocationFailure(): void {
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.AllocationFailures)), uint(1));
  }

  recordAllocationFailures(count: Node<'uint'>): void {
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.AllocationFailures)), count);
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.AllocationAttempts)), count);
  }

  recordRecycledDeath(): void {
    atomicAdd(this.counterStorage.element(uint(AllocationCounter.RecycledDeaths)), uint(1));
  }

  resetEmissionRunClaims(): void {
    atomicStore(this.counterStorage.element(uint(AllocationCounter.EmissionRunClaims)), uint(0));
  }

  claimEmissionRun(): Node<'uint'> {
    return atomicAdd(this.counterStorage.element(uint(AllocationCounter.EmissionRunClaims)), uint(1));
  }

  recordActive(particle: GPUParticleLike): void {
    If(particle.alive.notEqual(uint(0)), () => {
      atomicAdd(this.counterStorage.element(uint(AllocationCounter.ActiveCount)), uint(1));
    });
  }

  claimDeadSlot(particle: GPUParticleLike, initialize: () => void): void {
    If(particle.alive.equal(uint(0)), () => {
      this.recordAllocationAttempt();
      particle.generation.assign(particle.generation.add(uint(1)));
      initialize();
      particle.alive.assign(uint(1));
      this.recordAllocationSuccess();
    });
  }

  claimDeadSlotWithinBudget(
    particle: GPUParticleLike,
    maxAllocations: Node<'uint'> | number,
    initialize: () => void,
  ): void {
    const maxAllocationNode = typeof maxAllocations === 'number'
      ? uint(maxAllocations)
      : maxAllocations;

    If(particle.alive.equal(uint(0)), () => {
      const attempt = atomicAdd(
        this.counterStorage.element(uint(AllocationCounter.AllocationAttempts)),
        uint(1),
      ).toVar('allocationAttemptIndex');

      If(attempt.lessThan(maxAllocationNode), () => {
        particle.generation.assign(particle.generation.add(uint(1)));
        initialize();
        particle.alive.assign(uint(1));
        this.recordAllocationSuccess();
      }).Else(() => {
        this.recordAllocationFailure();
      });
    });
  }

  claimDeadSlotForEmitter(
    particle: GPUParticleLike,
    requestCount: Node<'uint'>,
    claimRequest: () => Node<'uint'>,
    initialize: (claimIndex: Node<'uint'>) => void,
  ): void {
    If(particle.alive.equal(uint(0)), () => {
      const claimIndex = claimRequest().toVar('emitterClaimIndex');

      If(claimIndex.lessThan(requestCount), () => {
        this.recordAllocationAttempt();
        particle.generation.assign(particle.generation.add(uint(1)));
        initialize(claimIndex);
        particle.alive.assign(uint(1));
        this.recordAllocationSuccess();
      });
    });
  }

  snapshotAlive(particle: GPUParticleLike): void {
    atomicStore(
      this.occupancyStorage.element(particle.index),
      particle.alive,
    );
    atomicStore(
      this.occupancyStorage.element(
        particle.index.add(this.state.capacity),
      ),
      uint(0),
    );
    atomicStore(
      this.occupancyStorage.element(
        particle.index.add(this.state.capacity * 2),
      ),
      uint(0),
    );
  }

  markSpawned(particle: GPUParticleLike): void {
    atomicStore(
      this.occupancyStorage.element(
          particle.index.add(this.state.capacity),
      ),
      uint(1),
    );
  }

  wasSpawned(particle: GPUParticleLike): Node<'bool'> {
    return atomicLoad(this.occupancyStorage.element(
      particle.index.add(this.state.capacity),
    )).notEqual(uint(0));
  }

  storeEmissionSource(requestIndex: Node<'uint'>, sourceIndex: Node<'uint'>): void {
    If(requestIndex.lessThan(uint(this.state.capacity)), () => {
      atomicStore(
        this.occupancyStorage.element(
          requestIndex.add(this.state.capacity * 3),
        ),
        sourceIndex,
      );
    });
  }

  emissionSource(requestIndex: Node<'uint'>): Node<'uint'> {
    return atomicLoad(this.occupancyStorage.element(
      requestIndex.add(this.state.capacity * 3),
    ));
  }

  selectOldSlotForEmitter(
    particle: GPUParticleLike,
    replacementCount: Node<'uint'>,
    claimReplacement: () => Node<'uint'>,
  ): void {
    If(
      atomicLoad(
        this.occupancyStorage.element(particle.index),
      ).notEqual(uint(0)),
      () => {
        const replacementIndex = claimReplacement().toVar('emitterReplacementIndex');
        If(replacementIndex.lessThan(replacementCount), () => {
          atomicStore(
            this.occupancyStorage.element(
              particle.index.add(this.state.capacity * 2),
            ),
            replacementIndex.add(uint(1)),
          );
          atomicStore(
            this.occupancyStorage.element(
            particle.index,
            ),
            uint(0),
          );
        });
      },
    );
  }

  isSelectedForReplacement(particle: GPUParticleLike): Node<'bool'> {
    return atomicLoad(this.occupancyStorage.element(
      particle.index.add(this.state.capacity * 2),
    )).notEqual(uint(0));
  }

  claimOldSlotForEmitter(
    particle: GPUParticleLike,
    initialize: (replacementIndex: Node<'uint'>) => void,
  ): void {
    const marker = atomicLoad(this.occupancyStorage.element(
      particle.index.add(this.state.capacity * 2),
    )).toVar('emitterReplacementMarker');

    If(marker.notEqual(uint(0)), () => {
      this.recordAllocationAttempt();
      this.recordRecycledDeath();
      particle.generation.assign(particle.generation.add(uint(1)));
      initialize(marker.sub(uint(1)));
      particle.alive.assign(uint(1));
      this.recordAllocationSuccess();
      atomicStore(
        this.occupancyStorage.element(
          particle.index.add(this.state.capacity * 2),
        ),
        uint(0),
      );
    });
  }
}

export class GPUAllocationBufferState {
  readonly capacity: number;
  readonly counterAttribute: StorageBufferAttribute;
  readonly occupancyAttribute: StorageBufferAttribute;
  private readonly counterData: Uint32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.counterData = new Uint32Array(GPU_ALLOCATION_COUNTER_COUNT);
    this.counterAttribute = new StorageBufferAttribute(this.counterData, 1);
    this.occupancyAttribute = new StorageBufferAttribute(new Uint32Array(this.capacity * 4), 1);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.counterAttribute);
    initializeStorageAttribute(renderer, this.occupancyAttribute);
  }

  reset(sequence: number, startingActiveCount = 0, cullingMode = 0): void {
    this.counterData.fill(0);
    this.counterData[AllocationCounter.StartingActiveCount] = Math.max(0, Math.floor(startingActiveCount)) >>> 0;
    this.counterData[AllocationCounter.Capacity] = this.capacity >>> 0;
    this.counterData[AllocationCounter.CullingMode] = Math.max(0, Math.floor(cullingMode)) >>> 0;
    this.counterData[AllocationCounter.Sequence] = sequence >>> 0;
    this.counterAttribute.needsUpdate = true;
  }

  createWriter(): GPUAllocationWriter {
    return new GPUAllocationWriter(this);
  }

  snapshot(): GPUAllocationDiagnostics {
    return diagnosticsFromCounters(this.counterData);
  }

  async readback(renderer: GPUReadbackRenderer): Promise<GPUAllocationDiagnostics> {
    const buffer = await renderer.getArrayBufferAsync(this.counterAttribute);
    return diagnosticsFromCounters(new Uint32Array(buffer));
  }
}

function diagnosticsFromCounters(counters: Uint32Array): GPUAllocationDiagnostics {
  const allocationSuccesses = counters[AllocationCounter.AllocationSuccesses] ?? 0;
  const recycledDeaths = counters[AllocationCounter.RecycledDeaths] ?? 0;
  const startingActiveCount = counters[AllocationCounter.StartingActiveCount] ?? 0;

  return {
    sequence: counters[AllocationCounter.Sequence] ?? 0,
    capacity: counters[AllocationCounter.Capacity] ?? 0,
    cullingMode: counters[AllocationCounter.CullingMode] ?? 0,
    allocationAttempts: counters[AllocationCounter.AllocationAttempts] ?? 0,
    allocationSuccesses,
    allocationFailures: counters[AllocationCounter.AllocationFailures] ?? 0,
    recycledDeaths,
    startingActiveCount,
    estimatedActiveCount: Math.max(0, startingActiveCount + allocationSuccesses - recycledDeaths),
    activeCount: counters[AllocationCounter.ActiveCount] ?? 0,
  };
}

function initializeStorageAttribute(
  renderer: GPUStorageBufferRenderer,
  attribute: StorageBufferAttribute,
): void {
  const backend = renderer.backend as {
    get?(attribute: StorageBufferAttribute): { buffer?: unknown };
    createStorageAttribute?(attribute: StorageBufferAttribute): void;
  } | undefined;
  const data = backend?.get?.(attribute);

  if (!data?.buffer) backend?.createStorageAttribute?.(attribute);
}
