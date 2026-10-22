import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { atomicAdd, atomicLoad, atomicStore, storage, uint } from 'three/tsl';
import {
  enumValueCount,
  initializeStorageAttribute,
  readPackedVec4,
  writePackedVec4,
  type AtomicUintStorage,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
  type PackedFloatStorage,
  type PackedUintStorage,
} from './Storage';

enum EmitterFloatSlot {
  Timing,
  LastDistancePositionDuration,
}

enum EmitterUintSlot {
  Identity,
  State,
}

enum EmitterRuntimeCounter {
  RequestedParticles,
  ClaimedRequests,
  ClaimedReplacements,
  PendingRequests,
}

const FLOAT_SLOT_COUNT = enumValueCount(EmitterFloatSlot);
const BASE_UINT_SLOT_COUNT = enumValueCount(EmitterUintSlot);
const RUNTIME_COUNTER_COUNT = enumValueCount(EmitterRuntimeCounter);

export interface GPUEmitterInstanceRecord {
  active: boolean;
  parentSlot: number;
  parentGeneration: number;
  emitterIndex: number;
  runId: number;
  flags: number;
  firedBurstsMask: number;
  firedBurstWords?: readonly number[];
  startTime: number;
  lastSpawn: number;
  distanceCredit: number;
  elapsedTime: number;
  lastDistancePosition: THREE.Vector3;
  duration: number;
}
export class GPUEmitterInstanceRuntime {
  readonly timing: Node<'vec4'>;
  readonly distance: Node<'vec4'>;
  readonly identity: Node<'uvec4'>;
  readonly burstState: Node<'uvec4'>;

  private readonly state: GPUEmitterInstanceBufferState;
  private readonly uintOffset: Node<'uint'> | number;
  private readonly counters: AtomicUintStorage;
  private readonly counterOffset: Node<'uint'> | number;

  constructor(state: GPUEmitterInstanceBufferState, index: Node<'uint'> | number) {
    this.state = state;
    const floatStorage = state.floatStorage;
    const uintStorage = state.uintStorage;

    const floatIndex = typeof index === 'number'
      ? index * FLOAT_SLOT_COUNT
      : index.mul(FLOAT_SLOT_COUNT);
    const uintIndex = typeof index === 'number'
      ? index * state.uintSlotCount
      : index.mul(state.uintSlotCount);
    this.uintOffset = uintIndex;
    this.timing = floatStorage.element(typeof floatIndex === 'number' ? floatIndex + EmitterFloatSlot.Timing : floatIndex.add(EmitterFloatSlot.Timing));
    this.distance = floatStorage.element(
      typeof floatIndex === 'number'
        ? floatIndex + EmitterFloatSlot.LastDistancePositionDuration
        : floatIndex.add(EmitterFloatSlot.LastDistancePositionDuration),
    );
    this.identity = uintStorage.element(typeof uintIndex === 'number' ? uintIndex + EmitterUintSlot.Identity : uintIndex.add(EmitterUintSlot.Identity));
    this.burstState = uintStorage.element(typeof uintIndex === 'number' ? uintIndex + EmitterUintSlot.State : uintIndex.add(EmitterUintSlot.State));
    this.counters = state.runtimeCounterStorage;
    this.counterOffset = typeof index === 'number'
      ? index * RUNTIME_COUNTER_COUNT
      : index.mul(RUNTIME_COUNTER_COUNT);
  }

  firedBurstWord(index: number): Node<'uint'> {
    if (index < 0 || index >= this.state.burstWordCount) {
      throw new Error(`GPU emitter burst word ${index} is outside capacity ${this.state.burstWordCount}.`);
    }
    if (index === 0) return this.burstState.z;

    const overflowIndex = index - 1;
    const slot = BASE_UINT_SLOT_COUNT + Math.floor(overflowIndex / 4);
    const packed = this.state.uintStorage.element(
      typeof this.uintOffset === 'number'
        ? this.uintOffset + slot
        : this.uintOffset.add(slot),
    );
    return packed[['x', 'y', 'z', 'w'][overflowIndex % 4] as 'x' | 'y' | 'z' | 'w'];
  }

  private counter(index: number): Node<'uint'> {
    return this.counters.element(
      typeof this.counterOffset === 'number'
        ? this.counterOffset + index
        : this.counterOffset.add(index),
    );
  }

  // Multiple invocations may update these counters concurrently. Atomic store,
  // add, and load make reset, reservation, and observation race-free on the GPU.
  resetRequestCount(value: Node<'uint'> | number): void {
    atomicStore(this.counter(EmitterRuntimeCounter.RequestedParticles), typeof value === 'number' ? uint(value) : value);
    atomicStore(this.counter(EmitterRuntimeCounter.ClaimedRequests), uint(0));
    atomicStore(this.counter(EmitterRuntimeCounter.ClaimedReplacements), uint(0));
  }

  addRequestCount(value: Node<'uint'> | number): void {
    atomicAdd(this.counter(EmitterRuntimeCounter.RequestedParticles), typeof value === 'number' ? uint(value) : value);
  }

  reserveRequestCount(value: Node<'uint'> | number): Node<'uint'> {
    return atomicAdd(this.counter(EmitterRuntimeCounter.RequestedParticles), typeof value === 'number' ? uint(value) : value);
  }

  requestCount(): Node<'uint'> {
    return atomicLoad(this.counter(EmitterRuntimeCounter.RequestedParticles));
  }

  claimRequest(): Node<'uint'> {
    return atomicAdd(this.counter(EmitterRuntimeCounter.ClaimedRequests), uint(1));
  }

  claimCount(): Node<'uint'> {
    return atomicLoad(this.counter(EmitterRuntimeCounter.ClaimedRequests));
  }

  claimReplacement(): Node<'uint'> {
    return atomicAdd(this.counter(EmitterRuntimeCounter.ClaimedReplacements), uint(1));
  }

  replacementCount(): Node<'uint'> {
    return atomicLoad(this.counter(EmitterRuntimeCounter.ClaimedReplacements));
  }

  pendingRequestCount(): Node<'uint'> {
    return atomicLoad(this.counter(EmitterRuntimeCounter.PendingRequests));
  }

  setPendingRequestCount(value: Node<'uint'> | number): void {
    atomicStore(
      this.counter(EmitterRuntimeCounter.PendingRequests),
      typeof value === 'number' ? uint(value) : value,
    );
  }
}

export class GPUEmitterInstanceBufferState {
  readonly capacity: number;
  readonly burstWordCount: number;
  readonly uintSlotCount: number;
  readonly floatAttribute: StorageBufferAttribute;
  readonly uintAttribute: StorageBufferAttribute;
  readonly runtimeCounterAttribute: StorageBufferAttribute;
  readonly floatStorage: PackedFloatStorage;
  readonly uintStorage: PackedUintStorage;
  readonly runtimeCounterStorage: AtomicUintStorage;

  private readonly floatData: Float32Array;
  private readonly uintData: Uint32Array;
  private readonly runtimeCounterData: Uint32Array;

  constructor(capacity: number, maxBurstCount = 0) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.burstWordCount = Math.max(1, Math.ceil(Math.max(0, maxBurstCount) / 32));
    this.uintSlotCount = BASE_UINT_SLOT_COUNT + Math.ceil((this.burstWordCount - 1) / 4);
    this.floatData = new Float32Array(this.capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * this.uintSlotCount * 4);
    this.runtimeCounterData = new Uint32Array(this.capacity * RUNTIME_COUNTER_COUNT);
    this.floatAttribute = new StorageBufferAttribute(this.floatData, 4);
    this.uintAttribute = new StorageBufferAttribute(this.uintData, 4);
    this.runtimeCounterAttribute = new StorageBufferAttribute(this.runtimeCounterData, 1);
    this.floatStorage = storage(
      this.floatAttribute,
      'vec4',
      this.capacity * FLOAT_SLOT_COUNT,
    ) as PackedFloatStorage;
    this.uintStorage = storage(
      this.uintAttribute,
      'uvec4',
      this.capacity * this.uintSlotCount,
    ) as PackedUintStorage;
    this.runtimeCounterStorage = storage(
      this.runtimeCounterAttribute,
      'uint',
      this.capacity * RUNTIME_COUNTER_COUNT,
    ).toAtomic() as AtomicUintStorage;
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.floatAttribute);
    initializeStorageAttribute(renderer, this.uintAttribute);
    initializeStorageAttribute(renderer, this.runtimeCounterAttribute);
  }

  reset(): void {
    this.floatData.fill(0);
    this.uintData.fill(0);
    this.runtimeCounterData.fill(0);
    this.floatAttribute.needsUpdate = true;
    this.uintAttribute.needsUpdate = true;
    this.runtimeCounterAttribute.needsUpdate = true;
  }

  /** Creates a view for one concurrent emitter run; capacity is the run count. */
  createRuntime(index: Node<'uint'> | number): GPUEmitterInstanceRuntime {
    if (typeof index === 'number' && (index < 0 || index >= this.capacity)) {
      throw new Error(`GPU emitter instance index ${index} is outside capacity ${this.capacity}.`);
    }
    return new GPUEmitterInstanceRuntime(this, index);
  }

  upload(records: GPUEmitterInstanceRecord[]): void {
    if (records.length > this.capacity) {
      throw new Error(`GPU emitter instance buffer capacity ${this.capacity} exceeded by ${records.length} records.`);
    }

    this.reset();
    records.forEach((record, index) => this.writeRecord(index, record));
    this.floatAttribute.needsUpdate = true;
    this.uintAttribute.needsUpdate = true;
  }

  writeRecord(index: number, record: GPUEmitterInstanceRecord): void {
    if (index < 0 || index >= this.capacity) {
      throw new Error(`GPU emitter instance index ${index} is outside capacity ${this.capacity}.`);
    }

    writePackedVec4(
      this.floatData,
      index,
      EmitterFloatSlot.Timing,
      FLOAT_SLOT_COUNT,
      [record.startTime, record.lastSpawn, record.distanceCredit, record.elapsedTime],
    );
    writePackedVec4(
      this.floatData,
      index,
      EmitterFloatSlot.LastDistancePositionDuration,
      FLOAT_SLOT_COUNT,
      [record.lastDistancePosition.x, record.lastDistancePosition.y, record.lastDistancePosition.z, record.duration],
    );
    writePackedVec4(
      this.uintData,
      index,
      EmitterUintSlot.Identity,
      this.uintSlotCount,
      [record.active ? 1 : 0, record.parentSlot, record.parentGeneration, record.emitterIndex],
    );
    writePackedVec4(
      this.uintData,
      index,
      EmitterUintSlot.State,
      this.uintSlotCount,
      [record.runId, record.flags, record.firedBurstWords?.[0] ?? record.firedBurstsMask, 0],
    );
    const burstWords = record.firedBurstWords ?? [record.firedBurstsMask];
    burstWords.slice(1, this.burstWordCount).forEach((word, overflowIndex) => {
      const offset = (
        index * this.uintSlotCount
        + BASE_UINT_SLOT_COUNT
        + Math.floor(overflowIndex / 4)
      ) * 4 + overflowIndex % 4;
      this.uintData[offset] = word;
    });
  }

  async readback(renderer: GPUReadbackRenderer): Promise<GPUEmitterInstanceRecord[]> {
    const [floatBuffer, uintBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.floatAttribute),
      renderer.getArrayBufferAsync(this.uintAttribute),
    ]);
    const floats = new Float32Array(floatBuffer);
    const uints = new Uint32Array(uintBuffer);
    const records: GPUEmitterInstanceRecord[] = [];

    for (let index = 0; index < this.capacity; index += 1) {
      const identity = readPackedVec4(uints, index, EmitterUintSlot.Identity, this.uintSlotCount);
      const state = readPackedVec4(uints, index, EmitterUintSlot.State, this.uintSlotCount);
      if (identity[0] === 0) continue;

      const firedBurstWords = [state[2], ...Array.from(
        { length: this.burstWordCount - 1 },
        (_, overflowIndex) => {
          const offset = (
            index * this.uintSlotCount
            + BASE_UINT_SLOT_COUNT
            + Math.floor(overflowIndex / 4)
          ) * 4 + overflowIndex % 4;
          return uints[offset];
        },
      )];

      const timing = readPackedVec4(floats, index, EmitterFloatSlot.Timing, FLOAT_SLOT_COUNT);
      const distance = readPackedVec4(floats, index, EmitterFloatSlot.LastDistancePositionDuration, FLOAT_SLOT_COUNT);

      records.push({
        active: true,
        parentSlot: identity[1],
        parentGeneration: identity[2],
        emitterIndex: identity[3],
        runId: state[0],
        flags: state[1],
        firedBurstsMask: firedBurstWords[0],
        firedBurstWords,
        startTime: timing[0],
        lastSpawn: timing[1],
        distanceCredit: timing[2],
        elapsedTime: timing[3],
        lastDistancePosition: new THREE.Vector3(distance[0], distance[1], distance[2]),
        duration: distance[3],
      });
    }

    return records;
  }
}
