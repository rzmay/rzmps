import * as THREE from 'three';
import Particle from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';

export default function getParticleWorldPosition(
  particle: Particle,
  particleSystem?: ParticleSystem,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  target.copy(particle.position);

  if (particleSystem && particleSystem.simulationSpace !== 'world') {
    particleSystem.updateWorldMatrix(true, false);
    particleSystem.simulationToWorld(target);
  }

  return target;
}
