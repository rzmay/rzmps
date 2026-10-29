import type { Vector3Input } from '../types/ValueInput';
import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface RotationOverLifetimeOptions extends Partial<ModuleOptions> {
    /** Angular values are radians; scalar inputs expand uniformly across axes. */
    angle: DynamicValue<Vector3Input>;
    angularVelocity: DynamicValue<Vector3Input>;
    angularAcceleration: DynamicValue<Vector3Input>;
}

/** Adds age-dependent angle, angular velocity, and angular acceleration before movement as transient adjustments. */
class RotationOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
      priority: Module.Priority.PreMovementTransient,
      modifyGPU: (particle) => {
          particle.rotation.assign(
            particle.rotation.add(this.gpuParameters.vector(
              'angle',
              () => this.options.angle,
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
          particle.angularVelocity.assign(
            particle.angularVelocity.add(this.gpuParameters.vector(
              'angularVelocity',
              () => this.options.angularVelocity,
              particle.time,
              new THREE.Vector3(0, 0, 0),
              particle.index,
            )),
          );
          particle.angularAcceleration.assign(
            particle.angularAcceleration.add(this.gpuParameters.vector(
              'angularAcceleration',
              () => this.options.angularAcceleration,
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
