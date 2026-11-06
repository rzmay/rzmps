import type { GPUEventBatch } from './EventBatch';
import type { GPUEventPayload } from '../Events';
import type { Tag } from '../types/Tag';
import {
  ParticleFloatSlot, ParticleRenderFloatSlot, FLOAT_SLOT_COUNT, RENDER_FLOAT_SLOT_COUNT, UINT_SLOT_COUNT,
  createAttributes, renderFloatElement, packedOffset, stateOffset, writeVectorAndScalar,
  writeState, readVector, readScalar,
} from './ParticleLayout';
import * as THREE from 'three';
import { StorageBufferAttribute, IndirectStorageBufferAttribute, type ComputeNode } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { vec4, float, uint, uvec2, Fn, instanceIndex, storage } from 'three/tsl';
import Particle, { getParticleSourceBinding } from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { GPUAllocationWriter } from './AllocationBuffer';
import type { GPUCollisionEventWriter, GPUEventWriter } from './EventBuffer';
import {
  destroyStorageAttribute,
  initializeStorageAttribute,
  nextPowerOfTwo,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
  type PackedFloatStorage,
  type PackedUintStorage,
} from './Storage';

export type { GPUReadbackRenderer, GPUStorageBufferRenderer } from './Storage';

export type GPUParticleVectorField =
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

export type GPUParticleScalarField =
  | 'speed'
  | 'alpha'
  | 'mass'
  | 'distortionStrength'
  | 'lifetime'
  | 'time'
  | 'realtime';

type GPUParticleVectorNodes = Record<GPUParticleVectorField, Node<'vec3'>>;
type GPUParticleScalarNodes = Record<GPUParticleScalarField, Node<'float'>>;



export interface GPUParticleAttributes {
  floatData: StorageBufferAttribute;
  uintData: StorageBufferAttribute;
}

/** Reports which backend resources were newly created during initialization. */
export interface GPUParticleBufferInitialization {
  floatCreated: boolean;
  uintCreated: boolean;
}

export interface GPUParticleUpdateContext {
  /** Native event storage, frozen for the receiving component's execution. */
  events?: GPUEventBatch;
  system: ParticleSystem;
  buffers: GPUParticleBufferState;
  deltaTime: number;
  deltaTimeNode: Node<'float'>;
  elapsedTimeNode: Node<'float'>;
  emitterPositionNode?: Node<'vec3'>;
  gravityNode: Node<'vec3'>;
  simulationToWorldNode: Node<'mat4'>;
  worldToSimulationNode: Node<'mat4'>;
  allocationWriter?: GPUAllocationWriter;
  eventWriter?: GPUEventWriter;
  collisionEventWriter?: GPUCollisionEventWriter;
}

export interface GPUParticleLike {
  readonly materialCopy?: Node<'vec4'>;
  readonly materialCopyU?: Node<'vec4'>;
  readonly materialCopyV?: Node<'vec4'>;
  /** Marks this particle dead in the current GPU update. */
  kill(): void;
  emitEvent(event: string, payload?: GPUEventPayload): void;
  /** Adds a tag registered by an emitter, module, renderer, spatial effect, or subsystem selector. */
  addTag(tag: Tag): void;
  /** Removes a registered tag while preserving all other tags. */
  removeTag(tag: Tag): void;
  readonly id: Node<'uvec2'>;
  readonly isChild: Node<'bool'>;
  readonly parent: GPUParticleLike | null;
  readonly root: GPUParticleLike;
  readonly index: Node<'uint'>;
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
  readonly generation: Node<'uint'>;
  readonly lodPriority: Node<'uint'>;
}

/** Shader-node view of one particle; unlike Particle, this is not a CPU value object. */
export class GPUParticleContext implements GPUParticleLike {
  readonly materialCopy: Node<'vec4'>;
  readonly materialCopyU: Node<'vec4'>;
  readonly materialCopyV: Node<'vec4'>;
  /** Marks the particle dead and advances its age past its lifetime using finite GPU values. */
  kill(): void {
    this.realtime.assign(this.lifetime.mul(1000).add(1));
    this.time.assign(float(1).add(float(0.001).div(this.lifetime.max(0.000001))));
    this.alive.assign(uint(0));
  }
  /** Builds a tag mutation inside a system's GPU update callback. */
  addTag(tag: Tag): void {
    throw new Error(`Adding GPU tag '${tag}' requires a particle system update context.`);
  }
  /** Builds a tag mutation inside a system's GPU update callback. */
  removeTag(tag: Tag): void {
    throw new Error(`Removing GPU tag '${tag}' requires a particle system update context.`);
  }
  private eventDispatcher?: (event: string, payload?: GPUEventPayload) => void;
  /** Builds an event-buffer write at this point in the TSL graph. */
  emitEvent(event: string, payload?: GPUEventPayload): void { this.eventDispatcher?.(event, payload); }
  /** @internal */
  setEventDispatcher(dispatch: (event: string, payload?: GPUEventPayload) => void): void { this.eventDispatcher =
    dispatch; }

  readonly contribution = float(1);
  readonly index: Node<'uint'>;

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
  readonly generation: Node<'uint'>;
  readonly lodPriority: Node<'uint'>;

  get id(): Node<'uvec2'> {
    return uvec2(this.index, this.generation);
  }

  get isChild(): Node<'bool'> {
    return uint(0).equal(uint(1));
  }

  get parent(): null {
    return null;
  }

  get root(): GPUParticleContext {
    return this;
  }

  get lodPriorityValue(): Node<'float'> {
    return float(this.lodPriority).div(4294967296);
  }

  constructor(
    index: Node<'uint'>,
    vectors: GPUParticleVectorNodes,
    scalars: GPUParticleScalarNodes,
    alive: Node<'uint'>,
    tagMask: Node<'uint'>,
    generation: Node<'uint'>,
    materializeLocals = false,
    lodPriority: Node<'uint'> = uint(0),
    appearance: Node<'vec4'>[] = [vec4(0), vec4(0), vec4(0)],
  ) {
    this.materialCopy = materializeLocals ? appearance[0].toVar() : appearance[0];
    this.materialCopyU = materializeLocals ? appearance[1].toVar() : appearance[1];
    this.materialCopyV = materializeLocals ? appearance[2].toVar() : appearance[2];
    this.lodPriority = materializeLocals ? lodPriority.toVar('lodPriority') : lodPriority;
    this.index = index;
    this.position = materializeLocals ? vectors.position.toVar('particlePosition') : vectors.position;
    this.orbitCenter = materializeLocals ? vectors.orbitCenter.toVar('particleOrbitCenter') : vectors.orbitCenter;
    this.rotation = materializeLocals ? vectors.rotation.toVar('particleRotation') : vectors.rotation;
    this.scale = materializeLocals ? vectors.scale.toVar('particleScale') : vectors.scale;
    this.velocity = materializeLocals ? vectors.velocity.toVar('particleVelocity') : vectors.velocity;
    this.angularVelocity = materializeLocals
      ? vectors.angularVelocity.toVar('particleAngularVelocity')
      : vectors.angularVelocity;
    this.scalarVelocity = materializeLocals
      ? vectors.scalarVelocity.toVar('particleScalarVelocity')
      : vectors.scalarVelocity;
    this.acceleration = materializeLocals ? vectors.acceleration.toVar('particleAcceleration') : vectors.acceleration;
    this.angularAcceleration = materializeLocals
      ? vectors.angularAcceleration.toVar('particleAngularAcceleration')
      : vectors.angularAcceleration;
    this.scalarAcceleration = materializeLocals
      ? vectors.scalarAcceleration.toVar('particleScalarAcceleration')
      : vectors.scalarAcceleration;
    this.color = materializeLocals ? vectors.color.toVar('particleColor') : vectors.color;

    this.speed = materializeLocals ? scalars.speed.toVar('particleSpeed') : scalars.speed;
    this.alpha = materializeLocals ? scalars.alpha.toVar('particleAlpha') : scalars.alpha;
    this.mass = materializeLocals ? scalars.mass.toVar('particleMass') : scalars.mass;
    this.distortionStrength = materializeLocals
      ? scalars.distortionStrength.toVar('particleDistortionStrength')
      : scalars.distortionStrength;
    this.lifetime = materializeLocals ? scalars.lifetime.toVar('particleLifetime') : scalars.lifetime;
    this.time = materializeLocals ? scalars.time.toVar('particleTime') : scalars.time;
    this.realtime = materializeLocals ? scalars.realtime.toVar('particleRealtime') : scalars.realtime;
    this.alive = materializeLocals ? alive.toVar('particleAlive') : alive;
    this.tagMask = materializeLocals ? tagMask.toVar('particleTagMask') : tagMask;
    this.generation = materializeLocals ? generation.toVar('particleGeneration') : generation;
  }
}

export class GPUParticleStorage {
  /** @internal Shared packed storage for schema-compatible emission snapshots. */
  readonly floatStorage: PackedFloatStorage;
  private readonly uintStorage: PackedUintStorage;

  constructor(
    private readonly attributes: GPUParticleAttributes,
    private readonly capacity: number,
  ) {
    this.floatStorage = storage(attributes.floatData, 'vec4', capacity * FLOAT_SLOT_COUNT) as PackedFloatStorage;
    this.uintStorage = storage(attributes.uintData, 'uvec4', capacity * UINT_SLOT_COUNT) as PackedUintStorage;
  }

  createVectorNodes(index: Node<'uint'> = instanceIndex): GPUParticleVectorNodes {
    return {
      position: this.floatElement(ParticleFloatSlot.PositionSpeed, index).xyz,
      orbitCenter: this.floatElement(ParticleFloatSlot.OrbitCenterAlpha, index).xyz,
      rotation: this.floatElement(ParticleFloatSlot.RotationMass, index).xyz,
      scale: this.floatElement(ParticleFloatSlot.ScaleDistortion, index).xyz,
      velocity: this.floatElement(ParticleFloatSlot.VelocityLifetime, index).xyz,
      angularVelocity: this.floatElement(ParticleFloatSlot.AngularVelocityTime, index).xyz,
      scalarVelocity: this.floatElement(ParticleFloatSlot.ScalarVelocityRealtime, index).xyz,
      acceleration: this.floatElement(ParticleFloatSlot.Acceleration, index).xyz,
      angularAcceleration: this.floatElement(ParticleFloatSlot.AngularAcceleration, index).xyz,
      scalarAcceleration: this.floatElement(ParticleFloatSlot.ScalarAcceleration, index).xyz,
      color: this.floatElement(ParticleFloatSlot.Color, index).xyz,
    };
  }

  createScalarNodes(index: Node<'uint'> = instanceIndex): GPUParticleScalarNodes {
    return {
      speed: this.floatElement(ParticleFloatSlot.PositionSpeed, index).w,
      alpha: this.floatElement(ParticleFloatSlot.OrbitCenterAlpha, index).w,
      mass: this.floatElement(ParticleFloatSlot.RotationMass, index).w,
      distortionStrength: this.floatElement(ParticleFloatSlot.ScaleDistortion, index).w,
      lifetime: this.floatElement(ParticleFloatSlot.VelocityLifetime, index).w,
      time: this.floatElement(ParticleFloatSlot.AngularVelocityTime, index).w,
      realtime: this.floatElement(ParticleFloatSlot.ScalarVelocityRealtime, index).w,
    };
  }

  createStateNode(index: Node<'uint'> = instanceIndex): Node<'uvec4'> {
    return this.uintStorage.element(index.mul(UINT_SLOT_COUNT));
  }

  /** @internal Source slot, generation, kind, and initialization state, bit-packed into one vec4. */
  createSourceIdentityNode(index: Node<'uint'> = instanceIndex): Node<'vec4'> {
    return this.floatElement(ParticleFloatSlot.SourceIdentity, index);
  }

  createParticle(
    index: Node<'uint'> = instanceIndex,
    materializeLocals = false,
  ): GPUParticleContext {
    const state = this.createStateNode(index);
    return new GPUParticleContext(
      index,
      this.createVectorNodes(index),
      this.createScalarNodes(index),
      state.x,
      state.y,
      state.z,
      materializeLocals,
      state.w,
      [this.floatElement(ParticleFloatSlot.MaterialCopy, index),
        this.floatElement(ParticleFloatSlot.MaterialCopyU, index),
        this.floatElement(ParticleFloatSlot.MaterialCopyV, index)],
    );
  }

  private floatElement(slot: ParticleFloatSlot, index: Node<'uint'>): Node<'vec4'> {
    return this.floatStorage.element(index.mul(FLOAT_SLOT_COUNT).add(slot));
  }

  storeParticle(particle: GPUParticleLike): void {
    const vectors = this.createVectorNodes(particle.index);
    const scalars = this.createScalarNodes(particle.index);
    const state = this.createStateNode(particle.index);

    vectors.position.assign(particle.position);
    vectors.orbitCenter.assign(particle.orbitCenter);
    vectors.rotation.assign(particle.rotation);
    vectors.scale.assign(particle.scale);
    vectors.velocity.assign(particle.velocity);
    vectors.angularVelocity.assign(particle.angularVelocity);
    vectors.scalarVelocity.assign(particle.scalarVelocity);
    vectors.acceleration.assign(particle.acceleration);
    vectors.angularAcceleration.assign(particle.angularAcceleration);
    vectors.scalarAcceleration.assign(particle.scalarAcceleration);
    vectors.color.assign(particle.color);
    scalars.speed.assign(particle.speed);
    scalars.alpha.assign(particle.alpha);
    scalars.mass.assign(particle.mass);
    scalars.distortionStrength.assign(particle.distortionStrength);
    scalars.lifetime.assign(particle.lifetime);
    scalars.time.assign(particle.time);
    scalars.realtime.assign(particle.realtime);
    state.x.assign(particle.alive);
    state.y.assign(particle.tagMask);
    state.z.assign(particle.generation);
    state.w.assign(particle.lodPriority);
    this.floatElement(ParticleFloatSlot.MaterialCopy, particle.index).assign(particle.materialCopy ?? vec4(0));
    this.floatElement(ParticleFloatSlot.MaterialCopyU, particle.index).assign(particle.materialCopyU ?? vec4(0));
    this.floatElement(ParticleFloatSlot.MaterialCopyV, particle.index).assign(particle.materialCopyV ?? vec4(0));
  }
}

export class GPUParticleRenderContext {
  get materialCopy(): Node<'vec4'> { return this.owner?.appearance(this.index, 0) ?? vec4(0); }
  get materialCopyU(): Node<'vec4'> { return this.owner?.appearance(this.index, 1) ?? vec4(0); }
  get materialCopyV(): Node<'vec4'> { return this.owner?.appearance(this.index, 2) ?? vec4(0); }
  readonly velocity: Node<'vec3'>;
  readonly contribution: Node<'float'>;
  readonly index: Node<'uint'>;
  readonly position: Node<'vec3'>;
  readonly rotation: Node<'vec3'>;
  readonly scale: Node<'vec3'>;
  readonly color: Node<'vec3'>;
  readonly alpha: Node<'float'>;
  readonly distortionStrength: Node<'float'>;
  readonly realtime: Node<'float'>;
  readonly time: Node<'float'>;
  readonly alive: Node<'uint'>;
  readonly tagMask: Node<'uint'>;
  readonly generation: Node<'uint'>;
  readonly lodPriority: Node<'uint'>;

  constructor(
    index: Node<'uint'>,
    vectors: Pick<GPUParticleVectorNodes, 'position' | 'rotation' | 'scale' | 'color' | 'velocity'>,
    scalars: Pick<GPUParticleScalarNodes, 'alpha' | 'distortionStrength' | 'realtime' | 'time'>
      & { contribution: Node<'float'> },
    state: Node<'uvec4'>,
    private readonly owner?: GPUParticleRenderStorage,
  ) {
    this.index = index;
    this.contribution = scalars.contribution;
    this.velocity = vectors.velocity;
    this.position = vectors.position;
    this.rotation = vectors.rotation;
    this.scale = vectors.scale;
    this.color = vectors.color;
    this.alpha = scalars.alpha;
    this.distortionStrength = scalars.distortionStrength;
    this.realtime = scalars.realtime;
    this.time = scalars.time;
    this.alive = state.x;
    this.tagMask = state.y;
    this.generation = state.z;
    this.lodPriority = state.w;
  }

  get id(): Node<'uvec2'> {
    return this.owner?.identity(this.index) ?? uvec2(this.index, this.generation);
  }

  get isChild(): Node<'bool'> {
    return this.owner?.hierarchy
      ? this.index.greaterThanEqual(this.owner.hierarchy.originalCount)
      : uint(0).equal(uint(1));
  }

  get parent(): GPUParticleRenderContext {
    return this.owner?.createParticle(this.owner.parentIndex(this.index)) ?? this;
  }

  get root(): GPUParticleRenderContext {
    if (!this.owner) return this;
    const parent = this.owner.parentIndex(this.index);
    return this.owner.createParticle(this.owner.parentIndex(parent));
  }

  get lodPriorityValue(): Node<'float'> {
    return float(this.lodPriority).div(4294967296);
  }

}

/** Accesses the compact particle attributes consumed by renderer compute/material nodes. */
export class GPUParticleRenderStorage {
  appearance(index: Node<'uint'>, row: number): Node<'vec4'> {
    return renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.MaterialCopy + row, index);
  }
  hierarchy?: {
    mapping: { element(index: Node | number): Node<'uvec2'> };
    originalCount: Node<'uint'>;
    lodStart: Node<'uint'>;
  };

  parentIndex(index: Node<'uint'>): Node<'uint'> {
    if (!this.hierarchy) return index;
    const { mapping, originalCount } = this.hierarchy;
    const mappingIndex = index.greaterThanEqual(originalCount).select(index, originalCount).sub(originalCount);
    const entry = mapping.element(mappingIndex);
    return index.greaterThanEqual(originalCount).select(entry.x, index) as Node<'uint'>;
  }

  identity(index: Node<'uint'>): Node<'uvec2'> {
    if (!this.hierarchy) return uvec2(index, this.createStateNode(index).z);
    const { mapping, originalCount, lodStart } = this.hierarchy;
    const parent = this.parentIndex(index);
    const root = this.parentIndex(parent);
    const rootId = uvec2(root, this.createStateNode(root).z);
    const derive = (id: Node<'uvec2'>, at: Node<'uint'>) => {
      const mappingIndex = at.greaterThanEqual(originalCount).select(at, originalCount).sub(originalCount);
      const ordinal = mapping.element(mappingIndex).y;
      const stage = at.lessThan(lodStart).select(uint(0x72656e64), uint(0x6c6f6421));
      const mixed = ordinal.add(1).mul(uint(2246822519)).bitXor(stage);
      return uvec2(id.x.bitXor(mixed).mul(uint(3266489917)), id.y.bitXor(mixed).mul(uint(668265263)));
    };
    const parentId = parent.greaterThanEqual(originalCount).select(derive(rootId, parent), rootId) as Node<'uvec2'>;
    return index.greaterThanEqual(originalCount).select(derive(parentId, index), rootId) as Node<'uvec2'>;
  }

  private readonly floatStorage: PackedFloatStorage;
  private readonly uintStorage: PackedUintStorage;

  constructor(attributes: GPUParticleAttributes, capacity: number) {
    this.floatStorage = storage(attributes.floatData, 'vec4', capacity * RENDER_FLOAT_SLOT_COUNT) as PackedFloatStorage;
    this.uintStorage = storage(attributes.uintData, 'uvec4', capacity * UINT_SLOT_COUNT) as PackedUintStorage;
  }

  createVectorNodes(
    index: Node<'uint'> = instanceIndex,
  ): Pick<GPUParticleVectorNodes, 'position' | 'rotation' | 'scale' | 'color' | 'velocity'> {
    return {
      velocity: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.Contribution, index).yzw,
      position: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.PositionAlpha, index).xyz,
      rotation: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.RotationDistortion, index).xyz,
      scale: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.ScaleRealtime, index).xyz,
      color: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.ColorTime, index).xyz,
    };
  }

  createScalarNodes(
    index: Node<'uint'> = instanceIndex,
  ): Pick<GPUParticleScalarNodes, 'alpha' | 'distortionStrength' | 'realtime' | 'time'>
    & { contribution: Node<'float'> } {
    return {
      contribution: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.Contribution, index).x,
      alpha: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.PositionAlpha, index).w,
      distortionStrength: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.RotationDistortion, index).w,
      realtime: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.ScaleRealtime, index).w,
      time: renderFloatElement(this.floatStorage, ParticleRenderFloatSlot.ColorTime, index).w,
    };
  }

  createStateNode(index: Node<'uint'> = instanceIndex): Node<'uvec4'> {
    return this.uintStorage.element(index.mul(UINT_SLOT_COUNT));
  }

  createParticle(index: Node<'uint'> = instanceIndex): GPUParticleRenderContext {
    return new GPUParticleRenderContext(
      index,
      this.createVectorNodes(index),
      this.createScalarNodes(index),
      this.createStateNode(index),
      this,
    );
  }

  storeParticle(particle: GPUParticleLike): void {
    const vectors = this.createVectorNodes(particle.index);
    const scalars = this.createScalarNodes(particle.index);
    const state = this.createStateNode(particle.index);

    vectors.position.assign(particle.position);
    vectors.rotation.assign(particle.rotation);
    vectors.scale.assign(particle.scale);
    vectors.color.assign(particle.color);
    vectors.velocity.assign(particle.velocity);
    scalars.contribution.assign(float(1));
    scalars.alpha.assign(particle.alpha);
    scalars.distortionStrength.assign(particle.distortionStrength);
    scalars.realtime.assign(particle.realtime);
    scalars.time.assign(particle.time);
    state.x.assign(particle.alive);
    state.y.assign(particle.tagMask);
    state.z.assign(particle.generation);
    state.w.assign(particle.lodPriority);
    this.appearance(particle.index, 0).assign(particle.materialCopy ?? vec4(0));
    this.appearance(particle.index, 1).assign(particle.materialCopyU ?? vec4(0));
    this.appearance(particle.index, 2).assign(particle.materialCopyV ?? vec4(0));
  }
}

/** Owns the canonical simulation attributes and their CPU synchronization paths. */
export class GPUParticleBufferState {
  readonly floatStride = FLOAT_SLOT_COUNT * 4;
  count = 0;
  capacity: number;
  version = 0;
  attributes: GPUParticleAttributes;
  storage: GPUParticleStorage;
  particle: GPUParticleContext;
  alive: Node<'uint'>;
  tagMask: Node<'uint'>;

  private floatData: Float32Array;
  private uintData: Uint32Array;

  constructor(
    capacity: number,
    particles: Particle[],
    tagMaskForParticle?: (particle: Particle) => number,
    generationForParticle?: (particle: Particle, index: number) => number,
  ) {
    this.capacity = capacity;
    this.floatData = new Float32Array(capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(capacity * UINT_SLOT_COUNT * 4);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.storage = new GPUParticleStorage(this.attributes, capacity);
    this.particle = this.storage.createParticle();
    const state = this.storage.createStateNode();
    this.alive = state.x;
    this.tagMask = state.y;
    this.upload(particles, tagMaskForParticle, generationForParticle);
  }

  initialize(renderer: GPUStorageBufferRenderer): GPUParticleBufferInitialization {
    return {
      floatCreated: initializeStorageAttribute(renderer, this.attributes.floatData),
      uintCreated: initializeStorageAttribute(renderer, this.attributes.uintData),
    };
  }

  upload(
    particles: Particle[],
    tagMaskForParticle?: (particle: Particle) => number,
    generationForParticle?: (particle: Particle, index: number) => number,
  ): void {
    this.ensureCapacity(particles.length);

    this.count = particles.length;

    for (let index = 0; index < particles.length; index += 1) {
      this.writeParticle(index, particles[index], tagMaskForParticle, generationForParticle);
    }

    for (let index = particles.length; index < this.capacity; index += 1) {
      writeState(this.uintData, index, 0, 0, 0);
    }

    this.attributes.floatData.needsUpdate = true;
    this.attributes.uintData.needsUpdate = true;
  }

  /** Uploads one CPU-mutated slot without replacing GPU-native particles in other slots. */
  uploadIndex(
    index: number,
    particle: Particle,
    tagMaskForParticle?: (particle: Particle) => number,
    generationForParticle?: (particle: Particle, index: number) => number,
  ): void {
    this.ensureCapacity(index + 1);
    this.writeParticle(index, particle, tagMaskForParticle, generationForParticle);

    const floatStart = index * FLOAT_SLOT_COUNT * 4;
    const uintStart = index * UINT_SLOT_COUNT * 4;

    this.attributes.floatData.addUpdateRange(floatStart, FLOAT_SLOT_COUNT * 4);
    this.attributes.uintData.addUpdateRange(uintStart, UINT_SLOT_COUNT * 4);
    this.attributes.floatData.needsUpdate = true;
    this.attributes.uintData.needsUpdate = true;
    this.count = Math.max(this.count, index + 1);
  }

  ensureCount(count: number): void {
    this.ensureCapacity(count);
    this.count = Math.max(this.count, Math.min(Math.floor(count), this.capacity));
  }

  grow(renderer: GPUStorageBufferRenderer, requestedCapacity: number): boolean {
    const nextCapacity = Math.max(this.capacity, Math.floor(requestedCapacity));
    if (nextCapacity <= this.capacity) return false;

    const backend = renderer.backend as {
      device?: {
        createCommandEncoder(): {
          copyBufferToBuffer(
            source: unknown,
            sourceOffset: number,
            destination: unknown,
            destinationOffset: number,
            size: number,
          ): void;
          finish(): unknown;
        };
        queue: { submit(commands: unknown[]): void };
      };
      get?(attribute: StorageBufferAttribute): { buffer?: unknown };
      createStorageAttribute?(attribute: StorageBufferAttribute): void;
      destroyAttribute?(attribute: StorageBufferAttribute): void;
    } | undefined;
    const device = backend?.device;
    const previousFloatAttribute = this.attributes.floatData;
    const previousUintAttribute = this.attributes.uintData;
    const previousFloatBuffer = backend?.get?.(previousFloatAttribute)?.buffer;
    const previousUintBuffer = backend?.get?.(previousUintAttribute)?.buffer;
    if (!device || !previousFloatBuffer || !previousUintBuffer) return false;

    const previousFloatData = this.floatData;
    const previousUintData = this.uintData;
    this.capacity = nextCapacity;
    this.floatData = new Float32Array(this.capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * UINT_SLOT_COUNT * 4);
    this.floatData.set(previousFloatData);
    this.uintData.set(previousUintData);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.storage = new GPUParticleStorage(this.attributes, this.capacity);
    this.particle = this.storage.createParticle();
    const state = this.storage.createStateNode();
    this.alive = state.x;
    this.tagMask = state.y;
    this.version += 1;

    this.initialize(renderer);
    const nextFloatBuffer = backend.get?.(this.attributes.floatData)?.buffer;
    const nextUintBuffer = backend.get?.(this.attributes.uintData)?.buffer;
    if (!nextFloatBuffer || !nextUintBuffer) return false;

    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(previousFloatBuffer, 0, nextFloatBuffer, 0, previousFloatData.byteLength);
    encoder.copyBufferToBuffer(previousUintBuffer, 0, nextUintBuffer, 0, previousUintData.byteLength);
    device.queue.submit([encoder.finish()]);
    destroyGPUStorageAttribute(renderer, previousFloatAttribute);
    destroyGPUStorageAttribute(renderer, previousUintAttribute);
    return true;
  }

  sync(
    particles: Particle[],
    tagMaskForParticle?: (particle: Particle) => number,
    generationForParticle?: (particle: Particle, index: number) => number,
  ): void {
    this.upload(particles, tagMaskForParticle, generationForParticle);
  }

  /** Full synchronization path; selective readback is pooled by ParticleSystem separately. */
  async readback(renderer: GPUReadbackRenderer, particles: Particle[]): Promise<void> {
    const [floatBuffer, uintBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(this.attributes.floatData),
      renderer.getArrayBufferAsync(this.attributes.uintData),
    ]);

    this.floatData.set(new Float32Array(floatBuffer).subarray(0, this.floatData.length));
    this.uintData.set(new Uint32Array(uintBuffer).subarray(0, this.uintData.length));

    for (let index = 0; index < Math.min(this.count, particles.length); index += 1) {
      const particle = particles[index];

      readVector(this.floatData, index, ParticleFloatSlot.PositionSpeed, particle.position);
      readVector(this.floatData, index, ParticleFloatSlot.OrbitCenterAlpha, particle.orbitCenter);
      readVector(this.floatData, index, ParticleFloatSlot.RotationMass, particle.rotation);
      readVector(this.floatData, index, ParticleFloatSlot.ScaleDistortion, particle.scale);
      readVector(this.floatData, index, ParticleFloatSlot.VelocityLifetime, particle.velocity);
      readVector(this.floatData, index, ParticleFloatSlot.AngularVelocityTime, particle.angularVelocity);
      readVector(this.floatData, index, ParticleFloatSlot.ScalarVelocityRealtime, particle.scalarVelocity);
      readVector(this.floatData, index, ParticleFloatSlot.Acceleration, particle.acceleration);
      readVector(this.floatData, index, ParticleFloatSlot.AngularAcceleration, particle.angularAcceleration);
      readVector(this.floatData, index, ParticleFloatSlot.ScalarAcceleration, particle.scalarAcceleration);
      // Restore color from its packed RGB components.
      const colorOffset = packedOffset(index, ParticleFloatSlot.Color);
      particle.color.setRGB(
        this.floatData[colorOffset], this.floatData[colorOffset + 1], this.floatData[colorOffset + 2],
      );

      particle.speed = readScalar(this.floatData, index, ParticleFloatSlot.PositionSpeed);
      particle.alpha = readScalar(this.floatData, index, ParticleFloatSlot.OrbitCenterAlpha);
      particle.mass = readScalar(this.floatData, index, ParticleFloatSlot.RotationMass);
      particle.distortionStrength = readScalar(this.floatData, index, ParticleFloatSlot.ScaleDistortion);
      particle.lifetime = readScalar(this.floatData, index, ParticleFloatSlot.VelocityLifetime);
      particle.time = readScalar(this.floatData, index, ParticleFloatSlot.AngularVelocityTime);
      particle.realtime = readScalar(this.floatData, index, ParticleFloatSlot.ScalarVelocityRealtime);
      particle.alive = this.uintData[stateOffset(index)] !== 0;
      particle.lodPriority = this.uintData[stateOffset(index) + 3] / 4294967296;
      particle.materialCopy.fromArray(this.floatData, packedOffset(index, ParticleFloatSlot.MaterialCopy));
      particle.materialCopyU.fromArray(this.floatData, packedOffset(index, ParticleFloatSlot.MaterialCopyU));
      particle.materialCopyV.fromArray(this.floatData, packedOffset(index, ParticleFloatSlot.MaterialCopyV));
      particle.cache();
    }
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    destroyGPUStorageAttribute(renderer, this.attributes.floatData);
    destroyGPUStorageAttribute(renderer, this.attributes.uintData);
  }

  private ensureCapacity(nextCount: number): void {
    if (nextCount <= this.capacity) return;

    const previousFloatData = this.floatData;
    const previousUintData = this.uintData;

    this.capacity = nextPowerOfTwo(nextCount);
    this.floatData = new Float32Array(this.capacity * FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * UINT_SLOT_COUNT * 4);
    this.floatData.set(previousFloatData);
    this.uintData.set(previousUintData);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.storage = new GPUParticleStorage(this.attributes, this.capacity);
    this.particle = this.storage.createParticle();
    const state = this.storage.createStateNode();
    this.alive = state.x;
    this.tagMask = state.y;
    this.version += 1;
  }

  /** Serializes one particle; uploadIndex additionally marks its GPU update ranges. */
  private writeParticle(
    index: number,
    particle: Particle,
    tagMaskForParticle?: (particle: Particle) => number,
    generationForParticle?: (particle: Particle, index: number) => number,
  ): void {
    writeVectorAndScalar(this.floatData, index, ParticleFloatSlot.PositionSpeed, particle.position, particle.speed);
    writeVectorAndScalar(
      this.floatData, index, ParticleFloatSlot.OrbitCenterAlpha,
      particle.orbitCenter, particle.alpha,
    );
    writeVectorAndScalar(this.floatData, index, ParticleFloatSlot.RotationMass, particle.rotation, particle.mass);
    writeVectorAndScalar(
      this.floatData, index, ParticleFloatSlot.ScaleDistortion,
      particle.scale, particle.distortionStrength,
    );
    writeVectorAndScalar(
      this.floatData, index, ParticleFloatSlot.VelocityLifetime,
      particle.velocity, particle.lifetime,
    );
    writeVectorAndScalar(
      this.floatData, index, ParticleFloatSlot.AngularVelocityTime,
      particle.angularVelocity, particle.time,
    );
    writeVectorAndScalar(
      this.floatData, index, ParticleFloatSlot.ScalarVelocityRealtime,
      particle.scalarVelocity, particle.realtime,
    );
    writeVectorAndScalar(this.floatData, index, ParticleFloatSlot.Acceleration, particle.acceleration, 0);
    writeVectorAndScalar(this.floatData, index, ParticleFloatSlot.AngularAcceleration, particle.angularAcceleration, 0);
    writeVectorAndScalar(this.floatData, index, ParticleFloatSlot.ScalarAcceleration, particle.scalarAcceleration, 0);
    // The color slot stores RGB with an unused fourth component.
    const colorOffset = packedOffset(index, ParticleFloatSlot.Color);
    this.floatData.set([particle.color.r, particle.color.g, particle.color.b, 0], colorOffset);
    const source = getParticleSourceBinding(particle);
    const sourceOffset = (index * FLOAT_SLOT_COUNT + ParticleFloatSlot.SourceIdentity) * 16;
    const sourceWords = new Uint32Array(this.floatData.buffer, sourceOffset, 4);
    sourceWords.set(source ? [source.slot, source.generation, 2, 2] : [0, 0, 0, 0]);
    particle.writeMaterialCopy(this.floatData, packedOffset(index, ParticleFloatSlot.MaterialCopy));

    writeState(
      this.uintData,
      index,
      particle.alive ? 1 : 0,
      tagMaskForParticle?.(particle) ?? 0,
      generationForParticle?.(particle, index) ?? 0,
      particle.lodPriority,
    );
  }
}

/** Owns compact render-only attributes produced from the canonical simulation buffer. */
export class GPUParticleRenderBufferState {
  readonly floatStride = RENDER_FLOAT_SLOT_COUNT * 4;
  /** Actual GPU-produced visual range, including original simulation slots. */
  instanceCountNode?: Node<'uint'>;
  /** Source simulation slot for system-owned LOD spacing. */
  spacingIndex?: (index: Node<'uint'>) => Node<'uint'>;
  private indirect?: IndirectStorageBufferAttribute;
  private indirectCompute?: ComputeNode;
  private indirectIndexCount = -1;
  private indirectRangeNode?: Node<'uint'>;

  /** Binds an accurate GPU-only draw range after expansion. */
  bindIndirect(
    geometry: THREE.BufferGeometry,
    renderer: GPUStorageBufferRenderer & { compute(node: ComputeNode): void },
  ): void {
    if (!this.instanceCountNode) {
      geometry.indirect = null;
      return;
    }
    const indexCount = geometry.index?.count ?? geometry.getAttribute('position').count;
    if (!this.indirect) {
      this.indirect = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
    }
    if (this.indirectIndexCount !== indexCount) {
      this.indirect.array[0] = indexCount;
      this.indirect.needsUpdate = true;
      this.indirectIndexCount = indexCount;
    }
    if (!this.indirectCompute || this.indirectRangeNode !== this.instanceCountNode) {
      this.indirectCompute?.dispose();
      const args = storage(this.indirect, 'uint', 5);
      const range = this.instanceCountNode;
      this.indirectCompute = Fn(() => {
        args.element(1).assign(range);
      })().compute(1).setName('rzmps.children.indirect');
      this.indirectRangeNode = range;
    }
    renderer.compute(this.indirectCompute!);
    geometry.indirect = this.indirect;
  }

  count = 0;
  capacity: number;
  version = 0;
  attributes: GPUParticleAttributes;
  storage: GPUParticleRenderStorage;
  particle: GPUParticleRenderContext;
  alive: Node<'uint'>;
  tagMask: Node<'uint'>;

  private floatData: Float32Array;
  private uintData: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.floatData = new Float32Array(capacity * RENDER_FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(capacity * UINT_SLOT_COUNT * 4);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.storage = new GPUParticleRenderStorage(this.attributes, capacity);
    this.particle = this.storage.createParticle();
    const state = this.storage.createStateNode();
    this.alive = state.x;
    this.tagMask = state.y;
  }

  initialize(renderer: GPUStorageBufferRenderer): GPUParticleBufferInitialization {
    return {
      floatCreated: initializeStorageAttribute(renderer, this.attributes.floatData),
      uintCreated: initializeStorageAttribute(renderer, this.attributes.uintData),
    };
  }

  ensureCount(count: number): void {
    this.count = count;
    if (count <= this.capacity) return;

    this.capacity = nextPowerOfTwo(count);
    this.floatData = new Float32Array(this.capacity * RENDER_FLOAT_SLOT_COUNT * 4);
    this.uintData = new Uint32Array(this.capacity * UINT_SLOT_COUNT * 4);
    this.attributes = createAttributes(this.floatData, this.uintData);
    this.storage = new GPUParticleRenderStorage(this.attributes, this.capacity);
    this.particle = this.storage.createParticle();
    const state = this.storage.createStateNode();
    this.alive = state.x;
    this.tagMask = state.y;
    this.version += 1;
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.indirectCompute?.dispose();
    if (this.indirect) destroyGPUStorageAttribute(renderer, this.indirect);
    destroyGPUStorageAttribute(renderer, this.attributes.floatData);
    destroyGPUStorageAttribute(renderer, this.attributes.uintData);
  }

  // Render buffers are derived and intentionally write-only. Readback always targets
  // the canonical simulation buffer so consumers receive complete particle state.
}

export function createGPUParticleBufferState(
  particles: Particle[],
  capacity = particles.length,
  tagMaskForParticle?: (particle: Particle) => number,
  generationForParticle?: (particle: Particle, index: number) => number,
): GPUParticleBufferState {
  return new GPUParticleBufferState(
    Math.max(1, capacity, particles.length),
    particles,
    tagMaskForParticle,
    generationForParticle,
  );
}

/** Convenience factory for callers that do not have an initial CPU particle array. */
export function createEmptyGPUParticleBufferState(capacity: number): GPUParticleBufferState {
  return new GPUParticleBufferState(Math.max(1, capacity), []);
}

export function createGPUParticleRenderBufferState(capacity = 1): GPUParticleRenderBufferState {
  return new GPUParticleRenderBufferState(Math.max(1, capacity));
}

export function destroyGPUStorageAttribute(
  renderer: GPUStorageBufferRenderer | undefined,
  attribute: StorageBufferAttribute,
): void {
  destroyStorageAttribute(renderer, attribute);
}


/** @internal Reset schema-owned optional birth attributes when a storage slot is recycled. */
export function resetInitializationAttributesGPU(particle: GPUParticleLike): void {
  particle.materialCopy?.assign(vec4(0));
  particle.materialCopyU?.assign(vec4(0));
  particle.materialCopyV?.assign(vec4(0));
}
