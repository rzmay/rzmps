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
    super((particle: Particle) => {
      particle.acceleration = particle.start.acceleration.clone()
        .add(evaluateDynamicVector(this.options.force ?? new THREE.Vector3(0, 0, 0), particle.time, particle.id));
    }, options);
  }
}

export default ForceOverLifetime;
