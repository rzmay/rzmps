import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { atomicAdd, atomicLoad, atomicStore, storage, uint } from 'three/tsl';
import type { GPUReadbackRenderer, GPUStorageBufferRenderer } from './Particle';

const FLOAT_SLOT_COUNT = 2;
const UINT_SLOT_COUNT = 2;
const RUNTIME_COUNTER_COUNT = 3;

enum EmitterFloatSlot {
  Timing,
  LastDistancePositionDuration,
}

enum EmitterUintSlot {
  Identity,
  BurstMask,
}

export interface GPUEmitterInstanceRecord {
  active: boolean;
  parentSlot: number;
  parentGeneration: number;
  emitterIndex: number;
  runId: number;
  flags: number;
  firedBurstsMask: number;
  startTime: number;
  lastSpawn: number;
  distanceCredit: number;
  elapsedTime: number;
  lastDistancePosition: THREE.Vector3;
  duration: number;
}

type PackedFloatStorage = { element(index: Node | number): Node<'vec4'> };
type PackedUintStorage = { element(index: Node | number): Node<'uvec4'> };
type PackedAtomicUintStorage = { element(index: Node | number): Node<'uint'> };

export class GPUEmitterInstanceRuntime {
  readonly timing: Node<'vec4'>;
  readonly distance: Node<'vec4'>;
  readonly identity: Node<'uvec4'>;
  readonly burstState: Node<'uvec4'>;

  private readonly counters: PackedAtomicUintStorage;
  private readonly counterOffset: Node<'uint'> | number;

  constructor(state: GPUEmitterInstanceBufferState, index: Node<'uint'> | number) {
    const floatStorage = state.floatStorage;
    const uintStorage = state.uintStorage;

    const floatIndex = typeof index === 'number'
      ? index * FLOAT_SLOT_COUNT
      : index.mul(FLOAT_SLOT_COUNT);
    const uintIndex = typeof index === 'number'
      ? index * UINT_SLOT_COUNT
      : index.mul(UINT_SLOT_COUNT);
    this.timing = floatStorage.element(typeof floatIndex === 'number' ? floatIndex + EmitterFloatSlot.Timing : floatIndex.add(EmitterFloatSlot.Timing));
    this.distance = floatStorage.element(
      typeof floatIndex === 'number'
        ? floatIndex + EmitterFloatSlot.LastDistancePositionDuration
        : floatIndex.add(EmitterFloatSlot.LastDistancePositionDuration),
    );
    this.identity = uintStorage.element(typeof uintIndex === 'number' ? uintIndex + EmitterUintSlot.Identity : uintIndex.add(EmitterUintSlot.Identity));
    this.burstState = uintStorage.element(typeof uintIndex === 'number' ? uintIndex + EmitterUintSlot.BurstMask : uintIndex.add(EmitterUintSlot.BurstMask));
    this.counters = state.runtimeCounterStorage;
    this.counterOffset = typeof index === 'number'
      ? index * RUNTIME_COUNTER_COUNT
      : index.mul(RUNTIME_COUNTER_COUNT);
  }

  private counter(index: number): Node<'uint'> {
    return this.counters.element(
      typeof this.counterOffset === 'number'
        ? this.counterOffset + index
        : this.counterOffset.add(index),
    );
  }

  resetRequestCount(value: Node<'uint'> | number): void {
    atomicStore(this.counter(0), typeof value === 'number' ? uint(value) : value);
    atomicStore(this.counter(1), uint(0));
    atomicStore(this.counter(2), uint(0));
  }

  addRequestCount(value: Node<'uint'> | number): void {
    atomicAdd(this.counter(0), typeof value === 'number' ? uint(value) : value);
  }

  reserveRequestCount(value: Node<'uint'> | number): Node<'uint'> {
    return atomicAdd(this.counter(0), typeof value === 'number' ? uint(value) : value);
  }

  requestCount(): Node<'uint'> {
    return atomicLoad(this.counter(0));
  }

  claimRequest(): Node<'uint'> {
    return atomicAdd(this.counter(1), uint(1));
  }

  claimCount(): Node<'uint'> {
    return atomicLoad(this.counter(1));
  }

  claimReplacement(): Node<'uint'> {
    return atomicAdd(this.counter(2), uint(1));
  }

  replacementCount(): Node<'uint'> {
    return atomicLoad(this.counter(2));
  }
}

export class GPUEmitterInstanceBufferState {
  readonly capacity: number;
  readonly floatAttribute: StorageBufferAttribute;
  readonly uintAttribute: StorageBufferAttribute;
  readonly runtimeCounterAttribute: StorageBufferAttribute;
  readonly floatStorage: PackedFloatStorage;
  readonly uintStorage: PackedUintStorage;
  readonly runtimeCounterStorage: PackedAtomicUintStorage;

  private readonly floatData: Float32Array;
  private readonly uintData: Uint32Array;
  private readonly runtimeCounterData: Uint32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.floatData = new Float32Array(this.capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * UINT_SLOT_COUNT * 4);
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
      this.capacity * UINT_SLOT_COUNT,
    ) as PackedUintStorage;
    this.runtimeCounterStorage = storage(
      this.runtimeCounterAttribute,
      'uint',
      this.capacity * RUNTIME_COUNTER_COUNT,
    ).toAtomic() as PackedAtomicUintStorage;
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

    writeFloatSlot(
      this.floatData,
      index,
      EmitterFloatSlot.Timing,
      record.startTime,
      record.lastSpawn,
      record.distanceCredit,
      record.elapsedTime,
    );
    writeFloatSlot(
      this.floatData,
      index,
      EmitterFloatSlot.LastDistancePositionDuration,
      record.lastDistancePosition.x,
      record.lastDistancePosition.y,
      record.lastDistancePosition.z,
      record.duration,
    );
    writeUintSlot(
      this.uintData,
      index,
      EmitterUintSlot.Identity,
      record.active ? 1 : 0,
      record.parentSlot,
      record.parentGeneration,
      record.emitterIndex,
    );
    writeUintSlot(
      this.uintData,
      index,
      EmitterUintSlot.BurstMask,
      record.runId,
      record.flags,
      record.firedBurstsMask,
      0,
    );
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
      const identity = readUintSlot(uints, index, EmitterUintSlot.Identity);
      const burst = readUintSlot(uints, index, EmitterUintSlot.BurstMask);
      if (identity[0] === 0) continue;

      const timing = readFloatSlot(floats, index, EmitterFloatSlot.Timing);
      const distance = readFloatSlot(floats, index, EmitterFloatSlot.LastDistancePositionDuration);

      records.push({
        active: true,
        parentSlot: identity[1],
        parentGeneration: identity[2],
        emitterIndex: identity[3],
        runId: burst[0],
        flags: burst[1],
        firedBurstsMask: burst[2],
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

function writeFloatSlot(
  array: Float32Array,
  index: number,
  slot: number,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  const offset = (index * FLOAT_SLOT_COUNT + slot) * 4;
  array[offset] = x;
  array[offset + 1] = y;
  array[offset + 2] = z;
  array[offset + 3] = w;
}

function readFloatSlot(array: Float32Array, index: number, slot: number): [number, number, number, number] {
  const offset = (index * FLOAT_SLOT_COUNT + slot) * 4;
  return [
    array[offset],
    array[offset + 1],
    array[offset + 2],
    array[offset + 3],
  ];
}

function writeUintSlot(
  array: Uint32Array,
  index: number,
  slot: number,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  const offset = (index * UINT_SLOT_COUNT + slot) * 4;
  array[offset] = x >>> 0;
  array[offset + 1] = y >>> 0;
  array[offset + 2] = z >>> 0;
  array[offset + 3] = w >>> 0;
}

function readUintSlot(array: Uint32Array, index: number, slot: number): [number, number, number, number] {
  const offset = (index * UINT_SLOT_COUNT + slot) * 4;
  return [
    array[offset],
    array[offset + 1],
    array[offset + 2],
    array[offset + 3],
  ];
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
