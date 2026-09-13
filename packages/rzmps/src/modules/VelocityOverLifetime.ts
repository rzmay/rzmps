import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface VelocityOverLifetimeOptions extends Partial<ModuleOptions> {
    linear: DynamicValue<THREE.Vector3>;
    orbital: DynamicValue<THREE.Vector3>;
    orbitOffset: DynamicValue<THREE.Vector3>;
    radial: DynamicValue<number>;
    speedModifier: DynamicValue<number>;
}

class VelocityOverLifetime extends Module {
  constructor(public options: Partial<VelocityOverLifetimeOptions> = {}) {
    super((particle: Particle) => {
      const { time } = particle;
      const velocity = particle.start.velocity.clone();

      if (this.options.linear !== undefined) {
        velocity.add(evaluateDynamicVector(this.options.linear, time, particle.id).clone());
      }

      const offset = evaluateDynamicVector(this.options.orbitOffset ?? new THREE.Vector3(), time, particle.id).clone();
      const center = particle.start.position.clone().add(offset);
      const fromCenter = particle.position.clone().sub(center);

      if (this.options.orbital !== undefined && fromCenter.lengthSq() > 0) {
        const angularVelocity = evaluateDynamicVector(this.options.orbital, time, particle.id).clone();
        velocity.add(angularVelocity.cross(fromCenter.clone().normalize()));
      }

      if (this.options.radial !== undefined && fromCenter.lengthSq() > 0) {
        velocity.add(fromCenter.normalize().multiplyScalar(evaluateDynamicNumber(this.options.radial, time, particle.id)));
      }

      particle.velocity = velocity;

      if (this.options.speedModifier !== undefined) {
        particle.speed = particle.start.speed * evaluateDynamicNumber(this.options.speedModifier, time, particle.id);
      }
    }, options);
  }
}

export default VelocityOverLifetime;
