import type EmissionShape from '../EmissionShape';
import type Emitter from '../Emitter';
import { EmissionSource } from '../enums/EmissionSource';
import { TagSelectionMethod } from '../enums/TagSelectionMethod';
import type { Node } from 'three/webgpu';
import { uint } from 'three/tsl';
import {
  createEmptyGPUParticleBufferState,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUStorageBufferRenderer,
} from './Particle';

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
    this.snapshots = createEmptyGPUParticleBufferState(this.capacity);
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
    const slot = typeof index === 'number' ? uint(index) : index;
    const storage = this.snapshots.storage;
    const particle = storage.createParticle(slot, true);

    // Run lifetime bookkeeping must write through to storage so completed slots can be reused.
    // Keep the remaining particle fields as a stable snapshot for emission inheritance.
    return {
      active: storage.createStateNode(slot).x,
      eventType: particle.tagMask,
      elapsed: storage.createScalarNodes(slot).realtime,
      duration: particle.lifetime,
      collisionPoint: particle.acceleration,
      collisionNormal: particle.angularAcceleration,
      collisionImpulse: particle.scalarAcceleration,
      particle,
    };
  }

  storeParticle(index: Node<'uint'>, particle: GPUParticleLike): void {
    this.snapshots.storage.storeParticle({ ...particle, index });
  }
}
