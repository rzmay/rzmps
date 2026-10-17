import type { Node } from 'three/webgpu';
import { uint } from 'three/tsl';
import {
  createEmptyGPUParticleBufferState,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUStorageBufferRenderer,
} from './Particle';

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
    const particle = this.snapshots.storage.loadParticle(typeof index === 'number' ? uint(index) : index);

    return {
      active: particle.alive,
      eventType: particle.tagMask,
      elapsed: particle.realtime,
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
