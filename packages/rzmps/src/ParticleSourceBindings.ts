/**
 * CPU ownership for Source-space particles: the emitting source, previous resolved transform,
 * and the slot/generation used when uploading a CPU-born particle to the GPU.
 * ParticleSystem applies transform deltas at simulation updates; these bindings do not queue API calls.
 * The matching GPU matrix history and managed-source tables live in gpu/SourceFrameBuffer.ts.
 */
import type { Matrix4 } from 'three';
import type Particle from './Particle';
import type { SubSystemSource } from './EmissionSource';

/** @internal Ownership survives event snapshots and emission-run lifetimes. */
export interface ParticleSourceBinding {
  source: SubSystemSource;
  previous: Matrix4;
  slot: number;
  generation: number;
}

// Weak ownership keeps runtime attachment data out of particle serialization and clones.
const bindings = new WeakMap<Particle, ParticleSourceBinding>();

/** @internal Reads attachment state without adding serializable fields to the particle. */
export function getParticleSourceBinding(particle: Particle): ParticleSourceBinding | undefined {
  return bindings.get(particle);
}

/** @internal Sets or releases the source transform history used by CPU simulation. */
export function setParticleSourceBinding(particle: Particle, binding?: ParticleSourceBinding): void {
  if (binding) bindings.set(particle, binding);
  else bindings.delete(particle);
}
