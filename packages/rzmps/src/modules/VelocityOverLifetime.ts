import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface VelocityOverLifetimeOptions extends Partial<ModuleOptions> {
    position: DynamicValue<THREE.Vector3>;
    linear: DynamicValue<THREE.Vector3>;
    acceleration: DynamicValue<THREE.Vector3>;
    orbital: DynamicValue<THREE.Vector3>;
    orbitOffset: DynamicValue<THREE.Vector3>;
    radial: DynamicValue<number>;
    speedModifier: DynamicValue<number>;
}

class VelocityOverLifetime extends Module {
  constructor(public options: Partial<VelocityOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      const { time } = particle;

      if (this.options.position !== undefined) {
        particle.position.add(evaluateDynamicVector(this.options.position, time, particle.id));
      }

      if (this.options.linear !== undefined) {
        particle.velocity.add(evaluateDynamicVector(this.options.linear, time, particle.id));
      }

      if (this.options.acceleration !== undefined) {
        particle.acceleration.add(evaluateDynamicVector(this.options.acceleration, time, particle.id));
      }

      const offset = evaluateDynamicVector(this.options.orbitOffset ?? new THREE.Vector3(), time, particle.id).clone();
      const center = particle.orbitCenter.clone().add(offset);
      const fromCenter = particle.position.clone().sub(center);

      if (this.options.orbital !== undefined && fromCenter.lengthSq() > 0) {
        const angularVelocity = evaluateDynamicVector(this.options.orbital, time, particle.id).clone();
        particle.velocity.add(angularVelocity.cross(fromCenter.clone().normalize()));
      }

      if (this.options.radial !== undefined && fromCenter.lengthSq() > 0) {
        particle.velocity.add(
          fromCenter.normalize().multiplyScalar(
            evaluateDynamicNumber(this.options.radial, time, particle.id)
          )
        );
      }

      if (this.options.speedModifier !== undefined) {
        particle.speed *= evaluateDynamicNumber(this.options.speedModifier, time, particle.id);
      }
    }, {
      ...options,
      priority: 0.5,
    });
  }
}

export default VelocityOverLifetime;
