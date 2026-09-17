import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
    angularVelocity: DynamicValue<THREE.Vector3>;
}

class RotationOverLifetime extends Module {
  constructor(public options: Partial<RotationOverLifetimeOptions> = {}) {
    super((particle: Particle) => {
      particle.angularVelocity = particle.start.angularVelocity.clone()
        .add(evaluateDynamicVector(
          this.options.angularVelocity ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id));
    }, options);
  }
}

export default RotationOverLifetime;
