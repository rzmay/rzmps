import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  atomicAdd,
  atomicLoad,
  float,
  floatBitsToUint,
  If,
  storage,
  uint,
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
  CollisionPoint,
  CollisionNormal,
  CollisionImpulse,
  Metadata,
}

export const GPU_EVENT_FLOAT_SLOT_COUNT = Object.keys(EventFloatSlot).filter(key => isNaN(Number(key))).length;

export interface GPUEventRecord {
  type: GPUEventType;
  slot: number;
  /** Slot incarnation, incremented whenever a slot is recycled. */
  generation: number;
  /** Simulation frame that emitted the event, used to order async readbacks. */
  sequence: number;
  tagMask?: number;
  particle: Particle;
  collision?: CollisionHit;
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
  collisionPoint: Node<'vec3'>;
  collisionNormal: Node<'vec3'>;
  collisionImpulse: Node<'vec3'>;
}

/** Shader-side random-access reader used to consume an already populated stream. */
export class GPUEventReader {
  private readonly counterStorage: AtomicUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(private readonly state: GPUEventBufferState) {
    this.counterStorage = storage(state.counterAttribute, 'uint', GPU_EVENT_COUNTER_COUNT).toAtomic() as AtomicUintStorage;
    this.eventFloatStorage = storage(state.floatAttribute, 'vec4', state.capacity * GPU_EVENT_FLOAT_SLOT_COUNT) as PackedFloatStorage;
  }

  count(): Node<'uint'> {
    const count = atomicLoad(this.counterStorage.element(uint(EventCounter.Count)));
    return count.lessThan(uint(this.state.capacity)).select(count, uint(this.state.capacity)) as Node<'uint'>;
  }

  load(index: Node<'uint'>): GPUEventNodeRecord {
    const base = index.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
    const record = this.eventFloatStorage.element(base.add(EventFloatSlot.Metadata));
    const positionSpeed = this.eventFloatStorage.element(base.add(EventFloatSlot.PositionSpeed));
    const orbitCenterAlpha = this.eventFloatStorage.element(base.add(EventFloatSlot.OrbitCenterAlpha));
    const rotationMass = this.eventFloatStorage.element(base.add(EventFloatSlot.RotationMass));
    const scaleDistortion = this.eventFloatStorage.element(base.add(EventFloatSlot.ScaleDistortion));
    const velocityLifetime = this.eventFloatStorage.element(base.add(EventFloatSlot.VelocityLifetime));
    const angularVelocityTime = this.eventFloatStorage.element(base.add(EventFloatSlot.AngularVelocityTime));
    const scalarVelocityRealtime = this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarVelocityRealtime));

    return {
      type: bitcastFloatToUint(record.x),
      slot: bitcastFloatToUint(record.y),
      generation: bitcastFloatToUint(record.z),
      sequence: uint(this.state.sequence),
      particle: {
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
      },
      collisionPoint: this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionPoint)).xyz,
      collisionNormal: this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionNormal)).xyz,
      collisionImpulse: this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionImpulse)).xyz,
    };
  }
}

export class GPUEventWriter {
  readonly version: number;
  readonly capacity: number;

  private readonly counterStorage: AtomicUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(state: GPUEventBufferState) {
    this.version = state.version;
    this.capacity = state.capacity;
    this.counterStorage = storage(state.counterAttribute, 'uint', GPU_EVENT_COUNTER_COUNT).toAtomic() as AtomicUintStorage;
    this.eventFloatStorage = storage(state.floatAttribute, 'vec4', state.capacity * GPU_EVENT_FLOAT_SLOT_COUNT) as PackedFloatStorage;
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
    this.emitParticleEvent(GPUEventType.Collision, particle, point, normal, impulse);
  }

  private emitParticleEvent(
    type: number,
    particle: GPUParticleLike,
    collisionPoint?: Node<'vec3'>,
    collisionNormal?: Node<'vec3'>,
    collisionImpulse?: Node<'vec3'>,
  ): void {
    const eventIndex = atomicAdd(
      this.counterStorage.element(uint(EventCounter.Count)),
      uint(1),
    ).toVar('particleEventIndex');

    If(eventIndex.lessThan(uint(this.capacity)), () => {
      const base = eventIndex.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
      this.eventFloatStorage.element(base.add(EventFloatSlot.Metadata)).assign(vec4(
        bitcastUintToFloat(uint(type)),
        bitcastUintToFloat(particle.index),
        bitcastUintToFloat(particle.generation),
        bitcastUintToFloat(particle.tagMask),
      ));
      this.writeParticleSnapshot(eventIndex, particle);
      if (collisionPoint && collisionNormal && collisionImpulse) {
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionPoint)).assign(vec4(collisionPoint, 0));
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionNormal)).assign(vec4(collisionNormal, 0));
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionImpulse)).assign(vec4(collisionImpulse, 0));
      }
    }).Else(() => {
      atomicAdd(this.counterStorage.element(uint(EventCounter.OverflowCount)), uint(1));
    });
  }

  private writeParticleSnapshot(eventIndex: Node<'uint'>, particle: GPUParticleLike): void {
    const base = eventIndex.mul(GPU_EVENT_FLOAT_SLOT_COUNT);

    this.eventFloatStorage.element(base.add(EventFloatSlot.PositionSpeed)).assign(vec4(particle.position, particle.speed));
    this.eventFloatStorage.element(base.add(EventFloatSlot.OrbitCenterAlpha)).assign(vec4(particle.orbitCenter, particle.alpha));
    this.eventFloatStorage.element(base.add(EventFloatSlot.RotationMass)).assign(vec4(particle.rotation, particle.mass));
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScaleDistortion)).assign(vec4(particle.scale, particle.distortionStrength));
    this.eventFloatStorage.element(base.add(EventFloatSlot.VelocityLifetime)).assign(vec4(particle.velocity, particle.lifetime));
    this.eventFloatStorage.element(base.add(EventFloatSlot.AngularVelocityTime)).assign(vec4(particle.angularVelocity, particle.time));
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarVelocityRealtime)).assign(vec4(particle.scalarVelocity, particle.realtime));
    this.eventFloatStorage.element(base.add(EventFloatSlot.Acceleration)).assign(vec4(particle.acceleration, 0));
    this.eventFloatStorage.element(base.add(EventFloatSlot.AngularAcceleration)).assign(vec4(particle.angularAcceleration, 0));
    this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarAcceleration)).assign(vec4(particle.scalarAcceleration, 0));
    this.eventFloatStorage.element(base.add(EventFloatSlot.Color)).assign(vec4(particle.color, 0));
  }
}

export class GPUEventBufferState {
  readonly capacity: number;
  readonly version: number;
  sequence = 0;
  counterAttribute: StorageBufferAttribute;
  floatAttribute: StorageBufferAttribute;

  private readonly counterData = new Uint32Array(GPU_EVENT_COUNTER_COUNT);
  private readonly floatData: Float32Array;
  private static nextVersion = 1;

  constructor(capacity: number) {
    this.capacity = nextPowerOfTwo(capacity);
    this.version = GPUEventBufferState.nextVersion;
    GPUEventBufferState.nextVersion += 1;
    this.floatData = new Float32Array(this.capacity * GPU_EVENT_FLOAT_SLOT_COUNT * 4);
    this.counterAttribute = new StorageBufferAttribute(this.counterData, 1);
    this.floatAttribute = new StorageBufferAttribute(this.floatData, 4);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.counterAttribute);
    initializeStorageAttribute(renderer, this.floatAttribute);
  }

  reset(sequence: number): void {
    this.sequence = sequence;
    this.counterData[EventCounter.Count] = 0;
    this.counterData[EventCounter.OverflowCount] = 0;
    this.counterAttribute.needsUpdate = true;
  }

  createWriter(): GPUEventWriter {
    return new GPUEventWriter(this);
  }

  createReader(): GPUEventReader {
    return new GPUEventReader(this);
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    destroyGPUStorageAttribute(renderer, this.counterAttribute);
    destroyGPUStorageAttribute(renderer, this.floatAttribute);
  }

  async readback(
    renderer: GPUReadbackRenderer,
    identityForEvent: (slot: number, generation: number) => Particle | undefined,
  ): Promise<GPUEventReadbackBatch> {
    const sequence = this.sequence;
    const [counterBuffer, floatBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.counterAttribute),
      renderer.getArrayBufferAsync(this.floatAttribute),
    ]);
    const counters = new Uint32Array(counterBuffer);
    const rawEventCount = counters[EventCounter.Count] ?? 0;
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

    for (let index = 0; index < count; index += 1) {
      const eventOffset = packedOffset(index, EventFloatSlot.Metadata);
      const type = eventUintData[eventOffset];
      if (
        type !== GPUEventType.Death
        && type !== GPUEventType.Spawn
        && type !== GPUEventType.Collision
      ) continue;

      const slot = eventUintData[eventOffset + 1];
      const generation = eventUintData[eventOffset + 2];
      const sequence = this.sequence;
      const tagMask = eventUintData[eventOffset + 3];
      const identity = identityForEvent(slot, generation);
      const particle = identity?.clone() ?? new Particle();
      readParticleSnapshot(eventFloatData, index, particle);
      particle.alive = type !== GPUEventType.Death;

      events.push({
        type,
        slot,
        generation,
        sequence,
        tagMask,
        particle,
        collision: type === GPUEventType.Collision
          ? {
            point: readNewVector(eventFloatData, index, EventFloatSlot.CollisionPoint),
            normal: readNewVector(eventFloatData, index, EventFloatSlot.CollisionNormal),
            impulse: readNewVector(eventFloatData, index, EventFloatSlot.CollisionImpulse),
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
