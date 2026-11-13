import type { Node } from 'three/webgpu';
import { float, uint, vec3, vec4, mix } from 'three/tsl';
import Particle from '../../core/Particle';
import { GPUParticleContext, type GPUParticleLike } from '../../simulation/gpu/Particle';
import type SpatialEffect from './SpatialEffect';

/** Shader-local copy shared by particle transient updates and automatic spatial feathering. */
export function snapshotParticleGPU(particle: GPUParticleLike): GPUParticleLike {
  return {
    kill: particle.kill.bind(particle),
    emitEvent: particle.emitEvent.bind(particle),
    addTag: particle.addTag.bind(particle),
    removeTag: particle.removeTag.bind(particle),
    id: particle.id,
    isChild: particle.isChild,
    parent: particle.parent,
    root: particle.root,
    index: particle.index,
    position: particle.position.toVar('basePosition'),
    orbitCenter: particle.orbitCenter.toVar('baseOrbitCenter'),
    rotation: particle.rotation.toVar('baseRotation'),
    scale: particle.scale.toVar('baseScale'),
    velocity: particle.velocity.toVar('baseVelocity'),
    angularVelocity: particle.angularVelocity.toVar('baseAngularVelocity'),
    scalarVelocity: particle.scalarVelocity.toVar('baseScalarVelocity'),
    acceleration: particle.acceleration.toVar('baseAcceleration'),
    angularAcceleration: particle.angularAcceleration.toVar('baseAngularAcceleration'),
    scalarAcceleration: particle.scalarAcceleration.toVar('baseScalarAcceleration'),
    color: particle.color.toVar('baseColor'),
    speed: particle.speed.toVar('baseSpeed'),
    alpha: particle.alpha.toVar('baseAlpha'),
    mass: particle.mass.toVar('baseMass'),
    distortionStrength: particle.distortionStrength.toVar('baseDistortionStrength'),
    lifetime: particle.lifetime.toVar('baseLifetime'),
    time: particle.time.toVar('baseTime'),
    realtime: particle.realtime.toVar('baseRealtime'),
    alive: particle.alive.toVar('baseAlive'),
    tagMask: particle.tagMask.toVar('baseTagMask'),
    generation: particle.generation.toVar('baseGeneration'),
    lodPriority: particle.lodPriority,
    materialCopy: particle.materialCopy,
    materialCopyU: particle.materialCopyU,
    materialCopyV: particle.materialCopyV,
  };
}

/** Runs the normal modifier and feathers supported continuous particle fields once. */
export function modifyWithFeatherGPU(
  effect: SpatialEffect, particle: GPUParticleLike, strength: Node<'float'>, modify: () => void,
): void {
  if (!effect.automaticFeather) {
    modify();
    return;
  }

  const before = snapshotParticleGPU(particle);
  modify();
  const blendFloat = (start: Node<'float'>, end: Node<'float'>) => mix(start, end, strength);
  const blendVector = (start: Node<'vec3'>, end: Node<'vec3'>) => mix(start, end, strength);

  particle.lifetime.assign(blendFloat(before.lifetime, particle.lifetime));
  particle.position.assign(blendVector(before.position, particle.position));
  particle.orbitCenter.assign(blendVector(before.orbitCenter, particle.orbitCenter));
  particle.rotation.assign(blendVector(before.rotation, particle.rotation));
  particle.scale.assign(blendVector(before.scale, particle.scale));
  particle.velocity.assign(blendVector(before.velocity, particle.velocity));
  particle.angularVelocity.assign(blendVector(before.angularVelocity, particle.angularVelocity));
  particle.scalarVelocity.assign(blendVector(before.scalarVelocity, particle.scalarVelocity));
  particle.acceleration.assign(blendVector(before.acceleration, particle.acceleration));
  particle.angularAcceleration.assign(blendVector(before.angularAcceleration, particle.angularAcceleration));
  particle.scalarAcceleration.assign(blendVector(before.scalarAcceleration, particle.scalarAcceleration));
  particle.speed.assign(blendFloat(before.speed, particle.speed));
  particle.mass.assign(blendFloat(before.mass, particle.mass));
  particle.distortionStrength.assign(blendFloat(before.distortionStrength, particle.distortionStrength));
  particle.color.assign(blendVector(before.color, particle.color));
  particle.alpha.assign(blendFloat(before.alpha, particle.alpha));
}

/** Construct a local particle view, with no storage allocation or readback. */
export function createSampleParticleGPU(position: Node<'vec3'>, state: Partial<GPUParticleLike>): GPUParticleContext {
  return new GPUParticleContext(state.index ?? uint(0), {
    position,
    orbitCenter: state.orbitCenter ?? position,
    rotation: state.rotation ?? vec3(0),
    scale: state.scale ?? vec3(1),
    velocity: state.velocity ?? vec3(0),
    angularVelocity: state.angularVelocity ?? vec3(0),
    scalarVelocity: state.scalarVelocity ?? vec3(0),
    acceleration: state.acceleration ?? vec3(0),
    angularAcceleration: state.angularAcceleration ?? vec3(0),
    scalarAcceleration: state.scalarAcceleration ?? vec3(0),
    color: state.color ?? vec3(1),
  }, {
    speed: state.speed ?? float(1), alpha: state.alpha ?? float(1), mass: state.mass ?? float(0),
    distortionStrength: state.distortionStrength ?? float(1), lifetime: state.lifetime ?? float(5),
    time: state.time ?? float(0), realtime: state.realtime ?? float(0),
  }, state.alive ?? uint(1), state.tagMask ?? uint(0), state.generation ?? uint(0), true,
  state.lodPriority ?? uint(0), [vec4(0), vec4(0), vec4(0)]);
}

const vectors = ['position', 'orbitCenter', 'rotation', 'scale', 'velocity', 'angularVelocity',
  'scalarVelocity', 'acceleration', 'angularAcceleration', 'scalarAcceleration'] as const;
const scalars = ['lifetime', 'speed', 'mass', 'distortionStrength', 'alpha'] as const;

/** Copy only the continuous fields handled by automatic feathering, into reusable snapshots. */
export function copyParticleValues(target: Particle, source: Particle): Particle {
  for (const key of vectors) target[key].copy(source[key]);
  for (const key of scalars) target[key] = source[key];
  target.color.copy(source.color);
  return target;
}

/** Preserve discrete kill/event state while blending continuous before/after values. */
export function featherParticleValues(target: Particle, before: Particle, after: Particle, strength: number): void {
  for (const key of vectors) target[key].copy(before[key]).lerp(after[key], strength);
  for (const key of scalars) {
    target[key] = before[key] === after[key] ? after[key] : before[key] + (after[key] - before[key]) * strength;
  }
  target.color.copy(before.color).lerp(after.color, strength);
}
