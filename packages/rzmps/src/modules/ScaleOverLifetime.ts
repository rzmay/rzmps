import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface ScaleOverLifetimeOptions extends Partial<ModuleOptions> {
    scale: DynamicValue<THREE.Vector3>;
}

class ScaleOverLifetime extends Module {
  constructor(public options: Partial<ScaleOverLifetimeOptions> = {}) {
    super((particle: Particle) => {
      particle.scale = particle
        .start
        .scale
        .clone()
        .multiply(evaluateDynamicVector(this.options.scale ?? new THREE.Vector3(1, 1, 1), particle.time, particle.id));
    }, options);
  }
}

export default ScaleOverLifetime;
