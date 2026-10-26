import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  atomicAdd,
  atomicLoad,
  atomicMax,
  atomicMin,
  atomicStore,
  If,
  max,
  storage,
  uint,
} from 'three/tsl';
import type { GPUParticleLike } from './Particle';
import {
  enumValueCount,
  initializeStorageAttribute,
  orderedFloatNode,
  unorderedFloatBits,
  type AtomicUintStorage,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
} from './Storage';

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
  BoundsMinimumX,
  BoundsMinimumY,
  BoundsMinimumZ,
  BoundsMaximumX,
  BoundsMaximumY,
  BoundsMaximumZ,
  MaximumVelocity,
  HasBounds,
}

const GPU_ALLOCATION_COUNTER_COUNT = enumValueCount(AllocationCounter);

/** Production telemetry for saturation, culling, and allocation-pressure monitoring. */
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
  bounds?: THREE.Box3;
  maxVelocity: number;
}

export class GPUAllocationWriter {
  private readonly counterStorage: AtomicUintStorage;
  private readonly occupancyStorage: AtomicUintStorage;

  constructor(private readonly state: GPUAllocationBufferState) {
    const allocationStorage = storage(
      state.attribute,
      'uint',
      GPU_ALLOCATION_COUNTER_COUNT + state.capacity * 4,
    ).toAtomic() as AtomicUintStorage;
    this.counterStorage = allocationStorage;
    this.occupancyStorage = allocationStorage;
  }

  private occupancyIndex(index: Node<'uint'>): Node<'uint'> {
    return index.add(uint(GPU_ALLOCATION_COUNTER_COUNT));
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
      const radius = max(
        max(abs(particle.scale.x), abs(particle.scale.y)),
        max(abs(particle.scale.z), Number.EPSILON),
      );
      const minimum = particle.position.sub(radius);
      const maximum = particle.position.add(radius);
      atomicMin(this.counterStorage.element(uint(AllocationCounter.BoundsMinimumX)), orderedFloatNode(minimum.x));
      atomicMin(this.counterStorage.element(uint(AllocationCounter.BoundsMinimumY)), orderedFloatNode(minimum.y));
      atomicMin(this.counterStorage.element(uint(AllocationCounter.BoundsMinimumZ)), orderedFloatNode(minimum.z));
      atomicMax(this.counterStorage.element(uint(AllocationCounter.BoundsMaximumX)), orderedFloatNode(maximum.x));
      atomicMax(this.counterStorage.element(uint(AllocationCounter.BoundsMaximumY)), orderedFloatNode(maximum.y));
      atomicMax(this.counterStorage.element(uint(AllocationCounter.BoundsMaximumZ)), orderedFloatNode(maximum.z));
      atomicMax(
        this.counterStorage.element(uint(AllocationCounter.MaximumVelocity)),
        orderedFloatNode(particle.velocity.length().mul(abs(particle.speed))),
      );
      atomicStore(this.counterStorage.element(uint(AllocationCounter.HasBounds)), uint(1));
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
      this.occupancyStorage.element(this.occupancyIndex(particle.index)),
      particle.alive,
    );
    atomicStore(
      this.occupancyStorage.element(
        this.occupancyIndex(particle.index.add(this.state.capacity)),
      ),
      uint(0),
    );
    atomicStore(
      this.occupancyStorage.element(
        this.occupancyIndex(particle.index.add(this.state.capacity * 2)),
      ),
      uint(0),
    );
  }

  markSpawned(particle: GPUParticleLike): void {
    atomicStore(
      this.occupancyStorage.element(
        this.occupancyIndex(particle.index.add(this.state.capacity)),
      ),
      uint(1),
    );
  }

  wasSpawned(particle: GPUParticleLike): Node<'bool'> {
    return atomicLoad(this.occupancyStorage.element(
      this.occupancyIndex(particle.index.add(this.state.capacity)),
    )).notEqual(uint(0));
  }

  storeEmissionSource(requestIndex: Node<'uint'>, sourceIndex: Node<'uint'>): void {
    If(requestIndex.lessThan(uint(this.state.capacity)), () => {
      atomicStore(
        this.occupancyStorage.element(
          this.occupancyIndex(requestIndex.add(this.state.capacity * 3)),
        ),
        sourceIndex,
      );
    });
  }

  emissionSource(requestIndex: Node<'uint'>): Node<'uint'> {
    return atomicLoad(this.occupancyStorage.element(
      this.occupancyIndex(requestIndex.add(this.state.capacity * 3)),
    ));
  }

  selectOldSlotForEmitter(
    particle: GPUParticleLike,
    replacementCount: Node<'uint'>,
    claimReplacement: () => Node<'uint'>,
  ): void {
    If(
      atomicLoad(
        this.occupancyStorage.element(this.occupancyIndex(particle.index)),
      ).notEqual(uint(0)),
      () => {
        const replacementIndex = claimReplacement().toVar('emitterReplacementIndex');
        If(replacementIndex.lessThan(replacementCount), () => {
          atomicStore(
            this.occupancyStorage.element(
              this.occupancyIndex(particle.index.add(this.state.capacity * 2)),
            ),
            replacementIndex.add(uint(1)),
          );
          atomicStore(
            this.occupancyStorage.element(this.occupancyIndex(particle.index)),
            uint(0),
          );
        });
      },
    );
  }

  isSelectedForReplacement(particle: GPUParticleLike): Node<'bool'> {
    return atomicLoad(this.occupancyStorage.element(
      this.occupancyIndex(particle.index.add(this.state.capacity * 2)),
    )).notEqual(uint(0));
  }

  claimOldSlotForEmitter(
    particle: GPUParticleLike,
    initialize: (replacementIndex: Node<'uint'>) => void,
  ): void {
    const marker = atomicLoad(this.occupancyStorage.element(
      this.occupancyIndex(particle.index.add(this.state.capacity * 2)),
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
          this.occupancyIndex(particle.index.add(this.state.capacity * 2)),
        ),
        uint(0),
      );
    });
  }
}

/**
 * Owns buffer allocation, CPU reset/readback, and lifetime. GPUAllocationWriter
 * is its lightweight shader-node view and emits atomic operations into kernels.
 */
export class GPUAllocationBufferState {
  readonly capacity: number;
  readonly attribute: StorageBufferAttribute;
  private readonly counterData: Uint32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    // Counters and per-slot allocation state share one uint binding so native
    // emission remains within WebGPU's default eight-buffer stage limit.
    const data = new Uint32Array(GPU_ALLOCATION_COUNTER_COUNT + this.capacity * 4);
    this.counterData = data.subarray(0, GPU_ALLOCATION_COUNTER_COUNT);
    this.attribute = new StorageBufferAttribute(data, 1);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.attribute);
  }

  reset(sequence: number, startingActiveCount = 0, cullingMode = 0): void {
    this.counterData.fill(0);
    this.counterData[AllocationCounter.StartingActiveCount] = Math.max(0, Math.floor(startingActiveCount)) >>> 0;
    this.counterData[AllocationCounter.Capacity] = this.capacity >>> 0;
    this.counterData[AllocationCounter.CullingMode] = Math.max(0, Math.floor(cullingMode)) >>> 0;
    this.counterData[AllocationCounter.Sequence] = sequence >>> 0;
    this.counterData[AllocationCounter.BoundsMinimumX] = 0xffffffff;
    this.counterData[AllocationCounter.BoundsMinimumY] = 0xffffffff;
    this.counterData[AllocationCounter.BoundsMinimumZ] = 0xffffffff;
    this.counterData[AllocationCounter.MaximumVelocity] = 0x80000000;
    this.attribute.needsUpdate = true;
  }

  createWriter(): GPUAllocationWriter {
    return new GPUAllocationWriter(this);
  }

  snapshot(): GPUAllocationDiagnostics {
    return diagnosticsFromCounters(this.counterData);
  }

  async readback(renderer: GPUReadbackRenderer): Promise<GPUAllocationDiagnostics> {
    const buffer = await renderer.getArrayBufferAsync(this.attribute);
    return diagnosticsFromCounters(new Uint32Array(buffer));
  }
}

// Sequence is the simulation-frame token that produced this asynchronous snapshot.
function diagnosticsFromCounters(counters: Uint32Array): GPUAllocationDiagnostics {
  const allocationSuccesses = counters[AllocationCounter.AllocationSuccesses] ?? 0;
  const recycledDeaths = counters[AllocationCounter.RecycledDeaths] ?? 0;
  const startingActiveCount = counters[AllocationCounter.StartingActiveCount] ?? 0;

  const hasBounds = (counters[AllocationCounter.HasBounds] ?? 0) !== 0;
  const bounds = hasBounds
    ? new THREE.Box3(
      new THREE.Vector3(
        unorderedFloatBits(counters[AllocationCounter.BoundsMinimumX]),
        unorderedFloatBits(counters[AllocationCounter.BoundsMinimumY]),
        unorderedFloatBits(counters[AllocationCounter.BoundsMinimumZ]),
      ),
      new THREE.Vector3(
        unorderedFloatBits(counters[AllocationCounter.BoundsMaximumX]),
        unorderedFloatBits(counters[AllocationCounter.BoundsMaximumY]),
        unorderedFloatBits(counters[AllocationCounter.BoundsMaximumZ]),
      ),
    )
    : undefined;

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
    bounds,
    maxVelocity: unorderedFloatBits(counters[AllocationCounter.MaximumVelocity] ?? 0x80000000),
  };
}
