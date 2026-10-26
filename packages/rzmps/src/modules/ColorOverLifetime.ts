import type { ColorInput } from '../types/ValueInput';
import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface ColorOverLifetimeOptions extends Partial<ModuleOptions> {
    color?: DynamicValue<ColorInput>;
    alpha?: DynamicValue<number>;
}

/**
 * Multiplies color and alpha by normalized-age values in the transient render phase; original particle color is
 * restored next update.
 */
class ColorOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
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
              particle.color.mul(this.gpuParameters.color(
                'color', () => this.options.color, particle.time, new THREE.Color(), particle.index,
              )),
            );
          }
          if (this.options.alpha !== undefined) {
            particle.alpha.assign(
              particle.alpha.mul(this.gpuParameters.number(
                'alpha', () => this.options.alpha, particle.time, 1, particle.index,
              )),
            );
          }
        }
    });
  }
}

export default ColorOverLifetime;
