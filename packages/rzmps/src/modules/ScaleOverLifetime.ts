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
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          particle.scale.assign(
            particle.scale.mul(this.gpuParameters.vector(
              'scale',
              () => this.options.scale,
              particle.time,
              new THREE.Vector3(1, 1, 1),
              particle.index,
            )),
          );
          particle.scalarVelocity.assign(
            particle.scalarVelocity.add(this.gpuParameters.vector(
              'scalarVelocity',
              () => this.options.scalarVelocity,
              particle.time,
              new THREE.Vector3(),
              particle.index,
            )),
          );
          particle.scalarAcceleration.assign(
            particle.scalarAcceleration.add(this.gpuParameters.vector(
              'scalarAcceleration',
              () => this.options.scalarAcceleration,
              particle.time,
              new THREE.Vector3(),
              particle.index,
            )),
          );
        }
    });
  }
}

export default ScaleOverLifetime;
