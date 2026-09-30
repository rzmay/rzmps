import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface ForceOverLifetimeOptions extends Partial<ModuleOptions> {
  force: DynamicValue<THREE.Vector3>;
}

class ForceOverLifetime extends Module {
  constructor(public options: Partial<ForceOverLifetimeOptions> = {}) {

    super((particle: Particle, deltaTime) => {
      const force = evaluateDynamicVector(
          this.options.force ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id
        )
      const mass = Number.isFinite(particle.mass) && particle.mass > 0
        ? particle.mass
        : 1;

      particle.velocity.addScaledVector(
        force,
        deltaTime / mass,
      );
    }, {
      ...options,
      priority: Module.Priority.Permanent,
    });
  }
}

export default ForceOverLifetime;
