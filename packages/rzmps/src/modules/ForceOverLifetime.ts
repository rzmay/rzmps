import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import {
  evaluateDynamicVectorGPU,} from '../helpers/evaluateDynamicGPU';

export interface ForceOverLifetimeOptions extends Partial<ModuleOptions> {
  force: DynamicValue<THREE.Vector3>;
}

class ForceOverLifetime extends Module {
  constructor(public options: Partial<ForceOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.acceleration.add(
        evaluateDynamicVector(this.options.force ?? new THREE.Vector3(0, 0, 0), particle.time, particle.id),
      );
    }, {
      ...options,
      priority: 1,
      modifyGPU: (particle) => {
          particle.acceleration.assign(
            particle.acceleration.add(evaluateDynamicVectorGPU(
              this.options.force ?? new THREE.Vector3(0, 0, 0),
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
        }
    });
  }
}

export default ForceOverLifetime;
