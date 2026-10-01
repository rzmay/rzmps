import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import {
  evaluateDynamicColorGPU,
  evaluateDynamicNumberGPU,} from '../helpers/evaluateDynamicGPU';

export interface ColorOverLifetimeOptions extends Partial<ModuleOptions> {
    color?: DynamicValue<THREE.Color>;
    alpha?: DynamicValue<number>;
}

class ColorOverLifetime extends Module {
  constructor(public options: ColorOverLifetimeOptions = {}) {

    super((particle: Particle) => {
      if (this.options.color !== undefined) {
        particle.color.multiply(evaluateDynamicColor(this.options.color, particle.time, particle.id));
      }
      if (this.options.alpha !== undefined) {
        particle.alpha *= evaluateDynamicNumber(this.options.alpha, particle.time, particle.id);
      }
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          if (this.options.color !== undefined) {
            particle.color.assign(
              particle.color.mul(evaluateDynamicColorGPU(this.options.color, particle.time, new THREE.Color(), particle.index)),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(evaluateDynamicNumberGPU(this.options.alpha, particle.time, 1, particle.index)),
            );
          }
        }
    });
  }
}

export default ColorOverLifetime;
