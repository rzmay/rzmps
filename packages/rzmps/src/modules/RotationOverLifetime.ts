import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import {
  evaluateDynamicVectorGPU,} from '../helpers/evaluateDynamicGPU';

export interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
    angle: DynamicValue<THREE.Vector3>;
    angularVelocity: DynamicValue<THREE.Vector3>;
    angularAcceleration: DynamicValue<THREE.Vector3>;
}

class RotationOverLifetime extends Module {
  constructor(public options: Partial<RotationOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.rotation.add(evaluateDynamicVector(
          this.options.angle ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id));
      particle.angularVelocity.add(evaluateDynamicVector(
          this.options.angularVelocity ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id));
      particle.angularAcceleration.add(evaluateDynamicVector(
          this.options.angularAcceleration ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id));
    }, {
      ...options,
      priority: 0.5,
      modifyGPU: (particle) => {
          particle.rotation.assign(
            particle.rotation.add(evaluateDynamicVectorGPU(
              this.options.angle ?? new THREE.Vector3(0, 0, 0),
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
          particle.angularVelocity.assign(
            particle.angularVelocity.add(evaluateDynamicVectorGPU(
              this.options.angularVelocity ?? new THREE.Vector3(0, 0, 0),
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
          particle.angularAcceleration.assign(
            particle.angularAcceleration.add(evaluateDynamicVectorGPU(
              this.options.angularAcceleration ?? new THREE.Vector3(0, 0, 0),
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
        }
    });
  }
}

export default RotationOverLifetime;
