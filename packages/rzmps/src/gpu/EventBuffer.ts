import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { atomicAdd, atomicLoad, If, storage, uint, vec4 } from 'three/tsl';
import Particle from '../Particle';
import type { CollisionHit } from '../interfaces/ICollisionBackend';
import type { GPUParticleLike, GPUReadbackRenderer, GPUStorageBufferRenderer } from './Particle';

type PackedFloatStorage = { element(index: Node | number): Node<'vec4'> };
type PackedUintStorage = { element(index: Node | number): Node<'uvec4'> };
type PackedAtomicUintStorage = { element(index: Node | number): Node<'uint'> };

export enum GPUEventType {
  Death = 1,
  Spawn = 2,
  Collision = 3,
}
export const GPU_EVENT_FLOAT_SLOT_COUNT = 14;
const GPU_EVENT_UINT_SLOT_COUNT = 1;
const GPU_EVENT_COUNTER_COUNT = 4;

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
}

export interface GPUEventRecord {
  type: GPUEventType;
  slot: number;
  generation: number;
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

export class GPUEventReader {
  private readonly counterStorage: PackedAtomicUintStorage;
  private readonly eventUintStorage: PackedUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(private readonly state: GPUEventBufferState) {
    this.counterStorage = storage(state.counterAttribute, 'uint', GPU_EVENT_COUNTER_COUNT).toAtomic() as PackedAtomicUintStorage;
    this.eventUintStorage = storage(state.uintAttribute, 'uvec4', state.capacity) as PackedUintStorage;
    this.eventFloatStorage = storage(state.floatAttribute, 'vec4', state.capacity * GPU_EVENT_FLOAT_SLOT_COUNT) as PackedFloatStorage;
  }

  count(): Node<'uint'> {
    const count = atomicLoad(this.counterStorage.element(uint(0)));
    return count.lessThan(uint(this.state.capacity)).select(count, uint(this.state.capacity)) as Node<'uint'>;
  }

  load(index: Node<'uint'>): GPUEventNodeRecord {
    const record = this.eventUintStorage.element(index);
    const base = index.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
    const positionSpeed = this.eventFloatStorage.element(base.add(EventFloatSlot.PositionSpeed));
    const orbitCenterAlpha = this.eventFloatStorage.element(base.add(EventFloatSlot.OrbitCenterAlpha));
    const rotationMass = this.eventFloatStorage.element(base.add(EventFloatSlot.RotationMass));
    const scaleDistortion = this.eventFloatStorage.element(base.add(EventFloatSlot.ScaleDistortion));
    const velocityLifetime = this.eventFloatStorage.element(base.add(EventFloatSlot.VelocityLifetime));
    const angularVelocityTime = this.eventFloatStorage.element(base.add(EventFloatSlot.AngularVelocityTime));
    const scalarVelocityRealtime = this.eventFloatStorage.element(base.add(EventFloatSlot.ScalarVelocityRealtime));

    return {
      type: record.x,
      slot: record.y,
      generation: record.z,
      sequence: uint(this.state.sequence),
      particle: {
        index: record.y,
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
        tagMask: record.w,
        generation: record.z,
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

  private readonly counterStorage: PackedAtomicUintStorage;
  private readonly eventUintStorage: PackedUintStorage;
  private readonly eventFloatStorage: PackedFloatStorage;

  constructor(
    private readonly state: GPUEventBufferState,
    _frameSequenceNode: Node<'uint'>,
  ) {
    this.version = state.version;
    this.capacity = state.capacity;
    this.counterStorage = storage(state.counterAttribute, 'uint', GPU_EVENT_COUNTER_COUNT).toAtomic() as PackedAtomicUintStorage;
    this.eventUintStorage = storage(state.uintAttribute, 'uvec4', state.capacity * GPU_EVENT_UINT_SLOT_COUNT) as PackedUintStorage;
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
      this.counterStorage.element(uint(0)),
      uint(1),
    ).toVar('particleEventIndex');

    If(eventIndex.lessThan(uint(this.capacity)), () => {
      const eventRecord = this.eventUintStorage.element(eventIndex.mul(GPU_EVENT_UINT_SLOT_COUNT));
      eventRecord.x.assign(uint(type));
      eventRecord.y.assign(particle.index);
      eventRecord.z.assign(particle.generation);
      eventRecord.w.assign(particle.tagMask);
      this.writeParticleSnapshot(eventIndex, particle);
      if (collisionPoint && collisionNormal && collisionImpulse) {
        const base = eventIndex.mul(GPU_EVENT_FLOAT_SLOT_COUNT);
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionPoint)).assign(vec4(collisionPoint, 0));
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionNormal)).assign(vec4(collisionNormal, 0));
        this.eventFloatStorage.element(base.add(EventFloatSlot.CollisionImpulse)).assign(vec4(collisionImpulse, 0));
      }
    }).Else(() => {
      atomicAdd(this.counterStorage.element(uint(1)), uint(1));
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
  uintAttribute: StorageBufferAttribute;
  floatAttribute: StorageBufferAttribute;

  private readonly counterData = new Uint32Array(GPU_EVENT_COUNTER_COUNT);
  private readonly uintData: Uint32Array;
  private readonly floatData: Float32Array;
  private static nextVersion = 1;

  constructor(capacity: number) {
    this.capacity = 2 ** Math.ceil(Math.log2(Math.max(1, capacity)));
    this.version = GPUEventBufferState.nextVersion;
    GPUEventBufferState.nextVersion += 1;
    this.uintData = new Uint32Array(this.capacity * GPU_EVENT_UINT_SLOT_COUNT * 4);
    this.floatData = new Float32Array(this.capacity * GPU_EVENT_FLOAT_SLOT_COUNT * 4);
    this.counterAttribute = new StorageBufferAttribute(this.counterData, 1);
    this.uintAttribute = new StorageBufferAttribute(this.uintData, 4);
    this.floatAttribute = new StorageBufferAttribute(this.floatData, 4);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.counterAttribute);
    initializeStorageAttribute(renderer, this.uintAttribute);
    initializeStorageAttribute(renderer, this.floatAttribute);
  }

  reset(sequence: number): void {
    this.sequence = sequence;
    this.counterData[0] = 0;
    this.counterData[1] = 0;
    this.counterData[2] = sequence >>> 0;
    this.counterData[3] = this.capacity >>> 0;
    this.uintData.fill(0);
    this.counterAttribute.needsUpdate = true;
    this.uintAttribute.needsUpdate = true;
  }

  createWriter(frameSequenceNode: Node<'uint'>): GPUEventWriter {
    return new GPUEventWriter(this, frameSequenceNode);
  }

  createReader(): GPUEventReader {
    return new GPUEventReader(this);
  }

  async readback(
    renderer: GPUReadbackRenderer,
    identityForEvent: (slot: number, generation: number) => Particle | undefined,
  ): Promise<GPUEventReadbackBatch> {
    const sequence = this.sequence;
    const [counterBuffer, uintBuffer, floatBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.counterAttribute),
      renderer.getArrayBufferAsync(this.uintAttribute),
      renderer.getArrayBufferAsync(this.floatAttribute),
    ]);
    const counters = new Uint32Array(counterBuffer);
    const rawEventCount = counters[0] ?? 0;
    const overflowCount = counters[1] ?? 0;
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

    const eventUintData = new Uint32Array(uintBuffer);
    const eventFloatData = new Float32Array(floatBuffer);

    for (let index = 0; index < count; index += 1) {
      const eventOffset = index * GPU_EVENT_UINT_SLOT_COUNT * 4;
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
