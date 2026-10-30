import * as THREE from 'three';
import type Particle from './Particle';
import type { SubSystemSource } from './EmissionSource';

/** @internal Ownership survives event snapshots and emission-run lifetimes. */
export interface ParticleSourceFrame {
  source: SubSystemSource;
  previous: THREE.Matrix4;
  slot: number;
  generation: number;
}
const bindings = new WeakMap<Particle, ParticleSourceFrame>();
/** @internal */
export const particleSourceFrame = (particle: Particle): ParticleSourceFrame | undefined => bindings.get(particle);
/** @internal */
export function bindParticleSourceFrame(particle: Particle, binding?: ParticleSourceFrame): void {
  if (binding) bindings.set(particle, binding);
  else bindings.delete(particle);
}
