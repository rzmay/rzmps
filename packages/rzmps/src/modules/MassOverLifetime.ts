import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import {
  evaluateDynamicNumberGPU,} from '../helpers/evaluateDynamicGPU';

export interface MassOverLifetimeOptions extends Partial<ModuleOptions> {
    mass: DynamicValue<number>;
    multiplyMassBySize: boolean; // Default to true
}

class MassOverLifetime extends Module {
  constructor(public options: Partial<MassOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.mass *= evaluateDynamicNumber(this.options.mass ?? 1, particle.time, particle.id)
        * (options.multiplyMassBySize ?? true ? particle.scale.length() : 1);
    }, {
      ...options,
      modifyGPU: (particle) => {
          const massFactor = evaluateDynamicNumberGPU(
            this.options.mass ?? 1,
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
