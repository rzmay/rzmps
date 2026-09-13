import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface MassOverLifetimeOptions extends Partial<ModuleOptions> {
    mass: DynamicValue<number>;
    multiplyMassBySize: boolean; // Default to true
}

class MassOverLifetime extends Module {
  constructor(public options: MassOverLifetimeOptions) {
    super((particle: Particle) => {
      const sizeRatio = particle.scale.length() / particle.start.scale.length();

      particle.mass = particle.start.mass
        * evaluateDynamicNumber(this.options.mass, particle.time, particle.id)
        * (options.multiplyMassBySize ?? true ? sizeRatio : 1);
    }, options);
  }
}

export default MassOverLifetime;
