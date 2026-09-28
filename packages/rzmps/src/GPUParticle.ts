import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { instanceIndex, storage } from 'three/tsl';
import Particle from './Particle';
import type ParticleSystem from './ParticleSystem';

type VectorField =
  | 'position'
  | 'orbitCenter'
  | 'rotation'
  | 'scale'
  | 'velocity'
  | 'angularVelocity'
  | 'scalarVelocity'
  | 'acceleration'
  | 'angularAcceleration'
  | 'scalarAcceleration'
  | 'color';

type ScalarField =
  | 'speed'
  | 'alpha'
  | 'mass'
  | 'distortionStrength'
  | 'lifetime'
  | 'time'
  | 'realtime';

type GPUParticleVectorNodes = Record<VectorField, Node<'vec3'>>;
type GPUParticleScalarNodes = Record<ScalarField, Node<'float'>>;
type PackedFloatStorage = { element(index: Node | number): Node<'vec4'> };
type PackedUintStorage = { element(index: Node | number): Node<'uvec4'> };

const FLOAT_SLOT_COUNT = 11;
const UINT_SLOT_COUNT = 1;

const SLOT = {
  positionSpeed: 0,
  orbitCenterAlpha: 1,
  rotationMass: 2,
  scaleDistortion: 3,
  velocityLifetime: 4,
  angularVelocityTime: 5,
  scalarVelocityRealtime: 6,
  acceleration: 7,
  angularAcceleration: 8,
  scalarAcceleration: 9,
  color: 10,
} as const;

export interface GPUParticleAttributes {
  floatData: StorageBufferAttribute;
  uintData: StorageBufferAttribute;
}

export interface GPUParticleBufferState {
  count: number;
  capacity: number;
  attributes: GPUParticleAttributes;
  particle: GPUParticle;
  initialize(renderer: GPUStorageBufferRenderer): GPUParticleBufferInitialization;
  upload(particles: Particle[], tagMaskForParticle?: (particle: Particle) => number): void;
  uploadRange(
    particles: Particle[],
    startIndex: number,
    tagMaskForParticle?: (particle: Particle) => number,
  ): void;
  sync(particles: Particle[], tagMaskForParticle?: (particle: Particle) => number): void;
  readback(renderer: GPUReadbackRenderer, particles: Particle[]): Promise<void>;
}

export interface GPUParticleBufferInitialization {
  floatCreated: boolean;
  uintCreated: boolean;
}

export interface GPUStorageBufferRenderer {
  backend?: unknown;
}

export interface GPUReadbackRenderer extends GPUStorageBufferRenderer {
  getArrayBufferAsync(
    attribute: StorageBufferAttribute,
    target?: ArrayBuffer | null,
    offset?: number,
    count?: number,
  ): Promise<ArrayBuffer>;
}

export interface GPUParticleUpdateContext {
  system: ParticleSystem;
  buffers: GPUParticleBufferState;
  deltaTime: number;
}

export class GPUParticle {
  readonly index = instanceIndex;

  readonly position: Node<'vec3'>;
  readonly orbitCenter: Node<'vec3'>;
  readonly rotation: Node<'vec3'>;
  readonly scale: Node<'vec3'>;
  readonly velocity: Node<'vec3'>;
  readonly angularVelocity: Node<'vec3'>;
  readonly scalarVelocity: Node<'vec3'>;
  readonly acceleration: Node<'vec3'>;
  readonly angularAcceleration: Node<'vec3'>;
  readonly scalarAcceleration: Node<'vec3'>;
  readonly color: Node<'vec3'>;

  readonly speed: Node<'float'>;
  readonly alpha: Node<'float'>;
  readonly mass: Node<'float'>;
  readonly distortionStrength: Node<'float'>;
  readonly lifetime: Node<'float'>;
  readonly time: Node<'float'>;
  readonly realtime: Node<'float'>;
  readonly alive: Node<'uint'>;
  readonly tagMask: Node<'uint'>;

  constructor(attributes: GPUParticleAttributes, capacity: number) {
    const floatStorage = storage(attributes.floatData, 'vec4', capacity * FLOAT_SLOT_COUNT) as PackedFloatStorage;
    const uintStorage = storage(attributes.uintData, 'uvec4', capacity * UINT_SLOT_COUNT) as PackedUintStorage;
    const vectors = createVectorNodes(floatStorage);
    const scalars = createScalarNodes(floatStorage);
    const state = uintStorage.element(instanceIndex.mul(UINT_SLOT_COUNT));

    this.position = vectors.position;
    this.orbitCenter = vectors.orbitCenter;
    this.rotation = vectors.rotation;
    this.scale = vectors.scale;
    this.velocity = vectors.velocity;
    this.angularVelocity = vectors.angularVelocity;
    this.scalarVelocity = vectors.scalarVelocity;
    this.acceleration = vectors.acceleration;
    this.angularAcceleration = vectors.angularAcceleration;
    this.scalarAcceleration = vectors.scalarAcceleration;
    this.color = vectors.color;

    this.speed = scalars.speed;
    this.alpha = scalars.alpha;
    this.mass = scalars.mass;
    this.distortionStrength = scalars.distortionStrength;
    this.lifetime = scalars.lifetime;
    this.time = scalars.time;
    this.realtime = scalars.realtime;
    this.alive = state.x;
    this.tagMask = state.y;
  }
}

export function createGPUParticleBufferState(
  particles: Particle[],
  capacity = particles.length,
  tagMaskForParticle?: (particle: Particle) => number,
): GPUParticleBufferState {
  return new GPUParticleBufferStateImpl(Math.max(1, capacity, particles.length), particles, tagMaskForParticle);
}

class GPUParticleBufferStateImpl implements GPUParticleBufferState {
  count = 0;
  capacity: number;
  attributes: GPUParticleAttributes;
  particle: GPUParticle;

  private floatData: Float32Array;
  private uintData: Uint32Array;

  constructor(
    capacity: number,
    particles: Particle[],
    tagMaskForParticle?: (particle: Particle) => number,
  ) {
    this.capacity = capacity;
    this.floatData = new Float32Array(capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(capacity * UINT_SLOT_COUNT * 4);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.particle = new GPUParticle(this.attributes, capacity);
    this.upload(particles, tagMaskForParticle);
  }

  initialize(renderer: GPUStorageBufferRenderer): GPUParticleBufferInitialization {
    return {
      floatCreated: initializeStorageAttribute(renderer, this.attributes.floatData),
      uintCreated: initializeStorageAttribute(renderer, this.attributes.uintData),
    };
  }

  upload(particles: Particle[], tagMaskForParticle?: (particle: Particle) => number): void {
    this.ensureCapacity(particles.length);

    this.count = particles.length;

    for (let index = 0; index < particles.length; index += 1) {
      this.writeParticle(index, particles[index], tagMaskForParticle);
    }

    for (let index = particles.length; index < this.capacity; index += 1) {
      writeState(this.uintData, index, 0, 0);
    }

    this.attributes.floatData.needsUpdate = true;
    this.attributes.uintData.needsUpdate = true;
  }

  uploadRange(
    particles: Particle[],
    startIndex: number,
    tagMaskForParticle?: (particle: Particle) => number,
  ): void {
    if (startIndex >= particles.length) return;

    this.ensureCapacity(particles.length);

    for (let index = startIndex; index < particles.length; index += 1) {
      this.writeParticle(index, particles[index], tagMaskForParticle);
    }

    const floatStart = startIndex * FLOAT_SLOT_COUNT * 4;
    const floatCount = (particles.length - startIndex) * FLOAT_SLOT_COUNT * 4;
    const uintStart = startIndex * UINT_SLOT_COUNT * 4;
    const uintCount = (particles.length - startIndex) * UINT_SLOT_COUNT * 4;

    this.attributes.floatData.addUpdateRange(floatStart, floatCount);
    this.attributes.uintData.addUpdateRange(uintStart, uintCount);
    this.attributes.floatData.needsUpdate = true;
    this.attributes.uintData.needsUpdate = true;
    this.count = particles.length;
  }

  sync(particles: Particle[], tagMaskForParticle?: (particle: Particle) => number): void {
    this.upload(particles, tagMaskForParticle);
  }

  async readback(renderer: GPUReadbackRenderer, particles: Particle[]): Promise<void> {
    const [floatBuffer, uintBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.attributes.floatData),
      renderer.getArrayBufferAsync(this.attributes.uintData),
    ]);

    this.floatData.set(new Float32Array(floatBuffer).subarray(0, this.floatData.length));
    this.uintData.set(new Uint32Array(uintBuffer).subarray(0, this.uintData.length));

    for (let index = 0; index < Math.min(this.count, particles.length); index += 1) {
      const particle = particles[index];

      readVector(this.floatData, index, SLOT.positionSpeed, particle.position);
      readVector(this.floatData, index, SLOT.orbitCenterAlpha, particle.orbitCenter);
      readVector(this.floatData, index, SLOT.rotationMass, particle.rotation);
      readVector(this.floatData, index, SLOT.scaleDistortion, particle.scale);
      readVector(this.floatData, index, SLOT.velocityLifetime, particle.velocity);
      readVector(this.floatData, index, SLOT.angularVelocityTime, particle.angularVelocity);
      readVector(this.floatData, index, SLOT.scalarVelocityRealtime, particle.scalarVelocity);
      readVector(this.floatData, index, SLOT.acceleration, particle.acceleration);
      readVector(this.floatData, index, SLOT.angularAcceleration, particle.angularAcceleration);
      readVector(this.floatData, index, SLOT.scalarAcceleration, particle.scalarAcceleration);
      readColor(this.floatData, index, SLOT.color, particle.color);

      particle.speed = readScalar(this.floatData, index, SLOT.positionSpeed);
      particle.alpha = readScalar(this.floatData, index, SLOT.orbitCenterAlpha);
      particle.mass = readScalar(this.floatData, index, SLOT.rotationMass);
      particle.distortionStrength = readScalar(this.floatData, index, SLOT.scaleDistortion);
      particle.lifetime = readScalar(this.floatData, index, SLOT.velocityLifetime);
      particle.time = readScalar(this.floatData, index, SLOT.angularVelocityTime);
      particle.realtime = readScalar(this.floatData, index, SLOT.scalarVelocityRealtime);
      particle.cache();
    }
  }

  private ensureCapacity(nextCount: number): void {
    if (nextCount <= this.capacity) return;

    const previousFloatData = this.floatData;
    const previousUintData = this.uintData;

    this.capacity = Math.max(1, nextCount);
    this.floatData = new Float32Array(this.capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * UINT_SLOT_COUNT * 4);
    this.floatData.set(previousFloatData);
    this.uintData.set(previousUintData);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.particle = new GPUParticle(this.attributes, this.capacity);
  }

  private writeParticle(
    index: number,
    particle: Particle,
    tagMaskForParticle?: (particle: Particle) => number,
  ): void {
    writeVectorAndScalar(this.floatData, index, SLOT.positionSpeed, particle.position, particle.speed);
    writeVectorAndScalar(this.floatData, index, SLOT.orbitCenterAlpha, particle.orbitCenter, particle.alpha);
    writeVectorAndScalar(this.floatData, index, SLOT.rotationMass, particle.rotation, particle.mass);
    writeVectorAndScalar(this.floatData, index, SLOT.scaleDistortion, particle.scale, particle.distortionStrength);
    writeVectorAndScalar(this.floatData, index, SLOT.velocityLifetime, particle.velocity, particle.lifetime);
    writeVectorAndScalar(this.floatData, index, SLOT.angularVelocityTime, particle.angularVelocity, particle.time);
    writeVectorAndScalar(this.floatData, index, SLOT.scalarVelocityRealtime, particle.scalarVelocity, particle.realtime);
    writeVectorAndScalar(this.floatData, index, SLOT.acceleration, particle.acceleration, 0);
    writeVectorAndScalar(this.floatData, index, SLOT.angularAcceleration, particle.angularAcceleration, 0);
    writeVectorAndScalar(this.floatData, index, SLOT.scalarAcceleration, particle.scalarAcceleration, 0);
    writeColor(this.floatData, index, SLOT.color, particle.color);

    writeState(this.uintData, index, 1, tagMaskForParticle?.(particle) ?? 0);
  }
}

function createAttributes(floatData: Float32Array, uintData: Uint32Array): GPUParticleAttributes {
  return {
    floatData: new StorageBufferAttribute(floatData, 4),
    uintData: new StorageBufferAttribute(uintData, 4),
  };
}

function initializeStorageAttribute(
  renderer: GPUStorageBufferRenderer,
  attribute: StorageBufferAttribute,
): boolean {
  const backend = renderer.backend as {
    get?(attribute: StorageBufferAttribute): { buffer?: unknown };
    createStorageAttribute?(attribute: StorageBufferAttribute): void;
  } | undefined;
  const data = backend?.get?.(attribute);

  if (!data?.buffer) {
    backend?.createStorageAttribute?.(attribute);
    return true;
  }

  return false;
}

function createVectorNodes(floatStorage: PackedFloatStorage): GPUParticleVectorNodes {
  return {
    position: floatElement(floatStorage, SLOT.positionSpeed).xyz,
    orbitCenter: floatElement(floatStorage, SLOT.orbitCenterAlpha).xyz,
    rotation: floatElement(floatStorage, SLOT.rotationMass).xyz,
    scale: floatElement(floatStorage, SLOT.scaleDistortion).xyz,
    velocity: floatElement(floatStorage, SLOT.velocityLifetime).xyz,
    angularVelocity: floatElement(floatStorage, SLOT.angularVelocityTime).xyz,
    scalarVelocity: floatElement(floatStorage, SLOT.scalarVelocityRealtime).xyz,
    acceleration: floatElement(floatStorage, SLOT.acceleration).xyz,
    angularAcceleration: floatElement(floatStorage, SLOT.angularAcceleration).xyz,
    scalarAcceleration: floatElement(floatStorage, SLOT.scalarAcceleration).xyz,
    color: floatElement(floatStorage, SLOT.color).xyz,
  };
}

function createScalarNodes(floatStorage: PackedFloatStorage): GPUParticleScalarNodes {
  return {
    speed: floatElement(floatStorage, SLOT.positionSpeed).w,
    alpha: floatElement(floatStorage, SLOT.orbitCenterAlpha).w,
    mass: floatElement(floatStorage, SLOT.rotationMass).w,
    distortionStrength: floatElement(floatStorage, SLOT.scaleDistortion).w,
    lifetime: floatElement(floatStorage, SLOT.velocityLifetime).w,
    time: floatElement(floatStorage, SLOT.angularVelocityTime).w,
    realtime: floatElement(floatStorage, SLOT.scalarVelocityRealtime).w,
  };
}

function floatElement(floatStorage: PackedFloatStorage, slot: number): Node<'vec4'> {
  return floatStorage.element(instanceIndex.mul(FLOAT_SLOT_COUNT).add(slot));
}

function packedOffset(index: number, slot: number): number {
  return (index * FLOAT_SLOT_COUNT + slot) * 4;
}

function stateOffset(index: number): number {
  return index * UINT_SLOT_COUNT * 4;
}

function writeVectorAndScalar(
  array: Float32Array,
  index: number,
  slot: number,
  vector: THREE.Vector3,
  scalar: number,
): void {
  const offset = packedOffset(index, slot);
  array[offset] = vector.x;
  array[offset + 1] = vector.y;
  array[offset + 2] = vector.z;
  array[offset + 3] = scalar;
}

function writeColor(array: Float32Array, index: number, slot: number, color: THREE.Color): void {
  const offset = packedOffset(index, slot);
  array[offset] = color.r;
  array[offset + 1] = color.g;
  array[offset + 2] = color.b;
  array[offset + 3] = 0;
}

function writeState(array: Uint32Array, index: number, alive: number, tagMask: number): void {
  const offset = stateOffset(index);
  array[offset] = alive;
  array[offset + 1] = tagMask >>> 0;
  array[offset + 2] = 0;
  array[offset + 3] = 0;
}

function readVector(array: Float32Array, index: number, slot: number, vector: THREE.Vector3): void {
  const offset = packedOffset(index, slot);
  vector.set(array[offset], array[offset + 1], array[offset + 2]);
}

function readColor(array: Float32Array, index: number, slot: number, color: THREE.Color): void {
  const offset = packedOffset(index, slot);
  color.setRGB(array[offset], array[offset + 1], array[offset + 2]);
}

function readScalar(array: Float32Array, index: number, slot: number): number {
  return array[packedOffset(index, slot) + 3];
}
