import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
    angularVelocity: DynamicValue<THREE.Vector3>;
}

class RotationOverLifetime extends Module {
  constructor(public options: RotationOverLifetimeOptions) {
    super((particle: Particle) => {
      particle.angularVelocity = particle.start.angularVelocity.clone()
        .add(evaluateDynamicVector(this.options.angularVelocity, particle.time, particle.id));
    }, options);
  }
}

export default RotationOverLifetime;
