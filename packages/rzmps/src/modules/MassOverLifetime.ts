import Module, { type ModuleOptions } from '../core/Module';
import Particle from '../core/Particle';
import type { DynamicValue } from '../values/dynamicValue.types';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';

export interface MassOverLifetimeOptions extends Partial<ModuleOptions> {
    mass: DynamicValue<number>;
    /** Multiplies mass by scale vector length; defaults to true. */
    multiplyMassBySize: boolean; // Default to true
}

/**
 * Multiplies mass in the configured module phase, permanent by default; size multiplication defaults on and repeated
 * updates can accumulate.
 */
class MassOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<MassOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.mass *= evaluateDynamicNumber(this.options.mass ?? 1, particle.time, particle.id)
        * (options.multiplyMassBySize ?? true ? particle.scale.length() : 1);
    }, {
      ...options,
      modifyGPU: (particle) => {
          const massFactor = this.evaluateDynamicGPU.number(
            'mass',
            () => this.options.mass,
            particle.time,
            1,
            particle.index,
          );
          const sizeFactor = options.multiplyMassBySize ?? true ? particle.scale.length() : 1;

          particle.mass.assign(
            particle.mass.mul(massFactor).mul(sizeFactor),
          );
        }
    });
  }
}

export default MassOverLifetime;
