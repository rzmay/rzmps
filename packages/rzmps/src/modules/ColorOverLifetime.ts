import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface ColorOverLifetimeOptions extends Partial<ModuleOptions> {
    color?: DynamicValue<THREE.Color>;
    alpha?: DynamicValue<number>;
}

class ColorOverLifetime extends Module {
  constructor(public options: ColorOverLifetimeOptions = {}) {
    super((particle: Particle) => {
      if (this.options.color !== undefined) {
        particle.color = particle.start.color.clone().multiply(evaluateDynamicColor(this.options.color, particle.time, particle.id));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha = particle.start.alpha * evaluateDynamicNumber(this.options.alpha, particle.time, particle.id);
      }
    }, options);
  }
}

export default ColorOverLifetime;
