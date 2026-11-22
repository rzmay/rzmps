import type Particle from './Particle';
import type { GPUParticleLike } from '../simulation/gpu/Particle';
import type { Node } from 'three/webgpu';
import type { EventExecutionContext } from '../events/EventReceiver';
import type ParticleSystem from './ParticleSystem';

/** Shared particle predicate, used before a component performs per-particle work. */
export type ParticleCondition<Context = EventExecutionContext> = (
  particle: Particle,
  deltaTime: number,
  context: Context,
) => boolean;

/** Shader equivalent; the owning component supplies its execution context. */
export type ParticleGPUCondition<Context = { system: ParticleSystem }> = (
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  context: Context,
) => Node<'bool'>;
