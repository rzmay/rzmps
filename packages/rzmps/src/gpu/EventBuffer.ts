import type EventReceiver from '../EventReceiver';
import type { GPUEventData, GPUEventPayload } from '../Events';
import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node, ComputeNode } from 'three/webgpu';
import {
  atomicAdd,
  atomicLoad,
  atomicStore,
  Fn,
  instanceIndex,
  float,
  floatBitsToUint,
  If,
  storage,
  uint,
  uvec2,
  uintBitsToFloat,
  vec4,
} from 'three/tsl';
import Particle from '../Particle';
import type { CollisionHit } from '../interfaces/ICollisionBackend';
import {
  destroyGPUStorageAttribute,
  type GPUParticleLike,
} from './Particle';
import {
  enumValueCount,
  initializeStorageAttribute,
  nextPowerOfTwo,
  type AtomicUintStorage,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
  type PackedFloatStorage,
} from './Storage';

export enum GPUEventType {
  Death = 1,
  Spawn = 2,
  Collision = 3,
}

export interface GPUCollisionEventNodeRecord {
  active: Node<'bool'>;
  point: Node<'vec3'>;
  position: Node<'vec3'>;
  normal: Node<'vec3'>;
  impulse: Node<'vec3'>;
}

// This per-slot collision cache intentionally differs from the append-only event
// stream below: kernels can load the latest collision for a known particle in O(1).
export class GPUCollisionEventWriter {
  readonly version: number;
  private readonly storage: PackedFloatStorage;

  constructor(
    state: GPUCollisionEventBufferState,
    private readonly frameSequence: Node<'uint'>,
  ) {
    this.version = state.version;
    this.storage = storage(state.attribute, 'vec4', state.capacity * 4) as PackedFloatStorage;
  }

  emit(
    particle: GPUParticleLike,
    point: Node<'vec3'>,
    position: Node<'vec3'>,
    normal: Node<'vec3'>,
    impulse: Node<'vec3'>,
  ): void {
    const base = particle.index.mul(4);
    this.storage.element(base).assign(vec4(point, float(this.frameSequence)));
    this.storage.element(base.add(1)).assign(vec4(position, 0));
    this.storage.element(base.add(2)).assign(vec4(normal, 0));
    this.storage.element(base.add(3)).assign(vec4(impulse, 0));
  }

  load(index: Node<'uint'>): GPUCollisionEventNodeRecord {
    const base = index.mul(4);
    const point = this.storage.element(base);
    return {
      active: point.w.equal(float(this.frameSequence)),
      point: point.xyz,
      position: this.storage.element(base.add(1)).xyz,
      normal: this.storage.element(base.add(2)).xyz,
      impulse: this.storage.element(base.add(3)).xyz,
    };
  }

  clear(index: Node<'uint'>): void {
    this.storage.element(index.mul(4)).w.assign(0);
  }
}

export class GPUCollisionEventBufferState {
  readonly capacity: number;
  readonly version: number;
  readonly attribute: StorageBufferAttribute;
  private static nextVersion = 1;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.version = GPUCollisionEventBufferState.nextVersion;
    GPUCollisionEventBufferState.nextVersion += 1;
    this.attribute = new StorageBufferAttribute(new Float32Array(this.capacity * 4 * 4), 4);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.attribute);
  }

  createWriter(frameSequence: Node<'uint'>): GPUCollisionEventWriter {
    return new GPUCollisionEventWriter(this, frameSequence);
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    destroyGPUStorageAttribute(renderer, this.attribute);
  }
}

enum EventCounter {
  Count,
  OverflowCount,
}

const GPU_EVENT_COUNTER_COUNT = enumValueCount(EventCounter);

enum EventFloatSlot {
  PositionSpeed,
  OrbitCenterAlpha,
  RotationMass,
  ScaleDistortion,
  VelocityLifetime,
  AngularVelocityTime,
  ScalarVelocityRealtime,
  Acceleration,
  AngularAcceleration,
  ScalarAcceleration,
  Color,
  Payload0,
  Payload1,
  Payload2,
  Metadata,
}

export const GPU_EVENT_FLOAT_SLOT_COUNT = Object.keys(EventFloatSlot).filter(key => isNaN(Number(key))).length;

export interface GPUEventRecord {
  type: number;
  slot: number;
  /** Slot incarnation, incremented whenever a slot is recycled. */
  generation: number;
  /** Simulation frame that emitted the event, used to order async readbacks. */
  sequence: number;
  tagMask?: number;
  particle: Particle;
  collision?: CollisionHit;
  /** GPU numerical payload, including zero-filled unused vectors. */
  data: readonly [THREE.Vector4, THREE.Vector4, THREE.Vector4];
}

export interface GPUEventReadbackBatch {
  sequence: number;
  events: GPUEventRecord[];
  overflowCount: number;
  rawEventCount: number;
  capacity: number;
}

export interface GPUEventNodeRecord {
  type: Node<'uint'>;
  slot: Node<'uint'>;
  generation: Node<'uint'>;
  sequence: Node<'uint'>;
  particle: GPUParticleLike;
  /** Owning system's numeric Object3D identity; zero in legacy standalone buffers. */
  origin: Node<'uint'>;
  hasSource: Node<'bool'>;
  data: GPUEventData;
  collisionPoint: Node<'vec3'>;
  collisionNormal: Node<'vec3'>;
  collisionImpulse: Node<'vec3'>;
}

/** Shader-side random-access reader used to consume an already populated stream. */
export class GPUEventReader {
  private readonly counterStorage: AtomicUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(private readonly state: GPUEventBufferState, private readonly receiverSlot?: number) {
    this.counterStorage = state.counterStorage;
    this.eventFloatStorage = state.eventFloatStorage;
  }

  /** @internal Stable graph identity for a shared receiver range. */
  get versionKey(): string { return `${this.state.version}:${this.receiverSlot ?? 'frame'}`; }

  private start(): Node<'uint'> {
    return this.state.journal ? atomicLoad(this.counterStorage.element(uint(
      this.receiverSlot === undefined ? 2 : 4 + this.receiverSlot * 4))) : uint(0);
  }

  count(): Node<'uint'> {
    const end = atomicLoad(this.counterStorage.element(uint(this.receiverSlot === undefined
      ? EventCounter.Count : 5 + this.receiverSlot * 4)));
    const count = end.sub(this.start());
    return count.lessThan(uint(this.state.capacity)).select(count, uint(this.state.capacity)) as Node<'uint'>;
  }

  load(index: Node<'uint'>): GPUEventNodeRecord {
    const ordinal = this.start().add(index);
    const physical = this.state.journal ? ordinal.mod(this.state.capacity) : index;
    const base = physical.add(this.receiverSlot === undefined ? 0 : this.state.capacity)
      .mul(GPU_EVENT_FLOAT_SLOT_COUNT);
    const record = this.eventFloatStorage.element(base.add(EventFloatSlot.Metadata));
    const positionSpeed = this.eventFloatStorage.element(base.add(EventFloatSlot.PositionSpeed));
    const orbitCenterAlpha = this.eventFloatStorage.element(base.add(EventFloatSlot.OrbitCenterAlpha));
    const rotationMass = this.eventFloatStorage.element(base.add(EventFloatSlot.RotationMass));
    const scaleDistortion = this.eventFloatStorage.element(base.add(EventFloatSlot.ScaleDistortion));
    const velocityLifetime = this.eventFloatStorage.element(base.add(EventFloatSlot.VelocityLifetime));
    const angularVelocityTime = this.eventFloatStorage.element(base.add(EventFloatSlot.AngularVelocityTime));
    const scalarVelocityRealtime = this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarVelocityRealtime));

    return {
      origin: bitcastFloatToUint(this.eventFloatStorage.element(base.add(EventFloatSlot.Color)).w),
      hasSource: bitcastFloatToUint(record.y).notEqual(uint(0xffffffff)),
      type: bitcastFloatToUint(record.x),
      slot: bitcastFloatToUint(record.y),
      generation: bitcastFloatToUint(record.z),
      sequence: uint(this.state.sequence),
      particle: {
        kill() { throw new Error('GPU event snapshots cannot kill live particles.'); },
        emitEvent() {},
        addTag() { throw new Error('GPU event snapshots cannot mutate live particle tags.'); },
        removeTag() { throw new Error('GPU event snapshots cannot mutate live particle tags.'); },
        get id() {
          return uvec2(this.index, this.generation);
        },
        get isChild() {
          return uint(0).equal(uint(1));
        },
        parent: null,
        get root() {
          return this;
        },
        index: bitcastFloatToUint(record.y),
        position: positionSpeed.xyz,
        orbitCenter: orbitCenterAlpha.xyz,
        rotation: rotationMass.xyz,
        scale: scaleDistortion.xyz,
        velocity: velocityLifetime.xyz,
        angularVelocity: angularVelocityTime.xyz,
        scalarVelocity: scalarVelocityRealtime.xyz,
        acceleration: this.eventFloatStorage.element(base.add(EventFloatSlot.Acceleration)).xyz,
        angularAcceleration: this.eventFloatStorage.element(base.add(EventFloatSlot.AngularAcceleration)).xyz,
        scalarAcceleration: this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarAcceleration)).xyz,
        color: this.eventFloatStorage.element(base.add(EventFloatSlot.Color)).xyz,
        speed: positionSpeed.w,
        alpha: orbitCenterAlpha.w,
        mass: rotationMass.w,
        distortionStrength: scaleDistortion.w,
        lifetime: velocityLifetime.w,
        time: angularVelocityTime.w,
        realtime: scalarVelocityRealtime.w,
        alive: uint(1),
        tagMask: bitcastFloatToUint(record.w),
        generation: bitcastFloatToUint(record.z),
        lodPriority: uint(0),
      },
      data: [
        this.eventFloatStorage.element(base.add(EventFloatSlot.Payload0)),
        this.eventFloatStorage.element(base.add(EventFloatSlot.Payload1)),
        this.eventFloatStorage.element(base.add(EventFloatSlot.Payload2)),
      ],
      collisionPoint: this.eventFloatStorage.element(base.add(EventFloatSlot.Payload0)).xyz,
      collisionNormal: this.eventFloatStorage.element(base.add(EventFloatSlot.Payload1)).xyz,
      collisionImpulse: this.eventFloatStorage.element(base.add(EventFloatSlot.Payload2)).xyz,
    };
  }
}

export class GPUEventWriter {
  readonly version: number;
  readonly capacity: number;

  private readonly counterStorage: AtomicUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(private readonly state: GPUEventBufferState, private readonly origin = 0) {
    this.version = state.version;
    this.capacity = state.capacity;
    this.counterStorage = state.counterStorage;
    this.eventFloatStorage = state.eventFloatStorage;
  }

  emitDeath(particle: GPUParticleLike): void {
    this.emitParticleEvent(GPUEventType.Death, particle);
  }

  emitSpawn(particle: GPUParticleLike): void {
    this.emitParticleEvent(GPUEventType.Spawn, particle);
  }

  emitCollision(
    particle: GPUParticleLike,
    point: Node<'vec3'>,
    normal: Node<'vec3'>,
    impulse: Node<'vec3'>,
  ): void {
    this.emitParticleEvent(GPUEventType.Collision, particle, [vec4(point, 0), vec4(normal, 0), vec4(impulse, 0)]);
  }

  emitParticleEvent(
    type: number,
    particle: GPUParticleLike,
    payload?: GPUEventPayload,
  ): void {
    const data = Array.isArray(payload) ? payload : payload ? [payload] : [];
    if (data.length > 3) throw new Error('GPU custom event payload accepts at most three vec4 values (12 floats).');
    const eventIndex = atomicAdd(
      this.counterStorage.element(uint(EventCounter.Count)),
      uint(1),
    ).toVar('particleEventIndex');

    const write = () => {
      const physical = this.state.journal ? eventIndex.mod(this.capacity) : eventIndex;
      const base = physical.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
      this.eventFloatStorage.element(base.add(EventFloatSlot.Metadata)).assign(vec4(
        bitcastUintToFloat(uint(type)),
        bitcastUintToFloat(particle.index),
        bitcastUintToFloat(particle.generation),
        bitcastUintToFloat(particle.tagMask),
      ));
      this.writeParticleSnapshot(physical, particle);
      for (let i = 0; i < 3; i += 1) {
        this.eventFloatStorage.element(base.add(EventFloatSlot.Payload0 + i)).assign(data[i] ?? vec4(0));
      }
    };
    if (this.state.journal) {
      write();
      If(eventIndex.sub(atomicLoad(this.counterStorage.element(uint(2)))).greaterThanEqual(this.capacity), () => {
        atomicAdd(this.counterStorage.element(uint(EventCounter.OverflowCount)), uint(1));
      });
    } else If(eventIndex.lessThan(uint(this.capacity)), write).Else(() => {
      atomicAdd(this.counterStorage.element(uint(EventCounter.OverflowCount)), uint(1));
    });
  }

  private writeParticleSnapshot(eventIndex: Node<'uint'>, particle: GPUParticleLike): void {
    const base = eventIndex.mul(GPU_EVENT_FLOAT_SLOT_COUNT);

    this.eventFloatStorage.element(base.add(EventFloatSlot.PositionSpeed)).assign(
      vec4(particle.position, particle.speed),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.OrbitCenterAlpha)).assign(
      vec4(particle.orbitCenter, particle.alpha),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.RotationMass)).assign(
      vec4(particle.rotation, particle.mass),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScaleDistortion)).assign(
      vec4(particle.scale, particle.distortionStrength),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.VelocityLifetime)).assign(
      vec4(particle.velocity, particle.lifetime),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.AngularVelocityTime)).assign(
      vec4(particle.angularVelocity, particle.time),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarVelocityRealtime)).assign(
      vec4(particle.scalarVelocity, particle.realtime),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.Acceleration)).assign(vec4(particle.acceleration, 0));
    this.eventFloatStorage.element(base.add(EventFloatSlot.AngularAcceleration)).assign(
      vec4(particle.angularAcceleration, 0),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarAcceleration)).assign(
      vec4(particle.scalarAcceleration, 0),
    );
    this.eventFloatStorage.element(base.add(EventFloatSlot.Color)).assign(
      vec4(particle.color, bitcastUintToFloat(uint(this.origin))),
    );
  }
}

export class GPUEventBufferState {
  readonly capacity: number;
  readonly version: number;
  sequence = 0;
  counterAttribute: StorageBufferAttribute;
  floatAttribute: StorageBufferAttribute;

  private readonly counterData: Uint32Array;
  readonly counterLength: number;
  readonly floatLength: number;
  /** @internal Readers and writers share node identities as well as GPU allocations. */
  readonly counterStorage: AtomicUintStorage;
  readonly eventFloatStorage: PackedFloatStorage;
  private frameReset?: ComputeNode;
  private snapshotCopy?: ComputeNode;
  private readonly boundaries = new Map<number, ComputeNode>();
  private readonly receiverSlots = new WeakMap<EventReceiver, { slot: number; revision: number }>();
  private readonly receiverDisposers = new Map<number, () => void>();
  private readonly baselines = new Map<number, ComputeNode>();
  private readonly freeReceiverSlots: number[] = [];
  private nextReceiverSlot = 0;
  private framePending = false;
  private dirtySnapshot = true;
  private readonly floatData: Float32Array;
  private static nextVersion = 1;

  constructor(capacity: number, readonly journal = false) {
    this.capacity = nextPowerOfTwo(capacity);
    this.counterLength = journal ? 4 + 1024 * 4 : GPU_EVENT_COUNTER_COUNT;
    this.floatLength = this.capacity * GPU_EVENT_FLOAT_SLOT_COUNT * (journal ? 2 : 1);
    this.counterData = new Uint32Array(this.counterLength);
    this.version = GPUEventBufferState.nextVersion;
    GPUEventBufferState.nextVersion += 1;
    this.floatData = new Float32Array(this.floatLength * 4);
    this.counterAttribute = new StorageBufferAttribute(this.counterData, 1);
    this.floatAttribute = new StorageBufferAttribute(this.floatData, 4);
    this.counterStorage = storage(this.counterAttribute, 'uint', this.counterLength).toAtomic() as AtomicUintStorage;
    this.eventFloatStorage = storage(this.floatAttribute, 'vec4', this.floatLength) as PackedFloatStorage;
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.counterAttribute);
    initializeStorageAttribute(renderer, this.floatAttribute);
    if (this.journal && this.framePending) {
      const counters = this.counterStorage;
      this.frameReset ??= Fn(() => {
        atomicStore(counters.element(uint(2)), atomicLoad(counters.element(uint(0))));
        atomicStore(counters.element(uint(1)), uint(0));
      })().compute(1);
      (renderer as GPUStorageBufferRenderer & { compute(node: ComputeNode): void }).compute(this.frameReset);
      this.framePending = false;
      this.dirtySnapshot = true;
    }
  }

  /** @internal Registration starts at the current producer cursor, without replaying earlier subscriptions. */
  register(receiver: EventReceiver,
    renderer: GPUStorageBufferRenderer & { compute(node: ComputeNode): void }): number {
    let selection = this.receiverSlots.get(receiver);
    if (selection?.revision === receiver.revision) return selection.slot;
    if (!selection) {
      const slot = this.freeReceiverSlots.pop() ?? this.nextReceiverSlot++;
      if (slot >= 1024) throw new Error('GPU event journal supports at most 1024 receivers per root.');
      selection = { slot, revision: receiver.revision };
      this.receiverSlots.set(receiver, selection);
      this.receiverDisposers.set(slot, receiver.onDispose(() => {
        this.receiverSlots.delete(receiver);
        this.receiverDisposers.delete(slot);
        this.freeReceiverSlots.push(slot);
      }));
    }
    selection.revision = receiver.revision;
    const { slot } = selection;
    if (!this.baselines.has(slot)) {
      const base = 4 + slot * 4;
      this.baselines.set(slot, Fn(() => {
        const cursor = atomicLoad(this.counterStorage.element(uint(0))).toVar();
        for (let field = 0; field < 3; field++) atomicStore(this.counterStorage.element(uint(base + field)), cursor);
        atomicStore(this.counterStorage.element(uint(base + 3)), uint(0));
      })().compute(1));
    }
    renderer.compute(this.baselines.get(slot)!);
    return slot;
  }

  /** @internal A read-only arena in the same storage binding protects consumers that also emit events. */
  snapshot(receiver: EventReceiver, renderer: GPUStorageBufferRenderer & { compute(node: ComputeNode): void }): number {
    this.initialize(renderer);
    const slot = this.register(receiver, renderer);
    const counters = this.counterStorage;
    if (this.dirtySnapshot) {
      const values = this.eventFloatStorage;
      this.snapshotCopy ??= Fn(() => {
        const offset = instanceIndex.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
        for (let field = 0; field < GPU_EVENT_FLOAT_SLOT_COUNT; field++) {
          values.element(offset.add(this.capacity * GPU_EVENT_FLOAT_SLOT_COUNT + field))
            .assign(values.element(offset.add(field)));
        }
      })().compute(this.capacity);
      renderer.compute(this.snapshotCopy);
      this.dirtySnapshot = false;
    }
    if (!this.boundaries.has(slot)) {
      const base = 4 + slot * 4;
      this.boundaries.set(slot, Fn(() => {
        const end = atomicLoad(counters.element(uint(0))).toVar();
        const cursor = atomicLoad(counters.element(uint(base + 2)));
        const available = end.sub(cursor).toVar();
        const retained = available.lessThan(this.capacity).select(available, uint(this.capacity));
        atomicStore(counters.element(uint(base)), end.sub(retained));
        atomicStore(counters.element(uint(base + 1)), end);
        atomicStore(counters.element(uint(base + 2)), end);
        atomicAdd(counters.element(uint(base + 3)), available.sub(retained));
      })().compute(1));
    }
    renderer.compute(this.boundaries.get(slot)!);
    return slot;
  }

  /** @internal */
  produced(): void { this.dirtySnapshot = true; }

  reset(sequence: number): void {
    this.sequence = sequence;
    if (this.journal) { this.framePending = true; return; }
    this.counterData[EventCounter.Count] = 0;
    this.counterData[EventCounter.OverflowCount] = 0;
    this.counterAttribute.needsUpdate = true;
  }

  createWriter(origin = 0): GPUEventWriter {
    return new GPUEventWriter(this, origin);
  }

  createReader(receiverSlot?: number): GPUEventReader {
    return new GPUEventReader(this, receiverSlot);
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.frameReset?.dispose();
    this.snapshotCopy?.dispose();
    this.boundaries.forEach(node => node.dispose());
    this.baselines.forEach(node => node.dispose());
    this.receiverDisposers.forEach(unsubscribe => unsubscribe());
    this.receiverDisposers.clear();
    destroyGPUStorageAttribute(renderer, this.counterAttribute);
    destroyGPUStorageAttribute(renderer, this.floatAttribute);
  }

  async readback(
    renderer: GPUReadbackRenderer,
    identityForEvent: (slot: number, generation: number) => Particle | undefined,
    origin?: number,
  ): Promise<GPUEventReadbackBatch> {
    const sequence = this.sequence;
    const [counterBuffer, floatBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.counterAttribute),
      renderer.getArrayBufferAsync(this.floatAttribute),
    ]);
    const counters = new Uint32Array(counterBuffer);
    const frameStart = this.journal ? counters[2] : 0;
    const rawEventCount = ((counters[EventCounter.Count] ?? 0) - frameStart) >>> 0;
    const overflowCount = counters[EventCounter.OverflowCount] ?? 0;
    const count = Math.min(rawEventCount, this.capacity);
    const events: GPUEventRecord[] = [];

    if (count <= 0) {
      return {
        sequence,
        events,
        overflowCount,
        rawEventCount,
        capacity: this.capacity,
      };
    }

    const eventFloatData = new Float32Array(floatBuffer);
    const eventUintData = new Uint32Array(floatBuffer);

    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const index = this.journal ? ((frameStart + Math.max(0, rawEventCount - count) + ordinal) >>> 0)
        % this.capacity : ordinal;
      if (origin !== undefined && eventUintData[packedOffset(index, EventFloatSlot.Color) + 3] !== origin) continue;
      const eventOffset = packedOffset(index, EventFloatSlot.Metadata);
      const type = eventUintData[eventOffset];
      if (type < 1 || type > 32) continue;

      const slot = eventUintData[eventOffset + 1];
      const generation = eventUintData[eventOffset + 2];
      const sequence = this.sequence;
      const tagMask = eventUintData[eventOffset + 3];
      const identity = identityForEvent(slot, generation);
      const particle = identity?.clone() ?? new Particle();
      // Synthetic GPU identity names the captured generation, never the current slot occupant.
      if (!identity) particle.id = `gpu:${slot}:${generation}`;
      readParticleSnapshot(eventFloatData, index, particle);
      particle.alive = type !== GPUEventType.Death;

      events.push({
        type,
        slot,
        generation,
        sequence,
        tagMask,
        particle,
        data: [0, 1, 2].map(i => new THREE.Vector4().fromArray(eventFloatData,
          packedOffset(index, EventFloatSlot.Payload0 + i))) as [THREE.Vector4, THREE.Vector4, THREE.Vector4],
        collision: type === GPUEventType.Collision
          ? {
            point: readNewVector(eventFloatData, index, EventFloatSlot.Payload0),
            normal: readNewVector(eventFloatData, index, EventFloatSlot.Payload1),
            impulse: readNewVector(eventFloatData, index, EventFloatSlot.Payload2),
          }
          : undefined,
      });
    }

    return {
      sequence,
      events,
      overflowCount,
      rawEventCount,
      capacity: this.capacity,
    };
  }
}

// TSL's bitcast helpers preserve bits rather than numerically converting, but their
// current declarations lose the concrete node generic, so the narrow cast is needed.
function bitcastFloatToUint(value: Node<'float'>): Node<'uint'> {
  return floatBitsToUint(value) as unknown as Node<'uint'>;
}

function bitcastUintToFloat(value: Node<'uint'>): Node<'float'> {
  return uintBitsToFloat(value) as unknown as Node<'float'>;
}

// Event snapshots have their own packed ABI. Selective readback uses the canonical
// particle buffer layout, so sharing slot readers would incorrectly couple the two.
function readParticleSnapshot(array: Float32Array, index: number, particle: Particle): void {
  readVector(array, index, EventFloatSlot.PositionSpeed, particle.position);
  readVector(array, index, EventFloatSlot.OrbitCenterAlpha, particle.orbitCenter);
  readVector(array, index, EventFloatSlot.RotationMass, particle.rotation);
  readVector(array, index, EventFloatSlot.ScaleDistortion, particle.scale);
  readVector(array, index, EventFloatSlot.VelocityLifetime, particle.velocity);
  readVector(array, index, EventFloatSlot.AngularVelocityTime, particle.angularVelocity);
  readVector(array, index, EventFloatSlot.ScalarVelocityRealtime, particle.scalarVelocity);
  readVector(array, index, EventFloatSlot.Acceleration, particle.acceleration);
  readVector(array, index, EventFloatSlot.AngularAcceleration, particle.angularAcceleration);
  readVector(array, index, EventFloatSlot.ScalarAcceleration, particle.scalarAcceleration);
  readColor(array, index, EventFloatSlot.Color, particle.color);

  particle.speed = readScalar(array, index, EventFloatSlot.PositionSpeed);
  particle.alpha = readScalar(array, index, EventFloatSlot.OrbitCenterAlpha);
  particle.mass = readScalar(array, index, EventFloatSlot.RotationMass);
  particle.distortionStrength = readScalar(array, index, EventFloatSlot.ScaleDistortion);
  particle.lifetime = readScalar(array, index, EventFloatSlot.VelocityLifetime);
  particle.time = readScalar(array, index, EventFloatSlot.AngularVelocityTime);
  particle.realtime = readScalar(array, index, EventFloatSlot.ScalarVelocityRealtime);
  particle.cache();
}

function readVector(array: Float32Array, index: number, slot: number, vector: THREE.Vector3): void {
  const offset = packedOffset(index, slot);
  vector.set(array[offset], array[offset + 1], array[offset + 2]);
}

function readNewVector(array: Float32Array, index: number, slot: number): THREE.Vector3 {
  const offset = packedOffset(index, slot);
  return new THREE.Vector3(array[offset], array[offset + 1], array[offset + 2]);
}

function readColor(array: Float32Array, index: number, slot: number, color: THREE.Color): void {
  const offset = packedOffset(index, slot);
  color.setRGB(array[offset], array[offset + 1], array[offset + 2]);
}

function readScalar(array: Float32Array, index: number, slot: number): number {
  return array[packedOffset(index, slot) + 3];
}

function packedOffset(index: number, slot: number): number {
  return (index * GPU_EVENT_FLOAT_SLOT_COUNT + slot) * 4;
}
