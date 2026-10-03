import * as THREE from 'three';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';

export default function getParticleWorldPosition(
  particle: Particle,
  particleSystem?: ParticleSystem,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  target.copy(particle.position);

  if (particleSystem && particleSystem.simulationSpace !== 'world') {
    particleSystem.updateWorldMatrix(true, false);
    particleSystem.localToWorld(target);
  }

  return target;
}
