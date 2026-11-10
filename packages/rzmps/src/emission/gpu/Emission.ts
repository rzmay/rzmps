import { matrixColumnGPU } from '../../simulation/simulationFrame.utils';
import type EmissionShape from '../EmissionShape';
import type Emitter from '../Emitter';
import { EmissionSource } from '../../enums/EmissionSource';
import { TagSelectionMethod } from '../../enums/TagSelectionMethod';
import type { Node } from 'three/webgpu';
import { uint, mat4 } from 'three/tsl';
import { FLOAT_SLOT_COUNT } from '../../simulation/gpu/particleLayout.utils';
import { GPU_EVENT_FLOAT_SLOT_COUNT, readGPUEvent, type GPUEventNodeRecord } from '../../events/gpu/EventBuffer';
import {
  createEmptyGPUParticleBufferState,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUStorageBufferRenderer,
} from '../../simulation/gpu/Particle';

// Support auditing and the small emission-run snapshot live together here.
// EmitterInstanceBuffer remains separate because it owns the larger mutable,
// atomic runtime ABI rather than emission-shape behavior.

export type GPUEmissionSupportLevel = 'native' | 'cpu-only' | 'unsupported';

export interface GPUEmissionSupportReport {
  supported: boolean;
  level: GPUEmissionSupportLevel;
  reasons: string[];
  features: string[];
}

export function getGPUEmissionShapeSupport(shape: EmissionShape): GPUEmissionSupportReport {
  const reasons: string[] = [];
  const features: string[] = [];
  const geometryType = shape.geometry.type;
  const hasPositions = Boolean(shape.geometry.getAttribute('position'));

  if (!hasPositions) {
    reasons.push(`Emission shape geometry '${geometryType}' has no position attribute.`);
  } else {
    const sampling = shape.source === EmissionSource.Volume
      ? 'sampling:shared-volume-table'
      : 'sampling:geometry-buffer';
    features.push(`${geometryType}:${shape.source}`, sampling);
  }

  return {
    supported: reasons.length === 0,
    level: reasons.length === 0 ? 'native' : 'unsupported',
    reasons,
    features,
  };
}

export function getGPUEmitterSupport(emitter: Emitter): GPUEmissionSupportReport {
  const shapeReport = getGPUEmissionShapeSupport(emitter.source);
  const reasons = [...shapeReport.reasons];
  const features = [...shapeReport.features];

  features.push('rate', 'rateOverDistance', 'radialSpeed', 'alignment');
  if (emitter.bursts.length > 0) features.push('bursts');
  features.push('initialValues');

  if (emitter.tags?.length) {
    if (emitter.tagSelection === TagSelectionMethod.All) {
      features.push('tags:all');
    } else if (emitter.tagSelection === TagSelectionMethod.Random) {
      features.push('tags:random');
    } else if (emitter.tagSelection === TagSelectionMethod.Distribute) {
      features.push('tags:distribute');
    }
  }


  if (shapeReport.supported) {
    features.push(`builtIn:${emitter.source.geometry.type}:${emitter.source.source}`);
  }

  return {
    supported: reasons.length === 0,
    level: reasons.length === 0 ? 'native' : 'unsupported',
    reasons,
    features,
  };
}

export interface GPUEmissionRunNode {
  active: Node<'uint'>;
  eventType: Node<'uint'>;
  elapsed: Node<'float'>;
  duration: Node<'float'>;
  collisionPoint: Node<'vec3'>;
  collisionNormal: Node<'vec3'>;
  collisionImpulse: Node<'vec3'>;
  particle: GPUParticleLike;
}

/** Packed snapshots for concurrent subsystem emission runs. */
export class GPUEmissionRunBufferState {
  readonly capacity: number;
  readonly snapshots: GPUParticleBufferState;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.snapshots = createEmptyGPUParticleBufferState(Math.ceil(this.capacity
      * (FLOAT_SLOT_COUNT + GPU_EVENT_FLOAT_SLOT_COUNT + 4) / FLOAT_SLOT_COUNT));
    this.snapshots.ensureCount(this.capacity);
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    this.snapshots.initialize(renderer);
  }

  reset(): void {
    this.snapshots.upload([]);
    this.snapshots.ensureCount(this.capacity);
  }

  load(index: Node<'uint'> | number): GPUEmissionRunNode {
    const particle = this.snapshots.storage.createParticle(
      typeof index === 'number' ? uint(index) : index,
      false,
    );
    return {
      active: particle.alive,
      eventType: particle.lodPriority,
      elapsed: particle.realtime,
      duration: particle.lifetime,
      collisionPoint: particle.orbitCenter,
      collisionNormal: particle.rotation,
      collisionImpulse: particle.scalarVelocity,
      particle,
    };
  }

  /** @internal Persist the original event and producer frame in the existing run float buffer. */
  storeEvent(index: Node<'uint'>, event: GPUEventNodeRecord, sourceToWorld: Node<'mat4'>): void {
    const base = this.eventBase(index);
    event.snapshot(this.snapshots.storage.floatStorage, base);
    for (let i = 0; i < 4; i++) {
      this.snapshots.storage.floatStorage.element(base.add(GPU_EVENT_FLOAT_SLOT_COUNT + i))
        .assign(matrixColumnGPU(sourceToWorld, i));
    }
  }

  event(index: Node<'uint'>): GPUEventNodeRecord {
    return readGPUEvent(this.snapshots.storage.floatStorage, this.eventBase(index));
  }

  sourceToWorld(index: Node<'uint'>): Node<'mat4'> {
    const base = this.eventBase(index).add(GPU_EVENT_FLOAT_SLOT_COUNT);
    const storage = this.snapshots.storage.floatStorage;
    return mat4(storage.element(base), storage.element(base.add(1)),
      storage.element(base.add(2)), storage.element(base.add(3)));
  }

  private eventBase(index: Node<'uint'>): Node<'uint'> {
    return index.mul(GPU_EVENT_FLOAT_SLOT_COUNT + 4).add(this.capacity * FLOAT_SLOT_COUNT);
  }

  storeParticle(index: Node<'uint'>, particle: GPUParticleLike): void {
    this.snapshots.storage.storeParticle({ ...particle, index });
  }
}
