import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface ScaleOverLifetimeOptions extends Partial<ModuleOptions> {
    scale: DynamicValue<THREE.Vector3>;
    scalarVelocity: DynamicValue<THREE.Vector3>;
    scalarAcceleration: DynamicValue<THREE.Vector3>;
}

class ScaleOverLifetime extends Module {
  constructor(public options: Partial<ScaleOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.scale.multiply(evaluateDynamicVector(
        this.options.scale ?? new THREE.Vector3(1, 1, 1),
        particle.time,
        particle.id
      ));
      particle.scalarVelocity.add(evaluateDynamicVector(
        this.options.scalarVelocity ?? new THREE.Vector3(),
        particle.time,
        particle.id,
      ));
      particle.scalarAcceleration.add(evaluateDynamicVector(
        this.options.scalarAcceleration ?? new THREE.Vector3(),
        particle.time,
        particle.id,
      ));
    }, {
      priority: 1,
      ...options,

    });
  }
}

export default ScaleOverLifetime;
